import { describe, expect, it } from 'vitest';
import { WAV_HEADER_BYTES, encodeWav } from '../../src/sidecar/wav.js';

function ascii(view: DataView, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index++) value += String.fromCharCode(view.getUint8(offset + index));
  return value;
}

describe('encodeWav', () => {
  it('writes a canonical 16-bit mono WAV header around the PCM payload', () => {
    const pcm = new Int16Array([1, -2, 300, -400, 0]);
    const wav = encodeWav(pcm, 24_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(wav.length).toBe(WAV_HEADER_BYTES + pcm.byteLength);
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    for (let index = 0; index < pcm.length; index++)
      expect(view.getInt16(WAV_HEADER_BYTES + index * 2, true)).toBe(pcm[index]);
  });

  it('copies the exact PCM bytes even when the Int16Array is a view into a larger buffer', () => {
    const backing = new Int16Array([99, 100, 42, 101]);
    const pcm = backing.subarray(1, 3); // [100, 42] at byteOffset 2
    const wav = encodeWav(pcm, 16_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(wav.length).toBe(WAV_HEADER_BYTES + 4);
    expect(view.getInt16(WAV_HEADER_BYTES, true)).toBe(100);
    expect(view.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(42);
  });

  it('rejects a non-positive sample rate', () => {
    expect(() => encodeWav(new Int16Array(4), 0)).toThrow(RangeError);
    expect(() => encodeWav(new Int16Array(4), -1)).toThrow(RangeError);
  });
});
