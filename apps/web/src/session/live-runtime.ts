import type { HostEvent, SessionPlanningRequest } from '@app/contracts';
import { BrowserCapture, type CaptureHandle } from '../audio/capture';
import { BrowserPlayback } from '../audio/playback';
import type { PlaybackStopReason } from '../audio/playback-ledger';
import { createEncoderClient } from '../recording/encoder-client';
import { offlineResample } from '../recording/resample';
import { buildRecording, createBrowserDecoder, type ExportOnProgress } from '../recording/splice';
import { deleteSessionRecording } from '../recording/export';
import { RecordingRecorder } from '../recording/recorder';
import type { EncodeMp3 } from '../recording/encode';
import { activityLog } from './activity-log';
import { SessionController, type ControlledPlayback } from './controller';
import { createEnvelope, type HostEventPayload, uuidV7 } from './envelope';
import { FakeSessionTransport } from './fake-transport';
import type { SessionTransport } from './transport';
import { WebSocketSessionTransport } from './websocket-transport';
import { initialSessionState, type SessionViewState } from './state';
import { RecordingStore, type RecordingItemSummary } from '../storage/recording-store';
import type { StableTurnWriter } from '../storage/stable-turn-writer';
import type { SessionSettingsSnapshot } from '@app/contracts/settings';

export interface LiveSessionRuntime {
  readonly sessionId: string;
  snapshot(): SessionViewState;
  /** Explicit pre-live-to-live transition; the sole caller of capture/recorder activation. */
  beginLive(): Promise<void>;
  cancelPlanning(): Promise<void>;
  retryPlanning(): Promise<void>;
  cancelAssistant(): Promise<void>;
  pause(): Promise<boolean>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  recordingSummaries(): Promise<{ enabled: boolean; summaries: RecordingItemSummary[] }>;
  buildRecording(onProgress?: ExportOnProgress): ReturnType<typeof buildRecording>;
  deleteRecording(): Promise<void>;
  setItemsTrimmed(itemIds: string[], trimmed: boolean): Promise<void>;
  /** Test-only instrumentation; undefined for real transports. */
  testApi(): LiveRuntimeTestApi | undefined;
}

export interface LiveSessionRuntimeCallbacks {
  onView(state: SessionViewState): void;
  onTransportFailure(message: string): void;
  onRecordingChanged(): void;
}

export interface FakeRuntimeStats {
  captureStarts: number;
  captureStops: number;
  captureRunning: boolean;
  playbackPauses: number;
  playbackResumes: number;
  playbackStops: PlaybackStopReason[];
}

export interface LiveRuntimeTestApi {
  emit<T extends HostEvent['type']>(type: T, payload: HostEventPayload<T>, epoch?: number): Promise<void>;
  partial(text: string): Promise<void>;
  audio(playbackId: string, sampleOffset: number, samples: number): Promise<void>;
  capture(): void;
  degrade(message: string): void;
  stats(): FakeRuntimeStats & {
    captureFrames: number;
    progressReports: number;
    terminalReceipts: number;
    commands: string[];
  };
}

export interface LiveRuntimeOptions {
  sessionId: string;
  capability: string;
  writer: StableTurnWriter;
  initialState?: SessionViewState;
  seed: string;
  reasoningMode: 'full' | 'transcript_only';
  settings: SessionSettingsSnapshot;
  planning?: SessionPlanningRequest;
  activate: () => Promise<void>;
  callbacks: LiveSessionRuntimeCallbacks;
  fake?: boolean;
  stats?: FakeRuntimeStats;
  /** Narrow seams used by lifecycle tests; production uses browser implementations. */
  transport?: SessionTransport;
  openRecordingStore?: () => Promise<RecordingStore>;
  createCapture?: (
    streamId?: number,
    onAudio?: (audio: Parameters<RecordingRecorder['onCaptureAudio']>[0]) => void,
  ) => Promise<CaptureHandle>;
  createEncoder?: () => EncodeMp3;
}

