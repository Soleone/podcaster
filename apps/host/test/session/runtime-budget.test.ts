import { describe, expect, it } from 'vitest';
import {
  BUDGET_BOUNDS,
  BUDGET_COLD_PRIORS,
  D2_STALL_MARGIN_MS,
  D3_HANDOFF_MARGIN_MS,
  EWMA_ALPHA,
  GAP_PENALTY_CAP_MS,
  GAP_PENALTY_MS,
  MEASURED_GAP_THRESHOLD_MS,
  RuntimeBudget,
  STALL_SAFETY_SECONDS,
} from '../../src/session/RuntimeBudget.js';

function makeHarness(atMs = 0): { budget: RuntimeBudget; setClock: (ms: number) => void } {
  let clock = atMs;
  return { budget: new RuntimeBudget({ now: () => clock }), setClock: (ms) => (clock = ms) };
}

function settle(budget: RuntimeBudget, observe: (value: number) => void, value: number, times = 60): void {
  for (let index = 0; index < times; index++) observe(value);
}

describe('RuntimeBudget cold start', () => {
  it('starts at the static-plan priors with no penalty', () => {
    const { budget } = makeHarness();
    expect(budget.estimatesSnapshot()).toEqual(BUDGET_COLD_PRIORS);
    expect(budget.currentPenaltyMs).toBe(0);
  });

  it('computes the designed D1 formula and hint from cold priors', () => {
    const { budget } = makeHarness();
    // needed = 8.0 + 1.0 + 1.5 = 10.5 s; ceil(10.5 * 2.5) = 27 words.
    const neededSeconds =
      BUDGET_COLD_PRIORS.bodyFirstPartMs / 1000 + BUDGET_COLD_PRIORS.ttsTtfaMs / 1000 + STALL_SAFETY_SECONDS;
    expect(Math.ceil(neededSeconds * BUDGET_COLD_PRIORS.wordsPerSecond)).toBe(27);
    expect(budget.stallTargetWords()).toBe(27);
    expect(budget.stallTargetHint()).toBe('Aim for about 27 words this time (never more than 45).');
    const finding = budget.stallTargetFinding('turn-1', 'response-1');
    expect(finding).toMatchObject({
      turnId: 'turn-1',
      responseId: 'response-1',
      kind: 'stall_target',
      detail: { estimates: BUDGET_COLD_PRIORS, trigger: 'target=27 words; penalty=0ms' },
    });
  });
});

describe('RuntimeBudget EWMA', () => {
  it('converges toward repeated observations', () => {
    const { budget } = makeHarness();
    settle(budget, (value) => budget.observeBodyFirstPart(value), 2000);
    expect(Math.abs(budget.estimatesSnapshot().bodyFirstPartMs - 2000)).toBeLessThan(1);
  });

  it('moves by alpha of the error on each observation', () => {
    const { budget } = makeHarness();
    budget.observeStallFirstDelta(2500);
    expect(budget.estimatesSnapshot().stallFirstDeltaMs).toBeCloseTo(1500 + EWMA_ALPHA * (2500 - 1500), 10);
  });

  it('clamps out-of-bound samples into the estimate bounds', () => {
    const { budget } = makeHarness();
    budget.observeStallFirstDelta(999_999);
    expect(budget.estimatesSnapshot().stallFirstDeltaMs).toBeLessThanOrEqual(BUDGET_BOUNDS.stallFirstDeltaMs[1]);
    budget.observeStallFirstDelta(-5);
    budget.observeStallFirstDelta(-5);
    expect(budget.estimatesSnapshot().stallFirstDeltaMs).toBeGreaterThanOrEqual(BUDGET_BOUNDS.stallFirstDeltaMs[0]);
    budget.observeTtsRtf(99);
    expect(budget.estimatesSnapshot().ttsRtf).toBeLessThanOrEqual(BUDGET_BOUNDS.ttsRtf[1]);
    budget.observeWordsPerSecond(Number.NaN);
    expect(Number.isFinite(budget.estimatesSnapshot().wordsPerSecond)).toBe(true);
  });

  it('keeps TTS estimates per producing model with the latest model driving the formula', () => {
    const { budget } = makeHarness();
    budget.observeTtsTtfa(299, 'qwen/cuda');
    const afterQwen = budget.estimatesSnapshot().ttsTtfaMs;
    expect(afterQwen).toBeCloseTo(1000 + EWMA_ALPHA * (299 - 1000), 10);
    budget.observeTtsTtfa(978, 'kokoro/cpu');
    expect(budget.estimatesSnapshot().ttsTtfaMs).toBeCloseTo(1000 + EWMA_ALPHA * (978 - 1000), 10);
    // Returning to qwen continues its own EWMA, not kokoro's.
    budget.observeTtsTtfa(299, 'qwen/cuda');
    expect(budget.estimatesSnapshot().ttsTtfaMs).toBeCloseTo(afterQwen + EWMA_ALPHA * (299 - afterQwen), 10);
  });
});

