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

  it('holds a hidden placeholder until final text and never renders an empty bubble', () => {
    let state = reduceSessionState(initialSessionState, event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'question' }));
    expect(state.conversationItems).toEqual([{ kind: 'assistant', id: 'assistant:r', responseId: 'r', text: '', playback: 'preparing', sequence: state.conversationItems[0]!.sequence }]);
    state = reduceSessionState(state, event('tts.started', { responseId: 'r', playbackId: 'p', sampleRate: 24000 }));
    expect(state.dominant).toBe('speaking');
    expect(state.conversationItems).toContainEqual(expect.objectContaining({ responseId: 'r', playbackId: 'p', playback: 'playing', text: '' }));
    state = reduceSessionState(state, event('reasoning.final', { turnId: 't', responseId: 'r', posture: 'question', text: 'Final answer' }));
    const item = state.conversationItems.find(candidate => candidate.kind === 'assistant' && candidate.responseId === 'r');
    // Upsert preserves the already-known playbackId and playing status.
    expect(item).toMatchObject({ text: 'Final answer', playbackId: 'p', playback: 'playing' });
    expect(state.assistantText).toBe('Final answer');
    // A response already speaking must not regress to the forming state.
    expect(state.dominant).toBe('speaking');
  });

  it('removes an empty placeholder and marks a partial response interrupted on failure', () => {
    let state = reduceSessionState(initialSessionState, event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }));
    state = reduceSessionState(state, event('response.failed', { turnId: 't', responseId: 'r', reasonCode: 'tts_failed' }));
    expect(state.conversationItems.filter(item => item.kind === 'assistant')).toEqual([]);

    let partial = reduceSessionState(initialSessionState, event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }));
    partial = reduceSessionState(partial, event('reasoning.final', { turnId: 't', responseId: 'r', posture: 'riff', text: 'Heard part of this' }));
    partial = reduceSessionState(partial, event('response.failed', { turnId: 't', responseId: 'r', reasonCode: 'reasoning_invalid' }));
    expect(partial.conversationItems).toContainEqual(expect.objectContaining({ responseId: 'r', text: 'Heard part of this', playback: 'interrupted' }));
  });
});
