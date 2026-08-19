import type { StableEvent } from '../storage/stable-turn-writer';
import { joinAssistantParts, type AssistantPart, type ConversationItem } from './conversation';

export type DominantState = 'idle' | 'paused' | 'listening' | 'transcribing' | 'deciding' | 'intentional_silence' | 'reasoning' | 'speaking' | 'stopping' | 'degraded';
export type AudioEngineStatus = 'starting' | 'warming' | 'ready' | 'failed' | 'retrying';
export type AudioEngineSubstep = 'starting' | 'warming' | 'ready' | 'failed';
export interface AudioEngineViewState {
  status: AudioEngineStatus;
  capture: 'starting' | 'ready' | 'failed';
  vad: AudioEngineSubstep;
  tts: AudioEngineSubstep;
  detail?: string;
}
export interface SessionViewState {
  dominant: DominantState;
  audioEngine: AudioEngineViewState;
  epoch: number;
  tentativeText: string;
  stableTurns: Array<{ turnId: string; text: string; posture?: 'riff' | 'question' | 'challenge' | 'silence'; policyReason?: string }>;
  conversationItems: ConversationItem[];
  assistantText: string;
  playbackNotice: string;
  degradedMessage: string;
  announcement: string;
}

export const initialSessionState: SessionViewState = { dominant: 'idle', audioEngine: { status: 'starting', capture: 'starting', vad: 'starting', tts: 'starting' }, epoch: 0, tentativeText: '', stableTurns: [], conversationItems: [], assistantText: '', playbackNotice: '', degradedMessage: '', announcement: 'Idle' };
const label: Record<DominantState, string> = {
  idle: 'Session stopped', paused: 'Session paused', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering what you meant…', intentional_silence: 'Giving you space', reasoning: 'Forming a response…', speaking: 'Speaking', stopping: 'Stopping response…', degraded: 'Session needs attention',
};

function dominant(state: SessionViewState, next: DominantState): SessionViewState {
  return next === state.dominant ? state : { ...state, dominant: next, announcement: label[next] };
}

// An assistant row that only ever held a tentative preview (never a final) must
// disappear wholesale when the response is abandoned; a finalized row is kept.
function dropTentativeAssistant(items: ConversationItem[]): ConversationItem[] {
  return items.some(item => item.kind === 'assistant' && item.tentative)
    ? items.filter(item => !(item.kind === 'assistant' && item.tentative))
    : items;
}

