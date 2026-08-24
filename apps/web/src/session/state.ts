import type { PlanningDepth, PlanningStatus } from '@app/contracts';
import type { StableEvent } from '../storage/stable-turn-writer';
import { joinAssistantParts, type ConversationItem } from './conversation';

export type DominantState =
  | 'idle'
  | 'planning'
  | 'ready'
  | 'paused'
  | 'listening'
  | 'transcribing'
  | 'deciding'
  | 'intentional_silence'
  | 'reasoning'
  | 'speaking'
  | 'stopping'
  | 'degraded';
export type AudioEngineStatus = 'starting' | 'warming' | 'ready' | 'failed' | 'retrying';
export type AudioEngineSubstep = 'starting' | 'warming' | 'ready' | 'failed';
export interface AudioEngineViewState {
  status: AudioEngineStatus;
  capture: 'starting' | 'ready' | 'failed';
  vad: AudioEngineSubstep;
  tts: AudioEngineSubstep;
  detail?: string;
}
export interface PlanningViewState {
  status: PlanningStatus;
  attempt: number;
  stage?: 'starting' | 'researching' | 'finalizing';
  deadlineMs?: number;
  reasonCode?: 'timeout' | 'provider_unavailable' | 'invalid_result' | 'interrupted';
  topic?: string;
  depth?: PlanningDepth;
  detail?: string;
  notes?: string;
}
export type AgentToolStatus = 'running' | 'done' | 'failed' | 'interrupted';
/** One concise tool call made while the agent worked; display metadata only. */
export interface AgentToolActivity {
  toolCallId: string;
  toolName: string;
  status: AgentToolStatus;
  summary?: string;
  durationMs?: number;
}
/** Activity grouped by its origin: the preparation pass or one spoken turn. */
export interface AgentActivityGroup {
  key: string;
  scope: 'planning' | 'turn';
  turnId?: string;
  epoch: number;
  entries: AgentToolActivity[];
}
const MAX_ACTIVITY_GROUPS = 16;
const MAX_ACTIVITY_ENTRIES = 24;

// An epoch advance abandons in-flight work; tool calls still marked running
// never receive their end event and must not spin forever in the activity view.
function settleInterruptedActivity(groups: AgentActivityGroup[]): AgentActivityGroup[] {
  if (!groups.some((group) => group.entries.some((entry) => entry.status === 'running'))) return groups;
  return groups.map((group) =>
    group.entries.some((entry) => entry.status === 'running')
      ? {
          ...group,
          entries: group.entries.map((entry) =>
            entry.status === 'running' ? { ...entry, status: 'interrupted' as const } : entry,
          ),
        }
      : group,
  );
}
export interface SessionViewState {
  dominant: DominantState;
  audioEngine: AudioEngineViewState;
  planning: PlanningViewState;
  epoch: number;
  tentativeText: string;
  stableTurns: Array<{
    turnId: string;
    text: string;
    posture?: 'riff' | 'question' | 'challenge' | 'silence';
    policyReason?: string;
  }>;
  conversationItems: ConversationItem[];
  agentActivity: AgentActivityGroup[];
  assistantText: string;
  playbackNotice: string;
  degradedMessage: string;
  announcement: string;
}

export const initialSessionState: SessionViewState = {
  dominant: 'idle',
  audioEngine: { status: 'starting', capture: 'starting', vad: 'starting', tts: 'starting' },
  planning: { status: 'skipped', attempt: 0 },
  epoch: 0,
  tentativeText: '',
  stableTurns: [],
  conversationItems: [],
  agentActivity: [],
  assistantText: '',
  playbackNotice: '',
  degradedMessage: '',
  announcement: 'Idle',
};
const label: Record<DominantState, string> = {
  idle: 'Session stopped',
  planning: 'Preparing your session',
  ready: 'Ready to go live',
  paused: 'Session paused',
  listening: 'Listening',
  transcribing: 'Finishing transcript',
  deciding: 'Considering what you meant…',
  intentional_silence: 'Giving you space',
  reasoning: 'Forming a response…',
  speaking: 'Speaking',
  stopping: 'Stopping response…',
  degraded: 'Session needs attention',
};

