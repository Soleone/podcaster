import type { BudgetMitigationEvent } from '@app/contracts';

/**
 * Per-session latency-budget state for the multi-part turn pipeline: EWMA
 * estimates seeded from the static-plan cold priors (docs/latency-budget.md),
 * the D1 adaptive stall-target formula, pure D2/D3 ETA math, and gap penalty
 * bookkeeping. Measurement-only: it computes estimates and reports findings,
 * never inserts audio and never blocks the turn machine. Estimates are
 * session-scoped; nothing is persisted. See
 * artifacts/architect/2026-08-23-runtime-latency-budget.md.
 */

export type BudgetMitigationPayload = BudgetMitigationEvent['payload'];
export type BudgetEstimates = BudgetMitigationPayload['detail']['estimates'];

/** Cold-start priors from the static plan (docs/latency-budget.md). */
export const BUDGET_COLD_PRIORS: BudgetEstimates = {
  stallFirstDeltaMs: 1500,
  stallTextMs: 4000,
  bodyFirstPartMs: 8000,
  ttsTtfaMs: 1000,
  ttsRtf: 0.3,
  wordsPerSecond: 2.5,
};

export type BudgetEstimateKey = keyof BudgetEstimates;

/** Sample/result bounds keep noisy observations from poisoning the EWMA. */
export const BUDGET_BOUNDS: Record<BudgetEstimateKey, readonly [number, number]> = {
  stallFirstDeltaMs: [100, 15000],
  stallTextMs: [200, 30000],
  bodyFirstPartMs: [500, 60000],
  ttsTtfaMs: [50, 15000],
  ttsRtf: [0.02, 3],
  wordsPerSecond: [0.5, 6],
};

export const EWMA_ALPHA = 0.3;
export const STALL_SAFETY_SECONDS = 1.5;
export const STALL_TARGET_MIN_WORDS = 20;
export const STALL_TARGET_MAX_WORDS = 45;
/** D2 safety margin: body audio must beat the stall end by this much. */
export const D2_STALL_MARGIN_MS = 500;
/** D2 timer re-check period while the stall audio plays. */
export const D2_RECHECK_MS = 500;
/** D3 safety margin: the next part must be ready before the current ends by this much. */
export const D3_HANDOFF_MARGIN_MS = 300;
/** A measured handoff gap above this is recorded and penalized. */
export const MEASURED_GAP_THRESHOLD_MS = 200;
/** One measured gap adds this penalty to the next turn's body estimate. */
export const GAP_PENALTY_MS = 2000;
export const GAP_PENALTY_CAP_MS = 10000;

function clamp(value: number, bounds: readonly [number, number]): number {
  return Math.min(bounds[1], Math.max(bounds[0], value));
}

function formatMs(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : 'pending';
}

interface PartTimingRecord {
  responseId: string;
  turnId: string;
  partIndex: number;
  /** Text release time (first append / startBodyPart); undefined until released. */
  openedAtMs?: number;
  words: number;
  playbackId?: string;
  sampleRate: number;
  generatedSamples: number;
  deliveredSamples: number;
  /** TTS started (first audio) time. */
  startedAtMs?: number;
  /** First playback progress with delivered > 0. */
  audibleStartAtMs?: number;
  /** Playback terminal receipt. */
  audibleEndAtMs?: number;
  wpsObserved: boolean;
  projectedFired: boolean;
}

export interface RuntimeBudgetOptions {
  now?: () => number;
}

export interface NextPartEtaInput {
  released: boolean;
  openedAtMs?: number;
  startedAtMs?: number;
  words?: number;
}

export class RuntimeBudget {
  private readonly now: () => number;
  private readonly estimates: BudgetEstimates = { ...BUDGET_COLD_PRIORS };
  private readonly ttsTtfaByModel = new Map<string, number>();
  private readonly ttsRtfByModel = new Map<string, number>();
  private penaltyMs = 0;
  private readonly records = new Map<string, PartTimingRecord>();
  private readonly recordByPlayback = new Map<string, string>();
  private readonly gapByResponse = new Map<string, boolean>();

