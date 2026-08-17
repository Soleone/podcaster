import { createHash, randomUUID } from 'node:crypto';
import { decodeBinaryAudioFrame, CONTRACT_VALIDATORS, DEFAULT_TTS_MODEL, DEFAULT_VOICE_SPEED_MODIFIER } from '@app/contracts';
import WebSocket, { type RawData } from 'ws';
import type { SidecarProcess } from './process.js';
import type { SpeechOutputPort, SpeechOutputStream, SpeechSynthesisStart } from '../session/SessionOrchestrator.js';

const MAX_PAYLOAD = 64 * 1024;
const MAX_BUFFERED_OUTPUT_CHUNKS = 64;
// Decision 007 two-stream prefetch: never open more than two nonterminal TTS
// streams on the sidecar; a third begin() waits (FIFO) for the oldest to
// terminalize before its tts.open is sent. The sidecar keeps a defensive
// len(state.tts) >= 2 bound for uncoordinated clients.
const MAX_ADMITTED_TTS = 2;
// AudioClient is a WebSocket *client* to the sidecar, so its closes must use
// client-valid application codes (3000-4999); 1008/1011 are server-only.
// node ws accepts any code, so these are symmetry/hygiene only.
const CLOSE_PROTOCOL_VIOLATION = 4001;
const CLOSE_SIDECAR_FAILURE = 4002;
function rawBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) { const value = Buffer.concat(raw); return new Uint8Array(value.buffer, value.byteOffset, value.byteLength); }
  return new Uint8Array(raw);
}
type JsonObject = Record<string, unknown>;
export interface VadStartEvent { streamId: string; utteranceId: string; captureStartSequence: number }
export interface VadEndEvent { streamId: string; utteranceId: string; captureStartSequence: number; captureEndSequence: number }
export interface SttPartial { streamId: string; utteranceId: string; epoch: number; sequence: number; text: string; replacedCharacters: number }
export interface SttFinal { streamId: string; utteranceId: string; epoch: number; text: string; endpointComplete: true }
export interface AudioClientVoiceSelection { catalogId: string; voiceId: string; speedModifier?: number; tonePrompt?: string; backendId?: string; modelId?: string }
export interface AudioClientEvents {
  speechStart?(event: VadStartEvent): void;
  speechEnd?(event: VadEndEvent): void;
  partial?(event: SttPartial): void;
  final?(event: SttFinal): void;
  failure?(code: string): void;
}
interface PendingTts {
  key: string;
  responseId: string;
  partIndex?: number;
  partId?: string;
  epoch: number;
  resolveStart(value: SpeechSynthesisStart): void;
  rejectStart(error: Error): void;
  resolveCompletion(value: { generatedSamples: number }): void;
  rejectCompletion(error: Error): void;
  startSettled: boolean;
  sidecarStarted: boolean;
  completionSettled: boolean;
  remoteTerminal: boolean;
  playbackId?: string;
  outputStreamId?: number;
  sampleRate?: number;
  expectedSequence: number;
  receivedSamples: number;
  cutoff: boolean;
  onGeneratedSamples: ((total: number) => void) | undefined;
  released: boolean;
  chunks: Uint8Array[];
  queued: boolean;
  bufferedAppends: string[];
  bufferedCommit: { nextSequence: number; textSha256: string } | undefined;
  detachAbort(): void;
}
interface ActiveUtterance {
  utteranceId: string;
  captureStartSequence: number;
  epoch?: number;
  expectedPartialSequence: number;
  speechEnded: boolean;
}
interface OpenWaiter { resolve(): void; reject(error: Error): void }

function pendingKey(responseId: string, partIndex?: number): string {
  return partIndex === undefined ? responseId : `${responseId}:${partIndex}`;
}

