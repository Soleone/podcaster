export function foldToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array();
  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let sample = 0; sample < length; sample++) {
    let total = 0;
    for (const channel of channels) total += channel[sample] ?? 0;
    mono[sample] = total / channels.length;
  }
  return mono;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index++) {
    const value = Math.max(-1, Math.min(1, input[index] ?? 0));
    output[index] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }
  return output;
}
