import { createHash, randomUUID } from 'node:crypto';
import { decodeBinaryAudioFrame, CONTRACT_VALIDATORS } from '@app/contracts';
import WebSocket, { type RawData } from 'ws';
import type { SidecarProcess } from './process.js';
import type { SpeechOutputPort, SpeechOutputStream, SpeechSynthesisStart } from '../session/SessionOrchestrator.js';

const MAX_PAYLOAD = 64 * 1024;
const MAX_BUFFERED_OUTPUT_CHUNKS = 64;
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
  private usedOutputStreams = new Set<number>();
  private readyStatus: 'starting' | 'ready' | 'failed' = 'starting';
  private readinessSeen = false;
  private failed = false;
  private closing = false;
  private connectPromise: Promise<void> | undefined;

  constructor(
    private readonly sidecar: SidecarProcess,
    private readonly events: AudioClientEvents = {},
    private readonly binarySink: (frame: Uint8Array) => void = () => {},
  ) {}

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

  async open(captureStreamId: number): Promise<string> {
    await this.connect();
    await this.waitUntilReady();
    if (this.streamId || this.failed || this.readyStatus !== 'ready') throw new Error('audio sidecar is not ready for a stream');
    const streamId = randomUUID();
    this.streamId = streamId;
    this.captureStreamId = captureStreamId;
    const opened = new Promise<void>((resolve, reject) => { this.openWaiter = { resolve, reject }; });
    this.send('stream.open', { streamId, captureStreamId, sampleRate: 16_000, frameSamples: 320 });
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
    const completion = new Promise<{ generatedSamples: number }>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    void completion.catch(() => undefined);
    const abort = () => this.cancel(input.responseId, input.partIndex);
    const pending: PendingTts = {
      key, responseId: input.responseId, epoch: input.epoch, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}),
      resolveStart, rejectStart, resolveCompletion, rejectCompletion,
      startSettled: false, sidecarStarted: false, completionSettled: false, remoteTerminal: false, expectedSequence: 0, receivedSamples: 0,
      cutoff: false, onGeneratedSamples: input.onGeneratedSamples, released: false, chunks: [], detachAbort: () => input.signal.removeEventListener('abort', abort),
    };
    this.pending.set(key, pending);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) {
      pending.cutoff = true;
      this.rejectPending(pending, new Error('TTS cancelled'));
      this.pending.delete(key);
    } else {
      this.sendForStream('tts.open', { responseId: input.responseId, epoch: input.epoch, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}) });
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
        client.sendForStream('tts.append', { responseId: input.responseId, epoch: input.epoch, sequence: appendSequence, text, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}) });
        appendSequence++;
      },
      finish(): void {
        if (pending.cutoff || pending.remoteTerminal) throw new Error('TTS stream is terminated');
        const sha256 = hasher.digest('hex');
        client.sendForStream('tts.commit', { responseId: input.responseId, epoch: input.epoch, nextSequence: appendSequence, textSha256: sha256, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), ...(input.partId ? { partId: input.partId } : {}) });
      },
    };

    return stream;
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
  resume(_responseId: string): void { /* browser is the audible resume authority */ }
  cancel(responseId: string, partIndex?: number): void {
    if (partIndex !== undefined) {
      const pending = this.pending.get(pendingKey(responseId, partIndex));
      if (!pending || pending.cutoff) return;
      pending.cutoff = true;
      pending.chunks.length = 0;
      if (this.streamOpened && this.socket?.readyState === WebSocket.OPEN) this.sendForStream('tts.cancel', { responseId, epoch: pending.epoch, partIndex });
      this.rejectPending(pending, new Error('TTS cancelled'));
      return;
    }
    for (const pending of this.pending.values()) {
      if (pending.responseId !== responseId || pending.cutoff) continue;
      pending.cutoff = true;
      pending.chunks.length = 0;
      if (this.streamOpened && this.socket?.readyState === WebSocket.OPEN) this.sendForStream('tts.cancel', { responseId, epoch: pending.epoch, ...(pending.partIndex !== undefined ? { partIndex: pending.partIndex } : {}) });
      this.rejectPending(pending, new Error('TTS cancelled'));
    }
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
    pending.playbackId = String(payload.playbackId);
    pending.outputStreamId = outputStreamId;
    pending.sampleRate = Number(payload.sampleRate);
    pending.sidecarStarted = true;
    this.usedOutputStreams.add(outputStreamId);
    if (!pending.cutoff) {
      pending.startSettled = true;
      const completion = (pending as PendingTts & { completion: Promise<{ generatedSamples: number }> }).completion;
      pending.resolveStart({ playbackId: pending.playbackId, sampleRate: pending.sampleRate, completion, ...(pending.partIndex !== undefined ? { partIndex: pending.partIndex } : {}), ...(pending.partId ? { partId: pending.partId } : {}), ...(pending.outputStreamId !== undefined ? { outputStreamId: pending.outputStreamId } : {}) });
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
  }
  private ttsCancelled(payload: JsonObject): void {
    const pending = this.pending.get(pendingKey(String(payload.responseId), typeof payload.partIndex === "number" ? payload.partIndex : undefined));
    if (!pending || !pending.cutoff || pending.remoteTerminal || payload.epoch !== pending.epoch) return this.protocolFailure();
    pending.remoteTerminal = true;
    pending.chunks.length = 0;
    this.rejectPending(pending, new Error('TTS cancelled'));
    this.pending.delete(pending.key);
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
  }
}