export class AudioClient implements SpeechOutputPort {
  private socket: WebSocket | undefined;
  private streamId: string | undefined;
  private captureStreamId: number | undefined;
  private streamOpened = false;
  private openWaiter: OpenWaiter | undefined;
  private utterance: ActiveUtterance | undefined;
  private pending = new Map<string, PendingTts>();
  private admitted: PendingTts[] = [];
  private queued: PendingTts[] = [];
  private usedOutputStreams = new Set<number>();
  private readyStatus: 'starting' | 'ready' | 'failed' = 'starting';
  private readinessSeen = false;
  private failed = false;
  private closing = false;
  private connectPromise: Promise<void> | undefined;
  private readonly sidecar: SidecarProcess;
  private readonly events: AudioClientEvents;
  private readonly binarySink: (frame: Uint8Array) => void;
  private readonly selection: AudioClientVoiceSelection | undefined;
  private readonly voiceId: string;
  private readonly speedModifier: number;
  private readonly tonePrompt: string | undefined;
  private readonly backendId: string;
  private readonly modelId: string;
  private readonly explicitModelSelection: boolean;

  constructor(
    sidecar: SidecarProcess,
    events: AudioClientEvents = {},
    binarySink: (frame: Uint8Array) => void = () => {},
    selection?: AudioClientVoiceSelection,
  ) {
    this.sidecar = sidecar;
    this.events = events;
    this.binarySink = binarySink;
    this.selection = selection;
    this.voiceId = selection?.voiceId ?? 'af_heart';
    this.speedModifier = selection?.speedModifier ?? DEFAULT_VOICE_SPEED_MODIFIER;
    this.tonePrompt = selection?.tonePrompt;
    this.backendId = selection?.backendId ?? DEFAULT_TTS_MODEL.backendId;
    this.modelId = selection?.modelId ?? DEFAULT_TTS_MODEL.modelId;
    this.explicitModelSelection = selection?.backendId !== undefined || selection?.modelId !== undefined;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.sidecar.origin.replace(/^http/, 'ws')}/stream`, {
        headers: { authorization: `Bearer ${this.sidecar.secret}` },
        origin: undefined,
        maxPayload: MAX_PAYLOAD,
        perMessageDeflate: false,
      });
      this.socket = socket;
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('audio sidecar connection timed out')); }, 5_000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.on('message', (data, binary) => this.handleMessage(data, binary));
      socket.once('error', error => { clearTimeout(timer); this.connectionFailure('audio sidecar unavailable'); reject(error); });
      socket.once('close', () => { if (!this.closing) this.connectionFailure('audio sidecar closed'); });
    });
    return this.connectPromise;
  }

  readiness(): 'starting' | 'ready' | 'failed' { return this.readyStatus; }

  async open(captureStreamId: number, streamMode: 'capture' | 'preview' = 'capture'): Promise<string> {
    await this.connect();
    await this.waitUntilReady();
    if (this.failed || this.readyStatus !== 'ready') throw new Error('audio sidecar is not ready for a stream');
    // The sidecar owns one long-lived stream per AudioClient. Browser pause
    // stops microphone capture, but must not try to open a second sidecar stream
    // on resume. Rebind the capture stream id and reset VAD state instead.
    if (this.streamId && this.streamOpened) {
      if (streamMode !== 'capture') throw new Error('audio sidecar stream mode cannot change');
      this.captureStreamId = captureStreamId;
      this.reset();
      return this.streamId;
    }
    if (this.streamId) throw new Error('audio sidecar stream is still opening');
    const streamId = randomUUID();
    this.streamId = streamId;
    this.captureStreamId = captureStreamId;
    const opened = new Promise<void>((resolve, reject) => { this.openWaiter = { resolve, reject }; });
    this.send('stream.open', {
      streamId,
      captureStreamId,
      sampleRate: 16_000,
      frameSamples: 320,
      streamMode,
      // The catalog identity is part of the selectable-model extension. Keep
      // the legacy Kokoro stream shape unchanged for older sidecars; Qwen and
      // other non-default backends must carry it so the sidecar can reject
      // stale catalog-bound preferences before TTS admission.
      ...(this.selection && (this.backendId !== DEFAULT_TTS_MODEL.backendId || this.modelId !== DEFAULT_TTS_MODEL.modelId) ? { catalogId: this.selection.catalogId } : {}),
      ...(this.explicitModelSelection && (this.backendId !== DEFAULT_TTS_MODEL.backendId || this.modelId !== DEFAULT_TTS_MODEL.modelId) ? { backendId: this.backendId, modelId: this.modelId } : {}),
    });
    await opened;
    return streamId;
  }

  input(frame: Uint8Array): void {
    // After a sidecar failure the stream is terminal; drop capture frames so the
    // session degrades gracefully instead of throwing (which would surface as a
    // browser protocol error and close the browser socket).
    if (this.failed) return;
    if (!this.streamId || !this.streamOpened) throw new Error('audio stream is not open');
    const decoded = decodeBinaryAudioFrame(frame, MAX_PAYLOAD - 20);
    if (decoded.channel !== 1 || decoded.streamId !== this.captureStreamId || decoded.pcm16.length !== 320) throw new Error('invalid capture frame');
    this.readySocket().send(frame, { binary: true });
  }

  bindEpoch(utteranceId: string, epoch: number): void {
    const utterance = this.utterance;
    if (!utterance || utterance.utteranceId !== utteranceId || utterance.epoch !== undefined) throw new Error('unknown, stale, or bound utterance');
    utterance.epoch = epoch;
    this.sendForStream('stt.bind_epoch', { utteranceId, epoch });
  }
  reset(): void {
    this.requireOpened();
    this.utterance = undefined;
    this.sendForStream('stream.reset', {});
  }

  synthesize(input: { sessionId: string; epoch: number; responseId: string; partIndex?: number; partId?: string; text: string; signal: AbortSignal; onGeneratedSamples?: (total: number) => void }): Promise<SpeechSynthesisStart> {
    const stream = this.begin({ sessionId: input.sessionId, epoch: input.epoch, responseId: input.responseId, signal: input.signal, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}), ...(input.onGeneratedSamples ? { onGeneratedSamples: input.onGeneratedSamples } : {}) });
    stream.append(input.text);
    stream.finish();
    return stream.started;
  }

  begin(input: { sessionId: string; epoch: number; responseId: string; partIndex?: number; partId?: string; signal: AbortSignal; onGeneratedSamples?: (total: number) => void }): SpeechOutputStream {
    void input.sessionId;
    this.requireOpened();
    const key = pendingKey(input.responseId, input.partIndex);
    if (this.pending.has(key)) throw new Error('duplicate TTS response');
    let resolveStart!: (value: SpeechSynthesisStart) => void;
    let rejectStart!: (error: Error) => void;
    let resolveCompletion!: (value: { generatedSamples: number }) => void;
    let rejectCompletion!: (error: Error) => void;
    const started = new Promise<SpeechSynthesisStart>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    // Mirror the completion guard: started can be rejected before any caller
    // attaches a handler (cancel/failAll races, or an aborted signal that makes
    // synthesize() throw out of append() before returning started). Swallow the
    // potential unhandled rejection; awaited copies still surface errors.
    void started.catch(() => undefined);
    const completion = new Promise<{ generatedSamples: number }>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    void completion.catch(() => undefined);
    const abort = () => this.cancel(input.responseId, input.partIndex);
    const pending: PendingTts = {
      key, responseId: input.responseId, epoch: input.epoch, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}),
      resolveStart, rejectStart, resolveCompletion, rejectCompletion,
      startSettled: false, sidecarStarted: false, completionSettled: false, remoteTerminal: false, expectedSequence: 0, receivedSamples: 0,
      cutoff: false, onGeneratedSamples: input.onGeneratedSamples, released: false, chunks: [], queued: false, bufferedAppends: [], bufferedCommit: undefined, detachAbort: () => input.signal.removeEventListener('abort', abort),
    };
    this.pending.set(key, pending);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) {
      pending.cutoff = true;
      this.rejectPending(pending, new Error('TTS cancelled'));
      this.pending.delete(key);
    } else if (this.admitted.length < MAX_ADMITTED_TTS) {
      // A slot is free: admit immediately and open on the sidecar. The stall
      // (part 0) is always the first begin() so it always gets the first slot.
      this.admitted.push(pending);
      this.sendForStream('tts.open', this.ttsFields(input));
    } else {
      // Both slots are held by nonterminal streams. Queue FIFO and buffer the
      // stream locally; append()/finish() will be flushed when the oldest
      // admitted stream reports terminal (tts.ended / tts.cancelled).
      pending.queued = true;
      this.queued.push(pending);
    }
    (pending as PendingTts & { completion?: Promise<{ generatedSamples: number }> }).completion = completion;

    let appendSequence = 0;
    const hasher = createHash('sha256');
    const client = this;

    const stream: SpeechOutputStream = {
      started,
      append(text: string): void {
        if (pending.cutoff || pending.remoteTerminal) throw new Error('TTS stream is terminated');
        if (!text.trim()) throw new Error('empty append');
        hasher.update(text, 'utf8');
        if (pending.queued) {
          // No wire commands while queued; the flush replays these in order.
          pending.bufferedAppends.push(text);
          return;
        }
        client.sendForStream('tts.append', { responseId: input.responseId, epoch: input.epoch, sequence: appendSequence, text, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}) });
        appendSequence++;
      },
      finish(): void {
        if (pending.cutoff || pending.remoteTerminal) throw new Error('TTS stream is terminated');
        const sha256 = hasher.digest('hex');
        if (pending.queued) {
          pending.bufferedCommit = { nextSequence: pending.bufferedAppends.length, textSha256: sha256 };
          return;
        }
        client.sendForStream('tts.commit', { responseId: input.responseId, epoch: input.epoch, nextSequence: appendSequence, textSha256: sha256, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}) });
      },
    };

    return stream;
  }

  private ttsFields(input: { responseId: string; epoch: number; partIndex?: number; partId?: string }): Record<string, unknown> {
    return { responseId: input.responseId, epoch: input.epoch, voiceId: this.voiceId, speedModifier: this.speedModifier, ...(this.tonePrompt ? { tonePrompt: this.tonePrompt } : {}), ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}) };
  }

  private removeAdmitted(pending: PendingTts): void {
    const index = this.admitted.indexOf(pending);
    if (index >= 0) this.admitted.splice(index, 1);
  }

  private flushQueue(): void {
    while (this.admitted.length < MAX_ADMITTED_TTS && this.queued.length > 0) {
      const pending = this.queued.shift()!;
      pending.queued = false;
      this.admitted.push(pending);
      this.sendForStream('tts.open', { responseId: pending.responseId, epoch: pending.epoch, voiceId: this.voiceId, speedModifier: this.speedModifier, ...(this.tonePrompt ? { tonePrompt: this.tonePrompt } : {}), ...(pending.partIndex !== undefined ? { partIndex: pending.partIndex } : {}), ...(pending.partId ? { partId: pending.partId } : {}) });
      for (let index = 0; index < pending.bufferedAppends.length; index++) {
        this.sendForStream('tts.append', { responseId: pending.responseId, epoch: pending.epoch, sequence: index, text: pending.bufferedAppends[index]!, ...(pending.partIndex !== undefined ? { partIndex: pending.partIndex } : {}), ...(pending.partId ? { partId: pending.partId } : {}) });
      }
      if (pending.bufferedCommit) {
        this.sendForStream('tts.commit', { responseId: pending.responseId, epoch: pending.epoch, nextSequence: pending.bufferedCommit.nextSequence, textSha256: pending.bufferedCommit.textSha256, ...(pending.partIndex !== undefined ? { partIndex: pending.partIndex } : {}), ...(pending.partId ? { partId: pending.partId } : {}) });
      }
    }
  }

  release(responseId: string, partIndex?: number): void {
    const wantKey = pendingKey(responseId, partIndex);
    const pending = this.pending.get(wantKey);
    if (!pending || pending.cutoff || pending.released || !pending.playbackId) return;
    pending.released = true;
    for (const chunk of pending.chunks) this.binarySink(chunk);
    pending.chunks.length = 0;
  }

  pause(_responseId: string): void { /* browser is the audible pause authority */ }
  resume(_responseId: string, _rewindMs?: number): void { /* browser is the audible resume authority */ }
  cancel(responseId: string, partIndex?: number): void {
    if (partIndex !== undefined) {
      const pending = this.pending.get(pendingKey(responseId, partIndex));
      if (!pending || pending.cutoff) return;
      pending.cutoff = true;
      pending.chunks.length = 0;
      if (pending.queued) {
        this.removeQueued(pending);
        this.rejectPending(pending, new Error('TTS cancelled'));
        this.pending.delete(pending.key);
        return;
      }
      if (this.streamOpened && this.socket?.readyState === WebSocket.OPEN) this.sendForStream('tts.cancel', { responseId, epoch: pending.epoch, partIndex });
      this.rejectPending(pending, new Error('TTS cancelled'));
      return;
    }
    for (const pending of this.pending.values()) {
      if (pending.responseId !== responseId || pending.cutoff) continue;
      pending.cutoff = true;
      pending.chunks.length = 0;
      if (pending.queued) {
        this.removeQueued(pending);
        this.rejectPending(pending, new Error('TTS cancelled'));
        this.pending.delete(pending.key);
        continue;
      }
      if (this.streamOpened && this.socket?.readyState === WebSocket.OPEN) this.sendForStream('tts.cancel', { responseId, epoch: pending.epoch, ...(pending.partIndex !== undefined ? { partIndex: pending.partIndex } : {}) });
      this.rejectPending(pending, new Error('TTS cancelled'));
    }
  }

  private removeQueued(pending: PendingTts): void {
    const index = this.queued.indexOf(pending);
    if (index >= 0) this.queued.splice(index, 1);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.streamId && this.streamOpened && this.socket?.readyState === WebSocket.OPEN) this.sendForStream('stream.close', {});
    this.streamId = undefined;
    this.captureStreamId = undefined;
    this.streamOpened = false;
    this.utterance = undefined;
    this.failAll(new Error('audio client closed'));
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.close(1000, 'stream closed'); setTimeout(() => { socket.terminate(); resolve(); }, 500); });
  }

  private handleMessage(raw: RawData, binary: boolean): void {
    if (this.failed || this.closing) return;
    if (binary) { this.handleBinary(rawBytes(raw)); return; }
    let value: unknown;
    try { value = JSON.parse(raw.toString()); } catch { this.protocolFailure(); return; }
    if (!CONTRACT_VALIDATORS.SidecarMessage(value)) { this.protocolFailure(); return; }
    const message = value as { type: string; payload: JsonObject };
    const payload = message.payload;
    if (message.type === 'readiness.snapshot') {
      if (this.readinessSeen || this.streamId) return this.protocolFailure();
      this.readinessSeen = true;
      this.readyStatus = payload.status as typeof this.readyStatus;
      // Fail closed when a session voice/model selection cannot be reconciled
      // against the current verified catalog before any stream opens. Older
      // sidecars expose only the default Kokoro catalog, which remains valid for
      // legacy clients.
      if (this.readyStatus === 'ready' && this.selection) {
        const selection = this.selection;
        const models = Array.isArray(payload.ttsModels) ? payload.ttsModels as Array<{
          backendId?: unknown;
          modelId?: unknown;
          status?: unknown;
          speed?: { supported?: unknown; min?: unknown; max?: unknown; default?: unknown };
          voiceCatalog?: { catalogId?: unknown; backendId?: unknown; modelId?: unknown; speed?: { supported?: unknown; min?: unknown; max?: unknown; default?: unknown }; voices?: Array<{ id?: unknown }> };
        }> : [];
        const descriptor = models.find(model => model.backendId === this.backendId && model.modelId === this.modelId);
        const catalog = descriptor?.voiceCatalog ?? (this.backendId === DEFAULT_TTS_MODEL.backendId && this.modelId === DEFAULT_TTS_MODEL.modelId
          ? payload.voiceCatalog as { catalogId?: unknown; backendId?: unknown; modelId?: unknown; speed?: { supported?: unknown; min?: unknown; max?: unknown; default?: unknown }; voices?: Array<{ id?: unknown }> } | undefined
          : undefined);
        const voices = catalog?.voices;
        const speed = descriptor?.speed ?? catalog?.speed;
        const modelAvailable = descriptor === undefined || descriptor.status === 'ready';
        const catalogMatches = typeof catalog?.catalogId === 'string' && catalog.catalogId === selection.catalogId;
        const voicePresent = Array.isArray(voices) && voices.some(voice => voice.id === selection.voiceId);
        const speedValid = speed === undefined || (
          typeof speed === 'object' && speed !== null
          && typeof speed.supported === 'boolean'
          && typeof speed.min === 'number' && typeof speed.max === 'number' && typeof speed.default === 'number'
          && Number.isFinite(speed.min) && Number.isFinite(speed.max) && Number.isFinite(speed.default)
          && Number.isFinite(this.speedModifier)
          && this.speedModifier >= speed.min && this.speedModifier <= speed.max
          && (speed.supported || this.speedModifier === speed.default)
        );
        if (!modelAvailable) {
          this.failed = true;
          this.readyStatus = 'failed';
          this.events.failure?.('tts_model_unavailable');
          this.failAll(new Error('selected TTS model is unavailable; Kokoro remains available as the fallback'));
          this.socket?.close(CLOSE_SIDECAR_FAILURE, 'selected TTS model unavailable');
        } else if (!catalogMatches || !voicePresent) {
          this.failed = true;
          this.readyStatus = 'failed';
          this.events.failure?.('catalog_mismatch');
          this.failAll(new Error('audio sidecar catalog drifted from the session voice selection'));
          this.socket?.close(CLOSE_SIDECAR_FAILURE, 'audio voice catalog mismatch');
        } else if (!speedValid) {
          this.failed = true;
          this.readyStatus = 'failed';
          this.events.failure?.('unsupported_speed');
          this.failAll(new Error('selected TTS speed is not supported by the active model'));
          this.socket?.close(CLOSE_SIDECAR_FAILURE, 'unsupported TTS speed');
        }
      }
      return;
    }
    if (message.type === 'stream.opened') { this.streamOpenedMessage(payload); return; }
    if (message.type === 'stream.closed') return this.protocolFailure();
    if (message.type === 'sidecar.failure') {
      this.failed = true;
      this.readyStatus = 'failed';
      this.events.failure?.(String(payload.code));
      this.failAll(new Error('audio sidecar runtime failed'));
      this.socket?.close(CLOSE_SIDECAR_FAILURE, 'audio sidecar runtime failed');
      return;
    }
    if (!this.streamOpened || payload.streamId !== this.streamId) return this.protocolFailure();
    if (message.type === 'vad.speech_start') this.speechStart(payload);
    else if (message.type === 'vad.speech_end') this.speechEnd(payload);
    else if (message.type === 'stt.partial') this.sttPartial(payload);
    else if (message.type === 'stt.final') this.sttFinal(payload);
    else if (message.type === 'tts.started') this.ttsStarted(payload);
    else if (message.type === 'tts.ended') this.ttsEnded(payload);
    else if (message.type === 'tts.cancelled') this.ttsCancelled(payload);
    else this.protocolFailure();
  }

  private streamOpenedMessage(payload: JsonObject): void {
    if (!this.streamId || this.streamOpened || !this.openWaiter || payload.streamId !== this.streamId) return this.protocolFailure();
    if (payload.backendId !== undefined && payload.backendId !== this.backendId) return this.protocolFailure();
    if (payload.modelId !== undefined && payload.modelId !== this.modelId) return this.protocolFailure();
    if ((this.backendId !== DEFAULT_TTS_MODEL.backendId || this.modelId !== DEFAULT_TTS_MODEL.modelId)
      && (payload.backendId !== this.backendId || payload.modelId !== this.modelId)) return this.protocolFailure();
    if (this.selection && payload.voiceCatalog !== undefined) {
      const catalog = payload.voiceCatalog as JsonObject;
      if (catalog.catalogId !== this.selection.catalogId
        || catalog.backendId !== this.backendId
        || catalog.modelId !== this.modelId) return this.protocolFailure();
    }
    this.streamOpened = true;
    const waiter = this.openWaiter;
    this.openWaiter = undefined;
    waiter.resolve();
  }
  private speechStart(payload: JsonObject): void {
    if (this.utterance) return this.protocolFailure();
    this.utterance = { utteranceId: String(payload.utteranceId), captureStartSequence: Number(payload.captureStartSequence), expectedPartialSequence: 0, speechEnded: false };
    this.events.speechStart?.(payload as unknown as VadStartEvent);
  }
  private speechEnd(payload: JsonObject): void {
    const utterance = this.utterance;
    const captureEndSequence = payload.captureEndSequence;
    if (!utterance || utterance.speechEnded || payload.utteranceId !== utterance.utteranceId || payload.captureStartSequence !== utterance.captureStartSequence) return this.protocolFailure();
    if (!Number.isSafeInteger(captureEndSequence) || Number(captureEndSequence) < 0 || Number(captureEndSequence) < utterance.captureStartSequence) return this.protocolFailure();
    utterance.speechEnded = true;
    this.events.speechEnd?.(payload as unknown as VadEndEvent);
  }
  private sttPartial(payload: JsonObject): void {
    const utterance = this.utterance;
    if (!utterance || utterance.epoch === undefined || payload.utteranceId !== utterance.utteranceId || payload.epoch !== utterance.epoch || payload.sequence !== utterance.expectedPartialSequence) return this.protocolFailure();
    utterance.expectedPartialSequence++;
    this.events.partial?.(payload as unknown as SttPartial);
  }
  private sttFinal(payload: JsonObject): void {
    const utterance = this.utterance;
    if (!utterance || !utterance.speechEnded || utterance.epoch === undefined || payload.utteranceId !== utterance.utteranceId || payload.epoch !== utterance.epoch) return this.protocolFailure();
    this.events.final?.(payload as unknown as SttFinal);
    this.utterance = undefined;
  }

  private ttsStarted(payload: JsonObject): void {
    const pending = this.pending.get(pendingKey(String(payload.responseId), typeof payload.partIndex === "number" ? payload.partIndex : undefined));
    const outputStreamId = Number(payload.outputStreamId);
    if (!pending || pending.sidecarStarted || pending.epoch !== payload.epoch || this.usedOutputStreams.has(outputStreamId)) return this.protocolFailure();
    if (this.selection && payload.voiceId !== this.selection.voiceId) return this.protocolFailure();
    if ((payload.backendId === undefined) !== (payload.modelId === undefined)) return this.protocolFailure();
    if (payload.backendId !== undefined && payload.backendId !== this.backendId) return this.protocolFailure();
    if (payload.modelId !== undefined && payload.modelId !== this.modelId) return this.protocolFailure();
    if ((this.backendId !== DEFAULT_TTS_MODEL.backendId || this.modelId !== DEFAULT_TTS_MODEL.modelId)
      && (payload.backendId !== this.backendId || payload.modelId !== this.modelId)) return this.protocolFailure();
    pending.playbackId = String(payload.playbackId);
    pending.outputStreamId = outputStreamId;
    pending.sampleRate = Number(payload.sampleRate);
    pending.sidecarStarted = true;
    this.usedOutputStreams.add(outputStreamId);
    if (!pending.cutoff) {
      pending.startSettled = true;
      const completion = (pending as PendingTts & { completion: Promise<{ generatedSamples: number }> }).completion;
      pending.resolveStart({ playbackId: pending.playbackId, sampleRate: pending.sampleRate, completion, ...(payload.backendId !== undefined ? { backendId: String(payload.backendId) } : {}), ...(payload.modelId !== undefined ? { modelId: String(payload.modelId) } : {}), ...(pending.partIndex !== undefined ? { partIndex: pending.partIndex } : {}), ...(pending.partId ? { partId: pending.partId } : {}), ...(pending.outputStreamId !== undefined ? { outputStreamId: pending.outputStreamId } : {}) });
    }
  }

  private handleBinary(frame: Uint8Array): void {
    let decoded;
    try { decoded = decodeBinaryAudioFrame(frame, MAX_PAYLOAD - 20); } catch { this.protocolFailure(); return; }
    const pending = [...this.pending.values()].find(item => item.outputStreamId === decoded.streamId);
    if (!pending || !pending.sidecarStarted || pending.remoteTerminal || decoded.channel !== 2 || decoded.sequence !== pending.expectedSequence) return this.protocolFailure();
    pending.expectedSequence++;
    pending.receivedSamples += decoded.pcm16.length;
    if (pending.cutoff) return;
    pending.onGeneratedSamples?.(pending.receivedSamples);
    if (pending.released) this.binarySink(frame.slice());
    else {
      pending.chunks.push(frame.slice());
      if (pending.chunks.length > MAX_BUFFERED_OUTPUT_CHUNKS) this.protocolFailure();
    }
  }

  private ttsEnded(payload: JsonObject): void {
    const pending = this.pending.get(pendingKey(String(payload.responseId), typeof payload.partIndex === "number" ? payload.partIndex : undefined));
    if (!pending || pending.remoteTerminal || !pending.playbackId || pending.playbackId !== payload.playbackId || pending.epoch !== payload.epoch || !pending.sampleRate) return this.protocolFailure();
    const generatedSamples = Number(payload.generatedSamples);
    if (!Number.isSafeInteger(generatedSamples) || generatedSamples <= 0 || generatedSamples !== pending.receivedSamples) return this.protocolFailure();
    pending.remoteTerminal = true;
    pending.detachAbort();
    if (pending.cutoff) {
      pending.chunks.length = 0;
      this.rejectPending(pending, new Error('TTS cancelled'));
    } else if (!pending.completionSettled) {
      // The part is remotely complete. If the browser-facing release has not
      // happened yet (a multi-part body part commits synchronously right after
      // begin), flush the buffered PCM now so it is never dropped with the
      // pending entry. release() later is a no-op because the pending is gone.
      if (!pending.released) {
        for (const chunk of pending.chunks) this.binarySink(chunk);
        pending.chunks.length = 0;
      }
      pending.completionSettled = true;
      pending.resolveCompletion({ generatedSamples });
    }
    this.pending.delete(pending.key);
    this.removeAdmitted(pending);
    this.flushQueue();
  }
  private ttsCancelled(payload: JsonObject): void {
    const pending = this.pending.get(pendingKey(String(payload.responseId), typeof payload.partIndex === "number" ? payload.partIndex : undefined));
    if (!pending || !pending.cutoff || pending.remoteTerminal || payload.epoch !== pending.epoch) return this.protocolFailure();
    pending.remoteTerminal = true;
    pending.chunks.length = 0;
    this.rejectPending(pending, new Error('TTS cancelled'));
    this.pending.delete(pending.key);
    this.removeAdmitted(pending);
    this.flushQueue();
  }

  private sendForStream(type: string, payload: JsonObject): void {
    if (!this.streamId) throw new Error('audio stream is not open');
    this.send(type, { streamId: this.streamId, ...payload });
  }
  private send(type: string, payload: JsonObject): void { this.readySocket().send(JSON.stringify({ type, payload })); }
  private readySocket(): WebSocket { if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('audio sidecar is not connected'); return this.socket; }
  private requireOpened(): void { if (this.failed || !this.streamId || !this.streamOpened) throw new Error('audio stream is not open'); }
  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!this.readinessSeen && !this.failed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (!this.readinessSeen || this.readyStatus !== 'ready') throw new Error('audio sidecar is not ready');
  }
  private protocolFailure(): void {
    if (this.failed) return;
    this.failed = true;
    this.readyStatus = 'failed';
    this.events.failure?.('invalid_message');
    this.failAll(new Error('invalid sidecar protocol'));
    this.socket?.close(CLOSE_PROTOCOL_VIOLATION, 'invalid sidecar protocol');
  }
  private connectionFailure(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.readyStatus = 'failed';
    this.events.failure?.('sidecar_unavailable');
    this.failAll(new Error(message));
  }
  private rejectPending(pending: PendingTts, error: Error): void {
    pending.detachAbort();
    if (!pending.startSettled) { pending.startSettled = true; pending.rejectStart(error); }
    if (!pending.completionSettled) { pending.completionSettled = true; pending.rejectCompletion(error); }
  }
  private failAll(error: Error): void {
    this.openWaiter?.reject(error);
    this.openWaiter = undefined;
    for (const pending of this.pending.values()) { pending.cutoff = true; this.rejectPending(pending, error); }
    this.pending.clear();
    this.admitted.length = 0;
    this.queued.length = 0;
  }
}
