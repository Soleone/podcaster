/** Windowed-sinc offline resampler (mono). */
export function offlineResample(channelData: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) throw new RangeError('resample rates must be positive');
  if (fromRate === toRate) return channelData.slice();
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(channelData.length * toRate / fromRate));
  const output = new Float32Array(outputLength);
  const TAPS = 64;
  const cutoff = Math.min(1, ratio);
  for (let index = 0; index < outputLength; index++) {
    const center = index * ratio;
    const start = Math.floor(center) - (TAPS >> 1) + 1;
    let sum = 0;
    let weightSum = 0;
    for (let tap = 0; tap < TAPS; tap++) {
      const source = start + tap;
      if (source < 0 || source >= channelData.length) continue;
      const distance = source - center;
      const sinc = distance === 0 ? 1 : Math.sin(Math.PI * cutoff * distance) / (Math.PI * distance);
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * tap) / (TAPS - 1));
      const weight = sinc * window;
      sum += channelData[source]! * weight;
      weightSum += weight;
    }
    output[index] = weightSum > 0 ? sum / weightSum : 0;
  }
  return output;
}