function dominant(state: SessionViewState, next: DominantState): SessionViewState {
  return next === state.dominant ? state : { ...state, dominant: next, announcement: label[next] };
}

// An assistant row that only ever held a tentative preview (never a final) must
// disappear wholesale when the response is abandoned; a finalized row is kept.
function dropTentativeAssistant(items: ConversationItem[]): ConversationItem[] {
  return items.some((item) => item.kind === 'assistant' && item.tentative)
    ? items.filter((item) => !(item.kind === 'assistant' && item.tentative))
    : items;
}

export function reduceSessionState(state: SessionViewState, event: StableEvent): SessionViewState {
  if (event.epoch < state.epoch && event.type !== 'playback.progress' && event.type !== 'playback.stopped')
    return state;
  // An epoch advance means the in-flight response was cancelled or superseded, so
  // any still-tentative assistant preview must not linger.
  let next =
    event.epoch > state.epoch
      ? {
          ...state,
          epoch: event.epoch,
          conversationItems: dropTentativeAssistant(state.conversationItems),
          agentActivity: settleInterruptedActivity(state.agentActivity),
        }
      : state;
  if (event.type === 'transcript.partial')
    return { ...next, tentativeText: typeof event.payload.text === 'string' ? event.payload.text : '' };
  if (event.type === 'transcript.final') {
    const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : '';
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    const existing = next.stableTurns.findIndex((turn) => turn.turnId === turnId);
    const stableTurns = [...next.stableTurns];
    if (existing >= 0) stableTurns[existing] = { ...stableTurns[existing]!, text };
    else stableTurns.push({ turnId, text });
    const conversationItems = !text.trim()
      ? next.conversationItems
      : next.conversationItems.some((item) => item.kind === 'user' && item.id === turnId)
        ? next.conversationItems.map((item) =>
            item.kind === 'user' && item.id === turnId ? { ...item, text, status: 'stable' as const } : item,
          )
        : [
            ...next.conversationItems,
            { kind: 'user' as const, id: turnId, text, status: 'stable' as const, sequence: event.monotonicMs },
          ];
    next = { ...next, tentativeText: '', stableTurns, conversationItems };
    return dominant(next, 'deciding');
  }
  if (event.type === 'policy.decision') {
    const posture = event.payload.posture;
    const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : '';
    if (posture === 'riff' || posture === 'question' || posture === 'challenge' || posture === 'silence') {
      const typedPosture: 'riff' | 'question' | 'challenge' | 'silence' = posture;
      const reasonCodes = Array.isArray(event.payload.reasonCodes) ? event.payload.reasonCodes : [];
      const policyReason = typeof reasonCodes[0] === 'string' ? reasonCodes[0] : undefined;
      const stableTurns = next.stableTurns.map((turn) =>
        turn.turnId === turnId ? { ...turn, posture: typedPosture, ...(policyReason ? { policyReason } : {}) } : turn,
      );
      next = { ...next, stableTurns };
      return dominant(next, posture === 'silence' ? 'intentional_silence' : 'reasoning');
    }
  }
  if (event.type === 'reasoning.started') {
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    if (!responseId) return next;
    // Preserve an existing row when a new part of the same multi-part response
    // starts; create the hidden placeholder only for the first part.
    const existing = next.conversationItems.find(
      (item): item is Extract<ConversationItem, { kind: 'assistant' }> =>
        item.kind === 'assistant' && item.responseId === responseId,
    );
    const item: ConversationItem = existing ?? {
      kind: 'assistant',
      id: `assistant:${responseId}`,
      responseId,
      text: '',
      playback: 'preparing',
      sequence: event.monotonicMs,
    };
    return {
      ...next,
      conversationItems: [...next.conversationItems.filter((existing) => existing.id !== item.id), item],
    };
  }
  if (event.type === 'reasoning.delta') {
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    if (!responseId || !text) return next;
    const partIndex =
      typeof (event.payload as { partIndex?: number }).partIndex === 'number'
        ? (event.payload as { partIndex?: number }).partIndex
        : undefined;
    // Presentational preview: accumulate the cumulative text into the assistant row
    // and mark it tentative so the UI can render it dimmed until it materializes.
    const exists = next.conversationItems.some((item) => item.kind === 'assistant' && item.responseId === responseId);
    let conversationItems: ConversationItem[];
    if (exists) {
      conversationItems = next.conversationItems.map((item) => {
        if (item.kind !== 'assistant' || item.responseId !== responseId) return item;
        if (partIndex === undefined) return { ...item, text, tentative: true };
        const parts = [...(item.parts ?? [])];
        const last = parts[parts.length - 1];
        if (last && last.partIndex === partIndex) parts[parts.length - 1] = { ...last, text, tentative: true };
        else parts.push({ partIndex, text, tentative: true });
        return { ...item, parts, text: joinAssistantParts(parts), tentative: true };
      });
    } else {
      const base: ConversationItem =
        partIndex === undefined
          ? {
              kind: 'assistant',
              id: `assistant:${responseId}`,
              responseId,
              text,
              tentative: true,
              playback: 'preparing',
              sequence: event.monotonicMs,
            }
          : {
              kind: 'assistant',
              id: `assistant:${responseId}`,
              responseId,
              parts: [{ partIndex, text, tentative: true }],
              text,
              tentative: true,
              playback: 'preparing',
              sequence: event.monotonicMs,
            };
      conversationItems = [...next.conversationItems, base];
    }
    return { ...next, conversationItems };
  }
  if (event.type === 'reasoning.final') {
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    const partIndex =
      typeof (event.payload as { partIndex?: number }).partIndex === 'number'
        ? (event.payload as { partIndex?: number }).partIndex
        : undefined;
    const existing = next.conversationItems.find(
      (item): item is Extract<ConversationItem, { kind: 'assistant' }> =>
        item.kind === 'assistant' && item.responseId === responseId,
    );
    // Upsert the placeholder without resetting an already-playing item to preparing.
    // Materialization clears the tentative flag so the row solidifies.
    let item: ConversationItem;
    if (existing) {
      if (partIndex !== undefined) {
        const parts = [...(existing.parts ?? [])];
        const last = parts[parts.length - 1];
        if (last && last.partIndex === partIndex) parts[parts.length - 1] = { ...last, text, tentative: false };
        else parts.push({ partIndex, text, tentative: false });
        const finalized = parts.every((part) => !part.tentative);
        item = { ...existing, parts, text: joinAssistantParts(parts), ...(finalized ? { tentative: false } : {}) };
      } else {
        item = { ...existing, text, tentative: false };
      }
    } else {
      item =
        partIndex !== undefined
          ? {
              kind: 'assistant',
              id: `assistant:${responseId}`,
              responseId,
              parts: [{ partIndex, text, tentative: false }],
              text,
              playback: 'preparing',
              sequence: event.monotonicMs,
            }
          : {
              kind: 'assistant',
              id: `assistant:${responseId}`,
              responseId,
              text,
              playback: 'preparing',
              sequence: event.monotonicMs,
            };
    }
    // Never regress an already-speaking response back to the forming state.
    const phase: DominantState = next.dominant === 'speaking' ? 'speaking' : 'reasoning';
    return {
      ...dominant(next, phase),
      assistantText: text,
      conversationItems: [...next.conversationItems.filter((existing) => existing.id !== item.id), item],
    };
  }
  if (event.type === 'tool.activity') {
    const payload = event.payload;
    const scope = payload.scope === 'planning' ? 'planning' : 'turn';
    const responseId = typeof payload.responseId === 'string' ? payload.responseId : '';
    const turnId = typeof payload.turnId === 'string' && payload.turnId ? payload.turnId : undefined;
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
    const status = payload.status;
    if (!toolCallId || !toolName) return next;
    if (scope === 'turn' && !responseId) return next;
    const summary = typeof payload.summary === 'string' && payload.summary ? payload.summary : undefined;
    const durationMs =
      typeof payload.durationMs === 'number' && payload.durationMs >= 0 ? payload.durationMs : undefined;
    const key = scope === 'turn' ? `turn:${responseId}` : 'planning';
    const groups = next.agentActivity;
    const groupIndex = groups.findIndex((group) => group.key === key);
    const group = groupIndex >= 0 ? groups[groupIndex]! : undefined;
    const entries = group ? [...group.entries] : [];
    const entryIndex = entries.findIndex((entry) => entry.toolCallId === toolCallId);
    if (status === 'started') {
      if (entryIndex >= 0) return next;
      entries.push({ toolCallId, toolName, status: 'running', ...(summary ? { summary } : {}) });
    } else if (status === 'ended' || status === 'failed') {
      const prior = entryIndex >= 0 ? entries[entryIndex]! : undefined;
      const finalSummary = summary ?? prior?.summary;
      const entry: AgentToolActivity = {
        toolCallId,
        toolName,
        status: status === 'ended' ? 'done' : 'failed',
        ...(finalSummary !== undefined ? { summary: finalSummary } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      if (entryIndex >= 0) entries[entryIndex] = entry;
      else entries.push(entry);
    } else return next;
    const boundedEntries =
      entries.length > MAX_ACTIVITY_ENTRIES ? entries.slice(entries.length - MAX_ACTIVITY_ENTRIES) : entries;
    const finalTurnId = group?.turnId ?? turnId;
    const updated: AgentActivityGroup = {
      key,
      scope,
      epoch: group?.epoch ?? event.epoch,
      entries: boundedEntries,
      ...(finalTurnId !== undefined ? { turnId: finalTurnId } : {}),
    };
    let updatedGroups =
      groupIndex >= 0
        ? groups.map((existing, index) => (index === groupIndex ? updated : existing))
        : [...groups, updated];
    if (updatedGroups.length > MAX_ACTIVITY_GROUPS)
      updatedGroups = updatedGroups.slice(updatedGroups.length - MAX_ACTIVITY_GROUPS);
    return { ...next, agentActivity: updatedGroups };
  }
  if (event.type === 'response.failed') {
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    // Keep authoritative (finalized) text as interrupted, but drop an empty
    // placeholder or a still-tentative preview that never materialized.
    const conversationItems = next.conversationItems
      .map((item) =>
        item.kind === 'assistant' && item.responseId === responseId && item.text && item.tentative !== true
          ? { ...item, playback: 'interrupted' as const }
          : item,
      )
      .filter(
        (item) =>
          !(item.kind === 'assistant' && item.responseId === responseId && (!item.text || item.tentative === true)),
      );
    // A response failure normally arrives alongside a generic failure event,
    // but do not leave the speaking marker behind if that follow-up is delayed
    // or never reaches the browser.
    const matchingPlayback = next.conversationItems.some(
      (item) => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'playing',
    );
    const anyPlayingPlayback = next.conversationItems.some(
      (item) => item.kind === 'assistant' && item.playback === 'playing',
    );
    const failedCurrentPlayback = next.dominant === 'speaking' && (matchingPlayback || !anyPlayingPlayback);
    return failedCurrentPlayback
      ? dominant({ ...next, conversationItems }, 'listening')
      : { ...next, conversationItems };
  }
  if (event.type === 'tts.started') {
    const responseId = String(event.payload.responseId ?? '');
    const playbackId = String(event.payload.playbackId ?? '');
    return {
      ...dominant(next, 'speaking'),
      playbackNotice: '',
      conversationItems: next.conversationItems.map((item) =>
        item.kind === 'assistant' && item.responseId === responseId
          ? { ...item, playbackId, playback: 'playing' as const }
          : item,
      ),
    };
  }
  if (event.type === 'barge_in.provisional')
    return dominant(
      {
        ...next,
        playbackNotice: '',
        conversationItems: next.conversationItems.map((item) =>
          item.kind === 'assistant' && item.responseId === event.payload.responseId
            ? { ...item, playback: 'paused' as const }
            : item,
        ),
      },
      'listening',
    );
  if (event.type === 'interruption.decision') {
    const resume = event.payload.action === 'resume';
    const responseId = String(event.payload.responseId ?? '');
    const turnId = String(event.payload.turnId ?? '');
    const wasPaused = next.conversationItems.some(
      (item) => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused',
    );
    const conversationItems = next.conversationItems.map((item) =>
      item.kind === 'assistant' && item.responseId === responseId
        ? { ...item, playback: resume ? ('playing' as const) : ('interrupted' as const) }
        : item.kind === 'user' && item.id === turnId && resume
          ? { ...item, status: 'control' as const }
          : item,
    );
    // An accepted takeover is automatic: the previous response is abandoned and
    // the session returns to listening until the new response starts.
    const base = { ...next, playbackNotice: resume ? '' : 'Responding to you instead.', conversationItems };
    if (resume) {
      const resumed = dominant(base, 'speaking');
      return wasPaused ? { ...resumed, announcement: 'Continuing the response' } : resumed;
    }
    return dominant(base, 'listening');
  }
  if (event.type === 'playback.stopped') {
    const playbackId = String(event.payload.playbackId ?? '');
    const completed = event.payload.reason === 'completed';
    const matchingPlayback = next.conversationItems.some(
      (item) => item.kind === 'assistant' && item.playbackId === playbackId && item.playback === 'playing',
    );
    const anyPlayingPlayback = next.conversationItems.some(
      (item) => item.kind === 'assistant' && item.playback === 'playing',
    );
    const stoppedCurrentPlayback = next.dominant === 'speaking' && (matchingPlayback || !anyPlayingPlayback);
    const conversationItems = next.conversationItems.map((item) =>
      item.kind === 'assistant' && item.playbackId === playbackId
        ? { ...item, playback: completed ? ('completed' as const) : ('interrupted' as const) }
        : item,
    );
    // Playback termination is itself authoritative. The host normally follows
    // it with session.state=listening, but the marker must not wait for that
    // round trip to disappear.
    return stoppedCurrentPlayback
      ? dominant({ ...next, conversationItems }, 'listening')
      : { ...next, conversationItems };
  }
  if (event.type === 'barge_in.confirmed') return dominant(next, 'listening');
  if (event.type === 'barge_in.rejected') {
    const resumed = event.payload.resumable === true;
    const responseId = String(event.payload.responseId ?? '');
    const wasPaused =
      resumed &&
      next.conversationItems.some(
        (item) => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused',
      );
    const base = {
      ...next,
      playbackNotice: '',
      conversationItems: next.conversationItems.map((item) =>
        item.kind === 'assistant' && item.responseId === responseId
          ? { ...item, playback: resumed ? ('playing' as const) : ('interrupted' as const) }
          : item,
      ),
    };
    if (!resumed) return base;
    const continued = dominant(base, 'speaking');
    return wasPaused ? { ...continued, announcement: 'Continuing the response' } : continued;
  }
  if (event.type === 'barge_in.timed_out') {
    const resumed = event.payload.resumable === true;
    const responseId = String(event.payload.responseId ?? '');
    const wasPaused =
      resumed &&
      next.conversationItems.some(
        (item) => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused',
      );
    if (!resumed)
      return {
        ...next,
        playbackNotice: 'The response stopped because interruption recovery timed out.',
        announcement: 'The response stopped',
      };
    const base = {
      ...next,
      playbackNotice: '',
      conversationItems: next.conversationItems.map((item) =>
        item.kind === 'assistant' && item.responseId === responseId ? { ...item, playback: 'playing' as const } : item,
      ),
    };
    const continued = dominant(base, 'speaking');
    return wasPaused ? { ...continued, announcement: 'Continuing the response' } : continued;
  }
  if (event.type === 'failure')
    return {
      ...dominant(next, 'degraded'),
      degradedMessage: typeof event.payload.detail === 'string' ? event.payload.detail : 'A session component failed.',
    };
  if (event.type === 'session.state') {
    const planning = event.payload.planning;
    if (planning && typeof planning === 'object' && !Array.isArray(planning)) {
      const value = planning as Record<string, unknown>;
      if (
        value.status === 'skipped' ||
        value.status === 'planning' ||
        value.status === 'ready' ||
        value.status === 'failed' ||
        value.status === 'cancelled' ||
        value.status === 'continued'
      ) {
        next = {
          ...next,
          planning: {
            status: value.status,
            attempt: typeof value.attempt === 'number' ? Math.max(0, value.attempt) : next.planning.attempt,
            ...(value.stage === 'starting' || value.stage === 'researching' || value.stage === 'finalizing'
              ? { stage: value.stage }
              : {}),
            ...(typeof value.deadlineMs === 'number' && value.deadlineMs >= 0 ? { deadlineMs: value.deadlineMs } : {}),
            ...(value.reasonCode === 'timeout' ||
            value.reasonCode === 'provider_unavailable' ||
            value.reasonCode === 'invalid_result' ||
            value.reasonCode === 'interrupted'
              ? { reasonCode: value.reasonCode }
              : {}),
            ...(typeof value.topic === 'string' ? { topic: value.topic } : {}),
            ...(value.depth === 'light' || value.depth === 'standard' || value.depth === 'deep'
              ? { depth: value.depth }
              : {}),
            ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
            ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
          },
        };
      }
    }
    const audio = event.payload.audio;
    let audioStatusUpdated = false;
    if (audio && typeof audio === 'object' && !Array.isArray(audio)) {
      const value = audio as Record<string, unknown>;
      if (
        (value.status === 'starting' ||
          value.status === 'warming' ||
          value.status === 'ready' ||
          value.status === 'failed' ||
          value.status === 'retrying') &&
        (value.capture === 'starting' || value.capture === 'ready' || value.capture === 'failed') &&
        (value.vad === 'starting' || value.vad === 'warming' || value.vad === 'ready' || value.vad === 'failed') &&
        (value.tts === 'starting' || value.tts === 'warming' || value.tts === 'ready' || value.tts === 'failed')
      ) {
        next = {
          ...next,
          audioEngine: {
            status: value.status,
            capture: value.capture,
            vad: value.vad,
            tts: value.tts,
            ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
          },
          ...(value.status === 'ready' ? { degradedMessage: '' } : {}),
        };
        audioStatusUpdated = true;
      }
    }
    if (audioStatusUpdated) return next;
    const phase = event.payload.phase;
    if (phase === 'preparing' || phase === 'planning') return dominant(next, 'planning');
    if (phase === 'prelive' || phase === 'starting_live' || phase === 'ready') return dominant(next, 'ready');
    if (phase === 'listening') return dominant(next, 'listening');
    if (phase === 'deciding' || phase === 'interruption_deciding') return dominant(next, 'deciding');
    if (phase === 'reasoning' || phase === 'synthesizing') return dominant(next, 'reasoning');
    if (phase === 'playing') return dominant(next, 'speaking');
    if (phase === 'echo_provisional') return dominant(next, 'listening');
    if (phase === 'stopped') return dominant(next, 'stopping');
    if (phase === 'idle') return dominant(next, 'idle');
  }
  return next;
}

export function canSafelyResume(input: {
  hostResumable: boolean;
  responseMatches: boolean;
  playbackMatches: boolean;
  epochMatches: boolean;
  wasSpeaking: boolean;
  playbackTerminal: boolean;
  echoRecovered: boolean;
  newerStableTurn: boolean;
  stopped: boolean;
  confirmed: boolean;
}): boolean {
  return (
    input.hostResumable &&
    input.responseMatches &&
    input.playbackMatches &&
    input.epochMatches &&
    input.wasSpeaking &&
    !input.playbackTerminal &&
    input.echoRecovered &&
    !input.newerStableTurn &&
    !input.stopped &&
    !input.confirmed
  );
}