class InstrumentedPlayback implements ControlledPlayback {
  constructor(
    private readonly playback: BrowserPlayback,
    private readonly stats: FakeRuntimeStats,
  ) {}
  setGeneratedSamples(samples: number): void {
    this.playback.setGeneratedSamples(samples);
  }
  append(offset: number, pcm16: Int16Array): void {
    this.playback.append(offset, pcm16);
  }
  async pause(): Promise<ReturnType<ControlledPlayback['pause']> extends Promise<infer T> ? T : never> {
    this.stats.playbackPauses++;
    return this.playback.pause();
  }
  async resume(rewindMs?: number): Promise<void> {
    this.stats.playbackResumes++;
    await this.playback.resume(rewindMs);
  }
  stop(reason: PlaybackStopReason) {
    return this.playback.stop(reason);
  }
}

function fakeHostEvent<T extends HostEvent['type']>(
  sessionId: string,
  epoch: number,
  type: T,
  payload: HostEventPayload<T>,
): HostEvent {
  return createEnvelope({ sessionId, epoch, type, payload }) as HostEvent;
}

class Runtime implements LiveSessionRuntime {
  private store: RecordingStore | undefined;
  private recorder: RecordingRecorder | undefined;
  private transport: SessionTransport | undefined;
  private controller: SessionController | undefined;
  private capture: CaptureHandle | undefined;
  private streamId: number | undefined;
  private recovery: Promise<void> | undefined;
  private generation = 0;
  private stopped = false;
  private disposed = false;
  private released = false;
  private readonly unsubs: Array<() => void> = [];
  private readonly stats: FakeRuntimeStats;
  private readonly options: LiveRuntimeOptions;

  private constructor(options: LiveRuntimeOptions) {
    this.options = options;
    this.stats = options.stats ?? {
      captureStarts: 0,
      captureStops: 0,
      captureRunning: false,
      playbackPauses: 0,
      playbackResumes: 0,
      playbackStops: [],
    };
  }

