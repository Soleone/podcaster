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

interface AudioChunk {
  sampleOffset: number;
  pcm16: Int16Array;
}

const REWIND_HISTORY_MS = 1_000;

export class BrowserPlayback {
  private readonly ledger: PlaybackLedger;
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private readonly scheduled: ScheduledSource[] = [];
  private readonly pending = new Map<number, Int16Array>();
  // Scheduled PCM is retained only for a small rolling playback window so a
  // long barge-in can replay the listener's recent context without retaining
  // a complete response in memory.
  private readonly recentAudio: AudioChunk[] = [];
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
      this.rememberAudio(sampleOffset, pcm16);
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
    if (progress) {
      this.trimRecentAudio(progress.playedSampleOffset);
      void this.sink.progress(progress);
    }
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

  async resume(rewindMs = 0): Promise<void> {
    if (!this.stopped) {
      this.rewind(Math.floor(this.declaredSampleRate * Math.max(0, rewindMs) / 1_000));
      this.gain.gain.value = 1;
      await this.context.resume();
    }
  }

  private rememberAudio(sampleOffset: number, pcm16: Int16Array): void {
    const endOffset = sampleOffset + pcm16.length;
    if (this.recentAudio.some(chunk => chunk.sampleOffset <= sampleOffset && chunk.sampleOffset + chunk.pcm16.length >= endOffset)) return;
    this.recentAudio.push({ sampleOffset, pcm16: pcm16.slice() });
  }

  private trimRecentAudio(playedSampleOffset: number): void {
    const earliest = Math.max(0, playedSampleOffset - Math.ceil(this.declaredSampleRate * REWIND_HISTORY_MS / 1_000));
    while (this.recentAudio.length > 0) {
      const chunk = this.recentAudio[0]!;
      const endOffset = chunk.sampleOffset + chunk.pcm16.length;
      if (endOffset <= earliest) {
        this.recentAudio.shift();
        continue;
      }
      if (chunk.sampleOffset < earliest) {
        this.recentAudio[0] = { sampleOffset: earliest, pcm16: chunk.pcm16.slice(earliest - chunk.sampleOffset) };
      }
      return;
    }
  }

  private rewind(rewindSamples: number): void {
    if (!Number.isSafeInteger(rewindSamples) || rewindSamples <= 0) return;
    this.accountCurrentTime();
    const replayEnd = this.scheduledUntil;
    const replayStart = Math.max(0, this.ledger.deliveredSamples() - rewindSamples);
    if (replayStart >= replayEnd) return;

    const replay = this.replayAudio(replayStart, replayEnd);
    // A bounded history can be unavailable after an unusually delayed resume.
    // Keep the already-scheduled chain intact rather than risking a gap.
    if (!replay) return;

    const pending = [...this.pending.entries()];
    for (const { source } of this.scheduled.splice(0)) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.pending.clear();
    this.scheduledUntil = replayStart;
    this.nextStartTime = this.context.currentTime;
    for (const chunk of replay) this.pending.set(chunk.sampleOffset, chunk.pcm16);
    for (const [sampleOffset, pcm16] of pending) this.pending.set(sampleOffset, pcm16);
    this.drainContiguous();
  }

  private replayAudio(startOffset: number, endOffset: number): AudioChunk[] | undefined {
    const replay: AudioChunk[] = [];
    let nextOffset = startOffset;
    for (const chunk of this.recentAudio) {
      const chunkEnd = chunk.sampleOffset + chunk.pcm16.length;
      if (chunkEnd <= nextOffset) continue;
      if (chunk.sampleOffset > nextOffset) return;
      const takeStart = nextOffset - chunk.sampleOffset;
      const takeEnd = Math.min(chunk.pcm16.length, endOffset - chunk.sampleOffset);
      if (takeEnd > takeStart) {
        const pcm16 = chunk.pcm16.slice(takeStart, takeEnd);
        replay.push({ sampleOffset: nextOffset, pcm16 });
        nextOffset += pcm16.length;
      }
      if (nextOffset === endOffset) return replay;
    }
    return;
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
