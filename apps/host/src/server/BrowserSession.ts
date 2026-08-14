import { randomBytes } from 'node:crypto';
import { composePersonaAppend, CONTRACT_VALIDATORS, decodeBinaryAudioFrame, isValidSessionSettingsSnapshot, normalizeVoicePreference, type SessionSettingsSnapshot } from '@app/contracts';
import type { WebSocket, RawData } from 'ws';
import type { PiClient } from '../pi/PiClient.js';
import type { PiResearchClient } from '../pi/PiResearchClient.js';
import { SessionOrchestrator, type SessionEvent } from '../session/SessionOrchestrator.js';
import { PiInterruptionIntentClassifier } from '../session/InterruptionIntentClassifier.js';
import { AudioClient, type SttFinal, type SttPartial, type VadEndEvent, type VadStartEvent } from '../sidecar/AudioClient.js';
import type { SidecarProcess } from '../sidecar/process.js';

const MAX_PENDING_FINALS = 8;
const MAX_COMPLETED_PERSISTENCE_ACKS = 64;
export interface BrowserSessionOptions {
  multiPartEnabled?: boolean;
  /** Session-owned response Pi client; receives the frozen persona append. */
  createResponseClient(personaAppend: string): PiClient;
  /** Session-owned research Pi client; receives the frozen persona append. */
  createResearchClient(personaAppend: string): PiResearchClient;
  /** Session-owned persona-neutral classifier client. */
  createClassifierClient(): PiClient;
}
function rawBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) { const value = Buffer.concat(raw); return new Uint8Array(value.buffer, value.byteOffset, value.byteLength); }
  return new Uint8Array(raw);
}
const MAX_BINARY_PAYLOAD = 64 * 1024 - 20;
interface PendingFinal { event: SessionEvent; turnId: string; text: string; epoch: number; failed: boolean }
interface CompletedPersistenceAck { turnId: string; epoch: number }

