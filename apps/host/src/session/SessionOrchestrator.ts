import { randomBytes } from 'node:crypto';
import {
  DEFAULT_PERSONA_MARKDOWN,
  parsePersona,
  type HostEvent,
  type PersonaInterpretation,
  type PlaybackPausedEvent,
  type PlaybackProgressEvent,
  type PlaybackStoppedEvent,
  type SessionStateEvent,
} from '@app/contracts';
import {
  CHALLENGE_COOLDOWN_TURNS,
  decide,
  POLICY_VERSION,
  type PolicyDecision,
  type PolicyInput,
  type Posture,
} from '@app/policy';
import type { PiClient, PiPosture } from '../pi/PiClient.js';
import type { PiResearchClient } from '../pi/PiResearchClient.js';
import {
  fallbackInterruptionDecision,
  hasCorrectionIntent,
  hasLexicalContent,
  isBareRedirection,
  PiInterruptionIntentClassifier,
  type InterruptionIntentClassifier,
  type InterruptionIntentDecision,
} from './InterruptionIntentClassifier.js';
import { ReasoningSpeechAssembler } from './ReasoningSpeechAssembler.js';
import { ResearchPartAssembler, researchPartLimits } from './ResearchPartAssembler.js';
import { log } from '../logger.js';

export type SessionPhase =
  | 'idle'
  | 'planning'
  | 'ready'
  | 'listening'
  | 'deciding'
  | 'reasoning'
  | 'synthesizing'
  | 'playing'
  | 'echo_provisional'
  | 'interruption_deciding'
  | 'acceptance_pending_terminal'
  | 'stopped';
export type SessionEvent = HostEvent;
export type HostEventType = HostEvent['type'];
type HostEventFor<T extends HostEventType> = HostEvent extends infer Event
  ? Event extends { type: infer Type }
    ? T extends Type
      ? Event
      : never
    : never
  : never;
export type HostEventPayload<T extends HostEventType> = HostEventFor<T>['payload'];
type ResponseCancelReason = HostEventPayload<'response.cancelled'>['reason'];
type EmittedSessionPhase = SessionStateEvent['payload']['phase'];
export interface SpeechSynthesisStart {
  playbackId: string;
  sampleRate: number;
  generatedSamples?: number;
  partIndex?: number;
  partId?: string;
  outputStreamId?: number;
  backendId?: string;
  modelId?: string;
  completion?: Promise<{ generatedSamples: number }>;
}
export interface SpeechOutputStream {
  readonly started: Promise<SpeechSynthesisStart>;
  append(text: string): void;
  finish(): void;
}
export interface SpeechOutputPort {
  begin(input: {
    sessionId: string;
    epoch: number;
    responseId: string;
    partIndex?: number;
    partId?: string;
    signal: AbortSignal;
    onGeneratedSamples?: (total: number) => void;
  }): SpeechOutputStream;
  synthesize(input: {
    sessionId: string;
    epoch: number;
    responseId: string;
    partIndex?: number;
    partId?: string;
    text: string;
    signal: AbortSignal;
    onGeneratedSamples?: (total: number) => void;
  }): Promise<SpeechSynthesisStart>;
  pause(responseId: string): void;
  // The host's sidecar is not audible, but retaining the requested rewind on
  // this control path keeps browser and host interruption decisions aligned.
  resume(responseId: string, rewindMs?: number): void;
  cancel(responseId: string, partIndex?: number): void;
  release?(responseId: string, partIndex?: number): void;
}
export interface Scheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}
export interface SessionOrchestratorOptions {
  sessionId: string;
  sessionSeed: string;
  pi: PiClient;
  speech: SpeechOutputPort;
  personaSource?: string | Uint8Array;
  emit?: (event: HostEvent) => void;
  now?: () => number;
  idFactory?: () => string;
  scheduler?: Scheduler;
  provisionalTimeoutMs?: number;
  classifierTimeoutMs?: number;
  interruptionClassifier?: InterruptionIntentClassifier;
  maxContextBytes?: number;
  maxContextTurns?: number;
  policyDecide?: (input: PolicyInput) => PolicyDecision;
  transcriptOnly?: boolean;
  reasoningDeltaCoalesceChars?: number;
  researchPi?: PiResearchClient;
  /** Frozen, bounded preparation notes. They are context only and never spoken directly. */
  planningContext?: string;
  multiPartEnabled?: boolean;
}
export interface SessionSnapshot {
  phase: SessionPhase;
  epoch: number;
  personaDigest: string;
  activeResponseId?: string;
  deliveredExtent: Readonly<Record<string, number>>;
}
export interface SessionRetentionSnapshot {
  contextTurns: number;
  recentDecisions: number;
  seenTurns: number;
}
interface ContextTurn {
  role: 'user' | 'assistant';
  text: string;
}
interface PlaybackLedger {
  outputEpoch: number;
  generatedSamples: number;
  delivered: number;
  terminal: boolean;
}
export interface ActiveResponse {
  responseId: string;
  turnId: string;
  epoch: number;
  posture: PiPosture;
  controller: AbortController;
  cancelled: boolean;
  playbackId?: string;
  assistantText?: string;
  reasoningPrefix: string;
  generatedSamples: number;
  phaseBeforeProvisional?: SessionPhase;
}
interface ProvisionalState {
  responseId: string;
  outputEpoch: number;
  // Multipart responses keep the parent ActiveResponse pointed at the first
  // part for response-level lifecycle handling. Interruption checkpoints must
  // retain the playback identity of the part that was actually paused.
  playbackId?: string;
  echoRecovered: boolean;
  pausedAtMs: number;
  deadlineAtMs: number;
  pausedSampleOffset?: number;
  generatedSamples?: number;
  deciding?: AbortController;
  turnId?: string;
  pendingTurn?: { epoch: number; turnId: string; text: string; endpointComplete: boolean };
  cancelTimer: () => void;
}
interface AcceptancePendingTerminal {
  responseId: string;
  playbackId: string;
  outputEpoch: number;
  turn: { epoch: number; turnId: string; text: string; endpointComplete: boolean };
  cancelTimer: () => void;
}

