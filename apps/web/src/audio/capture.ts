import { AudioFramePacker } from './frame-packer';
import { floatToPcm16 } from './pcm';
import { StreamingResampler } from './resampler';

export interface CaptureSink {
  send(frame: Uint8Array): void | Promise<void>;
  degraded(message: string): void;
}

export interface CaptureHandle { stop(): Promise<void> }

export interface CapturedAudio {
  streamId: number;
  sequence: number;
  sampleOffset: number;
  pcm16: Int16Array;
}

export interface CaptureDependencies {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  createAudioContext?: () => AudioContext;
  createWorkletNode?: (context: AudioContext) => AudioWorkletNode;
  streamId?: () => number;
  onAudio?: (capture: CapturedAudio) => void;
}

export class BrowserCapture {
  constructor(private readonly dependencies: CaptureDependencies = {}) {}

  async start(sink: CaptureSink): Promise<CaptureHandle> {
    const mediaDevices = this.dependencies.mediaDevices ?? navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) throw new Error('Microphone capture is not supported by this browser.');
    const stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    let context: AudioContext | undefined;
    let stopped = false;
    try {
      context = this.dependencies.createAudioContext?.() ?? new AudioContext();
      await context.audioWorklet.addModule('/audio-worklet.js');
      const source = context.createMediaStreamSource(stream);
      const node = this.dependencies.createWorkletNode?.(context) ?? new AudioWorkletNode(context, 'podcaster-capture');
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(node); node.connect(silent); silent.connect(context.destination);
      const resampler = new StreamingResampler(context.sampleRate);
      const random = new Uint32Array(1); crypto.getRandomValues(random);
      const packer = new AudioFramePacker(this.dependencies.streamId?.() ?? (random[0] ?? 0));
      let sending = false;
      const pending: Uint8Array[] = [];
      const flush = async () => {
        if (sending || stopped) return;
        sending = true;
        try {
          while (pending.length && !stopped) await sink.send(pending.shift()!);
        } catch {
          sink.degraded('Microphone audio could not be sent. Capture was stopped.');
          await stop();
        } finally { sending = false; }
      };
      node.port.onmessage = event => {
        if (stopped || !(event.data instanceof Float32Array)) return;
        for (const frame of packer.push(floatToPcm16(resampler.push(event.data)))) {
          this.dependencies.onAudio?.({ streamId: packer.streamId, sequence: frame.sequence, sampleOffset: frame.sampleOffset, pcm16: frame.pcm16 });
          pending.push(frame.bytes);
        }
        if (pending.length > 50) {
          sink.degraded('Microphone audio fell behind. Capture was stopped to avoid dropping speech.');
          void stop();
        } else void flush();
      };
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        packer.stop(); resampler.reset();
        node.port.onmessage = null;
        source.disconnect(); node.disconnect(); silent.disconnect();
        for (const track of stream.getTracks()) track.stop();
        await context!.close();
      };
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (!stopped) sink.degraded('Microphone connection was lost. Choose retry or stop the session.');
        void stop();
      }, { once: true });
      return { stop };
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await context?.close().catch(() => undefined);
      throw error;
    }
  }
}
