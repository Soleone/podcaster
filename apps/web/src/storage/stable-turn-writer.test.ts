import { IDBObjectStore, indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StableTurnWriter, type StableEvent } from './stable-turn-writer';

const databases: string[] = [];
let sequence = 0;
const open = async () => { const name = `podcaster-test-${++sequence}`; databases.push(name); return { name, writer: await StableTurnWriter.open(indexedDB, name) }; };
const event = (sessionId: string, type: string, payload: Record<string, unknown>, epoch = 0): StableEvent => ({ eventId: `event-${++sequence}`, sessionId, epoch, monotonicMs: Date.now(), type, payload });
afterEach(async () => { vi.restoreAllMocks(); for (const name of databases.splice(0)) await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); }); });

describe('StableTurnWriter', () => {
  it('recovers the same active session seed after refresh', async () => {
    const { name, writer } = await open();
    await writer.beginSession({ sessionId: 'session', sessionSeed: 'seed-1', personaDigest: 'digest' }); writer.close();
    const reopened = await StableTurnWriter.open(indexedDB, name);
    expect(await reopened.recoverActiveSession()).toMatchObject({ sessionId: 'session', sessionSeed: 'seed-1', state: 'active' });
    reopened.close();
  });

  it('never persists partials and idempotently merges silence policy before stable final', async () => {
    const { writer } = await open(); await writer.beginSession({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'digest' });
    await writer.apply(event('s', 'transcript.partial', { turnId: 't', text: 'not stable' }));
    expect(await writer.getTurns('s')).toEqual([]);
    const policy = event('s', 'policy.decision', { turnId: 't', posture: 'silence', eligible: true });
    await writer.apply(policy); await writer.apply(policy);
    await writer.apply(event('s', 'transcript.final', { turnId: 't', text: 'stable', endpointComplete: true }));
    expect(await writer.getTurns('s')).toMatchObject([{ stableText: 'stable', posture: 'silence', eligible: true }]);
    writer.close();
  });

  it('keeps generated text separate and resolves reordered delivery with first-terminal wins', async () => {
    const { writer } = await open(); await writer.beginSession({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'digest' });
    await writer.apply(event('s', 'transcript.final', { turnId: 't', text: 'hello' }));
    await writer.apply(event('s', 'reasoning.final', { turnId: 't', responseId: 'r', posture: 'question', text: 'response text' }));
    await writer.apply(event('s', 'playback.progress', { playbackId: 'p', outputEpoch: 0, playedSampleOffset: 900, generatedSamples: 1000 }));
    await writer.apply(event('s', 'playback.stopped', { playbackId: 'p', cancelledEpoch: 0, finalPlayedSampleOffset: 700, reason: 'cancelled' }));
    await writer.apply(event('s', 'tts.started', { responseId: 'r', playbackId: 'p', sampleRate: 24000 }));
    await writer.apply(event('s', 'tts.ended', { responseId: 'r', playbackId: 'p', generatedSamples: 800 }));
    await writer.apply(event('s', 'playback.stopped', { playbackId: 'p', cancelledEpoch: 0, finalPlayedSampleOffset: 800, reason: 'completed' }));
    const [turn] = await writer.getTurns('s');
    expect(turn).toMatchObject({ assistantText: 'response text', generatedSamples: 800, deliveredSampleOffset: 700, terminalReason: 'cancelled', interrupted: true });
    writer.close();
  });

  it('does not mark a rejected provisional interruption as delivered history', async () => {
    const { writer } = await open(); await writer.beginSession({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'digest' });
    await writer.apply(event('s', 'transcript.final', { turnId: 't', text: 'hello' }));
    await writer.apply(event('s', 'reasoning.final', { turnId: 't', responseId: 'r', posture: 'question', text: 'answer' }));
    await writer.apply(event('s', 'tts.started', { responseId: 'r', playbackId: 'p', sampleRate: 24000 }));
    await writer.apply(event('s', 'barge_in.provisional', { responseId: 'r', outputEpoch: 0, resumable: true }));
    await writer.apply(event('s', 'barge_in.rejected', { responseId: 'r', outputEpoch: 0, resumable: true }));
    expect(await writer.getTurns('s')).toMatchObject([{ turnId: 't', interrupted: false }]);
    await writer.apply(event('s', 'barge_in.confirmed', { responseId: 'r', outputEpoch: 0, resumable: false }));
    expect(await writer.getTurns('s')).toMatchObject([{ turnId: 't', interrupted: true }]);
    writer.close();
  });

  it('persists pause identity and a control-only resume without interrupting the original response', async () => {
    const { writer } = await open(); await writer.beginSession({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'digest' });
    await writer.apply(event('s', 'transcript.final', { turnId: 'original', text: 'question' }));
    await writer.apply(event('s', 'reasoning.final', { turnId: 'original', responseId: 'r', posture: 'question', text: 'answer' }));
    await writer.apply(event('s', 'tts.started', { responseId: 'r', playbackId: 'p', sampleRate: 24000 }));
    await writer.apply(event('s', 'playback.paused', { responseId: 'r', playbackId: 'p', outputEpoch: 0, pausedSampleOffset: 240, generatedSamples: 1000 }));
    await writer.apply(event('s', 'transcript.final', { turnId: 'control', text: 'would you carry on' }));
    await writer.apply(event('s', 'interruption.decision', { turnId: 'control', responseId: 'r', playbackId: 'p', outputEpoch: 0, action: 'resume', intent: 'continue_previous', confidence: 'high', disposition: 'resume_requested', pausedSampleOffset: 240 }));
    const turns = (await writer.getTurns('s')).sort((a, b) => a.turnId.localeCompare(b.turnId));
    expect(turns).toMatchObject([
      { turnId: 'control', controlOnly: true, interruptionDisposition: 'resume_requested', interruptedResponseId: 'r' },
      { turnId: 'original', pausedSampleOffset: 240, continuationState: 'resumed', interrupted: false },
    ]);
    writer.close();
  });

  it('keeps first terminal extent authoritative over progress arriving afterward', async () => {
    const { writer } = await open(); await writer.beginSession({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'digest' });
    await writer.apply(event('s', 'transcript.final', { turnId: 't', text: 'hello' }));
    await writer.apply(event('s', 'reasoning.final', { turnId: 't', responseId: 'r', posture: 'question', text: 'answer' }));
    await writer.apply(event('s', 'tts.started', { responseId: 'r', playbackId: 'p', sampleRate: 24000 }));
    await writer.apply(event('s', 'tts.ended', { responseId: 'r', playbackId: 'p', generatedSamples: 1000 }));
    await writer.apply(event('s', 'playback.stopped', { playbackId: 'p', cancelledEpoch: 0, finalPlayedSampleOffset: 350, reason: 'cancelled' }));
    await writer.apply(event('s', 'playback.progress', { playbackId: 'p', outputEpoch: 0, playedSampleOffset: 900, generatedSamples: 1000 }));
    expect(await writer.getTurns('s')).toMatchObject([{ deliveredSampleOffset: 350, terminalReason: 'cancelled' }]);
    writer.close();
  });

  it('isolates reused playback IDs by session and epoch', async () => {
    const { writer } = await open();
    await writer.beginSession({ sessionId: 's1', sessionSeed: 'seed-1', personaDigest: 'digest' });
    await writer.beginSession({ sessionId: 's2', sessionSeed: 'seed-2', personaDigest: 'digest' });
    for (const [sessionId, turnId, responseId] of [['s1', 't1', 'r1'], ['s2', 't2', 'r2']] as const) {
      await writer.apply(event(sessionId, 'transcript.final', { turnId, text: 'hello' }));
      await writer.apply(event(sessionId, 'reasoning.final', { turnId, responseId, posture: 'question', text: 'answer' }));
      await writer.apply(event(sessionId, 'tts.started', { responseId, playbackId: 'shared', sampleRate: 24000 }));
      await writer.apply(event(sessionId, 'tts.ended', { responseId, playbackId: 'shared', generatedSamples: 1000 }));
    }
    await writer.apply(event('s1', 'transcript.final', { turnId: 't3', text: 'later' }, 1));
    await writer.apply(event('s1', 'reasoning.final', { turnId: 't3', responseId: 'r3', posture: 'question', text: 'later answer' }, 1));
    await writer.apply(event('s1', 'tts.started', { responseId: 'r3', playbackId: 'shared', sampleRate: 24000 }, 1));
    await writer.apply(event('s1', 'tts.ended', { responseId: 'r3', playbackId: 'shared', generatedSamples: 1000 }, 1));
    await writer.apply(event('s1', 'playback.stopped', { playbackId: 'shared', cancelledEpoch: 0, finalPlayedSampleOffset: 200, reason: 'cancelled' }));
    await writer.apply(event('s2', 'playback.stopped', { playbackId: 'shared', cancelledEpoch: 0, finalPlayedSampleOffset: 800, reason: 'completed' }));
    await writer.apply(event('s1', 'playback.stopped', { playbackId: 'shared', cancelledEpoch: 1, finalPlayedSampleOffset: 600, reason: 'completed' }, 1));
    expect((await writer.getTurns('s1')).sort((a, b) => a.turnId.localeCompare(b.turnId))).toMatchObject([
      { turnId: 't1', deliveredSampleOffset: 200, terminalReason: 'cancelled' },
      { turnId: 't3', deliveredSampleOffset: 600, terminalReason: 'completed' },
    ]);
    expect(await writer.getTurns('s2')).toMatchObject([{ deliveredSampleOffset: 800, terminalReason: 'completed' }]);
    writer.close();
  });

  it('reports quota degradation without changing an earlier stable turn', async () => {
    const { writer } = await open(); await writer.beginSession({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'digest' });
    await writer.apply(event('s', 'transcript.final', { turnId: 'kept', text: 'preserved' }));
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const result = await writer.apply(event('s', 'transcript.final', { turnId: 'lost', text: 'not committed' }));
    expect(result).toMatchObject({ ok: false, degradedReason: expect.stringContaining('Earlier stable turns are preserved') });
    expect(await writer.getTurns('s')).toMatchObject([{ turnId: 'kept', stableText: 'preserved' }]);
    writer.close();
  });
});
