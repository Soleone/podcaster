import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { StableTurnWriter } from '../storage/stable-turn-writer';
import { RecordingStore } from '../storage/recording-store';
import { loadSessionArchive, sessionDurationSeconds, sessionViewStateFromTurns } from './session-archive';

const databases: string[] = [];
let sequence = 0;
const openWriter = async () => {
  const name = `podcaster-archive-${++sequence}`;
  databases.push(name);
  return { name, writer: await StableTurnWriter.open(indexedDB, name) };
};
afterEach(async () => {
  for (const name of databases.splice(0)) await new Promise<void>(resolve => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

describe('session archive', () => {
  it('lists sessions with turn and recording counts, newest first', async () => {
    const { name, writer } = await openWriter();
    await writer.beginSession({ sessionId: 'older', sessionSeed: 's1', personaDigest: 'd', startedAt: '2026-01-01T00:00:00.000Z' });
    await writer.beginSession({ sessionId: 'newer', sessionSeed: 's2', personaDigest: 'd', startedAt: '2026-01-02T00:00:00.000Z' });
    await writer.apply({ eventId: 'e1', sessionId: 'older', epoch: 0, monotonicMs: 1, type: 'transcript.final', payload: { turnId: 't1', text: 'first', endpointComplete: true } });
    await writer.apply({ eventId: 'e2', sessionId: 'older', epoch: 0, monotonicMs: 2, type: 'transcript.final', payload: { turnId: 't2', text: 'second', endpointComplete: true } });
    await writer.apply({ eventId: 'e3', sessionId: 'newer', epoch: 0, monotonicMs: 3, type: 'transcript.final', payload: { turnId: 't3', text: 'third', endpointComplete: true } });
    const recordingStore = await RecordingStore.open(indexedDB, name);
    try {
      const summaries = await loadSessionArchive(writer, recordingStore);
      expect(summaries.map(summary => summary.session.sessionId)).toEqual(['newer', 'older']);
      expect(summaries).toMatchObject([
        { turnCount: 1, recordingItemCount: 0, recordingEnabled: true },
        { turnCount: 2, recordingItemCount: 0, recordingEnabled: true },
      ]);
    } finally {
      recordingStore.close();
    }
    writer.close();
  });

  it('rebuilds a stopped conversation with stored playback dispositions', async () => {
    const { writer } = await openWriter();
    await writer.beginSession({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'd' });
    await writer.apply({ eventId: 'e1', sessionId: 's', epoch: 0, monotonicMs: 1, type: 'transcript.final', payload: { turnId: 't1', text: 'a question', endpointComplete: true } });
    await writer.apply({ eventId: 'e2', sessionId: 's', epoch: 0, monotonicMs: 2, type: 'reasoning.final', payload: { turnId: 't1', responseId: 'r1', posture: 'question', text: 'an answer' } });
    await writer.apply({ eventId: 'e3', sessionId: 's', epoch: 0, monotonicMs: 3, type: 'tts.started', payload: { responseId: 'r1', playbackId: 'p1', sampleRate: 24000 } });
    await writer.apply({ eventId: 'e4', sessionId: 's', epoch: 0, monotonicMs: 4, type: 'playback.stopped', payload: { playbackId: 'p1', cancelledEpoch: 0, finalPlayedSampleOffset: 100, reason: 'completed' } });
    await writer.endSession('s');
    const view = await sessionViewStateFromTurns(writer, 's');
    expect(view.dominant).toBe('idle');
    expect(view.stableTurns.map(turn => turn.text)).toEqual(['a question']);
    const assistant = view.conversationItems.find(item => item.kind === 'assistant');
    expect(assistant).toMatchObject({ kind: 'assistant', text: 'an answer', playback: 'completed' });
    expect(view.conversationItems.find(item => item.kind === 'user')).toMatchObject({ kind: 'user', text: 'a question', status: 'stable' });
    writer.close();
  });

  it('computes duration from the stored start and end timestamps', () => {
    expect(sessionDurationSeconds({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'd', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:05:30.000Z', state: 'stopped', failures: [] })).toBe(330);
    expect(sessionDurationSeconds({ sessionId: 's', sessionSeed: 'seed', personaDigest: 'd', startedAt: new Date(Date.now() - 90_000).toISOString(), updatedAt: new Date().toISOString(), endedAt: null, state: 'active', failures: [] })).toBeGreaterThanOrEqual(89);
  });
});