export function reduceSessionState(state: SessionViewState, event: StableEvent): SessionViewState {
  if (event.epoch < state.epoch && event.type !== 'playback.progress' && event.type !== 'playback.stopped') return state;
  // An epoch advance means the in-flight response was cancelled or superseded, so
  // any still-tentative assistant preview must not linger.
  let next = event.epoch > state.epoch ? { ...state, epoch: event.epoch, conversationItems: dropTentativeAssistant(state.conversationItems) } : state;
  if (event.type === 'transcript.partial') return { ...next, tentativeText: typeof event.payload.text === 'string' ? event.payload.text : '' };
  if (event.type === 'capture.endpoint') return dominant(next, 'transcribing');
  if (event.type === 'transcript.final') {
    const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : '';
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    const existing = next.stableTurns.findIndex(turn => turn.turnId === turnId);
    const stableTurns = [...next.stableTurns];
    if (existing >= 0) stableTurns[existing] = { ...stableTurns[existing]!, text };
    else stableTurns.push({ turnId, text });
    const conversationItems = !text.trim() ? next.conversationItems
      : next.conversationItems.some(item => item.kind === 'user' && item.id === turnId)
        ? next.conversationItems.map(item => item.kind === 'user' && item.id === turnId ? { ...item, text, status: 'stable' as const } : item)
        : [...next.conversationItems, { kind: 'user' as const, id: turnId, text, status: 'stable' as const, sequence: event.monotonicMs }];
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
      const stableTurns = next.stableTurns.map(turn => turn.turnId === turnId ? { ...turn, posture: typedPosture, ...(policyReason ? { policyReason } : {}) } : turn);
      next = { ...next, stableTurns };
      return dominant(next, posture === 'silence' ? 'intentional_silence' : 'reasoning');
    }
  }
  if (event.type === 'reasoning.started') {
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    if (!responseId) return next;
    // Preserve an existing row when a new part of the same multi-part response
    // starts; create the hidden placeholder only for the first part.
    const existing = next.conversationItems.find((item): item is Extract<ConversationItem, { kind: 'assistant' }> => item.kind === 'assistant' && item.responseId === responseId);
    const item: ConversationItem = existing ?? { kind: 'assistant', id: `assistant:${responseId}`, responseId, text: '', playback: 'preparing', sequence: event.monotonicMs };
    return { ...next, conversationItems: [...next.conversationItems.filter(existing => existing.id !== item.id), item] };
  }
  if (event.type === 'reasoning.delta') {
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    if (!responseId || !text) return next;
    const partIndex = typeof event.payload.partIndex === 'number' ? event.payload.partIndex : undefined;
    // Presentational preview: accumulate the cumulative text into the assistant row
    // and mark it tentative so the UI can render it dimmed until it materializes.
    const exists = next.conversationItems.some(item => item.kind === 'assistant' && item.responseId === responseId);
    let conversationItems: ConversationItem[];
    if (exists) {
      conversationItems = next.conversationItems.map(item => {
        if (item.kind !== 'assistant' || item.responseId !== responseId) return item;
        if (partIndex === undefined) return { ...item, text, tentative: true };
        const parts = [...(item.parts ?? [])];
        const last = parts[parts.length - 1];
        if (last && last.partIndex === partIndex) parts[parts.length - 1] = { ...last, text, tentative: true };
        else parts.push({ partIndex, text, tentative: true });
        return { ...item, parts, text: joinAssistantParts(parts), tentative: true };
      });
    } else {
      const base: ConversationItem = partIndex === undefined
        ? { kind: 'assistant', id: `assistant:${responseId}`, responseId, text, tentative: true, playback: 'preparing', sequence: event.monotonicMs }
        : { kind: 'assistant', id: `assistant:${responseId}`, responseId, parts: [{ partIndex, text, tentative: true }], text, tentative: true, playback: 'preparing', sequence: event.monotonicMs };
      conversationItems = [...next.conversationItems, base];
    }
    return { ...next, conversationItems };
  }
  if (event.type === 'reasoning.final') {
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    const partIndex = typeof event.payload.partIndex === 'number' ? event.payload.partIndex : undefined;
    const existing = next.conversationItems.find((item): item is Extract<ConversationItem, { kind: 'assistant' }> => item.kind === 'assistant' && item.responseId === responseId);
    // Upsert the placeholder without resetting an already-playing item to preparing.
    // Materialization clears the tentative flag so the row solidifies.
    let item: ConversationItem;
    if (existing) {
      if (partIndex !== undefined) {
        const parts = [...(existing.parts ?? [])];
        const last = parts[parts.length - 1];
        if (last && last.partIndex === partIndex) parts[parts.length - 1] = { ...last, text, tentative: false };
        else parts.push({ partIndex, text, tentative: false });
        const finalized = parts.every(part => !part.tentative);
        item = { ...existing, parts, text: joinAssistantParts(parts), ...(finalized ? { tentative: false } : {}) };
      } else {
        item = { ...existing, text, tentative: false };
      }
    } else {
      item = partIndex !== undefined
        ? { kind: 'assistant', id: `assistant:${responseId}`, responseId, parts: [{ partIndex, text, tentative: false }], text, playback: 'preparing', sequence: event.monotonicMs }
        : { kind: 'assistant', id: `assistant:${responseId}`, responseId, text, playback: 'preparing', sequence: event.monotonicMs };
    }
    // Never regress an already-speaking response back to the forming state.
    const phase: DominantState = next.dominant === 'speaking' ? 'speaking' : 'reasoning';
    return { ...dominant(next, phase), assistantText: text, conversationItems: [...next.conversationItems.filter(existing => existing.id !== item.id), item] };
  }
  if (event.type === 'response.failed') {
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    // Keep authoritative (finalized) text as interrupted, but drop an empty
    // placeholder or a still-tentative preview that never materialized.
    return { ...next, conversationItems: next.conversationItems
      .map(item => item.kind === 'assistant' && item.responseId === responseId && item.text && item.tentative !== true ? { ...item, playback: 'interrupted' as const } : item)
      .filter(item => !(item.kind === 'assistant' && item.responseId === responseId && (!item.text || item.tentative === true))) };
  }
  if (event.type === 'tts.started') {
    const responseId = String(event.payload.responseId ?? '');
    const playbackId = String(event.payload.playbackId ?? '');
    return { ...dominant(next, 'speaking'), playbackNotice: '', conversationItems: next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === responseId ? { ...item, playbackId, playback: 'playing' as const } : item) };
  }
  if (event.type === 'barge_in.provisional') return dominant({ ...next, playbackNotice: '', conversationItems: next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === event.payload.responseId ? { ...item, playback: 'paused' as const } : item) }, 'listening');
  if (event.type === 'interruption.decision') {
    const resume = event.payload.action === 'resume';
    const responseId = String(event.payload.responseId ?? '');
    const turnId = String(event.payload.turnId ?? '');
    const wasPaused = next.conversationItems.some(item => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused');
    const conversationItems = next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === responseId ? { ...item, playback: resume ? 'playing' as const : 'interrupted' as const } : item.kind === 'user' && item.id === turnId && resume ? { ...item, status: 'control' as const } : item);
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
    return { ...next, conversationItems: next.conversationItems.map(item => item.kind === 'assistant' && item.playbackId === playbackId ? { ...item, playback: completed ? 'completed' as const : 'interrupted' as const } : item) };
  }
  if (event.type === 'barge_in.confirmed') return dominant(next, 'listening');
  if (event.type === 'barge_in.rejected') {
    const resumed = event.payload.resumable === true;
    const responseId = String(event.payload.responseId ?? '');
    const wasPaused = resumed && next.conversationItems.some(item => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused');
    const base = { ...next, playbackNotice: '', conversationItems: next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === responseId ? { ...item, playback: resumed ? 'playing' as const : 'interrupted' as const } : item) };
    if (!resumed) return base;
    const continued = dominant(base, 'speaking');
    return wasPaused ? { ...continued, announcement: 'Continuing the response' } : continued;
  }
  if (event.type === 'barge_in.timed_out') {
    const resumed = event.payload.resumable === true;
    const responseId = String(event.payload.responseId ?? '');
    const wasPaused = resumed && next.conversationItems.some(item => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused');
    if (!resumed) return { ...next, playbackNotice: 'The response stopped because interruption recovery timed out.', announcement: 'The response stopped' };
    const base = { ...next, playbackNotice: '', conversationItems: next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === responseId ? { ...item, playback: 'playing' as const } : item) };
    const continued = dominant(base, 'speaking');
    return wasPaused ? { ...continued, announcement: 'Continuing the response' } : continued;
  }
  if (event.type === 'failure') return { ...dominant(next, 'degraded'), degradedMessage: typeof event.payload.detail === 'string' ? event.payload.detail : 'A session component failed.' };
  if (event.type === 'session.state') {
    const audio = event.payload.audio;
    let audioStatusUpdated = false;
    if (audio && typeof audio === 'object' && !Array.isArray(audio)) {
      const value = audio as Record<string, unknown>;
      if ((value.status === 'starting' || value.status === 'warming' || value.status === 'ready' || value.status === 'failed' || value.status === 'retrying')
        && (value.capture === 'starting' || value.capture === 'ready' || value.capture === 'failed')
        && (value.vad === 'starting' || value.vad === 'warming' || value.vad === 'ready' || value.vad === 'failed')
        && (value.tts === 'starting' || value.tts === 'warming' || value.tts === 'ready' || value.tts === 'failed')) {
        next = { ...next, audioEngine: { status: value.status, capture: value.capture, vad: value.vad, tts: value.tts, ...(typeof value.detail === 'string' ? { detail: value.detail } : {}) }, ...(value.status === 'ready' ? { degradedMessage: '' } : {}) };
        audioStatusUpdated = true;
      }
    }
    if (audioStatusUpdated) return next;
    const phase = event.payload.phase;
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
  hostResumable: boolean; responseMatches: boolean; playbackMatches: boolean; epochMatches: boolean;
  wasSpeaking: boolean; playbackTerminal: boolean; echoRecovered: boolean; newerStableTurn: boolean; stopped: boolean; confirmed: boolean;
}): boolean {
  return input.hostResumable && input.responseMatches && input.playbackMatches && input.epochMatches && input.wasSpeaking && !input.playbackTerminal && input.echoRecovered && !input.newerStableTurn && !input.stopped && !input.confirmed;
}