describe('RuntimeBudget D1 target', () => {
  it('clamps the target between 20 and 45 words', () => {
    const slow = makeHarness();
    settle(slow.budget, (value) => slow.budget.observeBodyFirstPart(value), 60_000);
    expect(slow.budget.stallTargetWords()).toBe(45);
    const fast = makeHarness();
    settle(fast.budget, (value) => fast.budget.observeBodyFirstPart(value), 0);
    settle(fast.budget, (value) => fast.budget.observeTtsTtfa(value), 50);
    expect(fast.budget.stallTargetWords()).toBe(20);
  });

  it('raises the target by the measured-gap penalty', () => {
    const { budget } = makeHarness();
    const cold = budget.stallTargetWords();
    budget.noteMeasuredGap();
    expect(budget.currentPenaltyMs).toBe(GAP_PENALTY_MS);
    expect(budget.stallTargetWords()).toBeGreaterThan(cold);
    expect(budget.stallTargetFinding('t', 'r').detail.trigger).toContain('penalty=2000ms');
  });
});

describe('RuntimeBudget D2 stall-to-body ETA', () => {
  it('floors the body ETA at zero', () => {
    const { budget } = makeHarness();
    expect(budget.bodyEtaMs(0)).toBe(BUDGET_COLD_PRIORS.bodyFirstPartMs);
    expect(budget.bodyEtaMs(3000)).toBe(5000);
    expect(budget.bodyEtaMs(99_999)).toBe(0);
  });

  it('treats the margin boundary as safe', () => {
    const { budget } = makeHarness();
    // bodyEta(0) + ttsTtfa = 9000; at risk only when remaining < 9000 + margin.
    expect(budget.stallHandoffAtRisk(9000 + D2_STALL_MARGIN_MS, 0)).toBe(false);
    expect(budget.stallHandoffAtRisk(9000 + D2_STALL_MARGIN_MS - 1, 0)).toBe(true);
  });
});

describe('RuntimeBudget D3 part-handoff ETA', () => {
  it('reports infinity until release, TTFA-minus-elapsed while open, remaining synth once started', () => {
    const { budget } = makeHarness();
    expect(budget.nextPartEtaMs({ released: false }, 5000)).toBe(Number.POSITIVE_INFINITY);
    expect(budget.nextPartEtaMs({ released: true, openedAtMs: 4600 }, 5000)).toBe(600);
    expect(budget.nextPartEtaMs({ released: true, openedAtMs: 4600 }, 7000)).toBe(-1400);
    // 10 words at 2.5 wps = 4 s audio; synth = 4 * 0.3 = 1.2 s.
    const started = budget.nextPartEtaMs({ released: true, openedAtMs: 0, startedAtMs: 1000, words: 10 }, 1500);
    expect(started).toBeCloseTo(700, 10);
    expect(budget.nextPartEtaMs({ released: true, startedAtMs: 0, words: 10 }, 9000)).toBe(0);
  });

  it('treats the 300 ms handoff margin boundary as safe', () => {
    const { budget } = makeHarness();
    expect(budget.handoffAtRisk(1300, 1000)).toBe(false);
    expect(budget.handoffAtRisk(1299, 1000)).toBe(true);
    expect(budget.handoffAtRisk(1000, Number.POSITIVE_INFINITY)).toBe(true);
    // A next part that is already ready never projects a gap.
    expect(budget.handoffAtRisk(0, 0)).toBe(false);
    expect(budget.handoffAtRisk(0, -100)).toBe(false);
  });
});

