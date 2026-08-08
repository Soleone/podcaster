import type { StableEvent } from '../storage/stable-turn-writer';

export type DominantState = 'idle' | 'listening' | 'transcribing' | 'deciding' | 'intentional_silence' | 'reasoning' | 'speaking' | 'stopping' | 'degraded';
export interface SessionViewState {
  dominant: DominantState;
  epoch: number;
  tentativeText: string;
  stableTurns: Array<{ turnId: string; text: string; posture?: 'riff' | 'question' | 'challenge' | 'silence'; policyReason?: string }>;
  assistantText: string;
  echoConfirmation: boolean;
  playbackNotice: string;
  degradedMessage: string;
  announcement: string;
}

export const initialSessionState: SessionViewState = { dominant: 'idle', epoch: 0, tentativeText: '', stableTurns: [], assistantText: '', echoConfirmation: false, playbackNotice: '', degradedMessage: '', announcement: 'Idle' };
const label: Record<DominantState, string> = {
  idle: 'Idle', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering whether to respond', intentional_silence: 'Giving you space', reasoning: 'Forming a response', speaking: 'Speaking', stopping: 'Stopping session', degraded: 'Session needs attention',
};

function dominant(state: SessionViewState, next: DominantState): SessionViewState {
  return next === state.dominant ? state : { ...state, dominant: next, announcement: label[next] };
}

export function reduceSessionState(state: SessionViewState, event: StableEvent): SessionViewState {
  if (event.epoch < state.epoch && event.type !== 'playback.progress' && event.type !== 'playback.stopped') return state;
  let next = event.epoch > state.epoch ? { ...state, epoch: event.epoch } : state;
  if (event.type === 'transcript.partial') return { ...next, tentativeText: typeof event.payload.text === 'string' ? event.payload.text : '' };
  if (event.type === 'capture.endpoint') return dominant(next, 'transcribing');
  if (event.type === 'transcript.final') {
    const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : '';
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    const existing = next.stableTurns.findIndex(turn => turn.turnId === turnId);
    const stableTurns = [...next.stableTurns];
    if (existing >= 0) stableTurns[existing] = { ...stableTurns[existing]!, text };
    else stableTurns.push({ turnId, text });
    next = { ...next, tentativeText: '', stableTurns };
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
  if (event.type === 'reasoning.final') return { ...dominant(next, 'reasoning'), assistantText: typeof event.payload.text === 'string' ? event.payload.text : '' };
  if (event.type === 'tts.started') return { ...dominant(next, 'speaking'), playbackNotice: '' };
  if (event.type === 'barge_in.provisional') return { ...next, echoConfirmation: true, playbackNotice: '' };
  if (event.type === 'barge_in.confirmed') return { ...dominant(next, 'listening'), echoConfirmation: false, playbackNotice: '' };
  if (event.type === 'barge_in.rejected') return { ...next, echoConfirmation: false, playbackNotice: 'Continuing the response.', announcement: 'Continuing the response' };
  if (event.type === 'barge_in.timed_out') return { ...next, echoConfirmation: false, playbackNotice: 'No interruption was confirmed, so the response continued.', announcement: 'No interruption was confirmed. Continuing the response' };
  if (event.type === 'failure') return { ...dominant(next, 'degraded'), degradedMessage: typeof event.payload.detail === 'string' ? event.payload.detail : 'A session component failed.' };
  if (event.type === 'session.state') {
    const phase = event.payload.phase;
    if (phase === 'listening') return dominant(next, 'listening');
    if (phase === 'deciding') return dominant(next, 'deciding');
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
