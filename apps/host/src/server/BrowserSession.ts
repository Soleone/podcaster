import { randomBytes } from 'node:crypto';
import {
  composePersonaAppend,
  CONTRACT_VALIDATORS,
  decodeBinaryAudioFrame,
  isValidSessionSettingsSnapshot,
  MAX_PLANNING_NOTES_BYTES,
  normalizePiSettings,
  normalizeSessionPlanningRequest,
  normalizeVoicePreference,
  parsePersona,
  type BrowserCommand,
  type HostEvent,
  type PiSettings,
  type SessionPlanningRequest,
} from '@app/contracts';
import type { WebSocket, RawData } from 'ws';
import type { PiClient } from '../pi/PiClient.js';
import type { PiResearchClient, ResearchToolActivity } from '../pi/PiResearchClient.js';
import { SessionOrchestrator } from '../session/SessionOrchestrator.js';
import { RuntimeBudget } from '../session/RuntimeBudget.js';
import { PiInterruptionIntentClassifier } from '../session/InterruptionIntentClassifier.js';
import {
  AudioClient,
  type AudioEngineStatusSnapshot,
  type SttFinal,
  type SttPartial,
  type VadEndEvent,
  type VadStartEvent,
} from '../sidecar/AudioClient.js';
import type { SidecarProcess } from '../sidecar/process.js';

const MAX_PENDING_FINALS = 8;
const MAX_COMPLETED_PERSISTENCE_ACKS = 64;
const MAX_RECONNECT_QUEUE_MESSAGES = 4_096;
const MAX_RECONNECT_QUEUE_BYTES = 8 * 1024 * 1024;
interface OutboundFrame {
  value: string | Buffer;
  bytes: number;
  binary: boolean;
}
export interface BrowserSessionOptions {
  multiPartEnabled: boolean;
  /** Session-owned response Pi client; receives the frozen persona append. */
  createResponseClient(personaAppend: string, piSettings?: PiSettings): PiClient;
  /** Session-owned research Pi client; receives the frozen persona append. */
  createResearchClient(personaAppend: string, piSettings?: PiSettings): PiResearchClient;
  /** Session-owned persona-neutral classifier client. */
  createClassifierClient(piSettings?: PiSettings): PiClient;
}
function rawBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) {
    const value = Buffer.concat(raw);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(raw);
}
const MAX_BINARY_PAYLOAD = 64 * 1024 - 20;
interface PendingFinal {
  event: HostEvent;
  turnId: string;
  text: string;
  epoch: number;
  failed: boolean;
}
interface CompletedPersistenceAck {
  turnId: string;
  epoch: number;
}
class PlanningCancelled extends Error {}
type BrowserCommandType = BrowserCommand['type'];
type BrowserCommandFor<T extends BrowserCommandType> = BrowserCommand extends infer Command
  ? Command extends { type: infer Type }
    ? T extends Type
      ? Command
      : never
    : never
  : never;
type BrowserCommandPayload<T extends BrowserCommandType> = BrowserCommand extends infer Command
  ? Command extends { type: infer Type; payload: infer Payload }
    ? T extends Type
      ? Payload
      : never
    : never
  : never;