  constructor(options: RuntimeBudgetOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  nowMs(): number {
    return this.now();
  }

  estimatesSnapshot(): BudgetEstimates {
    return { ...this.estimates };
  }

  get currentPenaltyMs(): number {
    return this.penaltyMs;
  }

  // ---- Observations (EWMA, clamped) ----

  observeStallFirstDelta(ms: number): void {
    this.updateEstimate('stallFirstDeltaMs', ms);
  }

  observeStallText(ms: number): void {
    this.updateEstimate('stallTextMs', ms);
  }

  observeBodyFirstPart(ms: number): void {
    this.updateEstimate('bodyFirstPartMs', ms);
  }

  observeWordsPerSecond(wordsPerSecond: number): void {
    this.updateEstimate('wordsPerSecond', wordsPerSecond);
  }

  /** Keyed per producing backend/model; the latest model drives the formula. */
  observeTtsTtfa(ms: number, modelKey = 'default'): void {
    const key = modelKey || 'default';
    const next = this.ewmaStep(this.ttsTtfaByModel.get(key) ?? BUDGET_COLD_PRIORS.ttsTtfaMs, ms, 'ttsTtfaMs');
    this.ttsTtfaByModel.set(key, next);
    this.estimates.ttsTtfaMs = next;
  }

  observeTtsRtf(rtf: number, modelKey = 'default'): void {
    const key = modelKey || 'default';
    const next = this.ewmaStep(this.ttsRtfByModel.get(key) ?? BUDGET_COLD_PRIORS.ttsRtf, rtf, 'ttsRtf');
    this.ttsRtfByModel.set(key, next);
    this.estimates.ttsRtf = next;
  }

  private updateEstimate(key: BudgetEstimateKey, sample: number): void {
    this.estimates[key] = this.ewmaStep(this.estimates[key], sample, key);
  }

  private ewmaStep(previous: number, sample: number, key: BudgetEstimateKey): number {
    if (!Number.isFinite(sample) || !Number.isFinite(previous)) return previous;
    const bounded = clamp(sample, BUDGET_BOUNDS[key]);
    return clamp(previous + EWMA_ALPHA * (bounded - previous), BUDGET_BOUNDS[key]);
  }

  // ---- D1: adaptive stall sizing ----

  /** Body estimate plus the measured-gap penalty carried from earlier turns. */
  effectiveBodyFirstPartMs(): number {
    return this.estimates.bodyFirstPartMs + this.penaltyMs;
  }

  stallTargetWords(): number {
    const neededSeconds =
      this.effectiveBodyFirstPartMs() / 1000 + this.estimates.ttsTtfaMs / 1000 + STALL_SAFETY_SECONDS;
    return clamp(Math.ceil(neededSeconds * this.estimates.wordsPerSecond), [
      STALL_TARGET_MIN_WORDS,
      STALL_TARGET_MAX_WORDS,
    ]);
  }

  stallTargetHint(): string {
    return `Aim for about ${this.stallTargetWords()} words this time (never more than ${STALL_TARGET_MAX_WORDS}).`;
  }

  stallTargetFinding(turnId: string, responseId: string): BudgetMitigationPayload {
    return {
      turnId,
      responseId,
      kind: 'stall_target',
      detail: {
        estimates: this.estimatesSnapshot(),
        trigger: `target=${this.stallTargetWords()} words; penalty=${Math.round(this.penaltyMs)}ms`,
      },
    };
  }

  // ---- D2: stall-to-body handoff ETA ----

  bodyEtaMs(elapsedSinceBodyStartMs: number): number {
    return Math.max(0, this.effectiveBodyFirstPartMs() - Math.max(0, elapsedSinceBodyStartMs));
  }

  stallHandoffAtRisk(stallRemainingMs: number, elapsedSinceBodyStartMs: number): boolean {
    return this.bodyEtaMs(elapsedSinceBodyStartMs) + this.estimates.ttsTtfaMs > stallRemainingMs - D2_STALL_MARGIN_MS;
  }

  // ---- D3: part-handoff deadline ETA ----

  /**
   * Time until the next part's audio is ready: unknown until its text is
   * released, TTFA-minus-elapsed while open, then the remaining-synth
   * estimate (full synth time minus elapsed) once TTS has started.
   */
  nextPartEtaMs(state: NextPartEtaInput, atMs: number): number {
    if (!state.released) return Number.POSITIVE_INFINITY;
    if (state.startedAtMs === undefined)
      return this.estimates.ttsTtfaMs - Math.max(0, atMs - (state.openedAtMs ?? atMs));
    const wordsPerSecond = Math.max(0.1, this.estimates.wordsPerSecond);
    const totalSynthMs = (Math.max(0, state.words ?? 0) / wordsPerSecond) * this.estimates.ttsRtf * 1000;
    return Math.max(0, totalSynthMs - Math.max(0, atMs - state.startedAtMs));
  }

  handoffAtRisk(currentRemainingMs: number, nextEtaMs: number): boolean {
    // A next part that is already ready (eta <= 0) cannot project a gap.
    return nextEtaMs > 0 && nextEtaMs > currentRemainingMs - D3_HANDOFF_MARGIN_MS;
  }

  // ---- Penalty bookkeeping (next-turn adaptation) ----

  noteMeasuredGap(): void {
    this.penaltyMs = Math.min(GAP_PENALTY_CAP_MS, this.penaltyMs + GAP_PENALTY_MS);
  }

  /** Called when a response completes; halves the penalty after a gap-free turn. */
  endTurn(responseId: string): void {
    if (!this.gapByResponse.get(responseId)) this.penaltyMs = Math.floor(this.penaltyMs / 2);
    this.cleanupResponse(responseId);
  }

  /** Called when a response is superseded before completing; no penalty change. */
  abandonResponse(responseId: string): void {
    this.cleanupResponse(responseId);
  }

  // ---- Per-turn part timing records ----

  registerPart(input: {
    responseId: string;
    turnId: string;
    partIndex: number;
    openedAtMs?: number;
    words?: number;
  }): void {
    const record = this.upsertPart(input.responseId, input.turnId, input.partIndex);
    if (input.openedAtMs !== undefined && record.openedAtMs === undefined) record.openedAtMs = input.openedAtMs;
    if (input.words !== undefined && input.words > 0) record.words = input.words;
  }

  attachPlayback(input: {
    responseId: string;
    turnId: string;
    partIndex: number;
    playbackId: string;
    sampleRate: number;
    generatedSamples?: number;
  }): void {
    const record = this.upsertPart(input.responseId, input.turnId, input.partIndex);
    record.playbackId = input.playbackId;
    record.sampleRate = input.sampleRate;
    if (input.generatedSamples !== undefined && input.generatedSamples > 0)
      record.generatedSamples = Math.max(record.generatedSamples, input.generatedSamples);
    record.startedAtMs = this.now();
    this.recordByPlayback.set(input.playbackId, this.recordKey(input.responseId, input.partIndex));
  }

  setPartWords(responseId: string, partIndex: number, words: number): void {
    const record = this.partRecord(responseId, partIndex);
    if (record && words > 0) record.words = words;
  }

  notePlaybackSamples(playbackId: string, generatedSamples: number): void {
    const record = this.playbackRecord(playbackId);
    if (record && generatedSamples > 0) record.generatedSamples = Math.max(record.generatedSamples, generatedSamples);
  }

  notePlaybackEnded(playbackId: string): void {
    const record = this.playbackRecord(playbackId);
    if (record && record.audibleStartAtMs !== undefined && record.audibleEndAtMs === undefined)
      record.audibleEndAtMs = this.now();
  }

  /** Remaining audible milliseconds for a part, or undefined while unknown. */
  playbackRemainingMs(playbackId: string): number | undefined {
    const record = this.playbackRecord(playbackId);
    if (!record || record.sampleRate <= 0 || record.generatedSamples <= 0) return undefined;
    return Math.max(0, ((record.generatedSamples - record.deliveredSamples) / record.sampleRate) * 1000);
  }

  /**
   * Playback progression hook (called from SessionOrchestrator.playbackProgress
   * and playbackStopped). Updates the audible timeline and returns at most one
   * measured-gap finding and one projected-handoff finding per handoff.
   */
  observePlayback(playbackId: string, deliveredSamples: number, generatedSamples?: number): BudgetMitigationPayload[] {
    const record = this.playbackRecord(playbackId);
    if (!record || record.audibleEndAtMs !== undefined) return [];
    if (generatedSamples !== undefined && generatedSamples > 0)
      record.generatedSamples = Math.max(record.generatedSamples, generatedSamples);
    record.deliveredSamples = Math.max(
      record.deliveredSamples,
      Math.min(Math.max(0, deliveredSamples), record.generatedSamples),
    );
    const atMs = this.now();
    const findings: BudgetMitigationPayload[] = [];
    if (record.deliveredSamples > 0 && record.audibleStartAtMs === undefined) {
      record.audibleStartAtMs = atMs;
      const previous = this.partRecord(record.responseId, record.partIndex - 1);
      if (previous && previous.audibleEndAtMs !== undefined) {
        const gapMs = atMs - previous.audibleEndAtMs;
        if (gapMs > MEASURED_GAP_THRESHOLD_MS) {
          this.noteMeasuredGap();
          this.gapByResponse.set(record.responseId, true);
          findings.push({
            turnId: record.turnId,
            responseId: record.responseId,
            kind: 'gap_measured',
            partIndex: record.partIndex,
            detail: {
              estimates: this.estimatesSnapshot(),
              trigger: `handoff gap ${Math.round(gapMs)}ms > ${MEASURED_GAP_THRESHOLD_MS}ms`,
            },
          });
        }
      }
      if (!record.wpsObserved && record.words > 0 && record.generatedSamples > 0 && record.sampleRate > 0) {
        record.wpsObserved = true;
        this.observeWordsPerSecond(record.words / (record.generatedSamples / record.sampleRate));
      }
    }
    if (record.deliveredSamples > 0 && !record.projectedFired && record.sampleRate > 0) {
      const next = this.partRecord(record.responseId, record.partIndex + 1);
      if (next) {
        const remainingMs = ((record.generatedSamples - record.deliveredSamples) / record.sampleRate) * 1000;
        const nextEtaMs = this.nextPartEtaMs(
          {
            released: next.openedAtMs !== undefined,
            ...(next.openedAtMs !== undefined ? { openedAtMs: next.openedAtMs } : {}),
            ...(next.startedAtMs !== undefined ? { startedAtMs: next.startedAtMs } : {}),
            words: next.words,
          },
          atMs,
        );
        if (this.handoffAtRisk(remainingMs, nextEtaMs)) {
          record.projectedFired = true;
          findings.push({
            turnId: record.turnId,
            responseId: record.responseId,
            kind: 'late_handoff_projected',
            partIndex: next.partIndex,
            detail: {
              estimates: this.estimatesSnapshot(),
              trigger: `nextEta ${formatMs(nextEtaMs)} > remaining ${Math.round(remainingMs)}ms - ${D3_HANDOFF_MARGIN_MS}ms`,
            },
          });
        }
      }
    }
    return findings;
  }

  /** D3 check at text release of a part while the previous part is audible. */
  handoffCheckOnRelease(input: { responseId: string; turnId: string; partIndex: number }): BudgetMitigationPayload[] {
    const released = this.partRecord(input.responseId, input.partIndex);
    const current = this.partRecord(input.responseId, input.partIndex - 1);
    if (!released || !current || current.projectedFired) return [];
    if (current.sampleRate <= 0 || current.generatedSamples <= 0) return [];
    if (current.audibleStartAtMs === undefined || current.audibleEndAtMs !== undefined) return [];
    const remainingMs = ((current.generatedSamples - current.deliveredSamples) / current.sampleRate) * 1000;
    const atMs = this.now();
    const nextEtaMs = this.nextPartEtaMs(
      {
        released: true,
        ...(released.openedAtMs !== undefined ? { openedAtMs: released.openedAtMs } : {}),
        words: released.words,
      },
      atMs,
    );
    if (!this.handoffAtRisk(remainingMs, nextEtaMs)) return [];
    current.projectedFired = true;
    return [
      {
        turnId: current.turnId,
        responseId: current.responseId,
        kind: 'late_handoff_projected',
        partIndex: input.partIndex,
        detail: {
          estimates: this.estimatesSnapshot(),
          trigger: `nextEta ${formatMs(nextEtaMs)} > remaining ${Math.round(remainingMs)}ms - ${D3_HANDOFF_MARGIN_MS}ms`,
        },
      },
    ];
  }

  private recordKey(responseId: string, partIndex: number): string {
    return `${responseId}#${partIndex}`;
  }

  private upsertPart(responseId: string, turnId: string, partIndex: number): PartTimingRecord {
    const key = this.recordKey(responseId, partIndex);
    let record = this.records.get(key);
    if (!record) {
      record = {
        responseId,
        turnId,
        partIndex,
        words: 0,
        sampleRate: 0,
        generatedSamples: 0,
        deliveredSamples: 0,
        wpsObserved: false,
        projectedFired: false,
      };
      this.records.set(key, record);
    }
    return record;
  }

  private partRecord(responseId: string, partIndex: number): PartTimingRecord | undefined {
    return this.records.get(this.recordKey(responseId, partIndex));
  }

  private playbackRecord(playbackId: string): PartTimingRecord | undefined {
    const key = this.recordByPlayback.get(playbackId);
    return key ? this.records.get(key) : undefined;
  }

  private cleanupResponse(responseId: string): void {
    this.gapByResponse.delete(responseId);
    for (const [key, record] of [...this.records]) {
      if (record.responseId !== responseId) continue;
      this.records.delete(key);
      if (record.playbackId) this.recordByPlayback.delete(record.playbackId);
    }
  }
}
