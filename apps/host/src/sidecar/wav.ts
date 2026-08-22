// Minimal 16-bit mono little-endian WAV writer. The browser decodes preview
// audio with decodeAudioData(), which needs a real container rather than raw
// PCM; a WAV header is the smallest representation that satisfies it.

/** RIFF chunks before the PCM payload: "RIFF" + size + "WAVE" + "fmt " + ... + "data". */
export const WAV_HEADER_BYTES = 44;

export function encodeWav(pcm16: Int16Array, sampleRate: number): Uint8Array {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0)
    throw new RangeError('sampleRate must be a positive integer');
  const dataBytes = pcm16.byteLength;
  const output = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(output.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  new Uint8Array(output.buffer, WAV_HEADER_BYTES, dataBytes).set(
    new Uint8Array(pcm16.buffer, pcm16.byteOffset, dataBytes),
  );
  return output;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
}
