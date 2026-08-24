import { describe, expect, it } from 'vitest';
import { canSafelyResume, initialSessionState, reduceSessionState } from './state';
import type { StableEvent } from '../storage/stable-turn-writer';

let sequence = 0;
const event = <T extends StableEvent['type']>(type: T, payload: Record<string, unknown> = {}, epoch = 0): StableEvent =>
  ({
    protocolVersion: 1,
    eventId: `e-${++sequence}`,
    sessionId: 's',
    epoch,
    monotonicMs: sequence,
    type,
    payload,
  }) as StableEvent;

describe('session presentation state', () => {
  it('tracks factual planning attempt/stage state and preserves notes into pre-live', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('session.state', {
        phase: 'preparing',
        planning: {
          status: 'planning',
          attempt: 1,
          stage: 'researching',
          deadlineMs: 60_000,
          topic: 'radio',
          depth: 'light',
          detail: 'Researching',
        },
      }),
    );
    expect(state.dominant).toBe('planning');
    expect(state.planning).toMatchObject({
      status: 'planning',
      attempt: 1,
      stage: 'researching',
      deadlineMs: 60_000,
      topic: 'radio',
      depth: 'light',
    });
    state = reduceSessionState(
      state,
      event('session.state', {
        phase: 'prelive',
        planning: {
          status: 'ready',
          attempt: 1,
          topic: 'radio',
          depth: 'light',
          notes: 'Talking points',
        },
      }),
    );
    expect(state.dominant).toBe('ready');
    expect(state.planning.notes).toBe('Talking points');
    state = reduceSessionState(state, event('session.state', { phase: 'listening' }));
    expect(state.dominant).toBe('listening');
    expect(state.planning).toMatchObject({ status: 'ready', notes: 'Talking points', attempt: 1 });
  });

  it('maps terminal failure reason codes and starting_live transitions onto the view', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('session.state', {
        phase: 'prelive',
        planning: { status: 'failed', attempt: 2, reasonCode: 'timeout', depth: 'standard' },
      }),
    );
    expect(state.dominant).toBe('ready');
    expect(state.planning).toMatchObject({ status: 'failed', attempt: 2, reasonCode: 'timeout' });
    state = reduceSessionState(state, event('session.state', { phase: 'starting_live' }));
    expect(state.dominant).toBe('ready');
    state = reduceSessionState(state, event('session.state', { phase: 'listening' }));
    expect(state.dominant).toBe('listening');
  });

  it('keeps partials tentative and out of announcements', () => {
    const listening = reduceSessionState(initialSessionState, event('session.state', { phase: 'listening' }));
    const partial = reduceSessionState(listening, event('transcript.partial', { text: 'revising words' }));
    expect(partial.dominant).toBe('listening');
    expect(partial.tentativeText).toBe('revising words');
    expect(partial.announcement).toBe('Listening');
  });

  it('surfaces audio warmup progress and clears the degraded copy when healthy', () => {
    let state = reduceSessionState(initialSessionState, event('failure', { detail: 'Audio engine is retrying.' }));
    state = reduceSessionState(
      state,
      event('session.state', {
        phase: 'idle',
        audio: { status: 'warming', capture: 'starting', vad: 'warming', tts: 'ready', detail: 'Loading VAD.' },
      }),
    );
    expect(state.audioEngine).toMatchObject({ status: 'warming', capture: 'starting', vad: 'warming', tts: 'ready' });
    expect(state.dominant).toBe('degraded');
    state = reduceSessionState(
      state,
      event('session.state', {
        phase: 'idle',
        audio: { status: 'ready', capture: 'ready', vad: 'ready', tts: 'ready' },
      }),
    );
    expect(state.audioEngine.status).toBe('ready');
    expect(state.degradedMessage).toBe('');
  });

  it('shows intentional silence distinctly and ignores stale UI events', () => {
    let state = reduceSessionState(initialSessionState, event('transcript.final', { turnId: 't', text: 'hello' }, 2));
    state = reduceSessionState(state, event('policy.decision', { turnId: 't', posture: 'silence' }, 2));
    expect(state.dominant).toBe('intentional_silence');
    expect(reduceSessionState(state, event('session.state', { phase: 'reasoning' }, 1))).toBe(state);
  });

  it('accumulates multi-part responses into one assistant row with per-part tentative transitions', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff', partIndex: 0 }),
    );
    state = reduceSessionState(
      state,
      event('reasoning.delta', { turnId: 't', responseId: 'r', partIndex: 0, text: 'Let me look that up.' }),
    );
    state = reduceSessionState(
      state,
      event('reasoning.final', {
        turnId: 't',
        responseId: 'r',
        posture: 'riff',
        partIndex: 0,
        text: 'Let me look that up.',
      }),
    );
    state = reduceSessionState(
      state,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff', partIndex: 1 }),
    );
    state = reduceSessionState(
      state,
      event('reasoning.delta', {
        turnId: 't',
        responseId: 'r',
        partIndex: 1,
        text: 'Paris is the capital. It sits on the Seine.',
      }),
    );
    const item = state.conversationItems.find(
      (candidate) => candidate.kind === 'assistant' && candidate.responseId === 'r',
    );
    expect(item).toMatchObject({
      kind: 'assistant',
      text: 'Let me look that up.\n\nParis is the capital. It sits on the Seine.',
    });
    if (item?.kind === 'assistant') {
      expect(item.parts).toEqual([
        { partIndex: 0, text: 'Let me look that up.', tentative: false },
        { partIndex: 1, text: 'Paris is the capital. It sits on the Seine.', tentative: true },
      ]);
    }
    state = reduceSessionState(
      state,
      event('reasoning.final', {
        turnId: 't',
        responseId: 'r',
        posture: 'riff',
        partIndex: 1,
        text: 'Paris is the capital. It sits on the Seine.',
      }),
    );
    const finalized = state.conversationItems.find(
      (candidate) => candidate.kind === 'assistant' && candidate.responseId === 'r',
    );
    expect(finalized).toMatchObject({
      text: 'Let me look that up.\n\nParis is the capital. It sits on the Seine.',
      tentative: false,
    });
  });

  it('requires every conservative safe-resume guard', () => {
    const all = {
      hostResumable: true,
      responseMatches: true,
      playbackMatches: true,
      epochMatches: true,
      wasSpeaking: true,
      playbackTerminal: false,
      echoRecovered: true,
      newerStableTurn: false,
      stopped: false,
      confirmed: false,
    };
    expect(canSafelyResume(all)).toBe(true);
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      const unsafe = { ...all, [key]: typeof all[key] === 'boolean' ? !all[key] : all[key] };
      expect(canSafelyResume(unsafe)).toBe(false);
    }
  });

  it('holds a hidden placeholder until final text and never renders an empty bubble', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'question' }),
    );
    expect(state.conversationItems).toEqual([
      {
        kind: 'assistant',
        id: 'assistant:r',
        responseId: 'r',
        text: '',
        playback: 'preparing',
        sequence: state.conversationItems[0]!.sequence,
      },
    ]);
    state = reduceSessionState(state, event('tts.started', { responseId: 'r', playbackId: 'p', sampleRate: 24000 }));
    expect(state.dominant).toBe('speaking');
    expect(state.conversationItems).toContainEqual(
      expect.objectContaining({ responseId: 'r', playbackId: 'p', playback: 'playing', text: '' }),
    );
    state = reduceSessionState(
      state,
      event('reasoning.final', { turnId: 't', responseId: 'r', posture: 'question', text: 'Final answer' }),
    );
    const item = state.conversationItems.find(
      (candidate) => candidate.kind === 'assistant' && candidate.responseId === 'r',
    );
    // Upsert preserves the already-known playbackId and playing status.
    expect(item).toMatchObject({ text: 'Final answer', playbackId: 'p', playback: 'playing' });
    expect(state.assistantText).toBe('Final answer');
    // A response already speaking must not regress to the forming state.
    expect(state.dominant).toBe('speaking');
  });

  it('clears the speaking marker from playback termination and ignores stale terminals', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }),
    );
    state = reduceSessionState(state, event('tts.started', { responseId: 'r', playbackId: 'p1', sampleRate: 24000 }));
    expect(state.dominant).toBe('speaking');
    state = reduceSessionState(state, event('tts.started', { responseId: 'r', playbackId: 'p2', sampleRate: 24000 }));
    state = reduceSessionState(
      state,
      event('playback.stopped', {
        playbackId: 'p1',
        cancelledEpoch: 0,
        finalPlayedSampleOffset: 10,
        reason: 'completed',
      }),
    );
    expect(state.dominant).toBe('speaking');
    state = reduceSessionState(
      state,
      event('playback.stopped', {
        playbackId: 'p2',
        cancelledEpoch: 0,
        finalPlayedSampleOffset: 10,
        reason: 'completed',
      }),
    );
    expect(state.dominant).toBe('listening');
    expect(state.conversationItems).toContainEqual(
      expect.objectContaining({ playbackId: 'p2', playback: 'completed' }),
    );

    let untracked = reduceSessionState(
      initialSessionState,
      event('tts.started', { responseId: 'untracked-response', playbackId: 'untracked-playback', sampleRate: 24000 }),
    );
    untracked = reduceSessionState(
      untracked,
      event('playback.stopped', {
        playbackId: 'untracked-playback',
        cancelledEpoch: 0,
        finalPlayedSampleOffset: 0,
        reason: 'cancelled',
      }),
    );
    expect(untracked.dominant).toBe('listening');

    let failed = reduceSessionState(
      initialSessionState,
      event('tts.started', { responseId: 'failed-response', playbackId: 'failed-playback', sampleRate: 24000 }),
    );
    failed = reduceSessionState(
      failed,
      event('response.failed', { responseId: 'failed-response', turnId: 'turn', reasonCode: 'tts_failed' }),
    );
    expect(failed.dominant).toBe('listening');
  });

  it('removes an empty placeholder and marks a partial response interrupted on failure', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }),
    );
    state = reduceSessionState(
      state,
      event('response.failed', { turnId: 't', responseId: 'r', reasonCode: 'tts_failed' }),
    );
    expect(state.conversationItems.filter((item) => item.kind === 'assistant')).toEqual([]);

    let partial = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }),
    );
    partial = reduceSessionState(
      partial,
      event('reasoning.final', { turnId: 't', responseId: 'r', posture: 'riff', text: 'Heard part of this' }),
    );
    partial = reduceSessionState(
      partial,
      event('response.failed', { turnId: 't', responseId: 'r', reasonCode: 'reasoning_invalid' }),
    );
    expect(partial.conversationItems).toContainEqual(
      expect.objectContaining({ responseId: 'r', text: 'Heard part of this', playback: 'interrupted' }),
    );
  });

  it('accumulates reasoning.delta into a tentative row and materializes it on final', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }),
    );
    state = reduceSessionState(state, event('reasoning.delta', { turnId: 't', responseId: 'r', text: 'A short' }));
    let item = state.conversationItems.find(
      (candidate) => candidate.kind === 'assistant' && candidate.responseId === 'r',
    );
    expect(item).toMatchObject({ text: 'A short', tentative: true });
    state = reduceSessionState(
      state,
      event('reasoning.delta', { turnId: 't', responseId: 'r', text: 'A short reply grows' }),
    );
    item = state.conversationItems.find((candidate) => candidate.kind === 'assistant' && candidate.responseId === 'r');
    expect(item).toMatchObject({ text: 'A short reply grows', tentative: true });
    state = reduceSessionState(
      state,
      event('reasoning.final', {
        turnId: 't',
        responseId: 'r',
        posture: 'riff',
        text: 'A short reply grows complete.',
      }),
    );
    item = state.conversationItems.find((candidate) => candidate.kind === 'assistant' && candidate.responseId === 'r');
    expect(item).toMatchObject({ text: 'A short reply grows complete.', tentative: false });
    expect(state.assistantText).toBe('A short reply grows complete.');
  });

  it('drops a tentative-only assistant row when the response fails', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }),
    );
    state = reduceSessionState(
      state,
      event('reasoning.delta', { turnId: 't', responseId: 'r', text: 'A preview that never lands' }),
    );
    expect(state.conversationItems.filter((item) => item.kind === 'assistant')).toHaveLength(1);
    state = reduceSessionState(
      state,
      event('response.failed', { turnId: 't', responseId: 'r', reasonCode: 'reasoning_invalid' }),
    );
    expect(state.conversationItems.filter((item) => item.kind === 'assistant')).toEqual([]);
  });

  it('clears the tentative assistant row when the epoch advances', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }),
    );
    state = reduceSessionState(
      state,
      event('reasoning.delta', { turnId: 't', responseId: 'r', text: 'A preview mid-flight' }),
    );
    expect(state.conversationItems.filter((item) => item.kind === 'assistant' && item.tentative)).toHaveLength(1);
    state = reduceSessionState(state, event('session.state', { phase: 'listening' }, 1));
    expect(state.epoch).toBe(1);
    expect(state.conversationItems.filter((item) => item.kind === 'assistant' && item.tentative)).toEqual([]);
  });

  it('keeps a finalized assistant row across an epoch advance', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('reasoning.started', { turnId: 't', responseId: 'r', posture: 'riff' }),
    );
    state = reduceSessionState(
      state,
      event('reasoning.final', { turnId: 't', responseId: 'r', posture: 'riff', text: 'A complete answer' }),
    );
    state = reduceSessionState(state, event('session.state', { phase: 'listening' }, 1));
    expect(state.conversationItems).toContainEqual(
      expect.objectContaining({ responseId: 'r', text: 'A complete answer', tentative: false }),
    );
  });

  it('resumes the same assistant item in place without transcript notices', () => {
    let state = reduceSessionState(
      initialSessionState,
      event('transcript.final', { turnId: 'original', text: 'Tell me more' }),
    );
    state = reduceSessionState(state, event('reasoning.started', { turnId: 'original', responseId: 'r' }));
    state = reduceSessionState(
      state,
      event('reasoning.final', { turnId: 'original', responseId: 'r', text: 'One complete answer' }),
    );
    state = reduceSessionState(state, event('tts.started', { responseId: 'r', playbackId: 'p' }));
    for (let index = 0; index < 10; index += 1) {
      const turnId = `control-${index}`;
      state = reduceSessionState(state, event('transcript.final', { turnId, text: 'keep going' }));
      state = reduceSessionState(state, event('barge_in.provisional', { responseId: 'r' }));
      state = reduceSessionState(state, event('interruption.decision', { action: 'resume', responseId: 'r', turnId }));
    }
    expect(state.conversationItems.filter((item) => item.kind === 'assistant' && item.responseId === 'r')).toEqual([
      expect.objectContaining({ text: 'One complete answer', playback: 'playing' }),
    ]);
    expect(state.conversationItems).not.toContainEqual(expect.objectContaining({ kind: 'notice' }));
    expect(state.conversationItems.filter((item) => item.kind === 'user' && item.status === 'control')).toHaveLength(
      10,
    );
    expect(state.playbackNotice).toBe('');
    expect(state.announcement).toBe('Continuing the response');
  });

  describe('agent tool activity visibility', () => {
    const started = (over: Record<string, unknown> = {}, epoch = 0) =>
      event(
        'tool.activity',
        {
          scope: 'turn',
          turnId: 't',
          responseId: 'r',
          toolCallId: 'c1',
          toolName: 'web_search',
          status: 'started',
          ...over,
        },
        epoch,
      );

    it('merges started and ended observations into one concise planning entry', () => {
      let state = reduceSessionState(
        initialSessionState,
        event('tool.activity', {
          scope: 'planning',
          toolCallId: 'c9',
          toolName: 'web_search',
          status: 'started',
          summary: 'future of local radio',
        }),
      );
      expect(state.agentActivity).toEqual([
        {
          key: 'planning',
          scope: 'planning',
          epoch: 0,
          entries: [{ toolCallId: 'c9', toolName: 'web_search', status: 'running', summary: 'future of local radio' }],
        },
      ]);
      state = reduceSessionState(
        state,
        event('tool.activity', {
          scope: 'planning',
          toolCallId: 'c9',
          toolName: 'web_search',
          status: 'ended',
          durationMs: 1420,
        }),
      );
      expect(state.agentActivity).toHaveLength(1);
      expect(state.agentActivity[0]!.entries).toEqual([
        {
          toolCallId: 'c9',
          toolName: 'web_search',
          status: 'done',
          summary: 'future of local radio',
          durationMs: 1420,
        },
      ]);
    });

    it('groups turn activity by response and keeps failed calls distinct', () => {
      let state = reduceSessionState(initialSessionState, started());
      state = reduceSessionState(
        state,
        started({ toolCallId: 'c2', toolName: 'webfetch', status: 'failed', durationMs: 7 }),
      );
      state = reduceSessionState(state, started({ responseId: 'other', turnId: 't2', toolCallId: 'c3' }));
      expect(state.agentActivity.map((group) => group.key)).toEqual(['turn:r', 'turn:other']);
      expect(state.agentActivity[0]!.entries.map((entry) => entry.status)).toEqual(['running', 'failed']);
      expect(state.agentActivity[1]!.turnId).toBe('t2');
    });

    it('marks still-running calls interrupted when the epoch advances', () => {
      let state = reduceSessionState(initialSessionState, started({}, 3));
      state = reduceSessionState(state, event('transcript.final', { turnId: 'next', text: 'stop' }, 4));
      expect(state.agentActivity[0]!.entries).toEqual([
        { toolCallId: 'c1', toolName: 'web_search', status: 'interrupted' },
      ]);
      // Late end events from the abandoned epoch are dropped, not resurrected.
      state = reduceSessionState(state, started({ status: 'ended', durationMs: 99 }, 3));
      expect(state.agentActivity[0]!.entries[0]!.status).toBe('interrupted');
    });

    it('keeps terminal observations without a matching start and bounds group size', () => {
      let state = reduceSessionState(initialSessionState, started({ status: 'ended', durationMs: 12 }));
      expect(state.agentActivity[0]!.entries).toEqual([
        { toolCallId: 'c1', toolName: 'web_search', status: 'done', durationMs: 12 },
      ]);
      for (let index = 0; index < 40; index += 1)
        state = reduceSessionState(state, started({ toolCallId: `bulk-${index}` }));
      expect(state.agentActivity[0]!.entries).toHaveLength(24);
      expect(state.agentActivity[0]!.entries.at(-1)!.toolCallId).toBe('bulk-39');
    });

    it('ignores malformed activity payloads', () => {
      const missingResponse = reduceSessionState(
        initialSessionState,
        event('tool.activity', { scope: 'turn', toolCallId: 'c1', toolName: 'web_search', status: 'started' }),
      );
      expect(missingResponse.agentActivity).toEqual([]);
      const emptyCallId = reduceSessionState(
        initialSessionState,
        event('tool.activity', { scope: 'planning', toolCallId: '', toolName: 'web_search', status: 'started' }),
      );
      expect(emptyCallId.agentActivity).toEqual([]);
    });
  });
});
