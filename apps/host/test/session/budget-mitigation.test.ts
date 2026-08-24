import { describe, expect, it } from 'vitest';
import { decide, type PolicyDecision, type PolicyInput } from '@app/policy';
import { PI_STALL_INSTRUCTION, type PiClient, type PiEvent, type PiRequestInput } from '../../src/pi/PiClient.js';
import type { PiResearchClient, PiResearchRequestInput } from '../../src/pi/PiResearchClient.js';
import {
  SessionOrchestrator,
  type Scheduler,
  type SessionEvent,
  type SpeechOutputPort,
  type SpeechOutputStream,
} from '../../src/session/SessionOrchestrator.js';
import { BUDGET_COLD_PRIORS, RuntimeBudget } from '../../src/session/RuntimeBudget.js';

const SESSION_ID = '018f06b5-3c8d-7b2a-9f35-8b3388a857f1';
const ids = Array.from(
  { length: 140 },
  (_, index) => `018f06b5-3c8d-7b2a-9f35-${(0x8b3388a85000 + index).toString(16)}`,
);
const SAMPLE_RATE = 24000;
const PART_SAMPLES = 240000; // 10 s of audio per part

const policy =
  (posture: PolicyDecision['posture']): ((input: PolicyInput) => PolicyDecision) =>
  () => ({
    policyVersion: 'v1.experimental',
    eligible: true,
    posture,
    reasonCodes: ['selected'],
    inputDigest: 'a'.repeat(64),
  });

class FakePi implements PiClient {
  readonly inputs: PiRequestInput[] = [];
  constructor(
    private readonly respond: (
      input: PiRequestInput,
      signal: AbortSignal,
    ) => AsyncIterable<PiEvent> = async function* () {
      yield { type: 'delta', text: 'Let me look that up for you.' };
      yield { type: 'final', text: 'Let me look that up for you.' };
    },
  ) {}
  async probe() {
    return { status: 'ready' as const, detail: 'ready', correctiveAction: 'None.' };
  }
  request(input: PiRequestInput, signal: AbortSignal): AsyncIterable<PiEvent> {
    this.inputs.push(input);
    return this.respond(input, signal);
  }
  async shutdown() {}
}

class FakeResearchPi implements PiResearchClient {
  readonly inputs: PiResearchRequestInput[] = [];
  constructor(
    private readonly respond: (
      input: PiResearchRequestInput,
      signal: AbortSignal,
    ) => AsyncIterable<PiEvent> = async function* () {
      yield { type: 'delta', text: 'Paris is the capital of France. It sits on the Seine.' };
      yield { type: 'final', text: 'Paris is the capital of France. It sits on the Seine.' };
    },
  ) {}
  requestBody(input: PiResearchRequestInput, signal: AbortSignal): AsyncIterable<PiEvent> {
    this.inputs.push(input);
    return this.respond(input, signal);
  }
  async shutdown() {}
}

class FakeSpeech implements SpeechOutputPort {
  readonly begins: Array<{ responseId: string; partIndex?: number }> = [];
  private speechIndex = 0;
  begin(input: { responseId: string; partIndex?: number; signal: AbortSignal }): SpeechOutputStream {
    this.begins.push({
      responseId: input.responseId,
      ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}),
    });
    this.speechIndex++;
    const playbackId = ids[100 + this.speechIndex]!;
    return {
      started: Promise.resolve({
        playbackId,
        sampleRate: SAMPLE_RATE,
        generatedSamples: PART_SAMPLES,
        backendId: 'kokoro',
        modelId: 'cpu',
        completion: Promise.resolve({ generatedSamples: PART_SAMPLES }),
      }),
      append(_text: string): void {},
      finish(): void {},
    };
  }
  synthesize(): Promise<{ playbackId: string; sampleRate: number; generatedSamples: number }> {
    throw new Error('unused in budget tests');
  }
  pause(_responseId: string) {}
  resume(_responseId: string) {}
  cancel(_responseId: string, _partIndex?: number) {}
  release?(_responseId: string, _partIndex?: number) {}
}

class FakeScheduler implements Scheduler {
  callbacks: Array<() => void> = [];
  schedule(_delayMs: number, callback: () => void): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((found) => found !== callback);
    };
  }
  fire(): void {
    const callback = this.callbacks.shift();
    callback?.();
  }
}

type MitigationEvent = Extract<SessionEvent, { type: 'budget.mitigation' }>;

function setup(overrides: { researchRespond?: () => AsyncIterable<PiEvent> } = {}) {
  let clockMs = 0;
  const events: SessionEvent[] = [];
  const pi = new FakePi();
  const speech = new FakeSpeech();
  const researchPi = overrides.researchRespond ? new FakeResearchPi(overrides.researchRespond) : new FakeResearchPi();
  const scheduler = new FakeScheduler();
  const budget = new RuntimeBudget({ now: () => clockMs });
  let id = 0;
  const session = new SessionOrchestrator({
    sessionId: SESSION_ID,
    sessionSeed: 'seed',
    pi,
    speech,
    researchPi,
    multiPartEnabled: true,
    budget,
    scheduler,
    emit: (event) => events.push(event),
    idFactory: () => ids[id++]!,
    now: () => clockMs,
    policyDecide: policy('question'),
    interruptionClassifier: {
      decide: async () => ({
        action: 'accept',
        intent: 'new_request',
        confidence: 'high',
        reason: 'Clear new request.',
      }),
    },
  });
  session.start();
  const mitigations = () => events.filter((event): event is MitigationEvents => event.type === 'budget.mitigation');
  return {
    session,
    events,
    pi,
    speech,
    researchPi,
    scheduler,
    budget,
    mitigations,
    advance: (ms: number) => {
      clockMs += ms;
      return clockMs;
    },
    clock: () => clockMs,
  };
}

