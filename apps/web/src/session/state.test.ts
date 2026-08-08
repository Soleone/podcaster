import { describe, expect, it } from 'vitest';
import { canSafelyResume, initialSessionState, reduceSessionState } from './state';
import type { StableEvent } from '../storage/stable-turn-writer';

let sequence = 0;
const event = (type: string, payload: Record<string, unknown> = {}, epoch = 0): StableEvent => ({ eventId: `e-${++sequence}`, sessionId: 's', epoch, monotonicMs: sequence, type, payload });

describe('session presentation state', () => {
  it('keeps partials tentative and out of announcements', () => {
    const listening = reduceSessionState(initialSessionState, event('session.state', { phase: 'listening' }));
    const partial = reduceSessionState(listening, event('transcript.partial', { text: 'revising words' }));
    expect(partial.dominant).toBe('listening');
    expect(partial.tentativeText).toBe('revising words');
    expect(partial.announcement).toBe('Listening');
  });

  it('shows intentional silence distinctly and ignores stale UI events', () => {
    let state = reduceSessionState(initialSessionState, event('transcript.final', { turnId: 't', text: 'hello' }, 2));
    state = reduceSessionState(state, event('policy.decision', { turnId: 't', posture: 'silence' }, 2));
    expect(state.dominant).toBe('intentional_silence');
    expect(reduceSessionState(state, event('session.state', { phase: 'reasoning' }, 1))).toBe(state);
  });

  it('requires every conservative safe-resume guard', () => {
    const all = { hostResumable: true, responseMatches: true, playbackMatches: true, epochMatches: true, wasSpeaking: true, playbackTerminal: false, echoRecovered: true, newerStableTurn: false, stopped: false, confirmed: false };
    expect(canSafelyResume(all)).toBe(true);
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      const unsafe = { ...all, [key]: typeof all[key] === 'boolean' ? !all[key] : all[key] };
      expect(canSafelyResume(unsafe)).toBe(false);
    }
  });
});
