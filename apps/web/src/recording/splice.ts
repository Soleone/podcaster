import type { StableTurnWriter } from '../storage/stable-turn-writer';
import type { RecordingStore, StoredRecordingItem } from '../storage/recording-store';
import type { DecodeMp3, EncodeMp3 } from './encode';
import { floatToPcm16 } from '../audio/pcm';

export const FINAL_SAMPLE_RATE = 44100;
export const FINAL_KBPS = 128;
export const EXPORT_GAP_MS = 300;

export const TARGET_RMS_DBFS = -16;
export const TARGET_RMS = 10 ** (TARGET_RMS_DBFS / 20);
export const SILENCE_RMS_FLOOR = 1e-4;
export const MAX_NORMALIZATION_GAIN = 10;

export type NormalizeMode = 'none' | 'rms';

export type ExportPhase = 'reading' | 'decoding' | 'encoding' | 'preparing';
export interface ExportProgress {
  phase: ExportPhase;
  message: string;
  value: number;
}
export type ExportOnProgress = (progress: ExportProgress) => void;

export const READ_START = 0;
export const READ_END = 0.04;
export const DECODE_START = 0.04;
export const DECODE_END = 0.9;
export const ENCODE_START = 0.9;
export const ENCODE_END = 0.99;
export const PREPARING_END = 1;

function normalizeSegment(input: Float32Array, mode: NormalizeMode): Float32Array {
  if (mode === 'none') return input;
  let sumSquares = 0;
  for (let index = 0; index < input.length; index++) {
    const sample = input[index] ?? 0;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / input.length);
  if (!Number.isFinite(rms) || rms < SILENCE_RMS_FLOOR) return input;
  const gain = Math.min(MAX_NORMALIZATION_GAIN, TARGET_RMS / rms);
  if (gain === 1) return input;
  const normalized = new Float32Array(input.length);
  for (let index = 0; index < input.length; index++) normalized[index] = (input[index] ?? 0) * gain;
  return normalized;
}

export interface SpliceDependencies {
  store: RecordingStore;
  turns: Pick<StableTurnWriter, 'getTurns'>;
  decode: DecodeMp3;
  resample: (channelData: Float32Array, fromRate: number, toRate: number) => Float32Array;
  encode: EncodeMp3;
  gapMs?: number;
  normalizeMode?: NormalizeMode;
  onProgress?: ExportOnProgress;
}

export function createBrowserDecoder(): DecodeMp3 {
  const context = new AudioContext();
  return async (bytes) => {
    const buffer = await context.decodeAudioData(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    return { sampleRate: buffer.sampleRate, channelData: buffer.getChannelData(0) };
  };
}

function orderItems(items: StoredRecordingItem[], turnSequences: Map<string, number>): StoredRecordingItem[] {
  const sequenceOf = (item: StoredRecordingItem): number | undefined =>
    item.turnId === null ? undefined : turnSequences.get(item.turnId);
  return [...items].sort((left, right) => {
    const leftSequence = sequenceOf(left);
    const rightSequence = sequenceOf(right);
    if (leftSequence !== undefined && rightSequence !== undefined) {
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      if (left.role !== right.role) return left.role === 'user' ? -1 : 1;
      return left.recordSeq - right.recordSeq;
    }
    if (leftSequence === undefined && rightSequence === undefined) return left.recordSeq - right.recordSeq;
    return leftSequence === undefined ? 1 : -1;
  });
}

/**
 * Builds the final export MP3: decode each persisted item, trim interrupted
 * agent items at their delivered extent (clamped to decoded length), resample
 * to 44.1 kHz, normalize each segment to a shared RMS target, concatenate with
 * the configured inter-item gap, and encode. Returns null when the session has
 * no recording items.
 */
export async function buildRecording(sessionId: string, deps: SpliceDependencies): Promise<Blob | null> {
  const normalizeMode: NormalizeMode = deps.normalizeMode ?? 'rms';
  let lastReported = -1;
  const reportProgress = (update: ExportProgress): void => {
    if (deps.onProgress === undefined) return;
    if (!Number.isFinite(update.value)) return;
    const clamped = Math.min(1, Math.max(0, update.value));
    const value = clamped < lastReported ? lastReported : clamped;
    lastReported = value;
    deps.onProgress({ ...update, value });
  };
  const [items, turns] = await Promise.all([deps.store.getSessionItems(sessionId), deps.turns.getTurns(sessionId)]);
  // Trimmed bubbles are excluded before ordering, decoding, resampling, or gap
  // insertion so their Blobs are never touched during export.
  const survivors = items.filter((item) => !item.trimmed);
  if (survivors.length === 0) return null;
  reportProgress({ phase: 'reading', message: 'Reading recording…', value: READ_END });
  const turnSequences = new Map(turns.map((turn) => [turn.turnId, turn.timelineSequence]));
  const gapSamples = Math.round((FINAL_SAMPLE_RATE * Math.max(0, deps.gapMs ?? EXPORT_GAP_MS)) / 1000);
  const segments: Float32Array[] = [];
  let totalSamples = 0;
  let completed = 0;
  for (const item of orderItems(survivors, turnSequences)) {
    let completedNormally = false;
    try {
      const { sampleRate, channelData } = await deps.decode(new Uint8Array(await item.data.arrayBuffer()));
      let samples = channelData;
      if (item.role === 'agent' && item.interrupted && item.deliveredSamples !== null) {
        const trim = Math.max(0, Math.min(item.deliveredSamples, samples.length));
        samples = samples.subarray(0, trim);
      }
      if (samples.length === 0) {
        completedNormally = true;
        continue;
      }
      const resampled = deps.resample(samples, sampleRate, FINAL_SAMPLE_RATE);
      if (resampled.length === 0) {
        completedNormally = true;
        continue;
      }
      const normalized = normalizeSegment(resampled, normalizeMode);
      if (segments.length > 0) totalSamples += gapSamples;
      segments.push(normalized);
      totalSamples += normalized.length;
      completedNormally = true;
    } finally {
      if (completedNormally) {
        completed++;
        const value = DECODE_START + (DECODE_END - DECODE_START) * (completed / survivors.length);
        reportProgress({ phase: 'decoding', message: `Decoding ${completed} of ${survivors.length} clips…`, value });
      }
    }
  }
  if (segments.length === 0) return null;
  const joined = new Float32Array(totalSamples);
  let offset = 0;
  for (let index = 0; index < segments.length; index++) {
    if (index > 0) offset += gapSamples;
    joined.set(segments[index]!, offset);
    offset += segments[index]!.length;
  }
  const pcm16 = floatToPcm16(joined);
  let lastEncodeFraction = 0;
  const mp3 = await deps.encode(pcm16, FINAL_SAMPLE_RATE, FINAL_KBPS, (fraction) => {
    const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : lastEncodeFraction;
    const eff = clamped < lastEncodeFraction ? lastEncodeFraction : clamped;
    lastEncodeFraction = eff;
    const value = ENCODE_START + (ENCODE_END - ENCODE_START) * eff;
    reportProgress({ phase: 'encoding', message: `Encoding MP3… ${Math.round(eff * 100)}%`, value });
  });
  reportProgress({ phase: 'preparing', message: 'Preparing download…', value: PREPARING_END });
  return new Blob([mp3], { type: 'audio/mpeg' });
}