function turn(index: number, text = 'What is the capital of France and why does it matter?') {
  return { epoch: 0, turnId: ids[60 + index]!, text, endpointComplete: true };
}

async function flush(times = 60): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

async function finishAllPlaybacks(env: ReturnType<typeof setup>, fromBegin: number, atMs?: number): Promise<void> {
  if (atMs !== undefined) env.advance(atMs - env.clock());
  for (let index = fromBegin; index < env.speech.begins.length; index++) {
    env.session.playbackStopped({
      playbackId: ids[101 + index]!,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: PART_SAMPLES,
      reason: 'completed',
    });
  }
  await flush();
}

describe('budget mitigation instrumentation (T2)', () => {
  it('updates session estimates from a scripted turn and snapshots them in events', async () => {
    const env = setup();
    await env.session.handleStableFinal(turn(0));
    // The stall_target event carries the pre-turn cold priors.
    const stallTarget = env.mitigations().find((event) => event.payload.kind === 'stall_target');
    expect(stallTarget?.payload.detail.estimates).toEqual(BUDGET_COLD_PRIORS);
    // Script the stall playing out, then part 1, with progress along the way.
    env.session.playbackProgress({
      playbackId: ids[101]!,
      outputEpoch: 0,
      playedSampleOffset: 120000,
      generatedSamples: PART_SAMPLES,
    });
    env.session.playbackStopped({
      playbackId: ids[101]!,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: PART_SAMPLES,
      reason: 'completed',
    });
    env.session.playbackProgress({
      playbackId: ids[102]!,
      outputEpoch: 0,
      playedSampleOffset: 48000,
      generatedSamples: PART_SAMPLES,
    });
    await finishAllPlaybacks(env, 1);
    const estimates = env.budget.estimatesSnapshot();
    expect(estimates.stallFirstDeltaMs).toBeLessThan(BUDGET_COLD_PRIORS.stallFirstDeltaMs);
    expect(estimates.stallTextMs).toBeLessThan(BUDGET_COLD_PRIORS.stallTextMs);
    expect(estimates.bodyFirstPartMs).toBeLessThan(BUDGET_COLD_PRIORS.bodyFirstPartMs);
    expect(estimates.ttsTtfaMs).toBeLessThan(BUDGET_COLD_PRIORS.ttsTtfaMs);
    expect(estimates.ttsRtf).not.toBe(BUDGET_COLD_PRIORS.ttsRtf);
    // wordsPerSecond observed from the ledger delivered progression.
    expect(estimates.wordsPerSecond).not.toBe(BUDGET_COLD_PRIORS.wordsPerSecond);
    expect(env.mitigations().filter((event) => event.payload.kind !== 'stall_target')).toEqual([]);
  });
});

describe('adaptive stall sizing (T3)', () => {
  it('appends the cold-start target hint to the unchanged stall instruction', async () => {
    const env = setup();
    await env.session.handleStableFinal(turn(0));
    const instruction = env.pi.inputs[0]!.instruction!;
    expect(instruction).toBe(`${PI_STALL_INSTRUCTION}\nAim for about 27 words this time (never more than 45).`);
    expect(instruction.startsWith(PI_STALL_INSTRUCTION)).toBe(true);
    expect(Buffer.byteLength(instruction, 'utf8')).toBeLessThanOrEqual(4096);
    expect(env.pi.inputs[0]!.maxWords).toBe(45);
  });

  it('keeps the hint target inside 20-45 for extreme estimates', async () => {
    const slow = setup();
    for (let index = 0; index < 60; index++) {
      slow.budget.observeBodyFirstPart(60_000);
      slow.budget.observeTtsTtfa(15_000);
    }
    await slow.session.handleStableFinal(turn(0));
    expect(slow.pi.inputs[0]!.instruction).toContain('Aim for about 45 words');
    const fast = setup();
    for (let index = 0; index < 60; index++) {
      fast.budget.observeBodyFirstPart(0);
      fast.budget.observeTtsTtfa(50);
      fast.budget.observeWordsPerSecond(0.5);
    }
    await fast.session.handleStableFinal(turn(0));
    expect(fast.pi.inputs[0]!.instruction).toContain('Aim for about 20 words');
    for (const env of [slow, fast]) {
      const match = env.pi.inputs[0]!.instruction!.match(/Aim for about (\d+) words/u);
      expect(match).not.toBeNull();
      const target = Number(match![1]);
      expect(target).toBeGreaterThanOrEqual(20);
      expect(target).toBeLessThanOrEqual(45);
      expect(env.pi.inputs[0]!.instruction!.startsWith(`${PI_STALL_INSTRUCTION}\n`)).toBe(true);
      expect(Buffer.byteLength(env.pi.inputs[0]!.instruction!, 'utf8')).toBeLessThanOrEqual(4096);
    }
  });
});