describe('RuntimeBudget playback observations', () => {
  function twoPartScript() {
    const harness = makeHarness();
    const { budget: b } = harness;
    b.registerPart({ responseId: 'r1', turnId: 't1', partIndex: 0, openedAtMs: 0, words: 10 });
    b.registerPart({ responseId: 'r1', turnId: 't1', partIndex: 1, openedAtMs: 0, words: 10 });
    b.attachPlayback({ responseId: 'r1', turnId: 't1', partIndex: 0, playbackId: 'p0', sampleRate: 24000 });
    b.attachPlayback({ responseId: 'r1', turnId: 't1', partIndex: 1, playbackId: 'p1', sampleRate: 24000 });
    b.notePlaybackSamples('p0', 240_000);
    b.notePlaybackSamples('p1', 240_000);
    return harness;
  }

  it('projects a late handoff once when the next part will not make the margin', () => {
    const harness = makeHarness();
    const { budget: b } = harness;
    b.registerPart({ responseId: 'r1', turnId: 't1', partIndex: 0, openedAtMs: 0, words: 10 });
    b.attachPlayback({ responseId: 'r1', turnId: 't1', partIndex: 0, playbackId: 'p0', sampleRate: 24000 });
    b.notePlaybackSamples('p0', 24_000);
    harness.setClock(100);
    expect(b.observePlayback('p0', 240)).toEqual([]);
    // Next part released but TTS not started: eta = TTFA 1000 > remaining 990 - 300.
    b.registerPart({ responseId: 'r1', turnId: 't1', partIndex: 1, openedAtMs: 100, words: 10 });
    harness.setClock(200);
    const findings = b.observePlayback('p0', 480);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      turnId: 't1',
      responseId: 'r1',
      kind: 'late_handoff_projected',
      partIndex: 1,
    });
    expect(findings[0]!.detail.trigger).toContain('nextEta');
    harness.setClock(300);
    expect(b.observePlayback('p0', 720)).toEqual([]);
  });

  it('records a measured gap over 200 ms once and penalizes the next turn', () => {
    const { budget: b, setClock } = twoPartScript();
    setClock(100);
    expect(b.observePlayback('p0', 240)).toEqual([]);
    setClock(2000);
    b.notePlaybackEnded('p0');
    setClock(2000 + MEASURED_GAP_THRESHOLD_MS + 400);
    const findings = b.observePlayback('p1', 240);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'gap_measured', partIndex: 1 });
    expect(b.currentPenaltyMs).toBe(GAP_PENALTY_MS);
    // The gap is reported once and the penalty does not stack on later progress.
    setClock(3000);
    expect(b.observePlayback('p1', 480)).toEqual([]);
    expect(b.currentPenaltyMs).toBe(GAP_PENALTY_MS);
    // A gap-measured turn keeps the full penalty; the next gap-free turn halves it.
    b.endTurn('r1');
    expect(b.currentPenaltyMs).toBe(GAP_PENALTY_MS);
    b.endTurn('r2');
    expect(b.currentPenaltyMs).toBe(GAP_PENALTY_MS / 2);
  });

  it('ignores gaps within the threshold and clean handoffs', () => {
    const { budget: b, setClock } = twoPartScript();
    setClock(100);
    b.observePlayback('p0', 240);
    setClock(1000);
    b.notePlaybackEnded('p0');
    setClock(1000 + MEASURED_GAP_THRESHOLD_MS);
    expect(b.observePlayback('p1', 240)).toEqual([]);
    expect(b.currentPenaltyMs).toBe(0);
  });

  it('updates words-per-second once a part becomes audible', () => {
    const { budget: b, setClock } = twoPartScript();
    setClock(50);
    b.observePlayback('p0', 240);
    // 10 words over 240000 samples at 24 kHz = 10 s of audio.
    expect(b.estimatesSnapshot().wordsPerSecond).toBeCloseTo(
      BUDGET_COLD_PRIORS.wordsPerSecond + EWMA_ALPHA * (1 - BUDGET_COLD_PRIORS.wordsPerSecond),
      10,
    );
  });

  it('reports remaining playback time for D2 checks', () => {
    const { budget: b } = twoPartScript();
    expect(b.playbackRemainingMs('p0')).toBe(10_000);
    b.observePlayback('p0', 120_000);
    expect(b.playbackRemainingMs('p0')).toBe(5_000);
    expect(b.playbackRemainingMs('missing')).toBeUndefined();
  });

  it('caps the accumulated penalty and cleans up abandoned responses', () => {
    const { budget: b } = twoPartScript();
    for (let index = 0; index < 10; index++) b.noteMeasuredGap();
    expect(b.currentPenaltyMs).toBe(GAP_PENALTY_CAP_MS);
    b.abandonResponse('r1');
    expect(b.playbackRemainingMs('p0')).toBeUndefined();
  });
});
