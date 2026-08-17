import { CUSTOM_VOICE_SAMPLE_RATE } from '@app/contracts/settings';

export function encodeWavPcm16(pcm16: Int16Array, sampleRate = CUSTOM_VOICE_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + pcm16.byteLength);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm16.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm16.byteLength, true);
  bytes.set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), 44);
  return bytes;
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm16 = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]!));
    pcm16[index] = Math.round(value * (value < 0 ? 32768 : 32767));
  }
  return pcm16;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then(value => new Uint8Array(value));
}
