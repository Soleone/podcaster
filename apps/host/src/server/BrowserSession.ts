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
  type PlanningDepth,
  type SessionPlanningRequest,
  type VoicePreference,
} from '@app/contracts';
import type { WebSocket, RawData } from 'ws';
import type { PiClient } from '../pi/PiClient.js';
import type { PiResearchClient, ResearchToolActivity } from '../pi/PiResearchClient.js';
import { SessionOrchestrator } from '../session/SessionOrchestrator.js';
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
// Safe starting bounds per preparation depth: these are hard attempt deadlines
// and prompt-level tool caps, not progress predictions. Revised from measured
// p95 attempt/tool timings when available.
const PLANNING_BOUNDS: Record<PlanningDepth, { deadlineMs: number; maxTools: number }> = {
  light: { deadlineMs: 30_000, maxTools: 1 },
  standard: { deadlineMs: 60_000, maxTools: 2 },
  deep: { deadlineMs: 120_000, maxTools: 3 },
};
/** One factual planning attempt; the host owns exactly one at a time. */
interface PlanningAttempt {
  attempt: number;
  state: 'running' | 'ready' | 'failed' | 'cancelled';
  stage?: 'starting' | 'researching' | 'finalizing';
  reasonCode?: 'timeout' | 'provider_unavailable' | 'invalid_result' | 'interrupted';
  deadlineMs: number;
  controller: AbortController;
}
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
  private liveBegin:
    | { epoch: number; streamId: number; sampleRate: number; channels: number; frameSamples: number }
    | undefined;
  private pending = new Map<string, PendingFinal>();
  private completedPersistenceAcks = new Map<string, CompletedPersistenceAck>();
  private stopped = false;
  private responsePi: PiClient | undefined;
  private researchPi: PiResearchClient | undefined;
  private classifierPi: PiClient | undefined;
  private ownedPis: Array<{ shutdown(): Promise<void> }> = [];
  private planningRequest: SessionPlanningRequest | undefined;
  private planningNotes: string | undefined;
  private planningAttempt: PlanningAttempt | undefined;
  private personaDigest = '0'.repeat(64);
  /** Frozen persona/session identity from session.open; consumed by session.begin. */
  private personaSource = '';
  private sessionSeed = '';
  private planningAbort: AbortController | undefined;
  private planningPromise: Promise<'ready' | 'failed' | 'cancelled'> | undefined;
  /** Frozen voice preference from session.open; consumed by session.begin. */
  private voice: VoicePreference | undefined;
  private transcriptOnly = false;
  /** True once session.begin completed; audio status before that is pre-live. */
  private live = false;

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
    if (command.type === 'session.open') return this.open(command);
    if (command.type === 'session.begin') return this.begin(command);
    if (command.type === 'session.rollback_begin') return this.rollbackBegin();
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
      default:
        this.protocolError('unsupported_command');
    }
  }

  /**
   * Pre-live open: freezes settings/persona, creates the session-owned Pi
   * clients, and optionally runs preparation. It never creates the audio
   * client, orchestrator, microphone capture, or recorder, and never reports
   * a listening phase. session.begin is the only initial transition to live.
   */
  private async open(command: BrowserCommandFor<'session.open'>): Promise<void> {
    if (this.sessionId || this.orchestrator || this.planningPromise) return this.protocolError('second_open');
    if (command.epoch !== 0) return this.protocolError('epoch_mismatch');
    const settings = command.payload.settings;
    if (!isValidSessionSettingsSnapshot(settings)) return this.protocolError('invalid_settings');
    const voice = normalizeVoicePreference(settings.voice);
    if (!voice) return this.protocolError('invalid_settings');
    const planning = command.payload.planning ? normalizeSessionPlanningRequest(command.payload.planning) : undefined;
    if (command.payload.planning && !planning) return this.protocolError('invalid_planning');
    this.sessionId = command.sessionId;
    this.sessionSeed = String(command.payload.sessionSeed);
    const parsedPersona = parsePersona(settings.persona);
    if (parsedPersona.ok) this.personaDigest = parsedPersona.digest;
    this.personaSource = settings.persona;
    this.planningRequest = planning;
    this.voice = voice;
    this.transcriptOnly = command.payload.reasoningMode === 'transcript_only';
    const personaAppend = composePersonaAppend(settings.persona);
    const piSettings = normalizePiSettings(settings.pi);
    // Session-owned Pi clients carry the frozen persona and Pi controls; never
    // reuse a mutable global client across sessions and never log prompt/persona text.
    this.responsePi = this.options.createResponseClient(personaAppend, piSettings);
    this.researchPi = this.options.createResearchClient(personaAppend, piSettings);
    this.classifierPi = this.options.createClassifierClient(piSettings);
    this.ownedPis.push(this.responsePi, this.researchPi, this.classifierPi);

    if (planning) {
      if (this.transcriptOnly) {
        this.emitPlanningState('continued', planning, undefined, {
          detail: 'Transcript-only mode is continuing without preparation.',
        });
      } else if (planning.reuse || planning.notes !== undefined) {
        this.planningNotes = planning.notes ? truncatePlanningNotes(planning.notes) : undefined;
        this.emitPlanningState(
          'ready',
          planning,
          undefined,
          this.planningNotes
            ? { detail: 'Saved preparation restored for this session.' }
            : { detail: 'No saved preparation was available; continuing without it.' },
          this.planningNotes,
        );
      } else {
        // Preparation runs pre-live: the microphone and conversation stay off
        // until session.begin. The web resolves its open handshake immediately
        // and renders the preparation card from planning session.state events.
        this.planningPromise = this.runPlanning(planning).finally(() => {
          this.planningPromise = undefined;
        });
      }
    } else {
      this.emitSessionPhase('prelive');
    }
  }

  /**
   * The only initial transition to live, valid only from the pre-live phase.
   * Cancels a running preparation (begin-without-preparation) and awaits its
   * terminal cancellation before constructing the audio engine and
   * orchestrator. On failure the session stays pre-live and retryable.
   */
  private async begin(command: BrowserCommandFor<'session.begin'>): Promise<void> {
    if (this.stopped) return;
    if (!this.sessionId || !this.voice) return this.protocolError('begin_before_open');
    const payload = command.payload;
    const streamId = Number(payload.streamId);
    if (!Number.isSafeInteger(streamId) || streamId < 0) return this.protocolError('invalid_begin');
    // A live begin is idempotent only when it is an exact retransmission. Do
    // not let a stale or misconfigured retry rebind the active audio stream.
    if (this.live && this.orchestrator && this.audio && this.captureStreamId !== undefined && this.liveBegin) {
      const exact =
        command.epoch === this.liveBegin.epoch &&
        streamId === this.liveBegin.streamId &&
        payload.sampleRate === this.liveBegin.sampleRate &&
        payload.channels === this.liveBegin.channels &&
        payload.frameSamples === this.liveBegin.frameSamples;
      if (exact) return;
      // A live begin mismatch is a recoverable command rejection. Keep the
      // active orchestrator, audio/capture streams, and websocket untouched.
      this.failure('begin_mismatch');
      return;
    }
    if (this.orchestrator) return this.protocolError('second_begin');
    if (command.epoch !== 0) return this.protocolError('epoch_mismatch');
    if (this.planningPromise) {
      this.cancelPlanning();
      await this.planningPromise.catch(() => undefined);
    }
    if (this.stopped) return;
    this.emitSessionPhase('starting_live');
    const sessionId = this.sessionId;
    try {
      const audio = new AudioClient(
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
        this.voice,
      );
      const orchestrator = new SessionOrchestrator({
        sessionId,
        sessionSeed: this.sessionSeed,
        pi: this.responsePi!,
        speech: audio,
        personaSource: this.personaSource,
        ...(this.researchPi ? { researchPi: this.researchPi } : {}),
        ...(this.planningNotes ? { planningContext: this.planningNotes } : {}),
        multiPartEnabled: this.options.multiPartEnabled,
        transcriptOnly: this.transcriptOnly,
        interruptionClassifier: new PiInterruptionIntentClassifier(this.classifierPi),
        emit: (value) => this.send(value),
      });
      this.audio = audio;
      this.orchestrator = orchestrator;
      await audio.connect();
      await audio.open(streamId);
      if (this.stopped) {
        await audio.close().catch(() => undefined);
        this.audio = undefined;
        this.orchestrator = undefined;
        return;
      }
      this.captureStreamId = streamId;
      this.liveBegin = {
        epoch: command.epoch,
        streamId,
        sampleRate: payload.sampleRate,
        channels: payload.channels,
        frameSamples: payload.frameSamples,
      };
      orchestrator.start();
      this.live = true;
    } catch (error) {
      // Roll back: close the audio engine and release the orchestrator so the
      // session stays pre-live and a retry can begin again. The browser keeps
      // the connection and may call session.begin again.
      this.captureStreamId = undefined;
      this.liveBegin = undefined;
      await this.audio?.close().catch(() => undefined);
      this.audio = undefined;
      this.orchestrator = undefined;
      if (!this.stopped) {
        this.emitSessionPhase('prelive');
        this.failure('audio_engine_not_ready');
      }
    }
  }

  /** Factual pre-live/live transition phase; carries no planning payload. */
  private emitSessionPhase(phase: 'prelive' | 'starting_live'): void {
    if (!this.sessionId || this.stopped) return;
    const snapshot = this.orchestrator?.snapshot();
    this.send(
      event(this.sessionId, snapshot?.epoch ?? 0, 'session.state', {
        phase,
        personaDigest: snapshot?.personaDigest ?? this.personaDigest,
      }),
    );
  }

  private emitPlanningState(
    status: 'planning' | 'ready' | 'failed' | 'cancelled' | 'continued',
    request: SessionPlanningRequest,
    attempt: Pick<PlanningAttempt, 'attempt' | 'deadlineMs' | 'stage' | 'reasonCode'> | undefined,
    fields: { stage?: PlanningAttempt['stage']; reasonCode?: PlanningAttempt['reasonCode']; detail: string },
    notes?: string,
  ): void {
    if (!this.sessionId || this.stopped) return;
    const snapshot = this.orchestrator?.snapshot();
    const stage = fields.stage ?? attempt?.stage;
    this.send(
      event(this.sessionId, snapshot?.epoch ?? 0, 'session.state', {
        // Terminal planning states land the session in the explicit pre-live
        // phase; a running attempt is reported as preparing. session.begin is
        // the only path from prelive into a listening phase.
        phase: status === 'planning' ? 'preparing' : 'prelive',
        personaDigest: snapshot?.personaDigest ?? this.personaDigest,
        planning: {
          status,
          attempt: attempt?.attempt ?? 0,
          ...(attempt?.deadlineMs !== undefined ? { deadlineMs: attempt.deadlineMs } : {}),
          ...(stage !== undefined ? { stage } : {}),
          ...(fields.reasonCode !== undefined ? { reasonCode: fields.reasonCode } : {}),
          topic: request.topic,
          depth: request.depth,
          detail: fields.detail,
          ...(notes !== undefined ? { notes } : {}),
        },
      }),
    );
  }

  private async runPlanning(request: SessionPlanningRequest): Promise<'ready' | 'failed' | 'cancelled'> {
    const bounds = PLANNING_BOUNDS[request.depth];
    const controller = new AbortController();
    const attempt: PlanningAttempt = {
      attempt: (this.planningAttempt?.attempt ?? 0) + 1,
      state: 'running',
      deadlineMs: bounds.deadlineMs,
      controller,
    };
    this.planningAbort = controller;
    this.planningAttempt = attempt;
    this.emitPlanningState('planning', request, attempt, {
      stage: 'starting',
      detail: `Preparing a ${request.depth} briefing. The microphone stays off until you go live.`,
    });
    try {
      const research = this.researchPi;
      if (!research?.requestPlan) throw new Error('planning provider unavailable');
      this.emitPlanningState('planning', request, attempt, {
        stage: 'researching',
        detail: 'Running a bounded read-only research pass.',
      });
      let notes = '';
      let sawDelta = false;
      for await (const item of research.requestPlan(
        {
          topic: request.topic,
          depth: request.depth,
          deadlineMs: bounds.deadlineMs,
          maxTools: bounds.maxTools,
          // Stale callbacks from a superseded attempt must never surface:
          // emit only while this attempt is still the registered one.
          onToolActivity: (activity) => {
            if (this.planningAttempt === attempt) this.emitPlanningToolActivity(activity);
          },
        },
        controller.signal,
      )) {
        if (controller.signal.aborted || this.stopped) throw new PlanningCancelled();
        if (item.type === 'delta') {
          // Research text remains host-internal. Only the final bounded notes
          // are retained and injected into the live reasoning context.
          if (!sawDelta) {
            sawDelta = true;
            attempt.stage = 'finalizing';
            this.emitPlanningState('planning', request, attempt, {
              stage: 'finalizing',
              detail: 'Condensing research into conversation notes.',
            });
          }
        } else if (item.type === 'final') {
          notes = truncatePlanningNotes(item.text);
        } else if (item.type === 'error') {
          throw new Error(item.detail ?? 'planning provider unavailable');
        }
      }
      if (controller.signal.aborted || this.stopped) throw new PlanningCancelled();
      if (!notes) {
        attempt.state = 'failed';
        attempt.reasonCode = 'invalid_result';
        this.emitPlanningState('failed', request, attempt, {
          reasonCode: 'invalid_result',
          detail: 'Preparation finished without usable notes. Begin without preparation, or retry.',
        });
        return 'failed';
      }
      this.planningNotes = notes;
      attempt.state = 'ready';
      this.emitPlanningState(
        'ready',
        request,
        attempt,
        { detail: 'Preparation is ready. Notes join the conversation when you go live.' },
        notes,
      );
      return 'ready';
    } catch (error) {
      this.planningNotes = undefined;
      if (controller.signal.aborted || error instanceof PlanningCancelled || this.stopped) {
        attempt.state = 'cancelled';
        attempt.reasonCode = 'interrupted';
        this.emitPlanningState('cancelled', request, attempt, {
          reasonCode: 'interrupted',
          detail: 'Preparation was cancelled. Begin without preparation, or retry.',
        });
        return 'cancelled';
      }
      // Keep provider detail out of the wire and spoken context. The bounded
      // reasonCode drives the browser's copy and available actions.
      const timedOut =
        error instanceof Error && (error.message.includes('timed out') || error.message.includes('timeout'));
      attempt.state = 'failed';
      attempt.reasonCode = timedOut ? 'timeout' : 'provider_unavailable';
      this.emitPlanningState('failed', request, attempt, {
        reasonCode: attempt.reasonCode,
        detail: timedOut
          ? 'Preparation timed out. Begin without preparation, or retry.'
          : 'Preparation failed. Begin without preparation, or retry.',
      });
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
    // Retry is accepted only pre-live after a terminal state; a running attempt
    // or an already-live session must ignore it.
    if (!request || this.stopped || this.orchestrator || this.planningPromise) return;
    if (this.planningAttempt?.state === 'running') return;
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
  private async rollbackBegin(): Promise<void> {
    await this.rollbackLiveToPrelive();
  }

  private stopAudio(payload: BrowserCommandPayload<'audio.stop'>): void {
    if (this.captureStreamId === undefined || Number(payload.streamId) !== this.captureStreamId) return;
    // audio.stop is the browser's compensating action when local activation
    // fails after begin acknowledgement. Tear down both live owners so the
    // next explicit session.begin is a real, retryable pre-live transition.
    void this.rollbackLiveToPrelive();
  }
  private async rollbackLiveToPrelive(): Promise<void> {
    const audio = this.audio;
    this.captureStreamId = undefined;
    this.liveBegin = undefined;
    this.live = false;
    this.orchestrator?.stop();
    this.orchestrator = undefined;
    this.audio = undefined;
    await audio?.close().catch(() => undefined);
    if (!this.stopped) this.emitSessionPhase('prelive');
  }

  private audioStatus(value: AudioEngineStatusSnapshot): void {
    if (!this.sessionId || !this.orchestrator || this.stopped) return;
    const snapshot = this.orchestrator.snapshot();
    if (snapshot.phase === 'acceptance_pending_terminal') return;
    this.send(
      event(this.sessionId, snapshot.epoch, 'session.state', {
        // Audio status emitted while session.begin is still in flight must not
        // report an idle/live phase; pre-live transitions are explicit.
        phase: this.live ? snapshot.phase : 'starting_live',
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
    if (!this.sessionId || this.stopped) return;
    this.send(
      event(this.sessionId, this.orchestrator?.snapshot().epoch ?? 0, 'failure', {
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
