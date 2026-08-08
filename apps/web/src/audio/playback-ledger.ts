export type PlaybackStopReason = 'completed' | 'cancelled' | 'stopped' | 'failed';
export interface PlaybackTerminal {
  playbackId: string;
  cancelledEpoch: number;
  finalPlayedSampleOffset: number;
  reason: PlaybackStopReason;
}
export interface PlaybackProgress {
  playbackId: string;
  outputEpoch: number;
  playedSampleOffset: number;
  generatedSamples: number;
}

export class PlaybackLedger {
  private generatedSamples = 0;
  private contiguousQueued = 0;
  private played = 0;
  private terminal?: PlaybackTerminal;
  private readonly ranges = new Map<number, number>();

  constructor(readonly playbackId: string, readonly outputEpoch: number, readonly sampleRate: number) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new RangeError('sample rate must be positive');
  }

  setGeneratedSamples(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('generated samples must be nonnegative');
    this.generatedSamples = Math.max(this.generatedSamples, value);
    this.played = Math.min(this.played, this.generatedSamples);
  }

  addChunk(offset: number, samples: Int16Array): number {
    if (this.terminal || !Number.isSafeInteger(offset) || offset < 0 || samples.length === 0) return this.contiguousQueued;
    const end = offset + samples.length;
    const previous = this.ranges.get(offset) ?? 0;
    if (end > previous) this.ranges.set(offset, end);
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const [start, rangeEnd] of this.ranges) {
        if (start <= this.contiguousQueued && rangeEnd > this.contiguousQueued) {
          this.contiguousQueued = rangeEnd;
          this.ranges.delete(start);
          advanced = true;
        } else if (rangeEnd <= this.contiguousQueued) this.ranges.delete(start);
      }
    }
    return this.contiguousQueued;
  }

  markPlayed(actualOffset: number): PlaybackProgress | undefined {
    if (this.terminal || !Number.isSafeInteger(actualOffset) || actualOffset < 0) return;
    const upper = Math.min(this.contiguousQueued, this.generatedSamples || this.contiguousQueued);
    const next = Math.min(actualOffset, upper);
    if (next <= this.played) return;
    this.played = next;
    return this.progress();
  }

  progress(): PlaybackProgress {
    return { playbackId: this.playbackId, outputEpoch: this.outputEpoch, playedSampleOffset: this.played, generatedSamples: this.generatedSamples };
  }

  stop(reason: PlaybackStopReason): PlaybackTerminal {
    if (!this.terminal) {
      this.terminal = Object.freeze({ playbackId: this.playbackId, cancelledEpoch: this.outputEpoch, finalPlayedSampleOffset: this.played, reason });
    }
    return this.terminal;
  }

  isTerminal(): boolean { return this.terminal !== undefined; }
  deliveredSamples(): number { return this.played; }
}
