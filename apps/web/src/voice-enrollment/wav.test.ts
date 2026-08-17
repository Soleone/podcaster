import { describe, expect, it } from 'vitest';
import { encodeWavPcm16, floatToPcm16 } from './wav';

describe('voice enrollment WAV encoding', () => {
  it('writes fixed mono PCM16LE WAV headers', () => {
    const bytes = encodeWavPcm16(new Int16Array([0, 32767, -32768]), 16_000);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WAVE');
    expect(new DataView(bytes.buffer).getUint16(22, true)).toBe(1);
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
    expect(new DataView(bytes.buffer).getUint16(34, true)).toBe(16);
    expect(bytes.byteLength).toBe(50);
  });

  it('clamps normalized float samples to PCM16', () => {
    expect(Array.from(floatToPcm16(new Float32Array([-2, -1, 0, 1, 2])))).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
});
