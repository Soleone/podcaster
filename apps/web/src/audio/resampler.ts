export class StreamingResampler {
  private readonly step: number;
  private samples: number[] = [];
  private position = 0;

  constructor(readonly inputRate: number, readonly outputRate = 16_000) {
    if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) {
      throw new RangeError('sample rates must be positive');
    }
    this.step = inputRate / outputRate;
  }

  push(input: Float32Array): Float32Array {
    for (const sample of input) this.samples.push(sample);
    const output: number[] = [];
    while (this.position + 1 < this.samples.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const a = this.samples[left] ?? 0;
      const b = this.samples[left + 1] ?? a;
      output.push(a + (b - a) * fraction);
      this.position += this.step;
    }
    // Linear interpolation always needs the sample immediately after position.
    // Retain the final sample when a block ends so fractional phase and any
    // overshoot carry into the next worklet block.
    const consumed = Math.min(Math.floor(this.position), Math.max(0, this.samples.length - 1));
    if (consumed > 0) {
      this.samples.splice(0, consumed);
      this.position -= consumed;
    }
    return Float32Array.from(output);
  }

  reset(): void {
    this.samples = [];
    this.position = 0;
  }
}
