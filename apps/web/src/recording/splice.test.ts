import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingStore, type RecordingRole, type StoredRecordingItem } from '../storage/recording-store';
import type { StoredTurn } from '../storage/schema';
import type { StableTurnWriter } from '../storage/stable-turn-writer';
import type { EncodeMp3 } from './encode';
import { buildRecording, DECODE_END, DECODE_START, ENCODE_END, ENCODE_START, EXPORT_GAP_MS, FINAL_KBPS, FINAL_SAMPLE_RATE, MAX_NORMALIZATION_GAIN, PREPARING_END, READ_END, SILENCE_RMS_FLOOR, TARGET_RMS, type ExportProgress, type SpliceDependencies } from './splice';

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
    sessionId: SESSION, turnId: null, responseId: null, partIndex: null, playbackId: null, outputEpoch: null, sampleCount: 0,
    interrupted: false, deliveredSamples: null, terminalReason: null, captureStartSequence: null, captureEndSequence: null,
    truncated: false, durationMs: 0, createdAt: '2026-01-01T00:00:00Z', monotonicMs: 0, trimmed: false, data: new Blob([], { type: 'audio/mpeg' }),
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
function sine(amplitude: number, length: number): Float32Array {
  const data = new Float32Array(length);
  for (let index = 0; index < length; index++) data[index] = amplitude * Math.sin((2 * Math.PI * 220 * index) / length);
  return data;
}
const identityResample = (data: Float32Array) => data.slice();
function rmsPcm(pcm: Int16Array, start: number, length: number): number {
  let sum = 0;
  for (let index = start; index < start + length; index++) sum += pcm[index]! * pcm[index]!;
  return Math.sqrt(sum / length);
}

async function openStore(): Promise<RecordingStore> {
  dbName = `splice-${Date.now()}-${Math.random()}`;
  return RecordingStore.open(indexedDB, dbName);
}