  static async create(options: LiveRuntimeOptions): Promise<LiveSessionRuntime> {
    const runtime = new Runtime(options);
    try {
      await runtime.open();
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  get sessionId(): string {
    return this.options.sessionId;
  }
  snapshot(): SessionViewState {
    return this.controller?.snapshot() ?? this.options.initialState ?? initialSessionState;
  }

  /**
   * Pre-live open: composes storage, recorder, transport, and controller, and
   * sends session.open (optionally starting preparation). It never acquires or
   * processes microphone audio: no getUserMedia, no recorder capture feed, no
   * capture stream, and no activation of the local session row. beginLive() is
   * the only path into live capture.
   */
  private async open(): Promise<void> {
    const store = await (this.options.openRecordingStore ?? (() => RecordingStore.open()))();
    this.store = store;
    const recorder = new RecordingRecorder({
      sessionId: this.sessionId,
      store,
      encode: this.options.createEncoder?.() ?? createEncoderClient(),
    });
    await recorder.start();
    this.recorder = recorder;
    const transport =
      this.options.transport ??
      (this.options.fake
        ? new FakeSessionTransport()
        : new WebSocketSessionTransport(this.sessionId, () => this.controller?.snapshot().epoch ?? 0));
    this.transport = transport;
    await transport.connect(this.options.capability);
    this.unsubs.push(transport.onEvent((event) => recorder.onSessionEvent(event)));
    let controller!: SessionController;
    controller = new SessionController({
      sessionId: this.sessionId,
      transport,
      writer: this.options.writer,
      ...(this.options.initialState
        ? {
            initialState: this.options.fake
              ? {
                  ...this.options.initialState,
                  audioEngine: { status: 'ready', capture: 'ready', vad: 'ready', tts: 'ready' },
                }
              : this.options.initialState,
          }
        : {}),
      playbackFactory: (input) => {
        const playback = new BrowserPlayback(
          input.playbackId,
          input.outputEpoch,
          input.sampleRate,
          {
            progress: (progress) => controller.reportPlaybackProgress(progress),
            terminal: (receipt) => {
              recorder.onSessionEvent(
                createEnvelope({
                  sessionId: this.sessionId,
                  epoch: controller.snapshot().epoch,
                  type: 'playback.stopped',
                  payload: { ...receipt },
                }),
              );
              if (this.options.fake) this.stats.playbackStops.push(receipt.reason);
              return controller.reportPlaybackTerminal(receipt);
            },
            degraded: (message) => controller.degrade(message),
          },
          undefined,
          (audio) => recorder.onPlaybackAudio(audio),
        );
        return this.options.fake ? new InstrumentedPlayback(playback, this.stats) : playback;
      },
    });
    this.controller = controller;
    this.unsubs.push(controller.subscribe((state) => this.options.callbacks.onView(state)));
    this.unsubs.push(
      transport.onFailure((message) => {
        this.options.callbacks.onTransportFailure(message);
        this.generation++;
        const capture = this.capture;
        this.capture = undefined;
        this.streamId = undefined;
        void capture?.stop().catch(() => undefined);
      }),
    );
    transport.openSession({
      sessionSeed: this.options.seed,
      reasoningMode: this.options.reasoningMode,
      ...(this.options.planning ? { planning: this.options.planning } : {}),
      settings: this.options.settings,
    });
    const fakeTransport = this.options.fake ? (transport as FakeSessionTransport) : undefined;
    if (fakeTransport && this.options.planning)
      await fakeTransport.emit(
        fakeHostEvent(this.sessionId, controller.snapshot().epoch, 'session.state', {
          phase: 'preparing',
          personaDigest: '0'.repeat(64),
          planning: {
            status: 'planning',
            attempt: 1,
            stage: 'starting',
            topic: this.options.planning.topic,
            depth: this.options.planning.depth,
            detail: 'Fake services are preparing the briefing. The microphone stays off until you go live.',
          },
        }),
      );
  }

  private beginning: Promise<void> | undefined;

  /**
   * The explicit Begin live action. Mutexed and retryable while pre-live: it
   * sends session.begin (the host cancels any running preparation first and
   * awaits its terminal state), activates the local session row only after the
   * host acknowledges, and only then starts BrowserCapture. Any failure leaves
   * the runtime pre-live without a leaked capture stream.
   */
  async beginLive(): Promise<void> {
    if (this.beginning) return this.beginning;
    if (this.stopped || this.disposed) throw new Error('The session is not pre-live.');
    if (!this.transport || !this.controller) throw new Error('The session is not open.');
    const transport = this.transport;
    const controller = this.controller;
    const recorder = this.recorder!;
    let liveStreamId: number | undefined;
    const run = (async () => {
      try {
        if (this.options.fake) {
          await this.options.activate();
          await this.startCapture();
          if (this.options.planning)
            await (transport as FakeSessionTransport).emit(
              fakeHostEvent(this.sessionId, controller.snapshot().epoch, 'session.state', {
                phase: 'listening',
                personaDigest: '0'.repeat(64),
              }),
            );
        } else {
          const random = new Uint32Array(1);
          crypto.getRandomValues(random);
          const streamId = random[0] ?? 0;
          liveStreamId = streamId;
          await transport.beginLive(streamId);
          await this.options.activate();
          let audioReady = false;
          const pending: Uint8Array[] = [];
          this.capture = await this.makeCapture(
            streamId,
            (audio) => recorder.onCaptureAudio(audio),
            (frame) => {
              if (audioReady) void transport.sendCapture(frame);
              else if (pending.length < 128) pending.push(frame);
              else controller.degrade('Microphone audio arrived before the audio engine was ready.');
            },
          );
          this.streamId = streamId;
          audioReady = true;
          for (const frame of pending.splice(0)) void transport.sendCapture(frame);
          this.stats.captureStarts++;
          this.unsubs.push(transport.onReconnect(() => this.recoverCapture()));
        }
      } catch (error) {
        // Roll back any partial capture so a failed begin never leaves a live
        // microphone stream behind; the session stays pre-live and retryable.
        const capture = this.capture;
        this.capture = undefined;
        this.streamId = undefined;
        if (capture) await capture.stop().catch(() => undefined);
        if (!this.options.fake) await Promise.resolve(transport.rollbackLive()).catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      if (this.beginning === run) this.beginning = undefined;
    });
    this.beginning = run;
    return run;
  }

  async cancelPlanning(): Promise<void> {
    await this.transport?.cancelPlanning();
  }

  async retryPlanning(): Promise<void> {
    await this.transport?.retryPlanning();
  }

  private makeCapture(
    streamId?: number,
    onAudio?: (audio: Parameters<RecordingRecorder['onCaptureAudio']>[0]) => void,
    send?: (frame: Uint8Array) => void | Promise<void>,
  ): Promise<CaptureHandle> {
    if (this.options.createCapture) return this.options.createCapture(streamId, onAudio);
    const dependencies = {
      ...(streamId === undefined ? {} : { streamId: () => streamId }),
      ...(onAudio ? { onAudio } : {}),
    };
    return new BrowserCapture(dependencies).start({
      send: send ?? ((frame) => this.transport!.sendCapture(frame)),
      degraded: (message) => this.controller?.degrade(message),
    });
  }

  private async startCapture(): Promise<void> {
    const transport = this.transport!;
    const recorder = this.recorder!;
    const capture = await this.makeCapture(undefined, (audio) => recorder.onCaptureAudio(audio));
    this.capture = capture;
    this.stats.captureStarts++;
    if (this.options.fake) this.stats.captureRunning = true;
  }

  private async recoverCapture(): Promise<void> {
    if (this.recovery || this.stopped || this.disposed || this.options.fake) return this.recovery;
    let recovery!: Promise<void>;
    recovery = (async () => {
      const transport = this.transport!;
      const controller = this.controller!;
      const recorder = this.recorder!;
      const generation = ++this.generation;
      const oldCapture = this.capture;
      const oldStream = this.streamId;
      this.capture = undefined;
      this.streamId = undefined;
      if (oldCapture) await oldCapture.stop().catch(() => undefined);
      // Keep the host live during reconnect; audio.open rebinds the capture
      // stream. audio.stop is reserved for compensating a failed initial begin.
      if (this.stopped || this.disposed) return;
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      const streamId = random[0] ?? 0;
      try {
        await transport.startAudio(streamId);
        const recovered = await this.makeCapture(streamId, (audio) => recorder.onCaptureAudio(audio));
        if (generation !== this.generation || this.stopped || this.disposed) {
          await recovered.stop();
          await Promise.resolve(transport.stopAudio(streamId)).catch(() => undefined);
          return;
        }
        this.streamId = streamId;
        this.capture = recovered;
        activityLog.append({
          level: 'info',
          source: 'app',
          message: 'microphone capture recovered after transport reconnect',
        });
      } catch (error) {
        await Promise.resolve(transport.stopAudio(streamId)).catch(() => undefined);
        if (generation !== this.generation || this.stopped) return;
        controller.degrade(
          error instanceof Error ? error.message : 'The microphone could not be recovered after reconnecting.',
        );
      }
    })().finally(() => {
      if (this.recovery === recovery) this.recovery = undefined;
    });
    this.recovery = recovery;
    return recovery;
  }

  async cancelAssistant(): Promise<void> {
    await this.controller?.cancelAssistant();
  }

  async pause(): Promise<boolean> {
    if (this.disposed || this.stopped) return this.snapshot().dominant === 'paused';
    const controller = this.controller;
    if (!controller) return false;
    const paused = await controller.pause();
    if (!paused) return false;
    this.stopped = true;
    await this.releaseLiveResources(true);
    return true;
  }

  async stop(): Promise<void> {
    if (this.disposed || this.stopped) return;
    this.stopped = true;
    await this.releaseCapture();
    const controller = this.controller;
    await controller?.stop();
    await this.releaseRecording(true);
    this.transport?.disconnect();
    for (const unsubscribe of this.unsubs.splice(0)) unsubscribe();
    this.transport = undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    this.generation++;
    await this.releaseCapture();
    try {
      await this.controller?.pause();
    } catch {
      /* best effort during rollback */
    }
    await this.releaseRecording(true);
    this.transport?.disconnect();
    for (const unsubscribe of this.unsubs.splice(0)) unsubscribe();
    this.controller = undefined;
    this.transport = undefined;
  }

  private async releaseCapture(): Promise<void> {
    const capture = this.capture;
    this.capture = undefined;
    const streamId = this.streamId;
    this.streamId = undefined;
    if (capture) {
      try {
        await capture.stop();
      } catch {
        /* capture cleanup is best effort */
      }
      this.stats.captureStops++;
      this.stats.captureRunning = false;
    }
    if (streamId !== undefined) await Promise.resolve(this.transport?.stopAudio(streamId)).catch(() => undefined);
  }

  private async releaseRecording(finalize: boolean): Promise<void> {
    if (this.released) return;
    this.released = true;
    const recorder = this.recorder;
    if (recorder) {
      try {
        await recorder.stop(finalize);
      } catch (error) {
        activityLog.append({
          level: 'warn',
          source: 'app',
          message: 'recording cleanup failed',
          ...(error instanceof Error ? { detail: error.message } : {}),
        });
      }
    }
    this.recorder = undefined;
    this.options.callbacks.onRecordingChanged();
    this.store?.close();
    this.store = undefined;
  }

  async deleteRecording(): Promise<void> {
    if (!this.store) return;
    await deleteSessionRecording(this.sessionId, this.store);
    this.options.callbacks.onRecordingChanged();
  }

  async setItemsTrimmed(itemIds: string[], trimmed: boolean): Promise<void> {
    if (!this.store) throw new Error('Recording storage is not available.');
    await this.store.setItemsTrimmed(this.sessionId, itemIds, trimmed);
    this.options.callbacks.onRecordingChanged();
  }

  private async releaseLiveResources(finalize: boolean): Promise<void> {
    this.generation++;
    this.recovery = undefined;
    await this.releaseCapture();
    await this.releaseRecording(finalize);
    for (const unsubscribe of this.unsubs.splice(0)) unsubscribe();
  }

  async recordingSummaries(): Promise<{ enabled: boolean; summaries: RecordingItemSummary[] }> {
    if (!this.store) return { enabled: false, summaries: [] };
    const [enabled, summaries] = await Promise.all([
      this.store.getRecordingEnabled(),
      this.store.getSessionItemSummaries(this.sessionId),
    ]);
    return { enabled, summaries };
  }

  buildRecording(onProgress?: ExportOnProgress): ReturnType<typeof buildRecording> {
    if (!this.store) return Promise.resolve(null);
    const deps: Parameters<typeof buildRecording>[1] = {
      store: this.store,
      turns: this.options.writer,
      decode: createBrowserDecoder(),
      resample: offlineResample,
      encode: createEncoderClient(),
    };
    if (onProgress) deps.onProgress = onProgress;
    return buildRecording(this.sessionId, deps);
  }

  testApi(): LiveRuntimeTestApi | undefined {
    if (!this.options.fake || !this.transport || !this.controller) return undefined;
    const transport = this.transport as FakeSessionTransport;
    const controller = this.controller;
    return {
      emit: (type, payload, epoch = controller.snapshot().epoch) =>
        transport.emit(fakeHostEvent(this.sessionId, epoch, type, payload)),
      partial: (text) =>
        transport.emit(
          createEnvelope({
            sessionId: this.sessionId,
            epoch: controller.snapshot().epoch,
            type: 'transcript.partial',
            payload: { utteranceId: uuidV7(), sequence: 0, text, replacedCharacters: 0 },
          }),
        ),
      audio: async (playbackId, sampleOffset, samples) => {
        transport.emitAudio({ playbackId, sequence: 0, sampleOffset, pcm16: new Int16Array(samples) });
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      capture: () =>
        (
          window as unknown as {
            __podcasterFakeWorkletNode?: { port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } };
          }
        ).__podcasterFakeWorkletNode?.port.onmessage?.({ data: new Float32Array(961) } as MessageEvent<Float32Array>),
      degrade: (message) => controller.degrade(message),
      stats: () => ({
        ...this.stats,
        playbackStops: [...this.stats.playbackStops],
        captureFrames: transport.captureFrames.length,
        progressReports: transport.progressReports.length,
        terminalReceipts: transport.terminalReceipts.size,
        commands: [...transport.commands],
      }),
    };
  }
}

export function createLiveSessionRuntime(options: LiveRuntimeOptions): Promise<LiveSessionRuntime> {
  return Runtime.create(options);
}
