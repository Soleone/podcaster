import { describe, expect, it } from 'vitest';
import { StreamingResampler } from './resampler';
import { floatToPcm16, foldToMono } from './pcm';

describe('browser PCM preparation', () => {
  it.each([44_100, 48_000])('preserves exact long-running phase across 128-sample blocks at %i Hz', (inputRate) => {
    const seconds = 12;
    const sampleCount = inputRate * seconds;
    const resampler = new StreamingResampler(inputRate);
    const output: number[] = [];
    for (let offset = 0; offset < sampleCount; offset += 128) {
      const length = Math.min(128, sampleCount - offset);
      const block = Float32Array.from({ length }, (_, index) => (offset + index) / sampleCount);
      output.push(...resampler.push(block));
    }
    expect(output).toHaveLength(16_000 * seconds);
    expect(output.every(Number.isFinite)).toBe(true);
    for (let index = 1; index < output.length; index++) {
      expect(output[index]!).toBeGreaterThan(output[index - 1]!);
    }
    expect(output.at(-1)).toBeCloseTo((sampleCount - inputRate / 16_000) / sampleCount, 6);
  });

  it('preserves interpolation continuity across irregular block boundaries', () => {
    const resampler = new StreamingResampler(44_100);
    const source = Float32Array.from({ length: 4_410 }, (_, index) => Math.sin(index / 20));
    const streamed = [source.slice(0, 137), source.slice(137, 991), source.slice(991)].flatMap((part) =>
      Array.from(resampler.push(part)),
    );
    const single = Array.from(new StreamingResampler(44_100).push(source));
    expect(streamed).toHaveLength(single.length);
    streamed.forEach((sample, index) => expect(sample).toBeCloseTo(single[index]!, 6));
  });

  it('folds channels and clips PCM16 with asymmetric signed scaling', () => {
    expect(Array.from(foldToMono([Float32Array.from([1, -1]), Float32Array.from([-1, 1])]))).toEqual([0, 0]);
    expect(Array.from(floatToPcm16(Float32Array.from([-2, -1, 0, 1, 2])))).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
});
