import { describe, expect, it } from 'vitest';
import { offlineResample } from './resample';

function rms(channelData: Float32Array): number {
  let sum = 0;
  for (const sample of channelData) sum += sample * sample;
  return Math.sqrt(sum / channelData.length);
}

describe('offlineResample', () => {
  it('preserves the RMS of a 440 Hz tone from 16 kHz to 44.1 kHz', () => {
    const input = new Float32Array(16_000);
    for (let index = 0; index < input.length; index++) input[index] = 0.5 * Math.sin((2 * Math.PI * 440 * index) / 16_000);
    const output = offlineResample(input, 16_000, 44_100);
    expect(output.length).toBe(Math.round((16_000 / 16_000) * 44_100));
    expect(rms(output)).toBeCloseTo(rms(input), 1);
  });

  it('preserves RMS from 24 kHz to 44.1 kHz and produces the expected length', () => {
    const input = new Float32Array(24_000);
    for (let index = 0; index < input.length; index++) input[index] = 0.3 * Math.sin((2 * Math.PI * 220 * index) / 24_000);
    const output = offlineResample(input, 24_000, 44_100);
    expect(output.length).toBe(Math.round((24_000 / 24_000) * 44_100));
    expect(rms(output)).toBeCloseTo(rms(input), 1);
  });

  it('returns a copy for equal rates', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const output = offlineResample(input, 16_000, 16_000);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it('handles a DC signal without gain drift', () => {
    const input = new Float32Array(8_000).fill(0.25);
    const output = offlineResample(input, 16_000, 44_100);
    for (const sample of output) expect(sample).toBeCloseTo(0.25, 2);
  });
});
