import { decodeBinaryAudioFrame } from '@app/contracts/binary';
import { describe, expect, it } from 'vitest';
import { AudioFramePacker, CAPTURE_FRAME_SAMPLES, MAX_BINARY_PAYLOAD_BYTES } from './frame-packer';

describe('AudioFramePacker', () => {
  it('carries partial input and emits sequenced mono 20ms frames', () => {
    const packer = new AudioFramePacker(7, () => 1234n);
    expect(packer.push(new Int16Array(100))).toHaveLength(0);
    const packed = packer.push(Int16Array.from({ length: 600 }, (_, index) => index - 300));
    expect(packed).toHaveLength(2);
    const first = decodeBinaryAudioFrame(packed[0]!.bytes, MAX_BINARY_PAYLOAD_BYTES);
    expect(first).toMatchObject({ channel: 1, streamId: 7, sequence: 0, monotonicUs: 1234n });
    expect(first.pcm16).toHaveLength(CAPTURE_FRAME_SAMPLES);
    expect(decodeBinaryAudioFrame(packed[1]!.bytes, MAX_BINARY_PAYLOAD_BYTES).sequence).toBe(1);
  });
});