describe('handoff deadline checks (T4)', () => {
  it('fires the projected stall-to-body gap once when the body never releases', async () => {
    const hangForever = async function* (): AsyncIterable<PiEvent> {
      await new Promise<void>(() => {});
    };
    const env = setup({ researchRespond: () => hangForever() });
    void env.session.handleStableFinal(turn(0));
    await flush(100);
    const stallPlaybackId = ids[101]!;
    // Play the 10 s stall in 500 ms steps, re-checking the D2 deadline each tick.
    for (let step = 0; step < 20; step++) {
      const atMs = env.advance(500);
      env.session.playbackProgress({
        playbackId: stallPlaybackId,
        outputEpoch: 0,
        playedSampleOffset: Math.min(PART_SAMPLES, (atMs / 1000) * SAMPLE_RATE),
        generatedSamples: PART_SAMPLES,
      });
      env.scheduler.fire();
    }
    const projected = env.mitigations().filter((event) => event.payload.kind === 'late_handoff_projected');
    expect(projected).toHaveLength(1);
    expect(projected[0]!.payload).toMatchObject({ partIndex: 1 });
    expect(projected[0]!.payload.detail.trigger).toContain('bodyEta');
    expect(projected[0]!.payload.detail.estimates).toEqual(env.budget.estimatesSnapshot());
    // Measurement only: no gap finding, no inserted audio, nothing blocked.
    expect(env.mitigations().filter((event) => event.payload.kind === 'gap_measured')).toEqual([]);
    env.session.stop();
  });

  it('never fires for a clean handoff', async () => {
    const env = setup();
    await env.session.handleStableFinal(turn(0));
    const stallPlaybackId = ids[101]!;
    for (let step = 0; step < 20; step++) {
      const atMs = env.advance(500);
      env.session.playbackProgress({
        playbackId: stallPlaybackId,
        outputEpoch: 0,
        playedSampleOffset: Math.min(PART_SAMPLES, (atMs / 1000) * SAMPLE_RATE),
        generatedSamples: PART_SAMPLES,
      });
      env.scheduler.fire();
    }
    env.session.playbackStopped({
      playbackId: stallPlaybackId,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: PART_SAMPLES,
      reason: 'completed',
    });
    const part1PlaybackId = ids[102]!;
    env.session.playbackProgress({
      playbackId: part1PlaybackId,
      outputEpoch: 0,
      playedSampleOffset: PART_SAMPLES,
      generatedSamples: PART_SAMPLES,
    });
    await finishAllPlaybacks(env, 1);
    expect(env.mitigations().filter((event) => event.payload.kind !== 'stall_target')).toEqual([]);
  });

  it('records a measured gap over 200 ms and adapts the next turns', async () => {
    const env = setup();
    await env.session.handleStableFinal(turn(0));
    // Stall plays to the 5 s mark, then its terminal receipt lands.
    env.advance(5000);
    env.session.playbackProgress({
      playbackId: ids[101]!,
      outputEpoch: 0,
      playedSampleOffset: 120000,
      generatedSamples: PART_SAMPLES,
    });
    env.session.playbackStopped({
      playbackId: ids[101]!,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 120000,
      reason: 'completed',
    });
    // Part 1 becomes audible 600 ms later: a measured gap.
    env.advance(600);
    env.session.playbackProgress({
      playbackId: ids[102]!,
      outputEpoch: 0,
      playedSampleOffset: 240,
      generatedSamples: PART_SAMPLES,
    });
    const gaps = env.mitigations().filter((event) => event.payload.kind === 'gap_measured');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.payload).toMatchObject({
      partIndex: 1,
      responseId: env.events.find((e) => e.type === 'response.part_started')!.payload.responseId,
    });
    expect(gaps[0]!.payload.detail.trigger).toContain('handoff gap 600ms > 200ms');
    expect(env.budget.currentPenaltyMs).toBe(2000);
    await finishAllPlaybacks(env, 1);
    // The gap kept the full penalty for the next turn's D1 target.
    await env.session.handleStableFinal(turn(1));
    const secondTarget = env
      .mitigations()
      .filter((event) => event.payload.kind === 'stall_target')
      .at(-1)!;
    expect(secondTarget.payload.detail.trigger).toContain('penalty=2000ms');
    expect(env.budget.currentPenaltyMs).toBe(2000);
    // A gap-free turn halves the penalty for the turn after that.
    await finishAllPlaybacks(env, 2);
    await env.session.handleStableFinal(turn(2));
    const thirdTarget = env
      .mitigations()
      .filter((event) => event.payload.kind === 'stall_target')
      .at(-1)!;
    expect(thirdTarget.payload.detail.trigger).toContain('penalty=1000ms');
  });
});