function uuidV7(): string {
  const bytes = randomBytes(16);
  let time = Date.now();
  for (let index = 5; index >= 0; index--) { bytes[index] = time & 0xff; time = Math.floor(time / 256); }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function event(sessionId: string, epoch: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { protocolVersion: 1, sessionId, epoch, eventId: uuidV7(), type, monotonicMs: Math.max(0, performance.now()), payload };
}

export class BrowserSession {
  private readonly socket: WebSocket;
  private readonly sidecar: SidecarProcess;
  private readonly options: BrowserSessionOptions;
  private sessionId: string | undefined;
  private orchestrator: SessionOrchestrator | undefined;
  private audio: AudioClient | undefined;
  private captureStreamId: number | undefined;
  private pending = new Map<string, PendingFinal>();
  private completedPersistenceAcks = new Map<string, CompletedPersistenceAck>();
  private stopped = false;
  private responsePi: PiClient | undefined;
  private researchPi: PiResearchClient | undefined;
  private classifierPi: PiClient | undefined;
  private ownedPis: Array<{ shutdown(): Promise<void> }> = [];

  constructor(socket: WebSocket, sidecar: SidecarProcess, options: BrowserSessionOptions) {
    this.socket = socket;
    this.sidecar = sidecar;
    this.options = options;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.orchestrator?.stop();
    this.pending.clear();
    this.completedPersistenceAcks.clear();
    await this.audio?.close();
    for (const client of this.ownedPis) {
      try { await client.shutdown(); } catch { /* best-effort child teardown */ }
    }
    this.responsePi = undefined;
    this.researchPi = undefined;
    this.classifierPi = undefined;
    this.ownedPis = [];
  }

  async handle(raw: RawData, binary: boolean): Promise<void> {
    if (this.stopped) { this.socket.close(1008, 'session already stopped'); return; }
    if (binary) {
      if (!this.orchestrator || this.captureStreamId === undefined) return this.protocolError('binary_before_audio_start');
      const bytes = rawBytes(raw);
      try {
        const decoded = decodeBinaryAudioFrame(bytes, MAX_BINARY_PAYLOAD);
        if (decoded.channel !== 1 || decoded.streamId !== this.captureStreamId || decoded.pcm16.length !== 320) throw new Error();
        this.audio!.input(bytes);
      } catch { this.protocolError('invalid_capture_frame'); }
      return;
    }
    let value: unknown;
    try { value = JSON.parse(raw.toString()); } catch { return this.protocolError('invalid_json'); }
    if (!CONTRACT_VALIDATORS.BrowserCommand(value)) return this.protocolError('invalid_command');
    const command = value as { sessionId: string; epoch: number; type: string; payload: Record<string, unknown> };
    if (this.sessionId && command.sessionId !== this.sessionId) return this.protocolError('session_mismatch');
    if (command.type === 'session.start') return this.start(command);
    if (!this.orchestrator || !this.sessionId) return this.protocolError('command_before_start');
    if (!['playback.stopped', 'playback.progress', 'playback.paused', 'turn.persisted', 'turn.persistence_failed'].includes(command.type) && command.epoch !== this.orchestrator.snapshot().epoch) return this.protocolError('epoch_mismatch');
    switch (command.type) {
      case 'audio.start': await this.startAudio(command.payload); break;
      case 'audio.stop': this.stopAudio(command.payload); break;
      case 'turn.persisted': await this.persisted(command.payload); break;
      case 'turn.persistence_failed': this.persistenceFailed(command.payload); break;
      case 'playback.progress': this.orchestrator.playbackProgress(command.payload as never); break;
      case 'playback.paused': this.orchestrator.playbackPaused(command.payload as never); break;
      case 'playback.stopped': this.orchestrator.playbackStopped(command.payload as never); break;
      case 'barge_in.confirm': this.resolveBarge(command.payload, true); break;
      case 'barge_in.reject': this.resolveBarge(command.payload, false); break;
      case 'turn.cancel': this.orchestrator.cancelCurrentTurn(); break;
      case 'session.stop': await this.stop(); break;
      default: this.protocolError('unsupported_command');
    }
  }

  private async start(command: { sessionId: string; epoch: number; payload: Record<string, unknown> }): Promise<void> {
    if (this.orchestrator || command.epoch !== 0) return this.protocolError('second_start');
    const settings = command.payload.settings as SessionSettingsSnapshot | undefined;
    if (!isValidSessionSettingsSnapshot(settings)) return this.protocolError('invalid_settings');
    const voice = normalizeVoicePreference(settings.voice);
    if (!voice) return this.protocolError('invalid_settings');
    this.sessionId = command.sessionId;
    const reasoningMode = command.payload.reasoningMode;
    const personaAppend = composePersonaAppend(settings.persona);
    // Session-owned Pi clients carry the frozen persona append; never reuse a
    // mutable global client across sessions and never log prompt/persona text.
    this.responsePi = this.options.createResponseClient(personaAppend);
    this.researchPi = this.options.createResearchClient(personaAppend);
    this.classifierPi = this.options.createClassifierClient();
    this.ownedPis.push(this.responsePi, this.researchPi, this.classifierPi);
    this.audio = new AudioClient(this.sidecar, {
      speechStart: value => this.speechStart(value),
      speechEnd: value => this.speechEnd(value),
      partial: value => this.partial(value),
      final: value => this.final(value),
      failure: code => this.failure(code),
    }, frame => {
      if (!this.stopped && this.socket.readyState === this.socket.OPEN) this.socket.send(frame, { binary: true });
    }, voice);
    this.orchestrator = new SessionOrchestrator({
      sessionId: command.sessionId,
      sessionSeed: String(command.payload.sessionSeed),
      pi: this.responsePi,
      speech: this.audio,
      researchPi: this.researchPi,
      multiPartEnabled: this.options.multiPartEnabled !== false,
      transcriptOnly: reasoningMode === 'transcript_only',
      interruptionClassifier: new PiInterruptionIntentClassifier(this.classifierPi),
      emit: value => this.send(value),
    });
    await this.audio.connect();
    this.orchestrator.start();
  }

  private async startAudio(payload: Record<string, unknown>): Promise<void> {
    if (this.captureStreamId !== undefined) return this.protocolError('second_audio_start');
    this.captureStreamId = Number(payload.streamId);
    await this.audio!.open(this.captureStreamId);
  }
  private stopAudio(payload: Record<string, unknown>): void {
    if (this.captureStreamId === undefined || Number(payload.streamId) !== this.captureStreamId) return this.protocolError('audio_stream_mismatch');
    this.audio!.reset();
    this.captureStreamId = undefined;
  }

  private speechStart(value: VadStartEvent): void {
    const orchestrator = this.orchestrator;
    if (!orchestrator || this.stopped) return;
    const epoch = orchestrator.handleSpeechStart();
    try { this.audio!.bindEpoch(value.utteranceId, epoch); } catch { this.failure('invalid_utterance'); }
    if (this.sessionId) this.send(event(this.sessionId, epoch, 'vad.speech_start', { streamId: value.streamId, utteranceId: value.utteranceId, captureStartSequence: value.captureStartSequence }));
  }
  private speechEnd(value: VadEndEvent): void {
    const orchestrator = this.orchestrator;
    if (!orchestrator || this.stopped) return;
    orchestrator.handleSpeechEnd();
    if (this.sessionId) this.send(event(this.sessionId, orchestrator.snapshot().epoch, 'vad.speech_end', { streamId: value.streamId, utteranceId: value.utteranceId, captureStartSequence: value.captureStartSequence, captureEndSequence: value.captureEndSequence }));
  }
  private partial(value: SttPartial): void {
    if (!this.sessionId || !this.orchestrator || value.epoch !== this.orchestrator.snapshot().epoch) return;
    this.send(event(this.sessionId, value.epoch, 'transcript.partial', { utteranceId: value.utteranceId, sequence: value.sequence, text: value.text, replacedCharacters: value.replacedCharacters }));
  }
  private final(value: SttFinal): void {
    if (!this.sessionId || !this.orchestrator || value.epoch !== this.orchestrator.snapshot().epoch || this.pending.size >= MAX_PENDING_FINALS) { this.failure('stale_or_overflow_final'); return; }
    if ([...this.pending.values()].some(item => item.turnId === value.utteranceId)) return;
    const finalEvent = event(this.sessionId, value.epoch, 'transcript.final', { turnId: value.utteranceId, text: value.text, endpointComplete: true });
    this.pending.set(finalEvent.eventId, { event: finalEvent, turnId: value.utteranceId, text: value.text, epoch: value.epoch, failed: false });
    this.send(finalEvent);
  }
  private async persisted(payload: Record<string, unknown>): Promise<void> {
    const finalEventId = String(payload.finalEventId);
    const completed = this.completedPersistenceAcks.get(finalEventId);
    if (completed) {
      if (payload.turnId === completed.turnId && payload.persistedEpoch === completed.epoch) return;
      return this.protocolError('persistence_ack_mismatch');
    }
    const pending = this.pending.get(finalEventId);
    if (!pending) return this.protocolError('unknown_persistence_ack');
    if (payload.turnId !== pending.turnId || payload.persistedEpoch !== pending.epoch) return this.protocolError('persistence_ack_mismatch');
    if (pending.epoch !== this.orchestrator!.snapshot().epoch) return this.protocolError('stale_persistence_ack');
    this.pending.delete(finalEventId);
    this.completedPersistenceAcks.set(finalEventId, { turnId: pending.turnId, epoch: pending.epoch });
    if (this.completedPersistenceAcks.size > MAX_COMPLETED_PERSISTENCE_ACKS) {
      const oldest = this.completedPersistenceAcks.keys().next().value as string | undefined;
      if (oldest) this.completedPersistenceAcks.delete(oldest);
    }
    void this.orchestrator!.handleStableFinal({ epoch: pending.epoch, turnId: pending.turnId, text: pending.text, endpointComplete: true }).catch(() => this.failure('stable_turn_processing_failed'));
  }
  private persistenceFailed(payload: Record<string, unknown>): void {
    const pending = this.pending.get(String(payload.finalEventId));
    if (!pending || payload.turnId !== pending.turnId || payload.persistedEpoch !== pending.epoch) return this.protocolError('persistence_failure_mismatch');
    if (pending.epoch !== this.orchestrator!.snapshot().epoch) return this.protocolError('stale_persistence_failure');
    if (pending.failed) return;
    pending.failed = true;
    this.failure('stable_turn_not_persisted');
  }
  private resolveBarge(payload: Record<string, unknown>, confirm: boolean): void {
    const snapshot = this.orchestrator!.snapshot();
    if (payload.responseId !== snapshot.activeResponseId || payload.outputEpoch !== snapshot.epoch) return this.protocolError('barge_identity_mismatch');
    if (confirm) this.orchestrator!.confirmBargeIn();
    else {
      this.orchestrator!.setEchoRecovered(true);
      this.orchestrator!.rejectBargeIn();
    }
  }
  private failure(code: string): void {
    if (!this.sessionId || !this.orchestrator || this.stopped) return;
    this.send(event(this.sessionId, this.orchestrator.snapshot().epoch, 'failure', { code, detail: 'The local audio conversation could not continue this turn.', correctiveAction: 'Continue listening, retry, or stop the session.', recoverable: true }));
  }
  private protocolError(code: string): void { this.failure(code); this.socket.close(1008, 'invalid conversation protocol'); }
  private send(value: SessionEvent): void { if (!this.stopped && this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(value)); }
}
