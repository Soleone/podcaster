import { randomBytes } from "node:crypto";
import { DEFAULT_PERSONA_MARKDOWN, parsePersona, type PersonaInterpretation } from "@app/contracts";
import { decide, POLICY_VERSION, type PolicyDecision, type PolicyInput, type Posture } from "@app/policy";
import type { PiClient, PiEvent, PiPosture } from "../pi/PiClient.js";
import type { PiResearchClient } from "../pi/PiResearchClient.js";
import { fallbackInterruptionDecision, hasCorrectionIntent, hasLexicalContent, isBareRedirection, PiInterruptionIntentClassifier, type InterruptionIntentClassifier, type InterruptionIntentDecision } from "./InterruptionIntentClassifier.js";
import { ReasoningSpeechAssembler } from "./ReasoningSpeechAssembler.js";
import { ResearchPartAssembler } from "./ResearchPartAssembler.js";
import { log } from "../logger.js";

export type SessionPhase = "idle" | "listening" | "deciding" | "reasoning" | "synthesizing" | "playing" | "echo_provisional" | "interruption_deciding" | "acceptance_pending_terminal" | "stopped";
export interface SessionEvent { protocolVersion: 1; sessionId: string; epoch: number; eventId: string; type: string; monotonicMs: number; payload: Record<string, unknown> }
export interface SpeechSynthesisStart {
  playbackId: string;
  sampleRate: number;
  generatedSamples?: number;
  partIndex?: number;
  partId?: string;
  outputStreamId?: number;
  completion?: Promise<{ generatedSamples: number }>;
}
export interface SpeechOutputStream {
  readonly started: Promise<SpeechSynthesisStart>;
  append(text: string): void;
  finish(): void;
}
export interface SpeechOutputPort {
  begin(input: { sessionId: string; epoch: number; responseId: string; partIndex?: number; partId?: string; signal: AbortSignal; onGeneratedSamples?: (total: number) => void }): SpeechOutputStream;
  synthesize(input: { sessionId: string; epoch: number; responseId: string; partIndex?: number; partId?: string; text: string; signal: AbortSignal; onGeneratedSamples?: (total: number) => void }): Promise<SpeechSynthesisStart>;
  pause(responseId: string): void;
  // The host's sidecar is not audible, but retaining the requested rewind on
  // this control path keeps browser and host interruption decisions aligned.
  resume(responseId: string, rewindMs?: number): void;
  cancel(responseId: string, partIndex?: number): void;
  release?(responseId: string, partIndex?: number): void;
}
export interface Scheduler { schedule(delayMs: number, callback: () => void): () => void }
export interface SessionOrchestratorOptions {
  sessionId: string;
  sessionSeed: string;
  pi: PiClient;
  speech: SpeechOutputPort;
  personaSource?: string | Uint8Array;
  emit?: (event: SessionEvent) => void;
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
  multiPartEnabled?: boolean;
}
export interface SessionSnapshot {
  phase: SessionPhase;
  epoch: number;
  personaDigest: string;
  activeResponseId?: string;
  deliveredExtent: Readonly<Record<string, number>>;
}
export interface SessionRetentionSnapshot { contextTurns: number; recentDecisions: number; seenTurns: number }
interface ContextTurn { role: "user" | "assistant"; text: string }
interface PlaybackLedger { outputEpoch: number; generatedSamples: number; delivered: number; terminal: boolean }
interface ActiveResponse {
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
  echoRecovered: boolean;
  pausedAtMs: number;
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
interface MultiPartPart {
  partIndex: number;
  kind: "stall" | "body";
  speechStream?: SpeechOutputStream;
  playbackId?: string;
  assistantText?: string;
  generatedSamples: number;
  terminal: boolean;
  started: boolean;
}
interface MultiPartState {
  responseId: string;
  turnId: string;
  epoch: number;
  posture: PiPosture;
  controller: AbortController;
  parentActive: ActiveResponse;
  parts: MultiPartPart[];
  partByPlayback: Map<string, MultiPartPart>;
  researchDone: boolean;
  cancelled: boolean;
}

export class PersonaValidationError extends Error {
  constructor(readonly diagnostics: readonly { code: string; message: string }[]) { super("default persona validation failed"); }
}

function defaultUuidV7(now: number): string {
  const bytes = randomBytes(16);
  let time = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index--) { bytes[index] = time & 0xff; time = Math.floor(time / 256); }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
function validReasoning(text: string, posture: PiPosture): string | undefined {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (!normalized) return;
  if ((normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length > 45) return;
  if (posture === "question" && (normalized.match(/\?/gu) ?? []).length > 1) return;
  if (/^(?:```|\{|\[|assistant\s*:|system\s*:|<\/?(?:script|iframe)\b)/iu.test(normalized)) return;
  return normalized;
}

export class SessionOrchestrator {
  private phase: SessionPhase = "idle";
  private epoch = 0;
  private readonly persona: PersonaInterpretation;
  private readonly personaDigest: string;
  private readonly seenTurns = new Set<string>();
  private readonly recentDecisions: Array<{ turnId: string; eligible: boolean; posture: Posture }> = [];
  private readonly context: ContextTurn[] = [];
  private readonly playback = new Map<string, PlaybackLedger>();
  private active: ActiveResponse | undefined;
  private multiPart: MultiPartState | undefined;
  private provisional: ProvisionalState | undefined;
  private acceptancePendingTerminal: AcceptancePendingTerminal | undefined;
  private timedOutInterruptionEpoch: number | undefined;
  private stableUserTurnCount = 0;
  private eligibleTurnsSinceChallenge = 3;
  private readonly emitFn: (event: SessionEvent) => void;
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
  private readonly multiPartEnabled: boolean;

  constructor(private readonly options: SessionOrchestratorOptions) {
    const parsed = parsePersona(options.personaSource ?? DEFAULT_PERSONA_MARKDOWN);
    if (!parsed.ok) throw new PersonaValidationError(parsed.errors);
    this.persona = parsed.interpretation;
    this.personaDigest = parsed.digest;
    this.emitFn = options.emit ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.idFactory = options.idFactory ?? (() => defaultUuidV7(Date.now()));
    this.scheduler = options.scheduler ?? { schedule: (delay, callback) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
    this.provisionalTimeoutMs = options.provisionalTimeoutMs ?? 5_000;
    this.classifierTimeoutMs = options.classifierTimeoutMs ?? 2_500;
    this.interruptionClassifier = options.interruptionClassifier ?? new PiInterruptionIntentClassifier(options.pi);
    this.maxContextBytes = options.maxContextBytes ?? 4096;
    this.maxContextTurns = options.maxContextTurns ?? 6;
    this.policyDecide = options.policyDecide ?? decide;
    this.reasoningDeltaCoalesceChars = Math.max(1, options.reasoningDeltaCoalesceChars ?? 16);
    this.researchPi = options.researchPi;
    this.multiPartEnabled = Boolean(options.researchPi && options.multiPartEnabled);
  }

  start(): void {
    if (this.phase !== "idle") return;
    this.phase = "listening";
    this.emitState();
  }

  snapshot(): SessionSnapshot {
    const deliveredExtent = Object.fromEntries([...this.playback].map(([id, value]) => [id, value.delivered]));
    const snapshot: SessionSnapshot = { phase: this.phase, epoch: this.epoch, personaDigest: this.personaDigest, deliveredExtent };
    if (this.active) snapshot.activeResponseId = this.active.responseId;
    return snapshot;
  }

  retentionSnapshot(): SessionRetentionSnapshot {
    return { contextTurns: this.context.length, recentDecisions: this.recentDecisions.length, seenTurns: this.seenTurns.size };
  }

  async handleStableFinal(turn: { epoch: number; turnId: string; text: string; endpointComplete: boolean }): Promise<void> {
    if (turn.epoch !== this.epoch || this.phase === "stopped" || this.seenTurns.has(turn.turnId)) return;
    this.seenTurns.add(turn.turnId);
    if (this.timedOutInterruptionEpoch === turn.epoch) {
      this.timedOutInterruptionEpoch = undefined;
      return;
    }
    if (this.acceptancePendingTerminal) return;
    if (this.provisional) {
      await this.decideInterruption(turn);
      return;
    } else if (this.active) {
      this.advanceEpochAndCancel();
    }
    const operationEpoch = this.epoch;
    this.phase = "deciding";
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
    this.emit("policy.decision", { turnId: turn.turnId, ...policy });
    this.recentDecisions.push({ turnId: turn.turnId, eligible: policy.eligible, posture: policy.posture });
    if (this.recentDecisions.length > 10) this.recentDecisions.splice(0, this.recentDecisions.length - 10);
    this.stableUserTurnCount++;
    this.addContext({ role: "user", text: turn.text.trim() });
    if (policy.eligible) this.eligibleTurnsSinceChallenge = policy.posture === "challenge" ? 0 : this.eligibleTurnsSinceChallenge + 1;
    if (policy.posture === "silence" || this.options.transcriptOnly) { this.phase = "listening"; this.emitState(); return; }

    if (this.multiPartEnabled && this.researchPi) {
      await this.runMultiPartResponse({ epoch: operationEpoch, turnId: turn.turnId, text: turn.text, posture: policy.posture }, boundedContext);
      return;
    }

    const responseId = this.idFactory();
    const controller = new AbortController();
    const active: ActiveResponse = { responseId, turnId: turn.turnId, epoch: operationEpoch, posture: policy.posture, controller, cancelled: false, reasoningPrefix: "", generatedSamples: 0 };
    this.active = active;
    this.phase = "reasoning";
    this.emit("reasoning.started", { turnId: active.turnId, responseId: active.responseId, posture: active.posture });
    const assembler = new ReasoningSpeechAssembler(active.posture);
    try {
      const speechStream = this.options.speech.begin({
        sessionId: this.options.sessionId,
        epoch: active.epoch,
        responseId: active.responseId,
        signal: controller.signal,
        onGeneratedSamples: total => this.recordGeneratedSamples(active, total),
      });
      // Attach rejection handling immediately so cancel-before-first-sentence
      // cannot create an unhandled rejection.
      void speechStream.started.catch(() => undefined);
      speechStream.started.then(
        meta => {
          if (!this.isCurrent(active)) return;
          if (!Number.isSafeInteger(meta.sampleRate) || meta.sampleRate <= 0) { this.failResponse(active, "tts_failed"); return; }
          if (meta.generatedSamples !== undefined && (!Number.isSafeInteger(meta.generatedSamples) || meta.generatedSamples <= 0)) { this.failResponse(active, "tts_failed"); return; }
          active.playbackId = meta.playbackId;
          this.playback.set(meta.playbackId, { outputEpoch: active.epoch, generatedSamples: Math.max(active.generatedSamples, meta.generatedSamples ?? 0), delivered: 0, terminal: false });
          this.emit("tts.started", { responseId: active.responseId, playbackId: meta.playbackId, sampleRate: meta.sampleRate });
          this.options.speech.release?.(active.responseId);
          this.setUnderlyingPhase(active, "playing");
          if (this.hasProvisional(active.responseId)) this.options.speech.pause(active.responseId);
          if (meta.completion) {
            void meta.completion.then(
              completed => {
                if (!this.isCurrent(active)) return;
                if (!Number.isSafeInteger(completed.generatedSamples) || completed.generatedSamples <= 0) {
                  this.failResponse(active, "tts_failed");
                  return;
                }
                const ledger = this.playback.get(meta.playbackId);
                if (!ledger || ledger.outputEpoch !== active.epoch || ledger.terminal) return;
                ledger.generatedSamples = completed.generatedSamples;
                this.emit("tts.ended", { responseId: active.responseId, playbackId: meta.playbackId, generatedSamples: completed.generatedSamples });
              },
              () => {
                if (this.isCurrent(active)) this.failResponse(active, "tts_failed");
              },
            );
          }
        },
        () => {
          if (this.isCurrent(active)) this.failResponse(active, "tts_failed");
        },
      );

      let finalText: string | undefined;
      let duplicateFinal = false;
      let emittedDeltaPrefix = "";
      const emitReasoningDelta = (text: string): void => {
        // Presentational preview only: never emit once cancelled/superseded, and
        // never after reasoning.final (which is authoritative).
        if (!text || text === emittedDeltaPrefix || !this.isCurrent(active)) return;
        emittedDeltaPrefix = text;
        this.emit("reasoning.delta", { turnId: active.turnId, responseId: active.responseId, text });
      };
      for await (const event of this.options.pi.request({ posture: policy.posture, transcript: truncateUtf8(turn.text, 16 * 1024), boundedContext, maxWords: 45 }, controller.signal)) {
        if (!this.isCurrent(active)) return;
        if (event.type === "final") {
          if (finalText !== undefined) duplicateFinal = true;
          else finalText = event.text;
        } else if (event.type === "delta") {
          const chunks = assembler.append(event.text);
          active.reasoningPrefix = assembler.canonicalPrefix;
          for (const chunk of chunks) speechStream.append(chunk.text);
          const preview = assembler.canonicalPrefix;
          if (preview && (emittedDeltaPrefix === "" || preview.length - emittedDeltaPrefix.length >= this.reasoningDeltaCoalesceChars)) emitReasoningDelta(preview);
        } else if (event.type === "error") {
          this.failResponse(active, "reasoning_unavailable");
          return;
        }
      }
      if (!this.isCurrent(active)) return;
      if (duplicateFinal) {
        this.failResponse(active, "reasoning_invalid");
        return;
      }

      let validated: string | undefined;
      try {
        const finalized = assembler.final(finalText ?? "");
        validated = finalized.result.canonical;
        if (finalized.tail) speechStream.append(finalized.tail.text);
        if (!validated || validated.split(/\s+/u).filter(Boolean).length > 45) validated = undefined;
        if (active.posture === "question" && (validated?.match(/\?/gu) ?? []).length > 1) validated = undefined;
        if (validated && /^(?:```|\{|\[|assistant\s*:|system\s*:|<\/?(?:script|iframe)\b)/iu.test(validated)) validated = undefined;
        if (validated && !assembler.validateFull(validated)) validated = undefined;
      } catch {
        validated = undefined;
      }
      if (!validated) {
        this.failResponse(active, "reasoning_invalid");
        return;
      }
      // Flush the preview to the full validated text so the tentative row matches
      // exactly before it materializes, then hand off to the authoritative final.
      emitReasoningDelta(validated);
      this.emit("reasoning.final", { turnId: active.turnId, responseId: active.responseId, posture: active.posture, text: validated });
      active.assistantText = validated;
      speechStream.finish();
    } catch {
      if (!this.isCurrent(active)) return;
      this.failResponse(active, "reasoning_unavailable");
    }
  }

  /**
   * Multi-part turn: a fast no-tool stall (part 0) followed by research body
   * parts (indices 1-7) generated by the research Pi child and played in order.
   * Enabled only when multiPartEnabled and a research client are configured;
   * otherwise handleStableFinal keeps the single-part path unchanged.
   */
  private async runMultiPartResponse(turn: { epoch: number; turnId: string; text: string; posture: PiPosture }, boundedContext: string): Promise<void> {
    const researchPi = this.researchPi!;
    const operationEpoch = turn.epoch;
    const responseId = this.idFactory();
    const controller = new AbortController();
    const parent: ActiveResponse = { responseId, turnId: turn.turnId, epoch: operationEpoch, posture: turn.posture, controller, cancelled: false, reasoningPrefix: "", generatedSamples: 0 };
    const state: MultiPartState = { responseId, turnId: turn.turnId, epoch: operationEpoch, posture: turn.posture, controller, parentActive: parent, parts: [], partByPlayback: new Map(), researchDone: false, cancelled: false };
    this.active = parent;
    this.multiPart = state;
    this.phase = "reasoning";
    this.emitState();
    try {
      // ---- Part 0: stall (existing 45-word no-tool path) ----
      const stall: MultiPartPart = { partIndex: 0, kind: "stall", generatedSamples: 0, terminal: false, started: false };
      state.parts.push(stall);
      const stallStartedAt = Date.now();
      log("session", `part started stall 0 ${state.responseId}`);
      this.emit("response.part_started", { turnId: state.turnId, responseId: state.responseId, partIndex: 0, kind: "stall" });
      this.emit("reasoning.started", { turnId: state.turnId, responseId: state.responseId, posture: state.posture, partIndex: 0 });
      const stallStream = this.options.speech.begin({ sessionId: this.options.sessionId, epoch: operationEpoch, responseId, partIndex: 0, signal: controller.signal, onGeneratedSamples: total => this.recordPartSamples(state, stall, total) });
      stall.speechStream = stallStream;
      void stallStream.started.catch(() => undefined);
      stallStream.started.then(
        meta => { if (this.isCurrentMultiPart(state)) this.attachPartTts(state, stall, meta); },
        () => { if (this.isCurrentMultiPart(state)) this.failMultiPart(state, 0, "tts_failed"); },
      );
      const stallAssembler = new ReasoningSpeechAssembler(state.posture);
      let stallFinalText: string | undefined;
      let stallRequestFailed = false;
      let emittedStallPreview = "";
      const emitStallPreview = (text: string): void => {
        if (!text || text === emittedStallPreview || !this.isCurrentMultiPart(state)) return;
        emittedStallPreview = text;
        this.emit("reasoning.delta", { turnId: state.turnId, responseId: state.responseId, partIndex: 0, text });
      };
      for await (const event of this.options.pi.request({ posture: state.posture, transcript: truncateUtf8(turn.text, 16 * 1024), boundedContext, maxWords: 45 }, controller.signal)) {
        if (!this.isCurrentMultiPart(state)) return;
        if (event.type === "final") stallFinalText = event.text;
        else if (event.type === "delta") {
          for (const chunk of stallAssembler.append(event.text)) stallStream.append(chunk.text);
          const preview = stallAssembler.canonicalPrefix;
          if (preview) emitStallPreview(preview);
        }
        else if (event.type === "error") { stallRequestFailed = true; break; }
      }
      if (!this.isCurrentMultiPart(state)) return;
      let stallText: string | undefined;
      if (!stallRequestFailed) {
        try {
          const finalized = stallAssembler.final(stallFinalText ?? "");
          stallText = finalized.result.canonical;
          if (finalized.tail) stallStream.append(finalized.tail.text);
          if (!stallText || stallText.split(/\s+/u).filter(Boolean).length > 45) stallText = undefined;
          if (state.posture === "question" && (stallText?.match(/\?/gu) ?? []).length > 1) stallText = undefined;
          if (stallText && /^(?:```|\{|\[|assistant\s*:|system\s*:|<\/?(?:script|iframe)\b)/iu.test(stallText)) stallText = undefined;
        } catch {
          stallText = undefined;
        }
      }
      if (!stallText) {
        // Fail-soft: chunks released by append() were already streamed to the
        // stall TTS and are valid by construction (each passed isValidChunk), so
        // keep that streamed prefix as the stall instead of failing the turn.
        const streamedText = stallAssembler.emittedText();
        if (streamedText) stallText = streamedText;
      }
      if (!stallText) { this.failMultiPart(state, 0, stallRequestFailed ? "reasoning_unavailable" : "reasoning_invalid"); return; }
      stall.assistantText = stallText;
      parent.reasoningPrefix = stallText;
      this.emit("reasoning.final", { turnId: state.turnId, responseId: state.responseId, posture: state.posture, partIndex: 0, text: stallText });
      stallStream.finish();
      log("session", `part final stall 0 ${state.responseId} ${stallText.length}chars ${Date.now() - stallStartedAt}ms`);
      this.emit("response.part_final", { turnId: state.turnId, responseId: state.responseId, partIndex: 0, kind: "stall" });
      if (!this.isCurrentMultiPart(state)) return;

      // ---- Body parts from the research Pi child ----
      const bodyAssembler = new ResearchPartAssembler();
      for await (const event of researchPi.requestBody({ posture: state.posture, transcript: truncateUtf8(turn.text, 16 * 1024), boundedContext, stallText }, controller.signal)) {
        if (!this.isCurrentMultiPart(state)) return;
        if (event.type === "final") {
          try {
            const finalized = bodyAssembler.final(event.text);
            for (const part of finalized.parts) this.startBodyPart(state, part);
            state.researchDone = true;
          } catch {
            this.failMultiPart(state, Math.max(1, state.parts.length), "reasoning_invalid");
            return;
          }
          this.completeMultiPartIfReady(state);
        } else if (event.type === "delta") {
          try {
            for (const part of bodyAssembler.append(event.text)) this.startBodyPart(state, part);
          } catch {
            this.failMultiPart(state, Math.max(1, state.parts.length), "reasoning_invalid");
            return;
          }
        } else if (event.type === "error") {
          this.failMultiPart(state, Math.max(1, state.parts.length), "reasoning_unavailable");
          return;
        }
      }
      if (!this.isCurrentMultiPart(state)) return;
      state.researchDone = true;
      this.completeMultiPartIfReady(state);
    } catch {
      if (this.isCurrentMultiPart(state)) this.failMultiPart(state, 0, "reasoning_unavailable");
    }
  }

  private isCurrentMultiPart(state: MultiPartState): boolean {
    return this.phase !== "stopped" && this.multiPart === state && this.active === state.parentActive && !state.cancelled && !state.controller.signal.aborted;
  }

  private recordPartSamples(state: MultiPartState, part: MultiPartPart, total: number): void {
    if (!this.validOffset(total) || total < part.generatedSamples || state.cancelled) return;
    part.generatedSamples = total;
    if (!part.playbackId) return;
    const ledger = this.playback.get(part.playbackId);
    if (ledger && !ledger.terminal && ledger.outputEpoch === state.epoch) ledger.generatedSamples = Math.max(ledger.generatedSamples, total);
  }

  private attachPartTts(state: MultiPartState, part: MultiPartPart, meta: SpeechSynthesisStart): void {
    if (!Number.isSafeInteger(meta.sampleRate) || meta.sampleRate <= 0) { this.failMultiPart(state, part.partIndex, "tts_failed"); return; }
    if (meta.generatedSamples !== undefined && (!Number.isSafeInteger(meta.generatedSamples) || meta.generatedSamples <= 0)) { this.failMultiPart(state, part.partIndex, "tts_failed"); return; }
    part.playbackId = meta.playbackId;
    part.started = true;
    state.partByPlayback.set(meta.playbackId, part);
    this.playback.set(meta.playbackId, { outputEpoch: state.epoch, generatedSamples: Math.max(part.generatedSamples, meta.generatedSamples ?? 0), delivered: 0, terminal: false });
    this.emit("tts.started", { responseId: state.responseId, playbackId: meta.playbackId, sampleRate: meta.sampleRate, partIndex: part.partIndex, ...(meta.outputStreamId !== undefined ? { outputStreamId: meta.outputStreamId } : {}) });
    const parent = this.active;
    if (parent && parent.responseId === state.responseId && !parent.playbackId) parent.playbackId = meta.playbackId;
    this.options.speech.release?.(state.responseId, part.partIndex);
    if (this.multiPart?.responseId === state.responseId) {
      this.phase = "playing";
      if (this.hasProvisional(state.responseId)) this.options.speech.pause(state.responseId);
    }
    if (meta.completion) {
      void meta.completion.then(
        completed => {
          if (!this.isCurrentMultiPart(state)) return;
          if (!Number.isSafeInteger(completed.generatedSamples) || completed.generatedSamples <= 0) { this.failMultiPart(state, part.partIndex, "tts_failed"); return; }
          const ledger = this.playback.get(meta.playbackId);
          if (!ledger || ledger.outputEpoch !== state.epoch || ledger.terminal) return;
          ledger.generatedSamples = completed.generatedSamples;
          this.emit("tts.ended", { responseId: state.responseId, playbackId: meta.playbackId, generatedSamples: completed.generatedSamples, partIndex: part.partIndex });
        },
        () => { if (this.isCurrentMultiPart(state)) this.failMultiPart(state, part.partIndex, "tts_failed"); },
      );
    }
  }

  private startBodyPart(state: MultiPartState, chunk: { text: string; partIndex: number }): void {
    if (chunk.partIndex > 7) { this.failMultiPart(state, chunk.partIndex, "reasoning_invalid"); return; }
    const part: MultiPartPart = { partIndex: chunk.partIndex, kind: "body", generatedSamples: 0, terminal: false, started: false };
    state.parts.push(part);
    const partStartedAt = Date.now();
    log("session", `part started body ${chunk.partIndex} ${state.responseId}`);
    this.emit("response.part_started", { turnId: state.turnId, responseId: state.responseId, partIndex: chunk.partIndex, kind: "body" });
    this.emit("reasoning.started", { turnId: state.turnId, responseId: state.responseId, posture: state.posture, partIndex: chunk.partIndex });
    const stream = this.options.speech.begin({ sessionId: this.options.sessionId, epoch: state.epoch, responseId: state.responseId, partIndex: chunk.partIndex, signal: state.controller.signal, onGeneratedSamples: total => this.recordPartSamples(state, part, total) });
    part.speechStream = stream;
    void stream.started.catch(() => undefined);
    stream.started.then(
      meta => { if (this.isCurrentMultiPart(state)) this.attachPartTts(state, part, meta); },
      () => { if (this.isCurrentMultiPart(state)) this.failMultiPart(state, part.partIndex, "tts_failed"); },
    );
    stream.append(chunk.text);
    part.assistantText = chunk.text;
    this.emit("reasoning.delta", { turnId: state.turnId, responseId: state.responseId, partIndex: chunk.partIndex, text: chunk.text });
    this.emit("reasoning.final", { turnId: state.turnId, responseId: state.responseId, posture: state.posture, partIndex: chunk.partIndex, text: chunk.text });
    stream.finish();
    log("session", `part final body ${chunk.partIndex} ${state.responseId} ${chunk.text.length}chars ${Date.now() - partStartedAt}ms`);
    this.emit("response.part_final", { turnId: state.turnId, responseId: state.responseId, partIndex: chunk.partIndex, kind: "body" });
  }

  private completeMultiPartIfReady(state: MultiPartState): void {
    if (!state.researchDone || state.parts.some(part => !part.terminal)) return;
    this.finishMultiPart(state, true);
  }

  private finishMultiPart(state: MultiPartState, addContext: boolean): void {
    if (state.cancelled) return;
    state.cancelled = true;
    const parentText = state.parts.map(part => part.assistantText).filter(Boolean).join(" ").trim();
    if (addContext && parentText) this.addContext({ role: "assistant", text: parentText });
    if (this.multiPart === state) this.multiPart = undefined;
    if (this.active?.responseId === state.responseId) this.active = undefined;
    this.phase = "listening";
    this.emitState();
  }

  private failMultiPart(state: MultiPartState, partIndex: number, reasonCode: "reasoning_unavailable" | "reasoning_invalid" | "tts_failed"): void {
    log("session", `multipart fail reason=${reasonCode} partIndex=${partIndex} responseId=${state.responseId}`);
    this.emit("response.failed", { turnId: state.turnId, responseId: state.responseId, reasonCode, partIndex });
    this.fail(reasonCode, "The response could not be completed successfully.", "Continue listening.");
    this.cancelMultiPart(state);
  }

  private cancelMultiPart(state: MultiPartState): void {
    if (state.cancelled) return;
    state.cancelled = true;
    state.controller.abort();
    this.options.speech.cancel(state.responseId);
    for (const part of state.parts) {
      const ledger = part.playbackId ? this.playback.get(part.playbackId) : undefined;
      if (ledger && !ledger.terminal) { ledger.terminal = true; }
    }
    this.multiPart = undefined;
    if (this.active?.responseId === state.responseId) this.active = undefined;
    this.phase = "listening";
    this.emitState();
  }

  handleSpeechStart(): number {
    if (this.phase === "stopped") return this.epoch;
    this.timedOutInterruptionEpoch = undefined;
    if (this.acceptancePendingTerminal) {
      this.acceptancePendingTerminal.cancelTimer();
      this.acceptancePendingTerminal = undefined;
      this.advanceEpochAndCancel();
      this.phase = "listening";
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
      this.phase = "echo_provisional";
      return this.epoch;
    }
    if (this.phase === "playing") {
      this.beginProvisionalBargeIn(active.responseId);
      return this.epoch;
    }
    this.advanceEpochAndCancel();
    this.phase = "listening";
    this.emitState();
    return this.epoch;
  }

  handleSpeechEnd(): void {
    if (this.phase === "stopped") return;
    if (this.provisional) {
      const provisional = this.provisional;
      provisional.cancelTimer();
      provisional.cancelTimer = this.scheduler.schedule(this.provisionalTimeoutMs, () => {
        if (this.provisional === provisional) {
          this.timedOutInterruptionEpoch = provisional.outputEpoch;
          this.resolveProvisional("timed_out");
        }
      });
      return;
    }
    if (!this.active && this.phase === "listening") {
      this.phase = "deciding";
      this.emitState();
    }
  }

  beginProvisionalBargeIn(responseId: string): boolean {
    const active = this.active;
    if (!active || active.responseId !== responseId || this.phase === "stopped" || this.provisional) return false;
    active.phaseBeforeProvisional = this.phase;
    this.options.speech.pause(responseId);
    const ledger = active.playbackId ? this.playback.get(active.playbackId) : undefined;
    const provisional: ProvisionalState = { responseId, outputEpoch: active.epoch, echoRecovered: false, pausedAtMs: this.now(), cancelTimer: () => {}, ...(ledger ? { generatedSamples: ledger.generatedSamples } : {}) };
    this.provisional = provisional;
    this.phase = "echo_provisional";
    this.emit("barge_in.provisional", { responseId, outputEpoch: active.epoch, resumable: true });
    return true;
  }

  playbackPaused(input: { responseId: string; playbackId: string; outputEpoch: number; pausedSampleOffset: number; generatedSamples: number }): void {
    const provisional = this.provisional;
    const active = this.active;
    const ledger = this.playback.get(input.playbackId);
    if (!provisional || !active || active.responseId !== input.responseId || active.epoch !== input.outputEpoch || provisional.responseId !== input.responseId || provisional.outputEpoch !== input.outputEpoch || !ledger || ledger.terminal) return;
    const multiPart = this.multiPart?.responseId === input.responseId ? this.multiPart : undefined;
    if (multiPart) {
      if (!multiPart.partByPlayback.has(input.playbackId)) return;
    } else if (active.playbackId !== input.playbackId) {
      return;
    }
    if (![input.outputEpoch, input.pausedSampleOffset, input.generatedSamples].every(value => this.validOffset(value)) || input.generatedSamples > ledger.generatedSamples || input.pausedSampleOffset > input.generatedSamples || input.pausedSampleOffset < ledger.delivered) return;
    ledger.delivered = input.pausedSampleOffset;
    provisional.pausedSampleOffset = input.pausedSampleOffset;
    provisional.generatedSamples = input.generatedSamples;
    const pendingTurn = provisional.pendingTurn;
    if (pendingTurn) {
      delete provisional.pendingTurn;
      void this.decideInterruption(pendingTurn);
    }
  }

  setEchoRecovered(recovered: boolean): void { if (this.provisional) this.provisional.echoRecovered = recovered; }
  confirmBargeIn(): boolean {
    const provisional = this.provisional;
    if (!provisional || this.phase === "stopped") return false;
    provisional.cancelTimer();
    provisional.deciding?.abort();
    this.provisional = undefined;
    const responseId = provisional.responseId;
    const outputEpoch = provisional.outputEpoch;
    this.advanceEpochAndCancel();
    this.phase = "listening";
    this.emit("barge_in.confirmed", { responseId, outputEpoch, resumable: false });
    return true;
  }
  rejectBargeIn(): boolean { return this.resolveProvisional("rejected"); }

  playbackProgress(input: { playbackId: string; outputEpoch: number; playedSampleOffset: number; generatedSamples: number }): void {
    const ledger = this.playback.get(input.playbackId);
    if (!ledger || ledger.terminal || !this.validOffset(input.outputEpoch) || !this.validOffset(input.playedSampleOffset) || !this.validOffset(input.generatedSamples)) return;
    if (input.outputEpoch !== this.epoch || ledger.outputEpoch !== input.outputEpoch) return;
    // Progressive speech: browser may report an older generated prefix after host ledger has advanced.
    // Accept as long as the browser's generatedSamples is not beyond what the host has received.
    if (input.generatedSamples > ledger.generatedSamples) return;
    if (input.playedSampleOffset > input.generatedSamples) return;
    ledger.delivered = Math.max(ledger.delivered, input.playedSampleOffset);
  }

  playbackStopped(input: { playbackId: string; cancelledEpoch: number; finalPlayedSampleOffset: number; reason: "completed" | "cancelled" | "stopped" | "failed" }): void {
    const ledger = this.playback.get(input.playbackId);
    if (!ledger || ledger.terminal || !this.validOffset(input.cancelledEpoch) || !this.validOffset(input.finalPlayedSampleOffset)) return;
    if (ledger.outputEpoch !== input.cancelledEpoch || input.finalPlayedSampleOffset > ledger.generatedSamples) return;
    ledger.delivered = Math.max(ledger.delivered, input.finalPlayedSampleOffset);
    ledger.terminal = true;
    const pending = this.acceptancePendingTerminal;
    if (pending
      && pending.playbackId === input.playbackId
      && pending.outputEpoch === input.cancelledEpoch
      && pending.responseId === this.active?.responseId) {
      this.finalizeAcceptedTakeover(pending);
      return;
    }
    if (input.cancelledEpoch !== this.epoch) return;
    const active = this.active;
    if (!active || this.phase === "stopped") return;
    const multiPart = this.multiPart?.responseId === active.responseId ? this.multiPart : undefined;
    if (multiPart) {
      const part = multiPart.partByPlayback.get(input.playbackId);
      if (part && !part.terminal) {
        part.terminal = true;
        this.completeMultiPartIfReady(multiPart);
        return;
      }
    }
    if (active.playbackId !== input.playbackId) return;
    if (input.reason === "completed" && input.finalPlayedSampleOffset === ledger.generatedSamples && active.assistantText) {
      this.addContext({ role: "assistant", text: active.assistantText });
    }
    const provisional = this.provisional?.responseId === active.responseId ? this.provisional : undefined;
    if (provisional) {
      provisional.cancelTimer();
      this.provisional = undefined;
      this.emit("barge_in.rejected", { responseId: provisional.responseId, outputEpoch: provisional.outputEpoch, resumable: false });
    }
    this.active = undefined;
    this.phase = "listening";
    this.emitState();
  }

  cancelCurrentTurn(): void {
    if (this.phase === "stopped") return;
    this.acceptancePendingTerminal?.cancelTimer();
    this.acceptancePendingTerminal = undefined;
    const provisional = this.provisional;
    provisional?.cancelTimer();
    provisional?.deciding?.abort();
    this.provisional = undefined;
    const responseId = provisional?.responseId;
    const outputEpoch = provisional?.outputEpoch;
    if (this.active || provisional) this.advanceEpochAndCancel();
    if (responseId && outputEpoch !== undefined) this.emit("barge_in.confirmed", { responseId, outputEpoch, resumable: false });
    this.phase = "listening";
    this.emitState();
  }

  stop(): void {
    if (this.phase === "stopped") return;
    this.acceptancePendingTerminal?.cancelTimer();
    this.acceptancePendingTerminal = undefined;
    const provisional = this.provisional;
    provisional?.cancelTimer();
    provisional?.deciding?.abort();
    this.provisional = undefined;
    this.advanceEpochAndCancel();
    if (provisional) this.emit("barge_in.rejected", { responseId: provisional.responseId, outputEpoch: provisional.outputEpoch, resumable: false });
    this.context.length = 0;
    this.recentDecisions.length = 0;
    this.seenTurns.clear();
    this.stableUserTurnCount = 0;
    this.eligibleTurnsSinceChallenge = 3;
    this.phase = "stopped";
    this.emitState();
  }

  private async decideInterruption(turn: { epoch: number; turnId: string; text: string; endpointComplete: boolean }): Promise<boolean> {
    const provisional = this.provisional;
    const active = this.active;
    if (!provisional || !active || active.responseId !== provisional.responseId || !active.playbackId) return false;
    provisional.turnId = turn.turnId;
    this.phase = "interruption_deciding";
    if (provisional.pausedSampleOffset === undefined || provisional.generatedSamples === undefined) {
      provisional.pendingTurn = turn;
      return false;
    }
    provisional.cancelTimer();
    provisional.cancelTimer = () => {};
    delete provisional.pendingTurn;
    let decision: InterruptionIntentDecision = fallbackInterruptionDecision(turn.text);
    if (hasLexicalContent(turn.text) && provisional.pausedSampleOffset !== undefined && provisional.generatedSamples !== undefined) {
      const controller = new AbortController();
      provisional.deciding = controller;
      let timeout: NodeJS.Timeout | undefined;
      try {
        decision = await Promise.race([
          this.interruptionClassifier.decide({
            interruptedResponseText: active.reasoningPrefix || active.assistantText || "",
            deliveredSampleOffset: provisional.pausedSampleOffset,
            generatedSamples: provisional.generatedSamples,
            transcript: turn.text,
            boundedContext: this.boundedContext(),
          }, controller.signal),
          new Promise<InterruptionIntentDecision>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("interruption classification timed out")), this.classifierTimeoutMs); }),
        ]);
      } catch { decision = fallbackInterruptionDecision(turn.text); }
      finally { if (timeout) clearTimeout(timeout); controller.abort(); }
    }
    if (this.provisional !== provisional) return false;
    // Newer speech re-entered classification and replaced this pending decision.
    if (provisional.turnId !== turn.turnId) return false;
    if (!this.active || this.active !== active) {
      // The response was superseded or cancelled while classifying. Never leave
      // the browser waiting on an orphaned provisional.
      this.resolveProvisional("rejected");
      return false;
    }
    const correction = hasCorrectionIntent(turn.text);
    const redirection = !correction && isBareRedirection(turn.text);
    const accept = correction || redirection || (decision.action === "accept" && decision.confidence !== "low" && hasLexicalContent(turn.text));
    const disposition = accept ? "accept_takeover" : decision.intent === "continue_previous" ? "resume_requested" : hasLexicalContent(turn.text) ? "resume_fragment" : "resume_noise";
    const rewindMs = accept ? 0 : this.rewindMsFor(provisional);
    this.emit("interruption.decision", {
      turnId: turn.turnId,
      responseId: provisional.responseId,
      playbackId: active.playbackId,
      outputEpoch: provisional.outputEpoch,
      action: accept ? "accept" : "resume",
      intent: accept ? (decision.action === "accept" ? decision.intent : redirection ? "topic_change" : "correction") : decision.intent,
      confidence: decision.confidence,
      disposition,
      pausedSampleOffset: provisional.pausedSampleOffset,
      ...(rewindMs > 0 ? { rewindMs } : {}),
    });
    if (!accept) {
      provisional.echoRecovered = true;
      this.resolveProvisional("rejected", rewindMs);
      return false;
    }
    provisional.cancelTimer();
    provisional.deciding?.abort();
    this.provisional = undefined;
    const pending: AcceptancePendingTerminal = {
      responseId: provisional.responseId,
      playbackId: active.playbackId,
      outputEpoch: provisional.outputEpoch,
      turn: { epoch: provisional.outputEpoch, turnId: turn.turnId, text: turn.text, endpointComplete: turn.endpointComplete },
      cancelTimer: () => {},
    };
    pending.cancelTimer = this.scheduler.schedule(this.provisionalTimeoutMs, () => this.finalizeAcceptedTakeover(pending));
    this.acceptancePendingTerminal = pending;
    this.cancelResponse(active);
    this.phase = "acceptance_pending_terminal";
    return true;
  }

  private resolveProvisional(type: "rejected" | "timed_out", requestedRewindMs?: number): boolean {
    const provisional = this.provisional;
    if (!provisional || this.phase === "stopped") return false;
    provisional.cancelTimer();
    provisional.deciding?.abort();
    this.provisional = undefined;
    const active = this.active;
    const ledger = active?.playbackId ? this.playback.get(active.playbackId) : undefined;
    const safe = Boolean(
      active
      && active.responseId === provisional.responseId
      && active.epoch === provisional.outputEpoch
      && this.epoch === provisional.outputEpoch
      && active.phaseBeforeProvisional === "playing"
      && active.playbackId
      && ledger
      && !ledger.terminal
      && provisional.pausedSampleOffset !== undefined
      && (provisional.echoRecovered || type === "timed_out"),
    );
    const rewindMs = safe ? requestedRewindMs ?? this.rewindMsFor(provisional) : 0;
    if (safe && active) {
      this.options.speech.resume(active.responseId, rewindMs);
      this.phase = "playing";
    } else {
      this.advanceEpochAndCancel();
      this.phase = "listening";
    }
    this.emit(`barge_in.${type}`, { responseId: provisional.responseId, outputEpoch: provisional.outputEpoch, resumable: safe, ...(rewindMs > 0 ? { rewindMs } : {}) });
    this.emitState();
    return true;
  }

  private rewindMsFor(provisional: ProvisionalState): number {
    return this.now() - provisional.pausedAtMs > 1_000 ? 500 : 0;
  }
  private finalizeAcceptedTakeover(pending: AcceptancePendingTerminal): void {
    if (this.acceptancePendingTerminal !== pending || pending.responseId !== this.active?.responseId) return;
    pending.cancelTimer();
    this.acceptancePendingTerminal = undefined;
    this.advanceEpochAndCancel();
    this.phase = "listening";
    this.emit("barge_in.confirmed", { responseId: pending.responseId, outputEpoch: pending.outputEpoch, resumable: false });
    this.seenTurns.delete(pending.turn.turnId);
    void this.handleStableFinal({ ...pending.turn, epoch: this.epoch });
  }

  private advanceEpochAndCancel(): void {
    this.epoch++;
    const active = this.active;
    if (active) { this.cancelResponse(active); this.active = undefined; }
    if (this.multiPart) this.multiPart = undefined;
  }
  private cancelResponse(active: ActiveResponse): void {
    if (active.cancelled) return;
    active.cancelled = true;
    active.controller.abort();
    this.options.speech.cancel(active.responseId);
  }  private clearActive(active: ActiveResponse): void {
    if (this.active !== active) return;
    const provisional = this.provisional?.responseId === active.responseId ? this.provisional : undefined;
    if (provisional) {
      provisional.cancelTimer();
      this.provisional = undefined;
      this.advanceEpochAndCancel();
      this.phase = "listening";
      this.emit("barge_in.rejected", { responseId: provisional.responseId, outputEpoch: provisional.outputEpoch, resumable: false });
    } else {
      this.active = undefined;
      this.phase = "listening";
    }
    this.emitState();
  }
  private hasProvisional(responseId: string): boolean { return this.provisional?.responseId === responseId; }
  private setUnderlyingPhase(active: ActiveResponse, phase: SessionPhase): void {
    if (this.provisional?.responseId === active.responseId) { active.phaseBeforeProvisional = phase; this.phase = "echo_provisional"; }
    else this.phase = phase;
  }
  private isCurrent(active: ActiveResponse): boolean { return this.phase !== "stopped" && this.active === active && active.epoch === this.epoch && !active.controller.signal.aborted; }
  private validOffset(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
  private recordGeneratedSamples(active: ActiveResponse, total: number): void {
    if (!this.validOffset(total) || total < active.generatedSamples || active.cancelled) return;
    active.generatedSamples = total;
    if (!active.playbackId) return;
    const ledger = this.playback.get(active.playbackId);
    if (ledger && !ledger.terminal && ledger.outputEpoch === active.epoch) ledger.generatedSamples = Math.max(ledger.generatedSamples, total);
  }
  private addContext(turn: ContextTurn): void {
    this.context.push(turn);
    if (this.context.length > this.maxContextTurns) this.context.splice(0, this.context.length - this.maxContextTurns);
  }
  private boundedContext(): string {
    const lines = this.context.slice(-this.maxContextTurns).map(turn => `${turn.role}: ${turn.text}`);
    while (lines.length && Buffer.byteLength(lines.join("\n"), "utf8") > this.maxContextBytes) lines.shift();
    return truncateUtf8(lines.join("\n"), this.maxContextBytes);
  }
  private fail(code: string, detail: string, correctiveAction: string): void { this.emit("failure", { code, detail, correctiveAction, recoverable: true }); }
  private failResponse(active: ActiveResponse, reasonCode: "reasoning_unavailable" | "reasoning_invalid" | "tts_failed"): void {
    log("session", `response fail reason=${reasonCode} responseId=${active.responseId}`);
    this.emit("response.failed", { turnId: active.turnId, responseId: active.responseId, reasonCode });
    this.fail(reasonCode, "The response could not be completed successfully.", "Continue listening.");
    // Establish the local TTS forwarding cutoff before clearing state so a failed
    // response cannot leave the sidecar progressive stream open and block a
    // later successful response. cancelResponse is idempotent.
    this.cancelResponse(active);
    this.clearActive(active);
  }
  private emitState(): void { this.emit("session.state", { phase: this.phase, personaDigest: this.personaDigest }); }
  private emit(type: string, payload: Record<string, unknown>): void {
    this.emitFn({ protocolVersion: 1, sessionId: this.options.sessionId, epoch: this.epoch, eventId: this.idFactory(), type, monotonicMs: Math.max(0, this.now()), payload });
  }
}