function uuidV7(): string {
  const bytes = randomBytes(16);
  let time = Date.now();
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time & 0xff;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function truncatePlanningNotes(value: string): string {
  const bytes = Buffer.from(value.trim(), 'utf8');
  if (bytes.length <= MAX_PLANNING_NOTES_BYTES) return value.trim();
  let end = MAX_PLANNING_NOTES_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8').trim();
}
function event<T extends HostEvent['type']>(
  sessionId: string,
  epoch: number,
  type: T,
  payload: HostEvent extends infer Host
    ? Host extends { type: infer EventType; payload: infer Payload }
      ? T extends EventType
        ? Payload
        : never
      : never
    : never,
): HostEvent {
  return {
    protocolVersion: 1,
    sessionId,
    epoch,
    eventId: uuidV7(),
    type,
    monotonicMs: Math.max(0, performance.now()),
    payload,
  } as HostEvent;
}

export class BrowserSession {
  private socket: WebSocket | undefined;
  private readonly sidecar: SidecarProcess;
  private readonly outboundQueue: OutboundFrame[] = [];
  private outboundQueueBytes = 0;
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
  private planningRequest: SessionPlanningRequest | undefined;
  private planningNotes: string | undefined;
  private personaDigest = '0'.repeat(64);
  private planningAbort: AbortController | undefined;
  private planningPromise: Promise<'ready' | 'failed' | 'cancelled'> | undefined;

  constructor(socket: WebSocket, sidecar: SidecarProcess, options: BrowserSessionOptions) {
    this.socket = socket;
    this.sidecar = sidecar;
    this.options = options;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  attachSocket(socket: WebSocket): void {
    if (this.stopped) {
      socket.close(1008, 'session already stopped');
      return;
    }
    this.socket = socket;
    this.flushOutbound();
  }

  detachSocket(socket: WebSocket): void {
    if (this.socket === socket) this.socket = undefined;
  }

  /** The websocket server uses this fast path so planning cancellation is not
   * queued behind the async session.start research request. */
  isPlanningControl(raw: RawData, binary: boolean): boolean {
    if (binary) return false;
    try {
      const value = JSON.parse(raw.toString()) as { type?: unknown };
      return (
        value?.type === 'planning.cancel' ||
        value?.type === 'planning.retry' ||
        (value?.type === 'session.stop' && this.planningPromise !== undefined)
      );
    } catch {
      return false;
    }
  }
  async handlePlanningControl(raw: RawData, binary: boolean): Promise<void> {
    if (binary) return;
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      return this.protocolError('invalid_json');
    }
    if (!CONTRACT_VALIDATORS.BrowserCommand(value)) return this.protocolError('invalid_command');
    const command = value as BrowserCommand;
    if (command.sessionId !== this.sessionId) return this.protocolError('session_mismatch');
    if (command.type === 'planning.cancel') {
      this.cancelPlanning();
      return;
    }
    if (command.type === 'planning.retry') {
      await this.retryPlanning();
      return;
    }
    if (command.type === 'session.stop') {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.planningAbort?.abort();
    await this.planningPromise?.catch(() => undefined);
    this.orchestrator?.stop();
    this.pending.clear();
    this.completedPersistenceAcks.clear();
    this.outboundQueue.length = 0;
    this.outboundQueueBytes = 0;
    await this.audio?.close();
    for (const client of this.ownedPis) {
      try {
        await client.shutdown();
      } catch {
        /* best-effort child teardown */
      }
    }
    this.responsePi = undefined;
    this.researchPi = undefined;
    this.classifierPi = undefined;
    this.ownedPis = [];
  }

  async handle(raw: RawData, binary: boolean): Promise<void> {
    if (this.stopped) {
      this.socket?.close(1008, 'session already stopped');
      return;
    }
    if (binary) {
      if (!this.orchestrator || this.captureStreamId === undefined)
        return this.protocolError('binary_before_audio_start');
      const bytes = rawBytes(raw);
      try {
        const decoded = decodeBinaryAudioFrame(bytes, MAX_BINARY_PAYLOAD);
        if (decoded.channel !== 1 || decoded.streamId !== this.captureStreamId || decoded.pcm16.length !== 320)
          throw new Error();
        this.audio!.input(bytes);
      } catch {
        this.protocolError('invalid_capture_frame');
      }
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      return this.protocolError('invalid_json');
    }
    if (!CONTRACT_VALIDATORS.BrowserCommand(value)) return this.protocolError('invalid_command');
    const command = value as BrowserCommand;
    if (this.sessionId && command.sessionId !== this.sessionId) return this.protocolError('session_mismatch');
    if (command.type === 'session.start') return this.start(command);
    if (command.type === 'planning.cancel') {
      this.cancelPlanning();
      return;
    }
    if (command.type === 'planning.retry') {
      await this.retryPlanning();
      return;
    }
    if (!this.orchestrator || !this.sessionId) return this.protocolError('command_before_start');
    if (
      ![
        'playback.stopped',
        'playback.progress',
        'playback.paused',
        'turn.persisted',
        'turn.persistence_failed',
      ].includes(command.type) &&
      command.epoch !== this.orchestrator.snapshot().epoch
    )
      return this.protocolError('epoch_mismatch');
    switch (command.type) {
      case 'audio.start':
        await this.startAudio(command.payload);
        break;
      case 'audio.stop':
        this.stopAudio(command.payload);
        break;
      case 'turn.persisted':
        await this.persisted(command.payload);
        break;
      case 'turn.persistence_failed':
        this.persistenceFailed(command.payload);
        break;
      case 'playback.progress':
        this.orchestrator.playbackProgress(command.payload);
        break;
      case 'playback.paused':
        this.orchestrator.playbackPaused(command.payload);
        break;
      case 'playback.stopped':
        this.orchestrator.playbackStopped(command.payload);
        break;
      case 'barge_in.confirm':
        this.resolveBarge(command.payload, true);
        break;
      case 'barge_in.reject':
        this.resolveBarge(command.payload, false);
        break;
      case 'turn.cancel':
        this.orchestrator.cancelCurrentTurn();
        break;
      case 'session.stop':
        await this.stop();
        break;
      default:
        this.protocolError('unsupported_command');
    }
  }

  private async start(command: BrowserCommandFor<'session.start'>): Promise<void> {
    if (this.orchestrator || command.epoch !== 0 || this.planningPromise) return this.protocolError('second_start');
    const settings = command.payload.settings;
    if (!isValidSessionSettingsSnapshot(settings)) return this.protocolError('invalid_settings');
    const voice = normalizeVoicePreference(settings.voice);
    if (!voice) return this.protocolError('invalid_settings');
    const planning = command.payload.planning ? normalizeSessionPlanningRequest(command.payload.planning) : undefined;
    if (command.payload.planning && !planning) return this.protocolError('invalid_planning');
    this.sessionId = command.sessionId;
    const parsedPersona = parsePersona(settings.persona);
    if (parsedPersona.ok) this.personaDigest = parsedPersona.digest;
    this.planningRequest = planning;
    const reasoningMode = command.payload.reasoningMode;
    const personaAppend = composePersonaAppend(settings.persona);
    const piSettings = normalizePiSettings(settings.pi);
    // Session-owned Pi clients carry the frozen persona and Pi controls; never
    // reuse a mutable global client across sessions and never log prompt/persona text.
    this.responsePi = this.options.createResponseClient(personaAppend, piSettings);
    this.researchPi = this.options.createResearchClient(personaAppend, piSettings);
    this.classifierPi = this.options.createClassifierClient(piSettings);
    this.ownedPis.push(this.responsePi, this.researchPi, this.classifierPi);

    // The absent-planning branch deliberately does not await or touch the
    // research client. This keeps the existing direct-to-live start path fast.
    if (planning) {
      if (reasoningMode === 'transcript_only') {
        this.emitPlanningState('continued', planning, 100, 'Transcript-only mode is continuing without preparation.');
      } else if (planning.reuse || planning.notes !== undefined) {
        this.planningNotes = planning.notes ? truncatePlanningNotes(planning.notes) : undefined;
        this.emitPlanningState(
          'ready',
          planning,
          100,
          this.planningNotes
            ? 'Saved preparation restored for this session.'
            : 'No saved preparation was available; continuing without it.',
          this.planningNotes,
        );
      } else {
        // Preparation runs behind the live start: the microphone and
        // conversation come up immediately and the notes land in the
        // reasoning context when the research pass finishes. The web resolves
        // its start handshake on the first ready phase below, not on a
        // terminal planning status.
        this.planningPromise = this.runPlanning(planning).finally(() => {
          this.planningPromise = undefined;
        });
      }
    }
    if (this.stopped) return;
    this.audio = new AudioClient(
      this.sidecar,
      {
        status: (value) => this.audioStatus(value),
        speechStart: (value) => this.speechStart(value),
        speechEnd: (value) => this.speechEnd(value),
        partial: (value) => this.partial(value),
        final: (value) => this.final(value),
        failure: (code) => this.failure(code),
      },
      (frame) => {
        if (!this.stopped) this.sendFrame(Buffer.from(frame), true);
      },
      voice,
    );
    this.orchestrator = new SessionOrchestrator({
      sessionId: command.sessionId,
      sessionSeed: String(command.payload.sessionSeed),
      pi: this.responsePi,
      speech: this.audio,
      personaSource: settings.persona,
      researchPi: this.researchPi,
      ...(this.planningNotes ? { planningContext: this.planningNotes } : {}),
      multiPartEnabled: this.options.multiPartEnabled,
      ...(this.options.multiPartEnabled ? { budget: new RuntimeBudget() } : {}),
      transcriptOnly: reasoningMode === 'transcript_only',
      interruptionClassifier: new PiInterruptionIntentClassifier(this.classifierPi),
      emit: (value) => this.send(value),
    });
    await this.audio.connect();
    if (this.planningRequest && this.planningPromise) {
      this.emitPlanningState(
        'planning',
        this.planningRequest,
        5,
        'Preparation is running behind the live conversation.',
        undefined,
        'ready',
      );
    }
    // Do not mark the session listening yet. audio.start must complete the
    // capture/VAD/TTS warmup contract first, otherwise the first utterance can
    // race a sidecar that only announced `starting`.
  }

  private emitPlanningState(
    status: 'planning' | 'ready' | 'failed' | 'cancelled' | 'continued',
    request: SessionPlanningRequest,
    progress: number,
    detail: string,
    notes?: string,
    phaseOverride?: 'ready',
  ): void {
    if (!this.sessionId || this.stopped) return;
    const snapshot = this.orchestrator?.snapshot();
    this.send(
      event(this.sessionId, snapshot?.epoch ?? 0, 'session.state', {
        phase: phaseOverride ?? (status === 'planning' ? 'planning' : 'ready'),
        personaDigest: snapshot?.personaDigest ?? this.personaDigest,
        planning: {
          status,
          topic: request.topic,
          depth: request.depth,
          progress: Math.max(0, Math.min(100, Math.round(progress))),
          detail,
          ...(notes ? { notes } : {}),
        },
      }),
    );
  }

  private async runPlanning(request: SessionPlanningRequest): Promise<'ready' | 'failed' | 'cancelled'> {
    const controller = new AbortController();
    this.planningAbort = controller;
    this.emitPlanningState('planning', request, 0, `Preparing a ${request.depth} briefing before microphone capture.`);
    try {
      const research = this.researchPi;
      if (!research?.requestPlan) throw new Error('planning provider unavailable');
      this.emitPlanningState('planning', request, 20, 'Running a bounded read-only research pass.');
      let notes = '';
      let sawDelta = false;
      for await (const item of research.requestPlan(
        {
          topic: request.topic,
          depth: request.depth,
          onToolActivity: (activity) => this.emitPlanningToolActivity(activity),
        },
        controller.signal,
      )) {
        if (controller.signal.aborted || this.stopped) throw new PlanningCancelled();
        if (item.type === 'delta') {
          // Research text remains host-internal. Only the final bounded notes
          // are retained and injected into the live reasoning context.
          if (!sawDelta) {
            sawDelta = true;
            this.emitPlanningState('planning', request, 65, 'Condensing research into conversation notes.');
          }
        } else if (item.type === 'final') {
          notes = truncatePlanningNotes(item.text);
        } else if (item.type === 'error') {
          throw new Error('planning provider unavailable');
        }
      }
      if (!notes) throw new Error('planning returned no notes');
      this.planningNotes = notes;
      this.orchestrator?.setPlanningContext(notes);
      this.emitPlanningState('ready', request, 100, 'Preparation is ready. Notes joined the live conversation.', notes);
      return 'ready';
    } catch (error) {
      this.planningNotes = undefined;
      if (controller.signal.aborted || error instanceof PlanningCancelled || this.stopped) {
        this.emitPlanningState('cancelled', request, 100, 'Preparation was cancelled. Continuing without preparation.');
        return 'cancelled';
      }
      // Keep provider detail out of the wire and spoken context. The lifecycle
      // state is enough for the browser to explain the safe continue path.
      this.emitPlanningState(
        'failed',
        request,
        100,
        'Preparation failed or timed out. Continuing without preparation is safe; retry later if needed.',
      );
      return 'failed';
    } finally {
      if (this.planningAbort === controller) this.planningAbort = undefined;
    }
  }

  private emitPlanningToolActivity(activity: ResearchToolActivity): void {
    if (!this.sessionId || this.stopped) return;
    const epoch = this.orchestrator?.snapshot().epoch ?? 0;
    this.send(event(this.sessionId, epoch, 'tool.activity', { scope: 'planning', ...activity }));
  }

  private cancelPlanning(): void {
    if (this.planningAbort && !this.planningAbort.signal.aborted) this.planningAbort.abort();
  }

  private async retryPlanning(): Promise<void> {
    const request = this.planningRequest;
    if (!request || this.stopped || this.planningPromise) return;
    this.planningPromise = this.runPlanning(request).finally(() => {
      this.planningPromise = undefined;
    });
  }

  private async startAudio(payload: BrowserCommandPayload<'audio.start'>): Promise<void> {
    const streamId = Number(payload.streamId);
    if (this.captureStreamId === streamId) return;
    // A reconnect can race with the last audio.stop command from the old
    // socket. Rebinding through AudioClient is safe and resets the sidecar VAD
    // boundary, so a fresh browser capture stream can always take ownership.
    this.captureStreamId = streamId;
    try {
      await this.audio!.open(streamId);
      this.orchestrator!.start();
    } catch (error) {
      this.captureStreamId = undefined;
      this.failure('audio_engine_not_ready');
      throw error;
    }
  }
  private stopAudio(payload: BrowserCommandPayload<'audio.stop'>): void {
    // Duplicate or late stops are expected when a reconnect races the last
    // command from the old socket. Treat them as idempotent instead of killing
    // the newly attached conversation.
    if (this.captureStreamId === undefined || Number(payload.streamId) !== this.captureStreamId) return;
    this.audio!.reset();
    this.captureStreamId = undefined;
  }

  private audioStatus(value: AudioEngineStatusSnapshot): void {
    if (!this.sessionId || !this.orchestrator || this.stopped) return;
    const snapshot = this.orchestrator.snapshot();
    if (snapshot.phase === 'acceptance_pending_terminal') return;
    this.send(
      event(this.sessionId, snapshot.epoch, 'session.state', {
        phase: snapshot.phase,
        personaDigest: snapshot.personaDigest,
        audio: value,
      }),
    );
  }
  private speechStart(value: VadStartEvent): void {
    const orchestrator = this.orchestrator;
    if (!orchestrator || this.stopped) return;
    const epoch = orchestrator.handleSpeechStart();
    try {
      this.audio!.bindEpoch(value.utteranceId, epoch);
    } catch {
      this.failure('invalid_utterance');
    }
    if (this.sessionId)
      this.send(
        event(this.sessionId, epoch, 'vad.speech_start', {
          streamId: value.streamId,
          utteranceId: value.utteranceId,
          captureStartSequence: value.captureStartSequence,
        }),
      );
  }
  private speechEnd(value: VadEndEvent): void {
    const orchestrator = this.orchestrator;
    if (!orchestrator || this.stopped) return;
    orchestrator.handleSpeechEnd();
    if (this.sessionId)
      this.send(
        event(this.sessionId, orchestrator.snapshot().epoch, 'vad.speech_end', {
          streamId: value.streamId,
          utteranceId: value.utteranceId,
          captureStartSequence: value.captureStartSequence,
          captureEndSequence: value.captureEndSequence,
        }),
      );
  }
  private partial(value: SttPartial): void {
    if (!this.sessionId || !this.orchestrator || value.epoch !== this.orchestrator.snapshot().epoch) return;
    this.send(
      event(this.sessionId, value.epoch, 'transcript.partial', {
        utteranceId: value.utteranceId,
        sequence: value.sequence,
        text: value.text,
        replacedCharacters: value.replacedCharacters,
      }),
    );
  }
  private final(value: SttFinal): void {
    if (
      !this.sessionId ||
      !this.orchestrator ||
      value.epoch !== this.orchestrator.snapshot().epoch ||
      this.pending.size >= MAX_PENDING_FINALS
    ) {
      this.failure('stale_or_overflow_final');
      return;
    }
    if ([...this.pending.values()].some((item) => item.turnId === value.utteranceId)) return;
    const finalEvent = event(this.sessionId, value.epoch, 'transcript.final', {
      turnId: value.utteranceId,
      text: value.text,
      endpointComplete: true,
    });
    this.pending.set(finalEvent.eventId, {
      event: finalEvent,
      turnId: value.utteranceId,
      text: value.text,
      epoch: value.epoch,
      failed: false,
    });
    this.send(finalEvent);
  }
  private async persisted(payload: BrowserCommandPayload<'turn.persisted'>): Promise<void> {
    const finalEventId = String(payload.finalEventId);
    const completed = this.completedPersistenceAcks.get(finalEventId);
    if (completed) {
      if (payload.turnId === completed.turnId && payload.persistedEpoch === completed.epoch) return;
      return this.protocolError('persistence_ack_mismatch');
    }
    const pending = this.pending.get(finalEventId);
    if (!pending) return this.protocolError('unknown_persistence_ack');
    if (payload.turnId !== pending.turnId || payload.persistedEpoch !== pending.epoch)
      return this.protocolError('persistence_ack_mismatch');
    if (pending.epoch !== this.orchestrator!.snapshot().epoch) return this.protocolError('stale_persistence_ack');
    this.pending.delete(finalEventId);
    this.completedPersistenceAcks.set(finalEventId, { turnId: pending.turnId, epoch: pending.epoch });
    if (this.completedPersistenceAcks.size > MAX_COMPLETED_PERSISTENCE_ACKS) {
      const oldest = this.completedPersistenceAcks.keys().next().value as string | undefined;
      if (oldest) this.completedPersistenceAcks.delete(oldest);
    }
    void this.orchestrator!.handleStableFinal({
      epoch: pending.epoch,
      turnId: pending.turnId,
      text: pending.text,
      endpointComplete: true,
    }).catch(() => this.failure('stable_turn_processing_failed'));
  }
  private persistenceFailed(payload: BrowserCommandPayload<'turn.persistence_failed'>): void {
    const pending = this.pending.get(String(payload.finalEventId));
    if (!pending || payload.turnId !== pending.turnId || payload.persistedEpoch !== pending.epoch)
      return this.protocolError('persistence_failure_mismatch');
    if (pending.epoch !== this.orchestrator!.snapshot().epoch) return this.protocolError('stale_persistence_failure');
    if (pending.failed) return;
    pending.failed = true;
    this.failure('stable_turn_not_persisted');
  }
  private resolveBarge(payload: BrowserCommandPayload<'barge_in.confirm' | 'barge_in.reject'>, confirm: boolean): void {
    const snapshot = this.orchestrator!.snapshot();
    if (payload.responseId !== snapshot.activeResponseId || payload.outputEpoch !== snapshot.epoch)
      return this.protocolError('barge_identity_mismatch');
    if (confirm) this.orchestrator!.confirmBargeIn();
    else {
      this.orchestrator!.setEchoRecovered(true);
      this.orchestrator!.rejectBargeIn();
    }
  }
  private failure(code: string): void {
    if (!this.sessionId || !this.orchestrator || this.stopped) return;
    this.send(
      event(this.sessionId, this.orchestrator.snapshot().epoch, 'failure', {
        code,
        detail: 'The local audio conversation could not continue this turn.',
        correctiveAction: 'Continue listening, retry, or stop the session.',
        recoverable: true,
      }),
    );
  }
  private protocolError(code: string): void {
    this.failure(code);
    this.socket?.close(1008, 'invalid conversation protocol');
  }
  private send(value: HostEvent): void {
    if (!this.stopped) this.sendFrame(JSON.stringify(value), false);
  }
  private sendFrame(value: string | Buffer, binary: boolean): void {
    const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
    const socket = this.socket;
    if (socket && socket.readyState === socket.OPEN) {
      try {
        socket.send(value, { binary });
      } catch {
        this.queueFrame(value, bytes, binary);
      }
      return;
    }
    this.queueFrame(value, bytes, binary);
  }
  private queueFrame(value: string | Buffer, bytes: number, binary: boolean): void {
    if (bytes > MAX_RECONNECT_QUEUE_BYTES) return;
    while (
      this.outboundQueue.length >= MAX_RECONNECT_QUEUE_MESSAGES ||
      this.outboundQueueBytes + bytes > MAX_RECONNECT_QUEUE_BYTES
    ) {
      const oldest = this.outboundQueue.shift();
      if (!oldest) break;
      this.outboundQueueBytes -= oldest.bytes;
    }
    this.outboundQueue.push({ value, bytes, binary });
    this.outboundQueueBytes += bytes;
  }
  private flushOutbound(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    while (this.outboundQueue.length > 0 && this.socket === socket && socket.readyState === socket.OPEN) {
      const frame = this.outboundQueue[0]!;
      try {
        socket.send(frame.value, { binary: frame.binary });
      } catch {
        return;
      }
      this.outboundQueue.shift();
      this.outboundQueueBytes -= frame.bytes;
    }
  }
}