async function deps(decoded: Array<{ sampleRate: number; channelData: Float32Array }>, storedTurns: StoredTurn[], options: { resample?: (data: Float32Array, fromRate: number, toRate: number) => Float32Array; store?: RecordingStore } = {}) {
  const store = options.store ?? (await openStore());
  const decode = vi.fn(async () => decoded.shift()!);
  const resample = vi.fn(options.resample ?? ((data: Float32Array, fromRate: number, toRate: number) => {
    const out = new Float32Array(Math.round(data.length * toRate / fromRate));
    out.fill(0.5);
    return out;
  }));
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

  it('excludes trimmed rows before decoding and inserts one gap per surviving segment', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const T2 = '018f1f32-7abe-7def-8abc-0123456789ab';
    const store = (await deps([], [turn(T1, 1), turn(T2, 2)])).store;
    const { decode, resample, encode, turns } = await deps([
      { sampleRate: 16000, channelData: tone(1600) },   // user T1 (survivor)
      { sampleRate: 16000, channelData: tone(800) },    // user T2 (survivor)
    ], [turn(T1, 1), turn(T2, 2)]);
    await store.put(item({ itemId: 'u1', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    await store.put(item({ itemId: 'a1', role: 'agent', recordSeq: 1, sampleRate: 24000, turnId: T1, trimmed: true }));
    await store.put(item({ itemId: 'u2', role: 'user', recordSeq: 2, sampleRate: 16000, turnId: T2 }));

    await buildRecording(SESSION, { store, turns, decode, resample, encode });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(resample).toHaveBeenCalledTimes(2);
    // survivors preserve turn order (user before absent agent), role, and recordSeq.
    expect(resample.mock.calls.map(call => call[0].length)).toEqual([1600, 800]);
    const gap = Math.round(FINAL_SAMPLE_RATE * EXPORT_GAP_MS / 1000);
    expect(encode.mock.calls[0]![0].length).toBe(Math.round(1600 * FINAL_SAMPLE_RATE / 16000) + Math.round(800 * FINAL_SAMPLE_RATE / 16000) + gap);
    store.close();
  });

  it('returns null when every row is trimmed without touching audio', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const T2 = '018f1f32-7abe-7def-8abc-0123456789ab';
    const store = (await deps([], [turn(T1, 1), turn(T2, 2)])).store;
    const { decode, resample, encode, turns } = await deps([
      { sampleRate: 16000, channelData: tone(1600) },
      { sampleRate: 16000, channelData: tone(800) },
    ], [turn(T1, 1), turn(T2, 2)]);
    await store.put(item({ itemId: 'u1', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1, trimmed: true }));
    await store.put(item({ itemId: 'u2', role: 'user', recordSeq: 1, sampleRate: 16000, turnId: T2, trimmed: true }));
    const blob = await buildRecording(SESSION, { store, turns, decode, resample, encode });
    expect(blob).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    expect(resample).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    store.close();
  });

  it('normalizes a low-RMS user segment and a high-RMS agent segment to the shared target', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const userLen = 4000;
    const agentLen = 6000;
    const store = (await deps([], [turn(T1, 1)])).store;
    const { decode, resample, encode, turns } = await deps([
      { sampleRate: 16000, channelData: sine(0.04, userLen) },
      { sampleRate: 24000, channelData: sine(0.7, agentLen) },
    ], [turn(T1, 1)], { resample: identityResample });
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    await store.put(item({ itemId: 'b', role: 'agent', recordSeq: 1, sampleRate: 24000, turnId: T1 }));
    await buildRecording(SESSION, { store, turns, decode, resample, encode, gapMs: 0 });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0]![1]).toBe(FINAL_SAMPLE_RATE);
    expect(encode.mock.calls[0]![2]).toBe(FINAL_KBPS);
    const pcm = encode.mock.calls[0]![0];
    // Normalization must not add or drop samples.
    expect(pcm.length).toBe(userLen + agentLen);
    const expected = TARGET_RMS * 32767;
    expect(Math.abs(rmsPcm(pcm, 0, userLen) - expected)).toBeLessThan(4);
    expect(Math.abs(rmsPcm(pcm, userLen, agentLen) - expected)).toBeLessThan(4);
    store.close();
  });

  it('leaves near-silent segments unchanged instead of amplifying them toward clipping', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const store = await openStore();
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    const turns = [turn(T1, 1)];
    const signal = sine(SILENCE_RMS_FLOOR / 10, 4000);
    const first = await deps([{ sampleRate: 16000, channelData: signal }], turns, { store, resample: identityResample });
    await buildRecording(SESSION, { store, turns: first.turns, decode: first.decode, resample: first.resample, encode: first.encode, gapMs: 0 });
    const second = await deps([{ sampleRate: 16000, channelData: signal.slice() }], turns, { store, resample: identityResample });
    await buildRecording(SESSION, { store, turns: second.turns, decode: second.decode, resample: second.resample, encode: second.encode, gapMs: 0, normalizeMode: 'none' });
    const rmsPcmEncoded = first.encode.mock.calls[0]![0];
    const nonePcm = second.encode.mock.calls[0]![0];
    // Default rms mode must not touch sub-floor segments.
    expect(rmsPcmEncoded).toEqual(nonePcm);
    expect(Math.max(...Array.from(rmsPcmEncoded).map(Math.abs))).toBeLessThan(10);
    store.close();
  });

  it('caps upward gain at MAX_NORMALIZATION_GAIN instead of reaching the target', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const store = await openStore();
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    const signal = new Float32Array(4000).fill(0.001);
    const { decode, resample, encode, turns } = await deps([{ sampleRate: 16000, channelData: signal }], [turn(T1, 1)], { store, resample: identityResample });
    await buildRecording(SESSION, { store, turns, decode, resample, encode, gapMs: 0 });
    const pcm = encode.mock.calls[0]![0];
    const rms = rmsPcm(pcm, 0, pcm.length);
    expect(Math.abs(rms - 0.001 * MAX_NORMALIZATION_GAIN * 32767)).toBeLessThan(2);
    expect(rms).toBeLessThan(TARGET_RMS * 32767 * 0.5);
    expect(Math.max(...Array.from(pcm).map(Math.abs))).toBeLessThan(0x7fff);
    store.close();
  });

  it('passes exact pre-change PCM16 to the encoder in none mode', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const store = await openStore();
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    const fixture = new Float32Array([0.5, -0.5, 0.25, -0.25, 1.0, -1.0, 0.0]);
    const { decode, resample, encode, turns } = await deps([{ sampleRate: 16000, channelData: fixture }], [turn(T1, 1)], { store, resample: identityResample });
    await buildRecording(SESSION, { store, turns, decode, resample, encode, gapMs: 0, normalizeMode: 'none' });
    expect(Array.from(encode.mock.calls[0]![0])).toEqual([16384, -16384, 8192, -8192, 32767, -32768, 0]);
    store.close();
  });

  it('saturates over-range normalized samples without wrapping outside Int16 bounds', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const length = 10000;
    const signal = new Float32Array(length);
    for (let index = 0; index < 100; index++) {
      signal[index] = 0.8;
      signal[length - 1 - index] = -0.8;
    }
    const store = await openStore();
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    const { decode, resample, encode, turns } = await deps([{ sampleRate: 16000, channelData: signal }], [turn(T1, 1)], { store, resample: identityResample });
    await buildRecording(SESSION, { store, turns, decode, resample, encode, gapMs: 0 });
    const pcm = encode.mock.calls[0]![0];
    expect(pcm.includes(32767)).toBe(true);
    expect(pcm.includes(-32768)).toBe(true);
    for (const value of pcm) {
      expect(value).toBeGreaterThanOrEqual(-32768);
      expect(value).toBeLessThanOrEqual(32767);
    }
    store.close();
  });

  it('reports reading, per-clip decoding, and preparing progress that is monotonic', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const T2 = '018f1f32-7abe-7def-8abc-0123456789ab';
    const store = (await deps([], [turn(T1, 1), turn(T2, 2)])).store;
    const { decode, resample, encode, turns } = await deps([
      { sampleRate: 16000, channelData: tone(1600) },
      { sampleRate: 16000, channelData: tone(800) },
    ], [turn(T1, 1), turn(T2, 2)]);
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    await store.put(item({ itemId: 'b', role: 'user', recordSeq: 1, sampleRate: 16000, turnId: T2 }));
    const progress: ExportProgress[] = [];
    await buildRecording(SESSION, { store, turns, decode, resample, encode, onProgress: update => progress.push(update) });
    // Reading is emitted once at READ_END before decoding starts.
    expect(progress[0]).toMatchObject({ phase: 'reading', message: 'Reading recording…', value: READ_END });
    // Every emitted value stays monotonic.
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]!.value).toBeGreaterThanOrEqual(progress[index - 1]!.value);
    }
    // Both clips surface their own completed count and the final decode uses DECODE_END.
    const first = progress.find(update => update.message === 'Decoding 1 of 2 clips…');
    const second = progress.find(update => update.message === 'Decoding 2 of 2 clips…');
    expect(first?.value).toBe(DECODE_START + (DECODE_END - DECODE_START) * (1 / 2));
    expect(second?.value).toBe(DECODE_END);
    // The successful export closes with an exactly-1 preparing call.
    expect(progress[progress.length - 1]).toMatchObject({ phase: 'preparing', message: 'Preparing download…', value: PREPARING_END });
    store.close();
  });

  it('counts a survivor that decodes to no samples toward per-clip progress', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const store = (await deps([], [turn(T1, 1)])).store;
    // The first survivor decodes to silence (empty samples); the second is real.
    const { decode, resample, encode, turns } = await deps([
      { sampleRate: 16000, channelData: new Float32Array(0) },
      { sampleRate: 16000, channelData: tone(800) },
    ], [turn(T1, 1)]);
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    await store.put(item({ itemId: 'b', role: 'user', recordSeq: 1, sampleRate: 16000, turnId: T1 }));
    const progress: ExportProgress[] = [];
    const blob = await buildRecording(SESSION, { store, turns, decode, resample, encode, onProgress: update => progress.push(update) });
    expect(blob).not.toBeNull();
    expect(progress.some(update => update.message === 'Decoding 1 of 2 clips…')).toBe(true);
    expect(progress.some(update => update.message === 'Decoding 2 of 2 clips…')).toBe(true);
    store.close();
  });

  it('maps encoder fractions into the encoding band and never regresses', async () => {
    const T1 = '018f1f32-7abd-7def-8abc-0123456789ab';
    const store = await openStore();
    await store.put(item({ itemId: 'a', role: 'user', recordSeq: 0, sampleRate: 16000, turnId: T1 }));
    const encode = vi.fn<EncodeMp3>(async (_pcm, _sampleRate, _bitrateKbps, onProgress) => {
      onProgress?.(0.25);
      onProgress?.(0.1); // regression that must be clamped
      onProgress?.(0.5);
      onProgress?.(1);
      return new Uint8Array([1, 2, 3]);
    });
    const { decode, resample, turns } = await deps([{ sampleRate: 16000, channelData: tone(1600) }], [turn(T1, 1)], { store, resample: identityResample });
    const progress: ExportProgress[] = [];
    await buildRecording(SESSION, { store, turns, decode, resample, encode, onProgress: update => progress.push(update) });
    const encoding = progress.filter(update => update.phase === 'encoding');
    expect(encoding.length).toBeGreaterThanOrEqual(3);
    for (const update of encoding) {
      expect(update.value).toBeGreaterThanOrEqual(ENCODE_START);
      expect(update.value).toBeLessThanOrEqual(ENCODE_END);
    }
    // The regressing 0.1 after 0.25 must clamp to the same encoded value.
    expect(encoding[0]!.value).toBeGreaterThan(ENCODE_START);
    expect(encoding[1]!.value).toBe(encoding[0]!.value);
    for (let index = 1; index < encoding.length; index++) {
      expect(encoding[index]!.value).toBeGreaterThanOrEqual(encoding[index - 1]!.value);
    }
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]!.value).toBeGreaterThanOrEqual(progress[index - 1]!.value);
    }
    expect(progress[progress.length - 1]).toMatchObject({ phase: 'preparing', value: PREPARING_END });
    store.close();
  });

  it('keeps the progress callback quiet for an empty export', async () => {
    const { store, decode, resample, encode, turns } = await deps([], []);
    const onProgress = vi.fn();
    const blob = await buildRecording(SESSION, { store, turns, decode, resample, encode, onProgress });
    expect(blob).toBeNull();
    expect(onProgress).not.toHaveBeenCalled();
    store.close();
  });
});
