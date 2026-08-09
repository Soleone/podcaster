import { PlaybackLedger, type PlaybackProgress, type PlaybackStopReason, type PlaybackTerminal } from './playback-ledger';

export interface PlaybackSink {
  progress(progress: PlaybackProgress): void | Promise<void>;
  terminal(receipt: PlaybackTerminal): void | Promise<void>;
  degraded(message: string): void;
}

export interface PlayedAudio {
  playbackId: string;
  sampleOffset: number;
  pcm16: Int16Array;
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  startTime: number;
  startOffset: number;
  endOffset: number;
}

export class BrowserPlayback {
  private readonly ledger: PlaybackLedger;
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private readonly scheduled: ScheduledSource[] = [];
  private readonly pending = new Map<number, Int16Array>();
  private nextStartTime = 0;
  private scheduledUntil = 0;
  private stopped = false;
  private generatedExtentDeclared = false;

  constructor(
    readonly playbackId: string,
    outputEpoch: number,
    readonly declaredSampleRate: number,
    private readonly sink: PlaybackSink,
    createContext: () => AudioContext = () => new AudioContext(),
    private readonly onAudio?: (audio: PlayedAudio) => void,
  ) {
    this.ledger = new PlaybackLedger(playbackId, outputEpoch, declaredSampleRate);
    this.context = createContext();
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }

  setGeneratedSamples(samples: number): void {
    this.ledger.setGeneratedSamples(samples);
    this.generatedExtentDeclared = true;
    this.completeIfReady();
  }

  append(sampleOffset: number, pcm16: Int16Array): void {
    if (this.stopped || !Number.isSafeInteger(sampleOffset) || sampleOffset < 0 || pcm16.length === 0) return;
    this.onAudio?.({ playbackId: this.playbackId, sampleOffset, pcm16 });
    const contiguousGenerated = this.ledger.addChunk(sampleOffset, pcm16);
    // Streaming progress must never report rendered samples beyond the known
    // generated prefix. Final completion still waits for setGeneratedSamples().
    this.ledger.setGeneratedSamples(contiguousGenerated);
    if (sampleOffset + pcm16.length <= this.scheduledUntil || this.pending.has(sampleOffset)) return;
    this.pending.set(sampleOffset, pcm16.slice());
    this.drainContiguous();
  }

  private drainContiguous(): void {
    for (;;) {
      const pcm16 = this.pending.get(this.scheduledUntil);
      if (!pcm16) return;
      const sampleOffset = this.scheduledUntil;
      this.pending.delete(sampleOffset);
      const buffer = this.context.createBuffer(1, pcm16.length, this.declaredSampleRate);
      const output = buffer.getChannelData(0);
      for (let index = 0; index < pcm16.length; index++) output[index] = (pcm16[index] ?? 0) / 0x8000;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);
      const startTime = Math.max(this.context.currentTime, this.nextStartTime);
      this.nextStartTime = startTime + pcm16.length / this.declaredSampleRate;
      const scheduled: ScheduledSource = { source, startTime, startOffset: sampleOffset, endOffset: sampleOffset + pcm16.length };
      this.scheduledUntil = scheduled.endOffset;
      this.scheduled.push(scheduled);
      source.onended = () => {
        const index = this.scheduled.indexOf(scheduled);
        if (index >= 0) this.scheduled.splice(index, 1);
        if (this.stopped) return;
        this.reportPlayed(scheduled.endOffset);
        this.completeIfReady();
      };
      source.start(startTime);
    }
  }

  private reportPlayed(offset: number): void {
    const progress = this.ledger.markPlayed(offset);
    if (progress) void this.sink.progress(progress);
  }

  private accountCurrentTime(): void {
    const now = this.context.currentTime;
    let rendered = this.ledger.deliveredSamples();
    for (const scheduled of this.scheduled) {
      if (now <= scheduled.startTime) continue;
      const elapsedSamples = Math.floor((now - scheduled.startTime) * this.declaredSampleRate);
      rendered = Math.max(rendered, Math.min(scheduled.endOffset, scheduled.startOffset + elapsedSamples));
    }
    this.reportPlayed(rendered);
  }

  private completeIfReady(): void {
    const progress = this.ledger.progress();
    if (!this.stopped && this.generatedExtentDeclared && progress.playedSampleOffset >= progress.generatedSamples) {
      void this.stop('completed');
    }
  }

  async pause(): Promise<PlaybackProgress> {
    if (this.stopped) return this.ledger.progress();
    this.gain.gain.value = 0;
    await this.context.suspend();
    this.accountCurrentTime();
    return this.ledger.progress();
  }

  async resume(): Promise<void> {
    if (!this.stopped) {
      this.gain.gain.value = 1;
      await this.context.resume();
    }
  }

  async stop(reason: PlaybackStopReason): Promise<PlaybackTerminal> {
    if (this.stopped) return this.ledger.stop(reason);
    this.accountCurrentTime();
    const receipt = this.ledger.stop(reason);
    this.stopped = true;
    this.gain.gain.value = 0;
    for (const { source } of this.scheduled.splice(0)) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
    }
    await this.sink.terminal(receipt);
    await this.context.close().catch(() => undefined);
    return receipt;
  }
}
