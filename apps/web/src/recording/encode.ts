import { Mp3Encoder } from '@breezystack/lamejs';

export type EncodeSampleRate = 16000 | 24000 | 44100;
export type EncodeOnProgress = (fraction: number) => void;
export interface EncodeMp3 { (pcm16: Int16Array, sampleRate: EncodeSampleRate, bitrateKbps: number, onProgress?: EncodeOnProgress): Promise<Uint8Array> }
export interface DecodeMp3 { (bytes: Uint8Array): Promise<{ sampleRate: number; channelData: Float32Array }> }

const LAME_FRAME_SAMPLES = 1152;

/**
 * Pure synchronous MPEG-1/2 Layer III mono encode via the pinned pure-JS
 * lamejs fork. Returns the complete MP3 byte stream (frame header first).
 */
export function encodeMp3(pcm16: Int16Array, sampleRate: EncodeSampleRate, bitrateKbps: number, onProgress?: EncodeOnProgress): Uint8Array {
  const encoder = new Mp3Encoder(1, sampleRate, bitrateKbps);
  const chunks: Uint8Array[] = [];
  const totalFrames = Math.ceil(pcm16.length / LAME_FRAME_SAMPLES);
  const progressBatchFrames = Math.max(1, Math.floor(totalFrames / 100));
  let completedFrames = 0;
  for (let offset = 0; offset < pcm16.length; offset += LAME_FRAME_SAMPLES) {
    const encoded = encoder.encodeBuffer(pcm16.subarray(offset, offset + LAME_FRAME_SAMPLES));
    if (encoded.length > 0) chunks.push(encoded);
    completedFrames++;
    if (totalFrames > 0 && (completedFrames % progressBatchFrames === 0 || completedFrames === totalFrames)) {
      onProgress?.(completedFrames / totalFrames);
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail);
  onProgress?.(1);
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
