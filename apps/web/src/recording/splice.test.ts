import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingStore, type RecordingRole, type StoredRecordingItem } from '../storage/recording-store';
import type { StoredTurn } from '../storage/schema';
import type { StableTurnWriter } from '../storage/stable-turn-writer';
import type { EncodeMp3 } from './encode';
import { buildRecording, EXPORT_GAP_MS, FINAL_KBPS, FINAL_SAMPLE_RATE, type SpliceDependencies } from './splice';

let dbName = '';
afterEach(async () => {
  if (dbName) {
    await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(dbName); request.onsuccess = request.onerror = request.onblocked = () => resolve(); });
    dbName = '';
  }
});

const SESSION = '018f1f32-7abc-7def-8abc-0123456789ab';

function item(partial: Partial<StoredRecordingItem> & { itemId: string; role: RecordingRole; recordSeq: number; sampleRate: 16000 | 24000 }): StoredRecordingItem {
  return {
    sessionId: SESSION, turnId: null, responseId: null, playbackId: null, outputEpoch: null, sampleCount: 0,
    interrupted: false, deliveredSamples: null, terminalReason: null, captureStartSequence: null, captureEndSequence: null,
    truncated: false, durationMs: 0, createdAt: '2026-01-01T00:00:00Z', monotonicMs: 0, data: new Blob([], { type: 'audio/mpeg' }),
    ...partial,
  };
}
function turn(turnId: string, timelineSequence: number): StoredTurn {
  return { key: `${SESSION}:${turnId}`, sessionId: SESSION, turnId, stableText: null, posture: null, eligible: null, policyReason: null, responseId: null, assistantText: null, playbackId: null, outputEpoch: null, sampleRate: null, generatedSamples: 0, deliveredSampleOffset: 0, pendingDeliveredOffset: 0, terminalReason: null, interrupted: false, pausedSampleOffset: null, interruptionDisposition: null, interruptionIntent: null, interruptedResponseId: null, controlOnly: false, continuationState: 'none', timelineSequence, failures: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}
function tone(rate: number): Float32Array {
  const data = new Float32Array(rate);
  for (let index = 0; index < data.length; index++) data[index] = 0.1 * Math.sin((2 * Math.PI * 220 * index) / rate);
  return data;
}

async function deps(decoded: Array<{ sampleRate: number; channelData: Float32Array }>, storedTurns: StoredTurn[]) {
  dbName = `splice-${Date.now()}-${Math.random()}`;
  const store = await RecordingStore.open(indexedDB, dbName);
  const decode = vi.fn(async () => decoded.shift()!);
  const resample = vi.fn((data: Float32Array, fromRate: number, toRate: number) => {
    const out = new Float32Array(Math.round(data.length * toRate / fromRate));
    out.fill(0.5);
    return out;
  });
  const encode = vi.fn<EncodeMp3>(async pcm => new Uint8Array(Math.max(1, Math.ceil(pcm.length / 4))));
  const turns = { getTurns: async () => storedTurns } as Pick<StableTurnWriter, 'getTurns'>;
  return { store, decode, resample, encode, turns };
}

describe('buildRecording', () => {
  it('orders items by turn timeline (user before agent), trims interrupted agents at deliveredSamples, and inserts the gap', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const T2 = '018f1f32-7abe-7def-8abc-0123456789ab';
    const store = (await deps([], [turn(T1, 1), turn(T2, 2)])).store;
    const { decode, resample, encode, turns } = await deps([
      { sampleRate: 16000, channelData: tone(1600) },   // user T1
      { sampleRate: 24000, channelData: tone(2400) },   // agent T1, delivered 100 -> trim
      { sampleRate: 16000, channelData: tone(800) },    // user T2
      { sampleRate: 24000, channelData: tone(1200) },   // agent T2, delivered 5000 -> clamped
    ], [turn(T1, 1), turn(T2, 2)]);
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    await store.put(item({ itemId: 'b', role: 'agent', recordSeq: 1, sampleRate: 24000, turnId: T1, interrupted: true, deliveredSamples: 100, terminalReason: 'cancelled' }));
    await store.put(item({ itemId: 'c', role: 'agent', recordSeq: 2, sampleRate: 24000, turnId: T2, interrupted: true, deliveredSamples: 5000, terminalReason: 'cancelled' }));
    await store.put(item({ itemId: 'd', role: 'user', recordSeq: 3, sampleRate: 16000, turnId: T2 }));

    const blob = await buildRecording(SESSION, { store, turns, decode, resample, encode });
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('audio/mpeg');
    // User before agent within each turn; T1 before T2 regardless of recordSeq.
    expect(decode).toHaveBeenCalledTimes(4);
    // The interrupted agent items were trimmed before resampling.
    expect(resample.mock.calls[1]![0].length).toBe(100);
    expect(resample.mock.calls[3]![0].length).toBe(1200);
    expect(resample.mock.calls.map(call => [call[1], call[2]])).toEqual([
      [16000, FINAL_SAMPLE_RATE], [24000, FINAL_SAMPLE_RATE], [16000, FINAL_SAMPLE_RATE], [24000, FINAL_SAMPLE_RATE],
    ]);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0]![1]).toBe(FINAL_SAMPLE_RATE);
    expect(encode.mock.calls[0]![2]).toBe(FINAL_KBPS);
    const segments = [Math.round(1600 * FINAL_SAMPLE_RATE / 16000), Math.round(100 * FINAL_SAMPLE_RATE / 24000), Math.round(800 * FINAL_SAMPLE_RATE / 16000), Math.round(1200 * FINAL_SAMPLE_RATE / 24000)];
    const gap = Math.round(FINAL_SAMPLE_RATE * EXPORT_GAP_MS / 1000);
    expect(encode.mock.calls[0]![0].length).toBe(segments.reduce((sum, length) => sum + length, 0) + gap * 3);
    store.close();
  });

  it('returns null for an empty recording and never encodes', async () => {
    const { store, decode, resample, encode, turns } = await deps([], []);
    const blob = await buildRecording(SESSION, { store, turns, decode, resample, encode });
    expect(blob).toBeNull();
    expect(encode).not.toHaveBeenCalled();
    store.close();
  });

  it('skips turns that never produced an agent item (tts_failed) and orders turnless items by recordSeq last', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const T2 = '018f1f32-7abe-7def-8abc-0123456789ab';
    const store = (await deps([], [turn(T1, 1), turn(T2, 2)])).store;
    const { decode, resample, encode, turns } = await deps([
      { sampleRate: 16000, channelData: tone(1600) },   // user T1
      { sampleRate: 16000, channelData: tone(800) },    // user T2
      { sampleRate: 16000, channelData: tone(400) },    // turnless fallback item
    ], [turn(T1, 1), turn(T2, 2)]);
    await store.put(item({ itemId: 'u1', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    // T2's agent item is absent: the response failed and was never recorded.
    await store.put(item({ itemId: 'u2', role: 'user', recordSeq: 1, sampleRate: 16000, turnId: T2 }));
    await store.put(item({ itemId: 'x', role: 'user', recordSeq: 9, sampleRate: 16000, turnId: null }));

    await buildRecording(SESSION, { store, turns, decode, resample, encode });
    expect(decode).toHaveBeenCalledTimes(3);
    // Turnless item goes last, so the third decode belongs to it.
    expect(resample.mock.calls[2]![0].length).toBe(400);
    store.close();
  });

  it('honors a custom gap and resamples each item', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const store = (await deps([], [turn(T1, 1)])).store;
    const { decode, resample, encode, turns } = await deps([
      { sampleRate: 16000, channelData: tone(1600) },
      { sampleRate: 16000, channelData: tone(800) },
    ], [turn(T1, 1)]);
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    await store.put(item({ itemId: 'b', role: 'user', recordSeq: 1, sampleRate: 16000, turnId: T1 }));
    await buildRecording(SESSION, { store, turns, decode, resample, encode, gapMs: 150 });
    const gap = Math.round(FINAL_SAMPLE_RATE * 150 / 1000);
    expect(encode.mock.calls[0]![0].length).toBe(Math.round(1600 * FINAL_SAMPLE_RATE / 16000) + Math.round(800 * FINAL_SAMPLE_RATE / 16000) + gap);
    store.close();
  });
});
