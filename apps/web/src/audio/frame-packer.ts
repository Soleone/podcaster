import { encodeBinaryAudioFrame } from '@app/contracts/binary';

export const CAPTURE_SAMPLE_RATE = 16_000;
export const CAPTURE_FRAME_SAMPLES = 320;
export const MAX_BINARY_PAYLOAD_BYTES = 64 * 1024 - 20;

export interface PackedFrame { sequence: number; sampleOffset: number; pcm16: Int16Array; bytes: Uint8Array }

export class AudioFramePacker {
  private carry: number[] = [];
  private sequence = 0;
  private sampleOffset = 0;
  private lastMonotonicUs = 0n;

  constructor(
    readonly streamId: number,
    private readonly monotonicUs: () => bigint = () => BigInt(Math.max(0, Math.floor(performance.now() * 1000))),
  ) {
    if (!Number.isSafeInteger(streamId) || streamId < 0 || streamId > 0xffffffff) throw new RangeError('streamId must be uint32');
  }

  push(samples: Int16Array): PackedFrame[] {
    for (const sample of samples) this.carry.push(sample);
    const frames: PackedFrame[] = [];
    while (this.carry.length >= CAPTURE_FRAME_SAMPLES) {
      if (this.sequence > 0xffffffff) throw new RangeError('audio frame sequence exhausted');
      const pcm16 = Int16Array.from(this.carry.splice(0, CAPTURE_FRAME_SAMPLES));
      const sequence = this.sequence++;
      const sampleOffset = this.sampleOffset;
      this.sampleOffset += pcm16.length;
      const timestamp = this.monotonicUs();
      this.lastMonotonicUs = timestamp > this.lastMonotonicUs ? timestamp : this.lastMonotonicUs;
      frames.push({
        sequence,
        sampleOffset,
        pcm16,
        bytes: encodeBinaryAudioFrame({ channel: 1, streamId: this.streamId, sequence, monotonicUs: this.lastMonotonicUs, pcm16 }, MAX_BINARY_PAYLOAD_BYTES),
      });
    }
    return frames;
  }

  stop(): void { this.carry = []; }
}
