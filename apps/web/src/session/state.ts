import type { StableEvent } from '../storage/stable-turn-writer';
import type { ConversationItem } from './conversation';

export type DominantState = 'idle' | 'listening' | 'transcribing' | 'deciding' | 'intentional_silence' | 'reasoning' | 'speaking' | 'stopping' | 'degraded';
export interface SessionViewState {
  dominant: DominantState;
  epoch: number;
  tentativeText: string;
  stableTurns: Array<{ turnId: string; text: string; posture?: 'riff' | 'question' | 'challenge' | 'silence'; policyReason?: string }>;
  conversationItems: ConversationItem[];
  assistantText: string;
  echoConfirmation: boolean;
  playbackNotice: string;
  degradedMessage: string;
  announcement: string;
}

export const initialSessionState: SessionViewState = { dominant: 'idle', epoch: 0, tentativeText: '', stableTurns: [], conversationItems: [], assistantText: '', echoConfirmation: false, playbackNotice: '', degradedMessage: '', announcement: 'Idle' };
const label: Record<DominantState, string> = {
  idle: 'Session stopped', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering what you meant…', intentional_silence: 'Giving you space', reasoning: 'Forming a response…', speaking: 'Speaking', stopping: 'Stopping response…', degraded: 'Session needs attention',
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
    // Hidden placeholder: carries response identity so an early tts.started can
    // attach playback before final text exists. Rendered only once text exists.
    const item: ConversationItem = { kind: 'assistant', id: `assistant:${responseId}`, responseId, text: '', playback: 'preparing', sequence: event.monotonicMs };
    return { ...next, conversationItems: [...next.conversationItems.filter(existing => existing.id !== item.id), item] };
  }
  if (event.type === 'reasoning.delta') {
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    if (!responseId || !text) return next;
    // Presentational preview: accumulate the cumulative text into the assistant row
    // and mark it tentative so the UI can render it dimmed until it materializes.
    const exists = next.conversationItems.some(item => item.kind === 'assistant' && item.responseId === responseId);
    const conversationItems = exists
      ? next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === responseId ? { ...item, text, tentative: true } : item)
      : [...next.conversationItems, { kind: 'assistant' as const, id: `assistant:${responseId}`, responseId, text, tentative: true, playback: 'preparing' as const, sequence: event.monotonicMs }];
    return { ...next, conversationItems };
  }
  if (event.type === 'reasoning.final') {
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
    const existing = next.conversationItems.find((item): item is Extract<ConversationItem, { kind: 'assistant' }> => item.kind === 'assistant' && item.responseId === responseId);
    // Upsert the placeholder without resetting an already-playing item to preparing.
    // Materialization clears the tentative flag so the row solidifies.
    const item: ConversationItem = existing
      ? { ...existing, text, tentative: false }
      : { kind: 'assistant', id: `assistant:${responseId}`, responseId, text, playback: 'preparing', sequence: event.monotonicMs };
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
  if (event.type === 'barge_in.provisional') return { ...next, echoConfirmation: true, playbackNotice: '', conversationItems: next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === event.payload.responseId ? { ...item, playback: 'paused' as const } : item) };
  if (event.type === 'interruption.decision') {
    const resume = event.payload.action === 'resume';
    const responseId = String(event.payload.responseId ?? '');
    const turnId = String(event.payload.turnId ?? '');
    const wasPaused = next.conversationItems.some(item => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused');
    const conversationItems = next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === responseId ? { ...item, playback: resume ? 'playing' as const : 'interrupted' as const } : item.kind === 'user' && item.id === turnId && resume ? { ...item, status: 'control' as const } : item);
    return { ...next, echoConfirmation: false, playbackNotice: resume ? '' : 'Responding to you instead.', ...(resume && wasPaused ? { announcement: 'Continuing the response' } : {}), conversationItems };
  }
  if (event.type === 'playback.stopped') {
    const playbackId = String(event.payload.playbackId ?? '');
    const completed = event.payload.reason === 'completed';
    return { ...next, conversationItems: next.conversationItems.map(item => item.kind === 'assistant' && item.playbackId === playbackId ? { ...item, playback: completed ? 'completed' as const : 'interrupted' as const } : item) };
  }
  if (event.type === 'barge_in.confirmed') return { ...dominant(next, 'listening'), echoConfirmation: false, playbackNotice: '' };
  if (event.type === 'barge_in.rejected') {
    const responseId = String(event.payload.responseId ?? '');
    const wasPaused = next.conversationItems.some(item => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused');
    return { ...next, echoConfirmation: false, playbackNotice: '', ...(wasPaused ? { announcement: 'Continuing the response' } : {}), conversationItems: next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === responseId ? { ...item, playback: 'playing' as const } : item) };
  }
  if (event.type === 'barge_in.timed_out') {
    const resumed = event.payload.resumable === true;
    const responseId = String(event.payload.responseId ?? '');
    const wasPaused = resumed && next.conversationItems.some(item => item.kind === 'assistant' && item.responseId === responseId && item.playback === 'paused');
    return { ...next, echoConfirmation: false, playbackNotice: resumed ? '' : 'The response stopped because interruption recovery timed out.', announcement: resumed && wasPaused ? 'Continuing the response' : resumed ? next.announcement : 'The response stopped', conversationItems: resumed ? next.conversationItems.map(item => item.kind === 'assistant' && item.responseId === responseId ? { ...item, playback: 'playing' as const } : item) : next.conversationItems };
  }
  if (event.type === 'failure') return { ...dominant(next, 'degraded'), degradedMessage: typeof event.payload.detail === 'string' ? event.payload.detail : 'A session component failed.' };
  if (event.type === 'session.state') {
    const phase = event.payload.phase;
    if (phase === 'listening') return dominant(next, 'listening');
    if (phase === 'deciding' || phase === 'interruption_deciding') return dominant(next, 'deciding');
    if (phase === 'reasoning' || phase === 'synthesizing') return dominant(next, 'reasoning');
    if (phase === 'playing') return dominant(next, 'speaking');
    if (phase === 'echo_provisional') return { ...dominant(next, 'speaking'), echoConfirmation: true };
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
