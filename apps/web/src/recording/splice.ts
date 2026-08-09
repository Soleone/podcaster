import type { StableTurnWriter } from '../storage/stable-turn-writer';
import type { RecordingStore, StoredRecordingItem } from '../storage/recording-store';
import type { DecodeMp3, EncodeMp3 } from './encode';

export const FINAL_SAMPLE_RATE = 44100;
export const FINAL_KBPS = 128;
export const EXPORT_GAP_MS = 300;

export interface SpliceDependencies {
  store: RecordingStore;
  turns: Pick<StableTurnWriter, 'getTurns'>;
  decode: DecodeMp3;
  resample: (channelData: Float32Array, fromRate: number, toRate: number) => Float32Array;
  encode: EncodeMp3;
  gapMs?: number;
}

export function createBrowserDecoder(): DecodeMp3 {
  const context = new AudioContext();
  return async bytes => {
    const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { sampleRate: buffer.sampleRate, channelData: buffer.getChannelData(0) };
  };
}

function orderItems(items: StoredRecordingItem[], turnSequences: Map<string, number>): StoredRecordingItem[] {
  const sequenceOf = (item: StoredRecordingItem): number | undefined => item.turnId === null ? undefined : turnSequences.get(item.turnId);
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
 * to 44.1 kHz, concatenate with the configured inter-item gap, and encode.
 * Returns null when the session has no recording items.
 */
export async function buildRecording(sessionId: string, deps: SpliceDependencies): Promise<Blob | null> {
  const [items, turns] = await Promise.all([deps.store.getSessionItems(sessionId), deps.turns.getTurns(sessionId)]);
  if (items.length === 0) return null;
  const turnSequences = new Map(turns.map(turn => [turn.turnId, turn.timelineSequence]));
  const gapSamples = Math.round(FINAL_SAMPLE_RATE * Math.max(0, deps.gapMs ?? EXPORT_GAP_MS) / 1000);
  const segments: Float32Array[] = [];
  let totalSamples = 0;
  for (const item of orderItems(items, turnSequences)) {
    const { sampleRate, channelData } = await deps.decode(new Uint8Array(await item.data.arrayBuffer()));
    let samples = channelData;
    if (item.role === 'agent' && item.interrupted && item.deliveredSamples !== null) {
      const trim = Math.max(0, Math.min(item.deliveredSamples, samples.length));
      samples = samples.subarray(0, trim);
    }
    if (samples.length === 0) continue;
    const resampled = deps.resample(samples, sampleRate, FINAL_SAMPLE_RATE);
    if (resampled.length === 0) continue;
    if (segments.length > 0) totalSamples += gapSamples;
    segments.push(resampled);
    totalSamples += resampled.length;
  }
  if (segments.length === 0) return null;
  const joined = new Float32Array(totalSamples);
  let offset = 0;
  for (let index = 0; index < segments.length; index++) {
    if (index > 0) offset += gapSamples;
    joined.set(segments[index]!, offset);
    offset += segments[index]!.length;
  }
  const pcm16 = new Int16Array(joined.length);
  for (let index = 0; index < joined.length; index++) {
    const sample = joined[index]!;
    pcm16[index] = sample < 0 ? Math.max(-0x8000, Math.round(sample * 0x8000)) : Math.min(0x7fff, Math.round(sample * 0x7fff));
  }
  const mp3 = await deps.encode(pcm16, FINAL_SAMPLE_RATE, FINAL_KBPS);
  return new Blob([mp3], { type: 'audio/mpeg' });
}
