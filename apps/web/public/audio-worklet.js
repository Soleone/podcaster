class PodcasterCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    const length = Math.min(...channels.map(channel => channel.length));
    const mono = new Float32Array(length);
    for (let sample = 0; sample < length; sample++) {
      let sum = 0;
      for (const channel of channels) sum += channel[sample] || 0;
      mono[sample] = sum / channels.length;
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}
registerProcessor('podcaster-capture', PodcasterCaptureProcessor);
