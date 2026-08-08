import { randomBytes } from "node:crypto";
import { DEFAULT_PERSONA_MARKDOWN, parsePersona, type PersonaInterpretation } from "@app/contracts";
import { decide, POLICY_VERSION, type PolicyDecision, type PolicyInput, type Posture } from "@app/policy";
import type { PiClient, PiEvent, PiPosture } from "../pi/PiClient.js";

export type SessionPhase = "idle" | "listening" | "deciding" | "reasoning" | "synthesizing" | "playing" | "echo_provisional" | "stopped";
export interface SessionEvent { protocolVersion: 1; sessionId: string; epoch: number; eventId: string; type: string; monotonicMs: number; payload: Record<string, unknown> }
export interface SpeechSynthesisStart {
  playbackId: string;
  sampleRate: number;
  generatedSamples?: number;
  completion?: Promise<{ generatedSamples: number }>;
}
export interface SpeechOutputPort {
  synthesize(input: { sessionId: string; epoch: number; responseId: string; text: string; signal: AbortSignal; onGeneratedSamples?: (total: number) => void }): Promise<SpeechSynthesisStart>;
  pause(responseId: string): void;
  resume(responseId: string): void;
  cancel(responseId: string): void;
  release?(responseId: string): void;
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
  maxContextBytes?: number;
  maxContextTurns?: number;
  policyDecide?: (input: PolicyInput) => PolicyDecision;
  transcriptOnly?: boolean;
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
  generatedSamples: number;
  phaseBeforeProvisional?: SessionPhase;
}
interface ProvisionalState { responseId: string; outputEpoch: number; cancelTimer: () => void; echoRecovered: boolean }

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
function meaningfulInterruption(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  if (/\b(?:stop|cancel|pause|wait|quiet)\b/iu.test(normalized)) return true;
  return (normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length >= 3;
}
function boundedPersonaForPi(persona: PersonaInterpretation, maxBytes: number): string | undefined {
  const body = Array.from(persona.body);
  const serialize = (bodyEnd: number) => JSON.stringify({
    version: persona.version,
    name: persona.name,
    invitation_only: persona.invitation_only,
    posture_weights: {
      riff: persona.posture_weights.riff,
      question: persona.posture_weights.question,
      challenge: persona.posture_weights.challenge,
    },
    challenge_enabled: persona.challenge_enabled,
    interests: [...persona.interests],
    body: body.slice(0, bodyEnd).join(""),
  });
  if (Buffer.byteLength(serialize(0), "utf8") > maxBytes) return;
  let low = 0;
  let high = body.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(serialize(midpoint), "utf8") <= maxBytes) low = midpoint;
    else high = midpoint - 1;
  }
  return serialize(low);
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
  private readonly personaForPi: string;
  private readonly seenTurns = new Set<string>();
  private readonly recentDecisions: Array<{ turnId: string; eligible: boolean; posture: Posture }> = [];
  private readonly context: ContextTurn[] = [];
  private readonly playback = new Map<string, PlaybackLedger>();
  private active: ActiveResponse | undefined;
  private provisional: ProvisionalState | undefined;
  private stableUserTurnCount = 0;
  private eligibleTurnsSinceChallenge = 3;
  private interruptionCooldownActive = false;
  private readonly emitFn: (event: SessionEvent) => void;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly scheduler: Scheduler;
  private readonly provisionalTimeoutMs: number;
  private readonly maxContextBytes: number;
  private readonly maxContextTurns: number;
  private readonly policyDecide: (input: PolicyInput) => PolicyDecision;

  constructor(private readonly options: SessionOrchestratorOptions) {
    const parsed = parsePersona(options.personaSource ?? DEFAULT_PERSONA_MARKDOWN);
    if (!parsed.ok) throw new PersonaValidationError(parsed.errors);
    this.persona = parsed.interpretation;
    this.personaDigest = parsed.digest;
    const personaForPi = boundedPersonaForPi(parsed.interpretation, 8 * 1024);
    if (personaForPi === undefined) throw new PersonaValidationError([{ code: "persona_context_too_large", message: "Persona structured fields exceed the reasoning context bound." }]);
    this.personaForPi = personaForPi;
    this.emitFn = options.emit ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.idFactory = options.idFactory ?? (() => defaultUuidV7(Date.now()));
    this.scheduler = options.scheduler ?? { schedule: (delay, callback) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
    this.provisionalTimeoutMs = options.provisionalTimeoutMs ?? 3_000;
    this.maxContextBytes = options.maxContextBytes ?? 4096;
    this.maxContextTurns = options.maxContextTurns ?? 6;
    this.policyDecide = options.policyDecide ?? decide;
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
    if (turn.epoch !== this.epoch) return;
    if (this.phase === "stopped" || this.seenTurns.has(turn.turnId)) return;
    this.seenTurns.add(turn.turnId);
    if (this.provisional && !meaningfulInterruption(turn.text)) {
      // Persisted empty/very short STT output is treated as accidental noise.
      // Keep the current response and explicitly authorize browser resume.
      this.provisional.echoRecovered = true;
      this.resolveProvisional("rejected");
      return;
    }
    if (this.provisional) {
      const provisional = this.provisional;
      provisional.cancelTimer(); this.provisional = undefined;
      this.advanceEpochAndCancel();
      this.interruptionCooldownActive = true;
      this.phase = "listening";
      this.emit("barge_in.confirmed", { responseId: provisional.responseId, outputEpoch: provisional.outputEpoch, resumable: false });
    } else if (this.active) { this.advanceEpochAndCancel(); this.interruptionCooldownActive = true; }
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
      interruptionCooldownActive: this.interruptionCooldownActive,
    });
    this.interruptionCooldownActive = false;
    this.emit("policy.decision", { turnId: turn.turnId, ...policy });
    this.recentDecisions.push({ turnId: turn.turnId, eligible: policy.eligible, posture: policy.posture });
    if (this.recentDecisions.length > 10) this.recentDecisions.splice(0, this.recentDecisions.length - 10);
    this.stableUserTurnCount++;
    this.addContext({ role: "user", text: turn.text.trim() });
    if (policy.eligible) this.eligibleTurnsSinceChallenge = policy.posture === "challenge" ? 0 : this.eligibleTurnsSinceChallenge + 1;
    if (policy.posture === "silence" || this.options.transcriptOnly) { this.phase = "listening"; this.emitState(); return; }

    const responseId = this.idFactory();
    const controller = new AbortController();
    const active: ActiveResponse = { responseId, turnId: turn.turnId, epoch: operationEpoch, posture: policy.posture, controller, cancelled: false, generatedSamples: 0 };
    this.active = active;
    this.phase = "reasoning";
    try {
      let finalText: string | undefined;
      let duplicateFinal = false;
      for await (const event of this.options.pi.request({ posture: policy.posture, transcript: truncateUtf8(turn.text, 16 * 1024), boundedContext, personaInterpretation: this.personaForPi, maxWords: 45 }, controller.signal)) {
        if (!this.isCurrent(active)) return;
        if (event.type === "final") { if (finalText !== undefined) duplicateFinal = true; else finalText = event.text; }
        else if (event.type === "error") { this.fail("reasoning_unavailable", event.detail, event.correctiveAction); this.clearActive(active); return; }
      }
      if (!this.isCurrent(active)) return;
      const validated = finalText === undefined || duplicateFinal ? undefined : validReasoning(finalText, active.posture);
      if (!validated) { this.fail("reasoning_invalid", "Reasoning output did not satisfy the concise posture contract.", "Continue listening; no speech was produced."); this.clearActive(active); return; }
      this.emit("reasoning.final", { turnId: active.turnId, responseId: active.responseId, posture: active.posture, text: validated });
      active.assistantText = validated;
      this.setUnderlyingPhase(active, "synthesizing");
      const synthesized = await this.options.speech.synthesize({
        sessionId: this.options.sessionId,
        epoch: active.epoch,
        responseId: active.responseId,
        text: validated,
        signal: controller.signal,
        onGeneratedSamples: total => this.recordGeneratedSamples(active, total),
      });
      if (!this.isCurrent(active)) return;
      if (!Number.isSafeInteger(synthesized.sampleRate) || synthesized.sampleRate <= 0 || (!synthesized.completion && (!Number.isSafeInteger(synthesized.generatedSamples) || synthesized.generatedSamples! <= 0))) throw new Error("invalid speech output metadata");
      active.playbackId = synthesized.playbackId;
      this.playback.set(synthesized.playbackId, { outputEpoch: active.epoch, generatedSamples: Math.max(active.generatedSamples, synthesized.generatedSamples ?? 0), delivered: 0, terminal: false });
      this.emit("tts.started", { responseId: active.responseId, playbackId: synthesized.playbackId, sampleRate: synthesized.sampleRate });
      this.options.speech.release?.(active.responseId);
      this.setUnderlyingPhase(active, "playing");
      if (this.hasProvisional(active.responseId)) this.options.speech.pause(active.responseId);
      const completed = synthesized.completion ? await synthesized.completion : { generatedSamples: synthesized.generatedSamples! };
      if (!this.isCurrent(active)) return;
      if (!Number.isSafeInteger(completed.generatedSamples) || completed.generatedSamples <= 0) throw new Error("invalid speech output completion");
      const ledger = this.playback.get(synthesized.playbackId);
      if (!ledger || ledger.outputEpoch !== active.epoch || ledger.terminal) return;
      ledger.generatedSamples = completed.generatedSamples;
      this.emit("tts.ended", { responseId: active.responseId, playbackId: synthesized.playbackId, generatedSamples: completed.generatedSamples });
    } catch (error) {
      if (!this.isCurrent(active)) return;
      this.fail("response_failed", "Local response generation failed.", "Continue in transcript-only mode or retry.");
      this.clearActive(active);
    }
  }

  handleSpeechStart(): number {
    const active = this.active;
    if (!active || this.phase === "stopped") return this.epoch;
    if (this.phase === "playing" || this.phase === "echo_provisional") {
      this.beginProvisionalBargeIn(active.responseId);
      return this.epoch;
    }
    this.advanceEpochAndCancel();
    this.interruptionCooldownActive = true;
    this.phase = "listening";
    this.emitState();
    return this.epoch;
  }

  beginProvisionalBargeIn(responseId: string): boolean {
    const active = this.active;
    if (!active || active.responseId !== responseId || this.phase === "stopped" || this.provisional) return false;
    active.phaseBeforeProvisional = this.phase;
    this.options.speech.pause(responseId);
    const provisional: ProvisionalState = { responseId, outputEpoch: active.epoch, echoRecovered: false, cancelTimer: () => {} };
    provisional.cancelTimer = this.scheduler.schedule(this.provisionalTimeoutMs, () => this.resolveProvisional("timed_out"));
    this.provisional = provisional;
    this.phase = "echo_provisional";
    this.emit("barge_in.provisional", { responseId, outputEpoch: active.epoch, resumable: true });
    return true;
  }

  setEchoRecovered(recovered: boolean): void { if (this.provisional) this.provisional.echoRecovered = recovered; }
  confirmBargeIn(): boolean {
    const provisional = this.provisional;
    if (!provisional || this.phase === "stopped") return false;
    provisional.cancelTimer();
    this.provisional = undefined;
    const responseId = provisional.responseId;
    const outputEpoch = provisional.outputEpoch;
    this.advanceEpochAndCancel();
    this.interruptionCooldownActive = true;
    this.phase = "listening";
    this.emit("barge_in.confirmed", { responseId, outputEpoch, resumable: false });
    return true;
  }
  rejectBargeIn(): boolean { return this.resolveProvisional("rejected"); }

  playbackProgress(input: { playbackId: string; outputEpoch: number; playedSampleOffset: number; generatedSamples: number }): void {
    const ledger = this.playback.get(input.playbackId);
    if (!ledger || ledger.terminal || !this.validOffset(input.outputEpoch) || !this.validOffset(input.playedSampleOffset) || !this.validOffset(input.generatedSamples)) return;
    if (input.outputEpoch !== this.epoch || ledger.outputEpoch !== input.outputEpoch || input.generatedSamples !== ledger.generatedSamples || input.playedSampleOffset > ledger.generatedSamples) return;
    ledger.delivered = Math.max(ledger.delivered, input.playedSampleOffset);
  }

  playbackStopped(input: { playbackId: string; cancelledEpoch: number; finalPlayedSampleOffset: number; reason: "completed" | "cancelled" | "stopped" | "failed" }): void {
    const ledger = this.playback.get(input.playbackId);
    if (!ledger || ledger.terminal || !this.validOffset(input.cancelledEpoch) || !this.validOffset(input.finalPlayedSampleOffset)) return;
    if (ledger.outputEpoch !== input.cancelledEpoch || input.finalPlayedSampleOffset > ledger.generatedSamples) return;
    ledger.delivered = Math.max(ledger.delivered, input.finalPlayedSampleOffset);
    ledger.terminal = true;
    if (input.cancelledEpoch !== this.epoch) return;
    const active = this.active;
    if (!active || active.playbackId !== input.playbackId || this.phase === "stopped") return;
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
    const provisional = this.provisional;
    provisional?.cancelTimer();
    this.provisional = undefined;
    const responseId = provisional?.responseId;
    const outputEpoch = provisional?.outputEpoch;
    if (this.active || provisional) this.advanceEpochAndCancel();
    if (responseId && outputEpoch !== undefined) this.emit("barge_in.confirmed", { responseId, outputEpoch, resumable: false });
    this.interruptionCooldownActive = true;
    this.phase = "listening";
    this.emitState();
  }

  stop(): void {
    if (this.phase === "stopped") return;
    const provisional = this.provisional;
    provisional?.cancelTimer();
    this.provisional = undefined;
    this.advanceEpochAndCancel();
    if (provisional) this.emit("barge_in.rejected", { responseId: provisional.responseId, outputEpoch: provisional.outputEpoch, resumable: false });
    this.context.length = 0;
    this.recentDecisions.length = 0;
    this.seenTurns.clear();
    this.stableUserTurnCount = 0;
    this.eligibleTurnsSinceChallenge = 3;
    this.interruptionCooldownActive = false;
    this.phase = "stopped";
    this.emitState();
  }

  private resolveProvisional(type: "rejected" | "timed_out"): boolean {
    const provisional = this.provisional;
    if (!provisional || this.phase === "stopped") return false;
    provisional.cancelTimer();
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
      // If the confirmation prompt times out, prefer continuing the response.
      // Silence is ambiguous and must not destructively discard audible output.
      && (provisional.echoRecovered || type === "timed_out"),
    );
    if (safe && active) {
      this.options.speech.resume(active.responseId);
      this.phase = "playing";
    } else {
      this.advanceEpochAndCancel();
      this.interruptionCooldownActive = true;
      this.phase = "listening";
    }
    this.emit(`barge_in.${type}`, { responseId: provisional.responseId, outputEpoch: provisional.outputEpoch, resumable: safe });
    return true;
  }

  private advanceEpochAndCancel(): void {
    this.epoch++;
    const active = this.active;
    if (active) { this.cancelResponse(active); this.active = undefined; }
  }
  private cancelResponse(active: ActiveResponse): void {
    if (active.cancelled) return;
    active.cancelled = true;
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
      this.interruptionCooldownActive = true;
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
  private emitState(): void { this.emit("session.state", { phase: this.phase, personaDigest: this.personaDigest }); }
  private emit(type: string, payload: Record<string, unknown>): void {
    this.emitFn({ protocolVersion: 1, sessionId: this.options.sessionId, epoch: this.epoch, eventId: this.idFactory(), type, monotonicMs: Math.max(0, this.now()), payload });
  }
}
