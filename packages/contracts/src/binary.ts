export const BINARY_FRAME_VERSION = 1;
export const BINARY_HEADER_BYTES = 20;
export type AudioChannel = 1 | 2;
export interface BinaryAudioFrame { version: 1; channel: AudioChannel; streamId: number; sequence: number; monotonicUs: bigint; pcm16: Int16Array }

export function encodeBinaryAudioFrame(frame: Omit<BinaryAudioFrame, "version">, maxPayloadBytes: number): Uint8Array {
  const payloadBytes = frame.pcm16.byteLength;
  if (payloadBytes > maxPayloadBytes) throw new RangeError("PCM payload exceeds negotiated frame size");
  if (frame.streamId < 0 || frame.streamId > 0xffffffff || frame.sequence < 0 || frame.sequence > 0xffffffff) throw new RangeError("streamId and sequence must be uint32");
  const output = new Uint8Array(BINARY_HEADER_BYTES + payloadBytes);
  const view = new DataView(output.buffer);
  view.setUint8(0, BINARY_FRAME_VERSION);
  view.setUint8(1, frame.channel);
  view.setUint16(2, BINARY_HEADER_BYTES, true);
  view.setUint32(4, frame.streamId, true);
  view.setUint32(8, frame.sequence, true);
  view.setBigUint64(12, frame.monotonicUs, true);
  for (let i = 0; i < frame.pcm16.length; i++) view.setInt16(BINARY_HEADER_BYTES + i * 2, frame.pcm16[i]!, true);
  return output;
}

export function decodeBinaryAudioFrame(data: Uint8Array, maxPayloadBytes: number): BinaryAudioFrame {
  if (data.byteLength < BINARY_HEADER_BYTES) throw new RangeError("truncated binary frame");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint8(0);
  if (version !== BINARY_FRAME_VERSION) throw new RangeError("unsupported binary frame version");
  const channel = view.getUint8(1);
  if (channel !== 1 && channel !== 2) throw new RangeError("unsupported audio channel");
  const headerBytes = view.getUint16(2, true);
  if (headerBytes !== BINARY_HEADER_BYTES) throw new RangeError("invalid binary header length");
  const payloadBytes = data.byteLength - headerBytes;
  if (payloadBytes > maxPayloadBytes) throw new RangeError("PCM payload exceeds negotiated frame size");
  if (payloadBytes % 2 !== 0) throw new RangeError("PCM16 payload has odd byte length");
  const pcm16 = new Int16Array(payloadBytes / 2);
  for (let i = 0; i < pcm16.length; i++) pcm16[i] = view.getInt16(headerBytes + i * 2, true);
  return { version: 1, channel, streamId: view.getUint32(4, true), sequence: view.getUint32(8, true), monotonicUs: view.getBigUint64(12, true), pcm16 };
}