export class PersonaValidationError extends Error {
  constructor(readonly diagnostics: readonly { code: string; message: string }[]) {
    super('session persona validation failed');
  }
}

function defaultUuidV7(now: number): string {
  const bytes = randomBytes(16);
  let time = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time & 0xff;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export class SessionOrchestrator {
  private phase: SessionPhase = 'idle';
  private epoch = 0;
  private readonly persona: PersonaInterpretation;
  private readonly personaDigest: string;
  private readonly seenTurns = new Set<string>();
  private readonly recentDecisions: Array<{ turnId: string; eligible: boolean; posture: Posture }> = [];
  private readonly context: ContextTurn[] = [];
  private readonly playback = new Map<string, PlaybackLedger>();
  private active: ActiveResponse | undefined;
  private provisional: ProvisionalState | undefined;
  private acceptancePendingTerminal: AcceptancePendingTerminal | undefined;
  private timedOutInterruptionEpoch: number | undefined;
  // VAD speech and TTS start are independent asynchronous streams. Keep the
  // capture-side speech state so a response that becomes audible after the
  // user has already started talking is paused before it can overlap them.
  private userSpeaking = false;
  private stableUserTurnCount = 0;
  private eligibleTurnsSinceChallenge = CHALLENGE_COOLDOWN_TURNS;
  private readonly emitFn: (event: HostEvent) => void;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly scheduler: Scheduler;
  private readonly provisionalTimeoutMs: number;
  private readonly classifierTimeoutMs: number;
  private readonly interruptionClassifier: InterruptionIntentClassifier;
  private readonly maxContextBytes: number;
  private readonly maxContextTurns: number;
  private readonly policyDecide: (input: PolicyInput) => PolicyDecision;
  private readonly reasoningDeltaCoalesceChars: number;
  private readonly researchPi: PiResearchClient | undefined;
  private planningContext: string;
  private readonly multiPartEnabled: boolean;

  constructor(private readonly options: SessionOrchestratorOptions) {
    const parsed = parsePersona(options.personaSource ?? DEFAULT_PERSONA_MARKDOWN);
    if (!parsed.ok) throw new PersonaValidationError(parsed.errors);
    this.persona = parsed.interpretation;
    this.personaDigest = parsed.digest;
    this.emitFn = options.emit ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.idFactory = options.idFactory ?? (() => defaultUuidV7(Date.now()));
    this.scheduler = options.scheduler ?? {
      schedule: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    };
    // Bound the whole interruption recovery window, including the endpoint
    // delay before speech_end. A five-second UI listening state must never be
    // extended by the old five-second post-end grace period.
    this.provisionalTimeoutMs = options.provisionalTimeoutMs ?? 3_000;
    this.classifierTimeoutMs = options.classifierTimeoutMs ?? 2_500;
    this.interruptionClassifier = options.interruptionClassifier ?? new PiInterruptionIntentClassifier(options.pi);
    this.maxContextBytes = options.maxContextBytes ?? 4096;
    this.maxContextTurns = options.maxContextTurns ?? 6;
    this.policyDecide = options.policyDecide ?? decide;
    this.reasoningDeltaCoalesceChars = Math.max(1, options.reasoningDeltaCoalesceChars ?? 16);
    this.researchPi = options.researchPi;
    this.planningContext = truncateUtf8(options.planningContext?.trim() ?? '', 3_072);
    this.multiPartEnabled = Boolean(options.researchPi && options.multiPartEnabled);
  }

  /** Late-arriving preparation notes join the bounded context for future turns. */
  setPlanningContext(notes: string | undefined): void {
    this.planningContext = truncateUtf8(notes?.trim() ?? '', 3_072);
  }

  start(): void {
    if (this.phase !== 'idle') return;
    this.phase = 'listening';
    this.emitState();
  }

  snapshot(): SessionSnapshot {
    const deliveredExtent = Object.fromEntries([...this.playback].map(([id, value]) => [id, value.delivered]));
    const snapshot: SessionSnapshot = {
      phase: this.phase,
      epoch: this.epoch,
      personaDigest: this.personaDigest,
      deliveredExtent,
    };
    if (this.active) snapshot.activeResponseId = this.active.responseId;
    return snapshot;
  }

  retentionSnapshot(): SessionRetentionSnapshot {
    return {
      contextTurns: this.context.length,
      recentDecisions: this.recentDecisions.length,
      seenTurns: this.seenTurns.size,
    };
  }

  async handleStableFinal(turn: {
    epoch: number;
    turnId: string;
    text: string;
    endpointComplete: boolean;
  }): Promise<void> {
    if (turn.epoch !== this.epoch || this.phase === 'stopped' || this.seenTurns.has(turn.turnId)) return;
    this.seenTurns.add(turn.turnId);
    if (this.timedOutInterruptionEpoch === turn.epoch) {
      this.timedOutInterruptionEpoch = undefined;
      return;
    }
    if (this.acceptancePendingTerminal) return;
    if (this.provisional) {
      await this.decideInterruption(turn);
      return;
    }
    // Do not cancel a response merely because VAD produced a stable final while
    // the response is still being generated. Short false positives are common
    // with background noise (for example, eating), and cancelling here leaves
    // the user with no answer to their original turn. Evaluate the transcript
    // first, then supersede only an eligible new turn below.
    const activeBeforePolicy = this.active;
    const boundedContext = this.boundedContext();
    const policy = this.policyDecide({
      policyVersion: POLICY_VERSION,
      personaDigest: this.personaDigest,
      persona: this.persona,
      sessionSeed: this.options.sessionSeed,
      turnId: turn.turnId,
      transcript: turn.text,
      endpointComplete: turn.endpointComplete,
      stableUserTurnCount: this.stableUserTurnCount + 1,
      recentDecisions: this.recentDecisions,
      eligibleTurnsSinceChallenge: this.eligibleTurnsSinceChallenge,
    });
    // A silence decision is not a takeover. Keep an in-flight response alive
    // when the candidate turn was captured before it became audible. This is
    // the recovery path for accidental VAD/STT finals during reasoning.
    const keepActiveResponse = Boolean(activeBeforePolicy && policy.posture === 'silence');
    if (!keepActiveResponse && this.active) this.advanceEpochAndCancel();
    const operationEpoch = this.epoch;
    if (!keepActiveResponse) this.phase = 'deciding';
    this.emit('policy.decision', { turnId: turn.turnId, ...policy, reasonCodes: [...policy.reasonCodes] });
    this.recentDecisions.push({ turnId: turn.turnId, eligible: policy.eligible, posture: policy.posture });
    if (this.recentDecisions.length > 10) this.recentDecisions.splice(0, this.recentDecisions.length - 10);
    this.stableUserTurnCount++;
    this.addContext({ role: 'user', text: turn.text.trim() });
    if (policy.eligible)
      this.eligibleTurnsSinceChallenge = policy.posture === 'challenge' ? 0 : this.eligibleTurnsSinceChallenge + 1;
    if (policy.posture === 'silence' || this.options.transcriptOnly) {
      if (keepActiveResponse) {
        // Leave the host phase untouched. The active response will emit its
        // normal TTS/playback state, or fail and recover through its usual path.
        return;
      }
      this.phase = 'listening';
      this.emitState();
      return;
    }

    if (this.multiPartEnabled && this.researchPi) {
      await this.runLongResponse(
        { epoch: operationEpoch, turnId: turn.turnId, text: turn.text, posture: policy.posture },
        boundedContext,
      );
      return;
    }

    const responseId = this.idFactory();
    const controller = new AbortController();
    const active: ActiveResponse = {
      responseId,
      turnId: turn.turnId,
      epoch: operationEpoch,
      posture: policy.posture,
      controller,
      cancelled: false,
      reasoningPrefix: '',
      generatedSamples: 0,
    };
    this.active = active;
    this.phase = 'reasoning';
    this.emit('reasoning.started', { turnId: active.turnId, responseId: active.responseId, posture: active.posture });
    const assembler = new ReasoningSpeechAssembler(active.posture);
    try {
      const speechStream = this.options.speech.begin({
        sessionId: this.options.sessionId,
        epoch: active.epoch,
        responseId: active.responseId,
        signal: controller.signal,
        onGeneratedSamples: (total) => this.recordGeneratedSamples(active, total),
      });
      // Attach rejection handling immediately so cancel-before-first-sentence
      // cannot create an unhandled rejection.
      void speechStream.started.catch(() => undefined);
      speechStream.started.then(
        (meta) => {
          if (!this.isCurrent(active)) return;
          if (!Number.isSafeInteger(meta.sampleRate) || meta.sampleRate <= 0) {
            this.failResponse(active, 'tts_failed');
            return;
          }
          if (
            meta.generatedSamples !== undefined &&
            (!Number.isSafeInteger(meta.generatedSamples) || meta.generatedSamples <= 0)
          ) {
            this.failResponse(active, 'tts_failed');
            return;
          }
          active.playbackId = meta.playbackId;
          this.playback.set(meta.playbackId, {
            outputEpoch: active.epoch,
            generatedSamples: Math.max(active.generatedSamples, meta.generatedSamples ?? 0),
            delivered: 0,
            terminal: false,
          });
          const started: HostEventPayload<'tts.started'> = {
            responseId: active.responseId,
            playbackId: meta.playbackId,
            sampleRate: meta.sampleRate,
          };
          if (meta.backendId) started.backendId = meta.backendId;
          if (meta.modelId) started.modelId = meta.modelId;
          this.emit('tts.started', started);
          this.setUnderlyingPhase(active, 'playing');
          // Speech can begin while Pi is still warming up. In that race there
          // was no provisional barge-in at speech_start, so create one
          // before releasing buffered PCM. The browser therefore receives the
          // pause barrier before the first output chunk can be scheduled.
          if (this.userSpeaking && !this.hasProvisional(active.responseId))
            this.beginProvisionalBargeIn(active.responseId);
          else if (this.hasProvisional(active.responseId)) this.options.speech.pause(active.responseId);
          this.options.speech.release?.(active.responseId);
          if (meta.completion) {
            void meta.completion.then(
              (completed) => {
                if (!this.isCurrent(active)) return;
                if (!Number.isSafeInteger(completed.generatedSamples) || completed.generatedSamples <= 0) {
                  this.failResponse(active, 'tts_failed');
                  return;
                }
                const ledger = this.playback.get(meta.playbackId);
                if (!ledger || ledger.outputEpoch !== active.epoch || ledger.terminal) return;
                ledger.generatedSamples = completed.generatedSamples;
                this.emit('tts.ended', {
                  responseId: active.responseId,
                  playbackId: meta.playbackId,
                  generatedSamples: completed.generatedSamples,
                });
              },
              () => {
                if (this.isCurrent(active)) this.failResponse(active, 'tts_failed');
              },
            );
          }
        },
        () => {
          if (this.isCurrent(active)) this.failResponse(active, 'tts_failed');
        },
      );

      let finalText: string | undefined;
      let duplicateFinal = false;
      let emittedDeltaPrefix = '';
      const emitReasoningDelta = (text: string): void => {
        // Presentational preview only: never emit once cancelled/superseded, and
        // never after reasoning.final (which is authoritative).
        if (!text || text === emittedDeltaPrefix || !this.isCurrent(active)) return;
        emittedDeltaPrefix = text;
        this.emit('reasoning.delta', { turnId: active.turnId, responseId: active.responseId, text });
      };
      for await (const event of this.options.pi.request(
        { posture: policy.posture, transcript: truncateUtf8(turn.text, 16 * 1024), boundedContext, maxWords: 45 },
        controller.signal,
      )) {
        if (!this.isCurrent(active)) return;
        if (event.type === 'final') {
          if (finalText !== undefined) duplicateFinal = true;
          else finalText = event.text;
        } else if (event.type === 'delta') {
          const chunks = assembler.append(event.text);
          active.reasoningPrefix = assembler.canonicalPrefix;
          for (const chunk of chunks) speechStream.append(chunk.text);
          const preview = assembler.canonicalPrefix;
          if (
            preview &&
            (emittedDeltaPrefix === '' ||
              preview.length - emittedDeltaPrefix.length >= this.reasoningDeltaCoalesceChars)
          )
            emitReasoningDelta(preview);
        } else if (event.type === 'error') {
          this.failResponse(active, 'reasoning_unavailable');
          return;
        }
      }
      if (!this.isCurrent(active)) return;
      if (duplicateFinal) {
        this.failResponse(active, 'reasoning_invalid');
        return;
      }

      let validated: string | undefined;
      try {
        const finalized = assembler.final(finalText ?? '');
        validated = finalized.result.canonical;
        if (finalized.tail) speechStream.append(finalized.tail.text);
        if (!validated || validated.split(/\s+/u).filter(Boolean).length > 45) validated = undefined;
        if (active.posture === 'question' && (validated?.match(/\?/gu) ?? []).length > 1) validated = undefined;
        if (validated && /^(?:```|\{|\[|assistant\s*:|system\s*:|<\/?(?:script|iframe)\b)/iu.test(validated))
          validated = undefined;
        if (validated && !assembler.validateFull(validated)) validated = undefined;
      } catch {
        validated = undefined;
      }
      if (!validated) {
        this.failResponse(active, 'reasoning_invalid');
        return;
      }
      // Flush the preview to the full validated text so the tentative row matches
      // exactly before it materializes, then hand off to the authoritative final.
      emitReasoningDelta(validated);
      this.emit('reasoning.final', {
        turnId: active.turnId,
        responseId: active.responseId,
        posture: active.posture,
        text: validated,
      });
      active.assistantText = validated;
      speechStream.finish();
    } catch {
      if (!this.isCurrent(active)) return;
      this.failResponse(active, 'reasoning_unavailable');
    }
  }

  /**
   * Tool-capable responses deliberately use the same response, progressive TTS
   * stream, and playback ledger as concise turns.  The acknowledgement is
   * deterministic so research begins immediately rather than waiting on a
   * second LLM request.
   */
  private async runLongResponse(
    turn: { epoch: number; turnId: string; text: string; posture: PiPosture },
    boundedContext: string,
  ): Promise<void> {
    const active: ActiveResponse = {
      responseId: this.idFactory(),
      turnId: turn.turnId,
      epoch: turn.epoch,
      posture: turn.posture,
      controller: new AbortController(),
      cancelled: false,
      reasoningPrefix: '',
      generatedSamples: 0,
    };
    this.active = active;
    this.phase = 'reasoning';
    this.emit('reasoning.started', { turnId: active.turnId, responseId: active.responseId, posture: active.posture });
    const acknowledgement = 'Let me think that through.';
    const limits = researchPartLimits(active.posture);
    const assembler = new ResearchPartAssembler(
      limits.maxPartWords,
      limits.maxPartChars,
      limits.maxPartSentences,
      limits.maxParts,
    );
    let cumulative = acknowledgement;
    let finalSeen = false;
    try {
      const stream = this.options.speech.begin({
        sessionId: this.options.sessionId,
        epoch: active.epoch,
        responseId: active.responseId,
        signal: active.controller.signal,
        onGeneratedSamples: (total) => this.recordGeneratedSamples(active, total),
      });
      void stream.started.catch(() => undefined);
      stream.started.then(
        (meta) => {
          if (!this.isCurrent(active)) return;
          if (!Number.isSafeInteger(meta.sampleRate) || meta.sampleRate <= 0)
            return this.failResponse(active, 'tts_failed');
          if (
            meta.generatedSamples !== undefined &&
            (!Number.isSafeInteger(meta.generatedSamples) || meta.generatedSamples <= 0)
          )
            return this.failResponse(active, 'tts_failed');
          active.playbackId = meta.playbackId;
          this.playback.set(meta.playbackId, {
            outputEpoch: active.epoch,
            generatedSamples: Math.max(active.generatedSamples, meta.generatedSamples ?? 0),
            delivered: 0,
            terminal: false,
          });
          const started: HostEventPayload<'tts.started'> = {
            responseId: active.responseId,
            playbackId: meta.playbackId,
            sampleRate: meta.sampleRate,
          };
          if (meta.backendId) started.backendId = meta.backendId;
          if (meta.modelId) started.modelId = meta.modelId;
          this.emit('tts.started', started);
          this.setUnderlyingPhase(active, 'playing');
          if (this.userSpeaking && !this.hasProvisional(active.responseId))
            this.beginProvisionalBargeIn(active.responseId);
          else if (this.hasProvisional(active.responseId)) this.options.speech.pause(active.responseId);
          this.options.speech.release?.(active.responseId);
          if (meta.completion) {
            void meta.completion.then(
              (completed) => {
                if (!this.isCurrent(active)) return;
                if (!Number.isSafeInteger(completed.generatedSamples) || completed.generatedSamples <= 0) {
                  this.failResponse(active, 'tts_failed');
                  return;
                }
                const ledger = this.playback.get(meta.playbackId);
                if (!ledger || ledger.outputEpoch !== active.epoch || ledger.terminal) return;
                ledger.generatedSamples = completed.generatedSamples;
                this.emit('tts.ended', {
                  responseId: active.responseId,
                  playbackId: meta.playbackId,
                  generatedSamples: completed.generatedSamples,
                });
              },
              () => {
                if (this.isCurrent(active)) this.failResponse(active, 'tts_failed');
              },
            );
          }
        },
        () => {
          if (this.isCurrent(active)) this.failResponse(active, 'tts_failed');
        },
      );
      // Ack first, then dispatch body immediately; every delta below replaces
      // the cumulative checkpoint rather than reconstructing arrival order.
      stream.append(acknowledgement);
      active.reasoningPrefix = acknowledgement;
      this.emit('reasoning.delta', { turnId: active.turnId, responseId: active.responseId, text: acknowledgement });
      for await (const item of this.researchPi!.requestBody(
        {
          posture: active.posture,
          transcript: truncateUtf8(turn.text, 16 * 1024),
          boundedContext,
          stallText: acknowledgement,
          onToolActivity: (activity) => {
            if (this.isCurrent(active))
              this.emit('tool.activity', {
                scope: 'turn',
                turnId: active.turnId,
                responseId: active.responseId,
                ...activity,
              });
          },
        },
        active.controller.signal,
      )) {
        if (!this.isCurrent(active)) return;
        if (item.type === 'error') return this.failResponse(active, 'reasoning_unavailable');
        if (item.type === 'delta') {
          for (const chunk of assembler.append(item.text)) {
            stream.append(chunk.text);
            cumulative = `${cumulative} ${chunk.text}`.trim();
            active.reasoningPrefix = cumulative;
            this.emit('reasoning.delta', { turnId: active.turnId, responseId: active.responseId, text: cumulative });
          }
        } else if (item.type === 'final') {
          if (finalSeen) return this.failResponse(active, 'reasoning_invalid');
          finalSeen = true;
          for (const chunk of assembler.final(item.text).parts) {
            stream.append(chunk.text);
            cumulative = `${cumulative} ${chunk.text}`.trim();
          }
        }
      }
      if (!this.isCurrent(active) || !finalSeen) return this.failResponse(active, 'reasoning_invalid');
      active.reasoningPrefix = cumulative;
      active.assistantText = cumulative;
      this.emit('reasoning.final', {
        turnId: active.turnId,
        responseId: active.responseId,
        posture: active.posture,
        text: cumulative,
      });
      stream.finish();
    } catch {
      if (this.isCurrent(active)) this.failResponse(active, 'reasoning_unavailable');
    }
  }

  handleSpeechStart(): number {
    if (this.phase === 'stopped') return this.epoch;
    this.userSpeaking = true;
    this.timedOutInterruptionEpoch = undefined;
    if (this.acceptancePendingTerminal) {
      this.acceptancePendingTerminal.cancelTimer();
      this.acceptancePendingTerminal = undefined;
      this.advanceEpochAndCancel();
      this.phase = 'listening';
      this.emitState();
      return this.epoch;
    }
    const active = this.active;
    if (!active) return this.epoch;
    if (this.provisional?.responseId === active.responseId) {
      // A newer utterance extends the same provisional pause. Invalidate the
      // older decision. The answer must not resume while the user is speaking.
      this.provisional.cancelTimer();
      this.provisional.cancelTimer = () => {};
      this.provisional.deciding?.abort();
      delete this.provisional.deciding;
      delete this.provisional.turnId;
      delete this.provisional.pendingTurn;
      this.provisional.deadlineAtMs = this.now() + this.provisionalTimeoutMs;
      this.provisional.cancelTimer();
      this.provisional.cancelTimer = () => {};
      this.phase = 'echo_provisional';
      return this.epoch;
    }
    if (this.phase === 'playing') {
      this.beginProvisionalBargeIn(active.responseId);
      return this.epoch;
    }
    // Speech start is only a signal that the user may be speaking. While the
    // response is still reasoning, wait for its stable final before deciding
    // whether it is a real takeover. VAD can fire on non-speech noise, and
    // cancelling here used to orphan the original response before it became
    // audible.
    return this.epoch;
  }

  handleSpeechEnd(): void {
    if (this.phase === 'stopped') return;
    this.userSpeaking = false;
    if (this.provisional) {
      this.scheduleProvisionalTimeout(this.provisional);
      return;
    }
    if (!this.active && this.phase === 'listening') {
      this.phase = 'deciding';
      this.emitState();
    }
  }

  beginProvisionalBargeIn(responseId: string): boolean {
    const active = this.active;
    if (!active || active.responseId !== responseId || this.phase === 'stopped' || this.provisional) return false;
    active.phaseBeforeProvisional = this.phase;
    this.options.speech.pause(responseId);
    const ledger = active.playbackId ? this.playback.get(active.playbackId) : undefined;
    const pausedAtMs = this.now();
    const provisional: ProvisionalState = {
      responseId,
      outputEpoch: active.epoch,
      echoRecovered: false,
      pausedAtMs,
      deadlineAtMs: pausedAtMs + this.provisionalTimeoutMs,
      cancelTimer: () => {},
    };
    if (ledger) provisional.generatedSamples = ledger.generatedSamples;
    this.provisional = provisional;
    // While speech is active, wait for VAD's speech_end before starting the
    // bounded recovery timer. This avoids spending the recovery window while
    // the user is still talking and keeps the takeover race deterministic.
    if (!this.userSpeaking) this.scheduleProvisionalTimeout(provisional);
    this.phase = 'echo_provisional';
    this.emit('barge_in.provisional', { responseId, outputEpoch: active.epoch, resumable: true });
    return true;
  }

  playbackPaused(input: PlaybackPausedEvent['payload']): void {
    const provisional = this.provisional;
    const active = this.active;
    const ledger = this.playback.get(input.playbackId);
    if (
      !provisional ||
      !active ||
      active.responseId !== input.responseId ||
      active.epoch !== input.outputEpoch ||
      provisional.responseId !== input.responseId ||
      provisional.outputEpoch !== input.outputEpoch ||
      !ledger ||
      ledger.terminal
    )
      return;
    if (active.playbackId !== input.playbackId) return;
    if (
      ![input.outputEpoch, input.pausedSampleOffset, input.generatedSamples].every((value) =>
        this.validOffset(value),
      ) ||
      input.generatedSamples > ledger.generatedSamples ||
      input.pausedSampleOffset > input.generatedSamples ||
      input.pausedSampleOffset < ledger.delivered
    )
      return;
    ledger.delivered = input.pausedSampleOffset;
    provisional.playbackId = input.playbackId;
    provisional.pausedSampleOffset = input.pausedSampleOffset;
    provisional.generatedSamples = input.generatedSamples;
    const pendingTurn = provisional.pendingTurn;
    if (pendingTurn) {
      delete provisional.pendingTurn;
      void this.decideInterruption(pendingTurn);
    }
  }

  setEchoRecovered(recovered: boolean): void {
    if (this.provisional) this.provisional.echoRecovered = recovered;
  }
  confirmBargeIn(): boolean {
    const provisional = this.provisional;
    if (!provisional || this.phase === 'stopped') return false;
    provisional.cancelTimer();
    provisional.deciding?.abort();
    this.provisional = undefined;
    const responseId = provisional.responseId;
    const outputEpoch = provisional.outputEpoch;
    this.advanceEpochAndCancel();
    this.phase = 'listening';
    this.emit('barge_in.confirmed', { responseId, outputEpoch, resumable: false });
    return true;
  }
  rejectBargeIn(): boolean {
    return this.resolveProvisional('rejected');
  }

  playbackProgress(input: PlaybackProgressEvent['payload']): void {
    const ledger = this.playback.get(input.playbackId);
    if (
      !ledger ||
      ledger.terminal ||
      !this.validOffset(input.outputEpoch) ||
      !this.validOffset(input.playedSampleOffset) ||
      !this.validOffset(input.generatedSamples)
    )
      return;
    if (input.outputEpoch !== this.epoch || ledger.outputEpoch !== input.outputEpoch) return;
    // Progressive speech: browser may report an older generated prefix after host ledger has advanced.
    // Accept as long as the browser's generatedSamples is not beyond what the host has received.
    if (input.generatedSamples > ledger.generatedSamples) return;
    if (input.playedSampleOffset > input.generatedSamples) return;
    ledger.delivered = Math.max(ledger.delivered, input.playedSampleOffset);
  }

  playbackStopped(input: PlaybackStoppedEvent['payload']): void {
    const ledger = this.playback.get(input.playbackId);
    if (
      !ledger ||
      ledger.terminal ||
      !this.validOffset(input.cancelledEpoch) ||
      !this.validOffset(input.finalPlayedSampleOffset)
    )
      return;
    if (ledger.outputEpoch !== input.cancelledEpoch || input.finalPlayedSampleOffset > ledger.generatedSamples) return;
    ledger.delivered = Math.max(ledger.delivered, input.finalPlayedSampleOffset);
    ledger.terminal = true;
    const pending = this.acceptancePendingTerminal;
    if (
      pending &&
      pending.playbackId === input.playbackId &&
      pending.outputEpoch === input.cancelledEpoch &&
      pending.responseId === this.active?.responseId
    ) {
      this.finalizeAcceptedTakeover(pending);
      return;
    }
    if (input.cancelledEpoch !== this.epoch) return;
    const active = this.active;
    if (!active || this.phase === 'stopped') return;
    if (active.playbackId !== input.playbackId) return;
    if (
      input.reason === 'completed' &&
      input.finalPlayedSampleOffset === ledger.generatedSamples &&
      active.assistantText
    ) {
      this.addContext({ role: 'assistant', text: active.assistantText });
    }
    const provisional = this.provisional?.responseId === active.responseId ? this.provisional : undefined;
    if (provisional) {
      provisional.cancelTimer();
      this.provisional = undefined;
      this.emit('barge_in.rejected', {
        responseId: provisional.responseId,
        outputEpoch: provisional.outputEpoch,
        resumable: false,
      });
    }
    this.active = undefined;
    this.phase = 'listening';
    this.emitState();
  }

  cancelCurrentTurn(): void {
    if (this.phase === 'stopped') return;
    this.acceptancePendingTerminal?.cancelTimer();
    this.acceptancePendingTerminal = undefined;
    const provisional = this.provisional;
    provisional?.cancelTimer();
    provisional?.deciding?.abort();
    this.provisional = undefined;
    const responseId = provisional?.responseId;
    const outputEpoch = provisional?.outputEpoch;
    if (this.active || provisional) this.advanceEpochAndCancel('user');
    if (responseId && outputEpoch !== undefined)
      this.emit('barge_in.confirmed', { responseId, outputEpoch, resumable: false });
    this.phase = 'listening';
    this.emitState();
  }

  stop(): void {
    if (this.phase === 'stopped') return;
    this.acceptancePendingTerminal?.cancelTimer();
    this.acceptancePendingTerminal = undefined;
    const provisional = this.provisional;
    provisional?.cancelTimer();
    provisional?.deciding?.abort();
    this.provisional = undefined;
    this.advanceEpochAndCancel('stopped');
    if (provisional)
      this.emit('barge_in.rejected', {
        responseId: provisional.responseId,
        outputEpoch: provisional.outputEpoch,
        resumable: false,
      });
    this.userSpeaking = false;
    this.context.length = 0;
    this.recentDecisions.length = 0;
    this.seenTurns.clear();
    this.stableUserTurnCount = 0;
    this.eligibleTurnsSinceChallenge = CHALLENGE_COOLDOWN_TURNS;
    this.phase = 'stopped';
    this.emitState();
  }

  private async decideInterruption(turn: {
    epoch: number;
    turnId: string;
    text: string;
    endpointComplete: boolean;
  }): Promise<boolean> {
    const provisional = this.provisional;
    const active = this.active;
    const playbackId = provisional?.playbackId;
    if (!provisional || !active || active.responseId !== provisional.responseId) return false;
    provisional.turnId = turn.turnId;
    this.phase = 'interruption_deciding';
    if (!playbackId || provisional.pausedSampleOffset === undefined || provisional.generatedSamples === undefined) {
      provisional.pendingTurn = turn;
      return false;
    }
    provisional.cancelTimer();
    provisional.cancelTimer = () => {};
    delete provisional.pendingTurn;
    let decision: InterruptionIntentDecision = fallbackInterruptionDecision(turn.text);
    if (
      hasLexicalContent(turn.text) &&
      provisional.pausedSampleOffset !== undefined &&
      provisional.generatedSamples !== undefined
    ) {
      const controller = new AbortController();
      provisional.deciding = controller;
      let timeout: NodeJS.Timeout | undefined;
      try {
        decision = await Promise.race([
          this.interruptionClassifier.decide(
            {
              interruptedResponseText: active.reasoningPrefix || active.assistantText || '',
              deliveredSampleOffset: provisional.pausedSampleOffset,
              generatedSamples: provisional.generatedSamples,
              transcript: turn.text,
              boundedContext: this.boundedContext(),
            },
            controller.signal,
          ),
          new Promise<InterruptionIntentDecision>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('interruption classification timed out')),
              this.classifierTimeoutMs,
            );
          }),
        ]);
      } catch {
        decision = fallbackInterruptionDecision(turn.text);
      } finally {
        if (timeout) clearTimeout(timeout);
        controller.abort();
      }
    }
    if (this.provisional !== provisional) return false;
    // Newer speech re-entered classification and replaced this pending decision.
    if (provisional.turnId !== turn.turnId) return false;
    if (!this.active || this.active !== active) {
      // The response was superseded or cancelled while classifying. Never leave
      // the browser waiting on an orphaned provisional.
      this.resolveProvisional('rejected');
      return false;
    }
    const correction = hasCorrectionIntent(turn.text);
    const redirection = !correction && isBareRedirection(turn.text);
    const fallback = fallbackInterruptionDecision(turn.text);
    const wordCount = turn.text.trim().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    // A short transcript is the common shape of a VAD false positive: "uh",
    // "I", or a clipped backchannel. The classifier is useful for ambiguous
    // real speech, but must not be allowed to turn those fragments into a
    // destructive takeover just because it guessed accept with high confidence.
    // Deterministic corrections and topic fragments remain authoritative.
    const shortAmbiguousResume = fallback.action === 'resume' && wordCount <= 2;
    const accept =
      correction ||
      redirection ||
      (!shortAmbiguousResume &&
        decision.action === 'accept' &&
        decision.confidence !== 'low' &&
        hasLexicalContent(turn.text));
    const disposition = accept
      ? 'accept_takeover'
      : decision.intent === 'continue_previous'
        ? 'resume_requested'
        : hasLexicalContent(turn.text)
          ? 'resume_fragment'
          : 'resume_noise';
    const rewindMs = accept ? 0 : this.rewindMsFor(provisional);
    const interruptionDecision: HostEventPayload<'interruption.decision'> = {
      turnId: turn.turnId,
      responseId: provisional.responseId,
      playbackId,
      outputEpoch: provisional.outputEpoch,
      action: accept ? 'accept' : 'resume',
      intent: accept
        ? decision.action === 'accept'
          ? decision.intent
          : redirection
            ? 'topic_change'
            : 'correction'
        : decision.intent,
      confidence: decision.confidence,
      disposition,
      pausedSampleOffset: provisional.pausedSampleOffset,
    };
    if (rewindMs > 0) interruptionDecision.rewindMs = rewindMs;
    this.emit('interruption.decision', interruptionDecision);
    if (!accept) {
      provisional.echoRecovered = true;
      this.resolveProvisional('rejected', rewindMs);
      return false;
    }
    provisional.cancelTimer();
    provisional.deciding?.abort();
    this.provisional = undefined;
    const pending: AcceptancePendingTerminal = {
      responseId: provisional.responseId,
      playbackId,
      outputEpoch: provisional.outputEpoch,
      turn: {
        epoch: provisional.outputEpoch,
        turnId: turn.turnId,
        text: turn.text,
        endpointComplete: turn.endpointComplete,
      },
      cancelTimer: () => {},
    };
    pending.cancelTimer = this.scheduler.schedule(this.provisionalTimeoutMs, () =>
      this.finalizeAcceptedTakeover(pending),
    );
    this.acceptancePendingTerminal = pending;
    this.cancelResponse(active);
    this.phase = 'acceptance_pending_terminal';
    return true;
  }

  private resolveProvisional(type: 'rejected' | 'timed_out', requestedRewindMs?: number): boolean {
    const provisional = this.provisional;
    if (!provisional || this.phase === 'stopped') return false;
    provisional.cancelTimer();
    provisional.deciding?.abort();
    this.provisional = undefined;
    const active = this.active;
    const ledger = provisional.playbackId ? this.playback.get(provisional.playbackId) : undefined;
    const safe = Boolean(
      active &&
        active.responseId === provisional.responseId &&
        active.epoch === provisional.outputEpoch &&
        this.epoch === provisional.outputEpoch &&
        active.phaseBeforeProvisional === 'playing' &&
        provisional.playbackId &&
        ledger &&
        !ledger.terminal &&
        provisional.pausedSampleOffset !== undefined &&
        (provisional.echoRecovered || type === 'timed_out'),
    );
    const rewindMs = safe ? (requestedRewindMs ?? this.rewindMsFor(provisional)) : 0;
    if (safe && active) {
      this.options.speech.resume(active.responseId, rewindMs);
      this.phase = 'playing';
    } else {
      this.advanceEpochAndCancel();
      this.phase = 'listening';
    }
    const bargeResult: HostEventPayload<'barge_in.rejected' | 'barge_in.timed_out'> = {
      responseId: provisional.responseId,
      outputEpoch: provisional.outputEpoch,
      resumable: safe,
    };
    if (rewindMs > 0) bargeResult.rewindMs = rewindMs;
    this.emit(type === 'rejected' ? 'barge_in.rejected' : 'barge_in.timed_out', bargeResult);
    this.emitState();
    return true;
  }

  private scheduleProvisionalTimeout(provisional: ProvisionalState): void {
    provisional.cancelTimer();
    const delay = Math.max(0, provisional.deadlineAtMs - this.now());
    provisional.cancelTimer = this.scheduler.schedule(delay, () => {
      if (this.provisional !== provisional) return;
      provisional.cancelTimer = () => {};
      // Never resume while the VAD still considers the user to be speaking.
      // handleSpeechEnd() owns the next deadline once capture goes quiet.
      if (this.userSpeaking) return;
      this.timedOutInterruptionEpoch = provisional.outputEpoch;
      this.resolveProvisional('timed_out');
    });
  }
  private rewindMsFor(provisional: ProvisionalState): number {
    return this.now() - provisional.pausedAtMs > 1_000 ? 500 : 0;
  }
  private finalizeAcceptedTakeover(pending: AcceptancePendingTerminal): void {
    if (this.acceptancePendingTerminal !== pending || pending.responseId !== this.active?.responseId) return;
    pending.cancelTimer();
    this.acceptancePendingTerminal = undefined;
    this.advanceEpochAndCancel();
    this.phase = 'listening';
    this.emit('barge_in.confirmed', {
      responseId: pending.responseId,
      outputEpoch: pending.outputEpoch,
      resumable: false,
    });
    this.seenTurns.delete(pending.turn.turnId);
    void this.handleStableFinal({ ...pending.turn, epoch: this.epoch });
  }

  private advanceEpochAndCancel(reason?: ResponseCancelReason): void {
    this.epoch++;
    const active = this.active;
    if (active) {
      this.cancelResponse(active, reason);
      this.active = undefined;
    }
  }
  private cancelResponse(
    active: ActiveResponse,
    reason: ResponseCancelReason = this.phase === 'stopped' ? 'stopped' : 'superseded',
  ): void {
    if (active.cancelled) return;
    active.cancelled = true;
    this.emit('response.cancelled', {
      turnId: active.turnId,
      responseId: active.responseId,
      reason,
    });
    active.controller.abort();
    this.options.speech.cancel(active.responseId);
  }
  private clearActive(active: ActiveResponse): void {
    if (this.active !== active) return;
    const provisional = this.provisional?.responseId === active.responseId ? this.provisional : undefined;
    if (provisional) {
      provisional.cancelTimer();
      this.provisional = undefined;
      this.advanceEpochAndCancel();
      this.phase = 'listening';
      this.emit('barge_in.rejected', {
        responseId: provisional.responseId,
        outputEpoch: provisional.outputEpoch,
        resumable: false,
      });
    } else {
      this.active = undefined;
      this.phase = 'listening';
    }
    this.emitState();
  }
  private hasProvisional(responseId: string): boolean {
    return this.provisional?.responseId === responseId;
  }
  private setUnderlyingPhase(active: ActiveResponse, phase: SessionPhase): void {
    if (this.provisional?.responseId === active.responseId) {
      active.phaseBeforeProvisional = phase;
      this.phase = 'echo_provisional';
    } else this.phase = phase;
  }
  private isCurrent(active: ActiveResponse): boolean {
    return (
      this.phase !== 'stopped' &&
      this.active === active &&
      active.epoch === this.epoch &&
      !active.controller.signal.aborted
    );
  }
  private validOffset(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
  }
  private recordGeneratedSamples(active: ActiveResponse, total: number): void {
    if (!this.validOffset(total) || total < active.generatedSamples || active.cancelled) return;
    active.generatedSamples = total;
    if (!active.playbackId) return;
    const ledger = this.playback.get(active.playbackId);
    if (ledger && !ledger.terminal && ledger.outputEpoch === active.epoch)
      ledger.generatedSamples = Math.max(ledger.generatedSamples, total);
  }
  private addContext(turn: ContextTurn): void {
    this.context.push(turn);
    if (this.context.length > this.maxContextTurns) this.context.splice(0, this.context.length - this.maxContextTurns);
  }
  private boundedContext(): string {
    const lines = this.context.slice(-this.maxContextTurns).map((turn) => `${turn.role}: ${turn.text}`);
    if (!this.planningContext) {
      while (lines.length && Buffer.byteLength(lines.join('\n'), 'utf8') > this.maxContextBytes) lines.shift();
      return truncateUtf8(lines.join('\n'), this.maxContextBytes);
    }
    // Keep preparation notes clearly delimited and reserve their bounded slice
    // before trimming ordinary conversation context. The base Pi prompt treats
    // all of this as untrusted data, so notes cannot redefine spoken behavior.
    const planBlock = `<session_preparation>
${truncateUtf8(this.planningContext, Math.min(3_072, this.maxContextBytes))}
</session_preparation>`;
    const planBytes = Buffer.byteLength(planBlock, 'utf8');
    const contextBudget = Math.max(0, this.maxContextBytes - planBytes - (lines.length ? 1 : 0));
    while (lines.length && Buffer.byteLength(lines.join('\n'), 'utf8') > contextBudget) lines.shift();
    const context = lines.join('\n');
    return truncateUtf8(context ? `${planBlock}\n${context}` : planBlock, this.maxContextBytes);
  }
  private fail(code: string, detail: string, correctiveAction: string): void {
    this.emit('failure', { code, detail, correctiveAction, recoverable: true });
  }
  private failResponse(
    active: ActiveResponse,
    reasonCode: 'reasoning_unavailable' | 'reasoning_invalid' | 'tts_failed',
  ): void {
    log('session', `response fail reason=${reasonCode} responseId=${active.responseId}`);
    this.emit('response.failed', { turnId: active.turnId, responseId: active.responseId, reasonCode });
    this.fail(reasonCode, 'The response could not be completed successfully.', 'Continue listening.');
    // Establish the local TTS forwarding cutoff before clearing state so a failed
    // response cannot leave the sidecar progressive stream open and block a
    // later successful response. cancelResponse is idempotent.
    this.cancelResponse(active);
    this.clearActive(active);
  }
  private emitState(): void {
    if (this.phase === 'acceptance_pending_terminal') return;
    const phase: EmittedSessionPhase = this.phase;
    this.emit('session.state', { phase, personaDigest: this.personaDigest });
  }
  private emit<T extends HostEventType>(type: T, payload: HostEventPayload<T>): void {
    // SAFETY: `payload` is selected from HostEvent's discriminated union by `type`.
    this.emitFn({
      protocolVersion: 1,
      sessionId: this.options.sessionId,
      epoch: this.epoch,
      eventId: this.idFactory(),
      type,
      monotonicMs: Math.max(0, this.now()),
      payload,
    } as HostEvent);
  }
}
