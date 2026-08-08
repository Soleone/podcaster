import { describe, expect, it } from "vitest";
import { CONTRACT_VALIDATORS } from "@app/contracts";
import type { PolicyDecision, PolicyInput } from "@app/policy";
import type { PiClient, PiEvent, PiRequestInput } from "../../src/pi/PiClient.js";
import { PersonaValidationError, SessionOrchestrator, type Scheduler, type SessionEvent, type SpeechOutputPort } from "../../src/session/SessionOrchestrator.js";

const SESSION_ID = "018f06b5-3c8d-7b2a-9f35-8b3388a857f1";
const ids = Array.from({ length: 100 }, (_, index) => `018f06b5-3c8d-7b2a-9f35-${(0x8b3388a85000 + index).toString(16)}`);
const policy = (posture: PolicyDecision["posture"]): ((input: PolicyInput) => PolicyDecision) => input => ({ policyVersion: "v1.experimental", eligible: posture !== "silence", posture, reasonCodes: [posture === "silence" ? "too_short" : "selected"], inputDigest: "a".repeat(64) });

class FakePi implements PiClient {
  readonly inputs: PiRequestInput[] = [];
  constructor(private readonly respond: (input: PiRequestInput, signal: AbortSignal) => AsyncIterable<PiEvent> = async function* () { yield { type: "final", text: "A concise response for this turn." }; }) {}
  async probe() { return { status: "ready" as const, detail: "ready", correctiveAction: "None." }; }
  request(input: PiRequestInput, signal: AbortSignal): AsyncIterable<PiEvent> { this.inputs.push(input); return this.respond(input, signal); }
  async shutdown() {}
}
class FakeSpeech implements SpeechOutputPort {
  readonly synthesized: Array<{ responseId: string; text: string }> = [];
  readonly paused: string[] = [];
  readonly resumed: string[] = [];
  readonly cancelled: string[] = [];
  synthesize(input: { responseId: string; text: string }): Promise<{ playbackId: string; sampleRate: number; generatedSamples: number }> {
    this.synthesized.push({ responseId: input.responseId, text: input.text });
    return Promise.resolve({ playbackId: ids[80 + this.synthesized.length]!, sampleRate: 24000, generatedSamples: 6400 });
  }
  pause(responseId: string) { this.paused.push(responseId); }
  resume(responseId: string) { this.resumed.push(responseId); }
  cancel(responseId: string) { this.cancelled.push(responseId); }
}
class FakeScheduler implements Scheduler {
  callbacks: Array<() => void> = [];
  schedule(_delayMs: number, callback: () => void): () => void { this.callbacks.push(callback); let live = true; return () => { live = false; this.callbacks = this.callbacks.filter(found => found !== callback); }; }
  fire(): void { const callback = this.callbacks.shift(); callback?.(); }
}
function setup(overrides: Partial<ConstructorParameters<typeof SessionOrchestrator>[0]> = {}) {
  const events: SessionEvent[] = [];
  const pi = overrides.pi ?? new FakePi();
  const speech = overrides.speech ?? new FakeSpeech();
  let id = 0;
  const session = new SessionOrchestrator({ sessionId: SESSION_ID, sessionSeed: "seed", pi, speech, emit: event => events.push(event), idFactory: () => ids[id++]!, now: () => 10, policyDecide: policy("question"), ...overrides });
  session.start();
  return { session, events, pi, speech };
}
function turn(index: number, text = "This is a stable user thought", epoch = 0) { return { epoch, turnId: ids[60 + index]!, text, endpointComplete: true }; }

const schemaForType: Record<string, keyof typeof CONTRACT_VALIDATORS> = {
  "session.state": "SessionStateEvent",
  "policy.decision": "PolicyDecisionEvent",
  "reasoning.final": "ReasoningFinalEvent",
  "tts.started": "TtsStartedEvent",
  "tts.ended": "TtsEndedEvent",
  "failure": "FailureEvent",
  "barge_in.provisional": "BargeInEvent",
  "barge_in.confirmed": "BargeInEvent",
  "barge_in.rejected": "BargeInEvent",
  "barge_in.timed_out": "BargeInEvent",
};

describe("safe session orchestrator", () => {
  it("emits tts.started before streaming completion and tts.ended only after completion", async () => {
    let finish!: (value: { generatedSamples: number }) => void;
    const released: string[] = [];
    const speech = new FakeSpeech() as FakeSpeech & { release(responseId: string): void };
    speech.release = responseId => released.push(responseId);
    speech.synthesize = input => {
      speech.synthesized.push({ responseId: input.responseId, text: input.text });
      return Promise.resolve({
        playbackId: ids[81]!,
        sampleRate: 24_000,
        completion: new Promise<{ generatedSamples: number }>(resolve => { finish = resolve; }),
      }) as never;
    };
    const { session, events } = setup({ speech });
    const handling = session.handleStableFinal(turn(0));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events.map(value => value.type)).toContain("tts.started");
    expect(events.map(value => value.type)).not.toContain("tts.ended");
    expect(released).toEqual([speech.synthesized[0]!.responseId]);
    finish({ generatedSamples: 960 });
    await handling;
    expect(events.find(value => value.type === "tts.ended")?.payload.generatedSamples).toBe(960);
  });

  it("accepts an old-epoch terminal receipt up to the incrementally generated streaming extent", async () => {
    let finish!: (value: { generatedSamples: number }) => void;
    let generated!: (total: number) => void;
    const speech = new FakeSpeech();
    speech.synthesize = ((input: { responseId: string; text: string; onGeneratedSamples?: (total: number) => void }) => {
      speech.synthesized.push({ responseId: input.responseId, text: input.text });
      generated = input.onGeneratedSamples!;
      return Promise.resolve({
        playbackId: ids[82]!,
        sampleRate: 24_000,
        completion: new Promise<{ generatedSamples: number }>(resolve => { finish = resolve; }),
      });
    }) as never;
    const { session } = setup({ speech });
    const handling = session.handleStableFinal(turn(0));
    await new Promise<void>(resolve => setImmediate(resolve));
    generated(480);
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    session.confirmBargeIn();
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 320, reason: "cancelled" });
    expect(session.snapshot()).toMatchObject({ epoch: 1, deliveredExtent: { [playbackId]: 320 } });
    finish({ generatedSamples: 960 });
    await handling;
  });

  it("keeps transcript-only turns local without invoking Pi or TTS", async () => {
    const { session, pi, speech, events } = setup({ transcriptOnly: true });
    await session.handleStableFinal(turn(0));
    expect((pi as FakePi).inputs).toEqual([]);
    expect((speech as FakeSpeech).synthesized).toEqual([]);
    expect(events.map(value => value.type)).toContain("policy.decision");
    expect(session.snapshot().phase).toBe("listening");
  });

  it("cancels only the current turn and remains available for listening", async () => {
    let release!: (value: string) => void;
    const pi = new FakePi(() => ({ async *[Symbol.asyncIterator]() { yield { type: "final" as const, text: await new Promise<string>(resolve => { release = resolve; }) }; } }));
    const { session, speech } = setup({ pi });
    const handling = session.handleStableFinal(turn(0));
    await Promise.resolve();
    const responseId = session.snapshot().activeResponseId!;
    session.cancelCurrentTurn();
    expect(session.snapshot()).toMatchObject({ phase: "listening", epoch: 1 });
    expect((speech as FakeSpeech).cancelled).toEqual([responseId]);
    release("late response");
    await handling;
    expect((speech as FakeSpeech).synthesized).toEqual([]);
  });

  it("validates persona before policy or Pi can run", () => {
    const pi = new FakePi();
    expect(() => setup({ pi, personaSource: "---\nunknown: true\n---\nbody" })).toThrow(PersonaValidationError);
    expect(pi.inputs).toEqual([]);
  });

  it("serializes a bounded structurally valid persona for Pi by truncating only its body", async () => {
    const body = 'Escaped \\ quote " and emoji 😀.\n'.repeat(400);
    const personaSource = `---\nversion: 1\nname: Detailed companion\ninvitation_only: true\nposture_weights: { riff: 40, question: 40, challenge: 20 }\nchallenge_enabled: true\ninterests: [audio systems, safety]\n---\n${body}`;
    const pi = new FakePi();
    const { session } = setup({ pi, personaSource });
    await session.handleStableFinal(turn(0));
    const serialized = pi.inputs[0]!.personaInterpretation;
    const persona = JSON.parse(serialized);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(persona).toMatchObject({
      version: 1,
      name: "Detailed companion",
      invitation_only: true,
      posture_weights: { riff: 40, question: 40, challenge: 20 },
      challenge_enabled: true,
      interests: ["audio systems", "safety"],
    });
    expect(persona.body.length).toBeLessThan(body.length);
    expect(body.startsWith(persona.body)).toBe(true);
  });

  it("emits schema-valid events and deduplicates stable finals", async () => {
    const { session, events, pi, speech } = setup();
    await Promise.all([session.handleStableFinal(turn(0)), session.handleStableFinal(turn(0))]);
    expect((pi as FakePi).inputs).toHaveLength(1);
    expect((speech as FakeSpeech).synthesized).toHaveLength(1);
    expect(events.filter(event => event.type === "policy.decision")).toHaveLength(1);
    for (const event of events) {
      const title = schemaForType[event.type];
      if (title) expect(CONTRACT_VALIDATORS[title](event), JSON.stringify(CONTRACT_VALIDATORS[title].errors)).toBe(true);
    }
  });

  it("silence invokes neither Pi nor speech", async () => {
    const { session, pi, speech, events } = setup({ policyDecide: policy("silence") });
    await session.handleStableFinal(turn(0, "only three words"));
    expect((pi as FakePi).inputs).toEqual([]);
    expect((speech as FakeSpeech).synthesized).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "policy.decision", payload: expect.objectContaining({ posture: "silence" }) }));
  });

  it.each(["", `${"word ".repeat(46)}`, "Why one? Why two?", "```json bad protocol"])("fails silent for invalid Pi final %j", async text => {
    const pi = new FakePi(async function* () { yield { type: "delta", text: "untrusted" }; yield { type: "final", text }; });
    const { session, speech, events } = setup({ pi });
    await session.handleStableFinal(turn(0));
    expect((speech as FakeSpeech).synthesized).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "failure", payload: expect.objectContaining({ code: "reasoning_invalid" }) }));
    expect(events.some(event => event.type === "reasoning.delta")).toBe(false);
  });

  it("passes bounded prior context and the literal 45-word limit", async () => {
    const pi = new FakePi();
    const { session } = setup({ pi, maxContextBytes: 64, maxContextTurns: 2 });
    for (let index = 0; index < 4; index++) {
      await session.handleStableFinal(turn(index, `This is stable turn ${index} with extra context words`));
      const snapshot = session.snapshot();
      const playbackId = Object.keys(snapshot.deliveredExtent).at(-1)!;
      session.playbackStopped({ playbackId, cancelledEpoch: snapshot.epoch, finalPlayedSampleOffset: 6400, reason: "completed" });
    }
    expect(pi.inputs).toHaveLength(4);
    expect(pi.inputs.every(input => Buffer.byteLength(input.boundedContext, "utf8") <= 64 && input.maxWords === 45)).toBe(true);
    expect(pi.inputs[0]!.boundedContext).toBe("");
  });

  it("suppresses stale Pi completion after a superseding final", async () => {
    const releases: Array<(value: string) => void> = [];
    const pi = new FakePi((_input, _signal) => ({
      async *[Symbol.asyncIterator]() { const text = await new Promise<string>(resolve => releases.push(resolve)); yield { type: "final" as const, text }; },
    }));
    const { session, speech, events } = setup({ pi });
    const first = session.handleStableFinal(turn(0));
    await Promise.resolve();
    const second = session.handleStableFinal(turn(1));
    await Promise.resolve();
    releases[0]!("First stale response");
    releases[1]!("Second current response");
    await Promise.all([first, second]);
    expect((speech as FakeSpeech).synthesized.map(item => item.text)).toEqual(["Second current response"]);
    expect(session.snapshot().epoch).toBe(1);
    expect(events.filter(event => event.type === "reasoning.final")).toHaveLength(1);
  });

  it("keeps output paused when synthesis completes during provisional state", async () => {
    let finish!: (value: { playbackId: string; sampleRate: number; generatedSamples: number }) => void;
    const speech = new FakeSpeech();
    speech.synthesize = input => {
      speech.synthesized.push({ responseId: input.responseId, text: input.text });
      return new Promise(resolve => { finish = resolve; });
    };
    const { session } = setup({ speech });
    const handling = session.handleStableFinal(turn(0));
    await new Promise<void>(resolve => setImmediate(resolve));
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    finish({ playbackId: ids[90]!, sampleRate: 24000, generatedSamples: 6400 });
    await handling;
    expect(session.snapshot().phase).toBe("echo_provisional");
    expect(speech.paused).toEqual([responseId, responseId]);
    session.setEchoRecovered(true);
    session.rejectBargeIn();
    expect(session.snapshot().phase).toBe("playing");
  });

  it("keeps provisional barge-in non-destructive and confirms exactly once", async () => {
    const { session, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    expect(session.beginProvisionalBargeIn(responseId)).toBe(true);
    expect(session.snapshot().epoch).toBe(0);
    expect((speech as FakeSpeech).paused).toEqual([responseId]);
    expect(session.confirmBargeIn()).toBe(true);
    expect(session.confirmBargeIn()).toBe(false);
    expect(session.snapshot()).toMatchObject({ epoch: 1, phase: "listening" });
    expect((speech as FakeSpeech).cancelled.filter(id => id === responseId)).toHaveLength(1);
    expect(events.filter(event => event.type === "barge_in.confirmed")).toHaveLength(1);
  });

  it("resumes after persisted accidental noise without cancelling the response", async () => {
    const { session, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    const first = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(first);
    await session.handleStableFinal(turn(1, "um"));
    expect(session.snapshot()).toMatchObject({ epoch: 0, phase: "playing", activeResponseId: first });
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    expect((speech as FakeSpeech).resumed).toEqual([first]);
    expect(events).toContainEqual(expect.objectContaining({ type: "barge_in.rejected", payload: expect.objectContaining({ resumable: true }) }));
  });

  it("treats a new stable final during provisional as one confirmed supersession", async () => {
    const { session, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    const first = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(first);
    await session.handleStableFinal(turn(1));
    expect(session.snapshot().epoch).toBe(1);
    expect((speech as FakeSpeech).cancelled.filter(id => id === first)).toHaveLength(1);
    expect(events.filter(event => event.type === "barge_in.confirmed")).toHaveLength(1);
  });

  it("ignores an unseen delayed old-epoch final after confirmed barge-in", async () => {
    const { session, pi, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    session.confirmBargeIn();
    const counts = { events: events.length, pi: (pi as FakePi).inputs.length, speech: (speech as FakeSpeech).synthesized.length };
    const retention = session.retentionSnapshot();
    await session.handleStableFinal(turn(1, "This delayed final was never seen", 0));
    expect(session.snapshot()).toMatchObject({ epoch: 1, phase: "listening" });
    expect({ events: events.length, pi: (pi as FakePi).inputs.length, speech: (speech as FakeSpeech).synthesized.length }).toEqual(counts);
    expect(session.retentionSnapshot()).toEqual(retention);
  });

  it("ignores an unseen delayed old-epoch final after supersession", async () => {
    const { session, pi, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    await session.handleStableFinal(turn(1, "A current final supersedes the response", 0));
    expect(session.snapshot().epoch).toBe(1);
    const counts = { events: events.length, pi: (pi as FakePi).inputs.length, speech: (speech as FakeSpeech).synthesized.length };
    const retention = session.retentionSnapshot();
    await session.handleStableFinal(turn(2, "This delayed final belongs to epoch zero", 0));
    expect(session.snapshot().epoch).toBe(1);
    expect({ events: events.length, pi: (pi as FakePi).inputs.length, speech: (speech as FakeSpeech).synthesized.length }).toEqual(counts);
    expect(session.retentionSnapshot()).toEqual(retention);
  });

  it("ignores an unseen delayed old-epoch final after stop", async () => {
    const { session, pi, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    session.stop();
    const counts = { events: events.length, pi: (pi as FakePi).inputs.length, speech: (speech as FakeSpeech).synthesized.length };
    await session.handleStableFinal(turn(1, "This delayed final arrived after stop", 0));
    expect(session.snapshot()).toMatchObject({ epoch: 1, phase: "stopped" });
    expect({ events: events.length, pi: (pi as FakePi).inputs.length, speech: (speech as FakeSpeech).synthesized.length }).toEqual(counts);
    expect(session.retentionSnapshot()).toEqual({ contextTurns: 0, recentDecisions: 0, seenTurns: 0 });
  });

  it("resumes an explicit rejection or an unanswered timeout for the same playable response", async () => {
    const scheduler = new FakeScheduler();
    const { session, speech } = setup({ scheduler });
    await session.handleStableFinal(turn(0));
    const first = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(first);
    session.setEchoRecovered(true);
    expect(session.rejectBargeIn()).toBe(true);
    expect((speech as FakeSpeech).resumed).toEqual([first]);
    session.beginProvisionalBargeIn(first);
    scheduler.fire();
    expect((speech as FakeSpeech).resumed).toEqual([first, first]);
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    expect(session.snapshot()).toMatchObject({ phase: "playing", epoch: 0 });
  });

  it("continues playable output after an unanswered interruption prompt", async () => {
    const scheduler = new FakeScheduler();
    const { session, speech, events } = setup({ scheduler });
    await session.handleStableFinal(turn(0));
    const { activeResponseId, deliveredExtent } = session.snapshot();
    const playbackId = Object.keys(deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(activeResponseId!);
    scheduler.fire();
    expect(session.snapshot()).toMatchObject({ phase: "playing", epoch: 0 });
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    expect((speech as FakeSpeech).resumed).toEqual([activeResponseId]);
    expect(events).toContainEqual(expect.objectContaining({ epoch: 0, type: "barge_in.timed_out", payload: expect.objectContaining({ outputEpoch: 0, resumable: true }) }));
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 3200, reason: "cancelled" });
    expect(session.snapshot()).toMatchObject({ phase: "listening", epoch: 0, deliveredExtent: { [playbackId]: 3200 } });
  });

  it("does not resume recovered provisional input before a playable buffer exists", async () => {
    let release!: (value: string) => void;
    const pi = new FakePi(() => ({ async *[Symbol.asyncIterator]() { yield { type: "final" as const, text: await new Promise<string>(resolve => { release = resolve; }) }; } }));
    const { session, speech } = setup({ pi });
    const handling = session.handleStableFinal(turn(0));
    await Promise.resolve();
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    session.setEchoRecovered(true);
    session.rejectBargeIn();
    expect((speech as FakeSpeech).resumed).toEqual([]);
    expect((speech as FakeSpeech).cancelled).toEqual([responseId]);
    expect(session.snapshot().epoch).toBe(1);
    release("late response");
    await handling;
    expect((speech as FakeSpeech).synthesized).toEqual([]);

    let finishSynthesis!: (value: { playbackId: string; sampleRate: number; generatedSamples: number }) => void;
    const pendingSpeech = new FakeSpeech();
    pendingSpeech.synthesize = input => {
      pendingSpeech.synthesized.push({ responseId: input.responseId, text: input.text });
      return new Promise(resolve => { finishSynthesis = resolve; });
    };
    const pending = setup({ speech: pendingSpeech });
    const pendingHandling = pending.session.handleStableFinal(turn(1));
    await new Promise<void>(resolve => setImmediate(resolve));
    const pendingId = pending.session.snapshot().activeResponseId!;
    pending.session.beginProvisionalBargeIn(pendingId);
    pending.session.setEchoRecovered(true);
    pending.session.rejectBargeIn();
    expect(pendingSpeech.resumed).toEqual([]);
    expect(pendingSpeech.cancelled).toEqual([pendingId]);
    finishSynthesis({ playbackId: ids[91]!, sampleRate: 24000, generatedSamples: 6400 });
    await pendingHandling;
    expect(pending.session.snapshot()).toMatchObject({ epoch: 1, phase: "listening" });
  });

  it("terminally resolves provisional state when reasoning becomes invalid", async () => {
    let release!: (event: PiEvent) => void;
    const scheduler = new FakeScheduler();
    const pi = new FakePi(() => ({ async *[Symbol.asyncIterator]() { yield await new Promise<PiEvent>(resolve => { release = resolve; }); } }));
    const { session, speech, events } = setup({ pi, scheduler });
    const handling = session.handleStableFinal(turn(0));
    await Promise.resolve();
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    release({ type: "final", text: "" });
    await handling;
    expect(session.snapshot()).toMatchObject({ phase: "listening", epoch: 1 });
    expect((speech as FakeSpeech).cancelled).toEqual([responseId]);
    expect(scheduler.callbacks).toEqual([]);
    expect(events.filter(event => event.type === "barge_in.rejected")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "barge_in.rejected", payload: expect.objectContaining({ outputEpoch: 0, resumable: false }) }));
  });

  it("terminally resolves provisional state on Pi and synthesis failures", async () => {
    for (const mode of ["pi", "synthesis"] as const) {
      let releasePi!: (event: PiEvent) => void;
      let rejectSynthesis!: (error: Error) => void;
      const scheduler = new FakeScheduler();
      const pi = new FakePi(() => ({ async *[Symbol.asyncIterator]() { yield await new Promise<PiEvent>(resolve => { releasePi = resolve; }); } }));
      const speech = new FakeSpeech();
      if (mode === "synthesis") speech.synthesize = input => {
        speech.synthesized.push({ responseId: input.responseId, text: input.text });
        return new Promise((_resolve, reject) => { rejectSynthesis = reject; });
      };
      const { session, events } = setup({ pi, speech, scheduler });
      const handling = session.handleStableFinal(turn(0));
      await Promise.resolve();
      if (mode === "synthesis") {
        releasePi({ type: "final", text: "A valid response for synthesis." });
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const responseId = session.snapshot().activeResponseId!;
      session.beginProvisionalBargeIn(responseId);
      if (mode === "pi") releasePi({ type: "error", state: "unavailable", detail: "unavailable", correctiveAction: "retry" });
      else rejectSynthesis(new Error("failed"));
      await handling;
      expect(session.snapshot()).toMatchObject({ phase: "listening", epoch: 1 });
      expect(speech.cancelled).toEqual([responseId]);
      expect(scheduler.callbacks).toEqual([]);
      expect(events.filter(event => event.type === "barge_in.rejected")).toHaveLength(1);
    }
  });

  it("adds assistant context only after current full successful playback", async () => {
    const pi = new FakePi(async function* (input) { yield { type: "final", text: `Reply to: ${input.transcript}` }; });
    const { session } = setup({ pi });
    await session.handleStableFinal(turn(0, "First user thought for reply"));
    const oldPlayback = Object.keys(session.snapshot().deliveredExtent)[0]!;
    await session.handleStableFinal(turn(1, "Second user thought for reply"));
    expect(pi.inputs[1]!.boundedContext).not.toContain("Reply to: First user thought for reply");
    session.playbackStopped({ playbackId: oldPlayback, cancelledEpoch: 0, finalPlayedSampleOffset: 6400, reason: "completed" });
    const currentPlayback = Object.keys(session.snapshot().deliveredExtent).at(-1)!;
    session.playbackStopped({ playbackId: currentPlayback, cancelledEpoch: 1, finalPlayedSampleOffset: 6400, reason: "completed" });
    await session.handleStableFinal(turn(2, "This is a stable user thought", 1));
    expect(pi.inputs[2]!.boundedContext).not.toContain("Reply to: First user thought for reply");
    expect(pi.inputs[2]!.boundedContext).toContain("Reply to: Second user thought for reply");
  });

  it("rejects zero-audio synthesis and never commits its assistant text to context", async () => {
    const pi = new FakePi(async function* (input) { yield { type: "final", text: `Zero audio reply to: ${input.transcript}` }; });
    const speech = new FakeSpeech();
    speech.synthesize = input => {
      speech.synthesized.push({ responseId: input.responseId, text: input.text });
      return Promise.resolve({ playbackId: ids[92]!, sampleRate: 24000, generatedSamples: 0 });
    };
    const { session, events } = setup({ pi, speech });
    await session.handleStableFinal(turn(0, "First thought receives zero audio"));
    expect(session.snapshot()).toMatchObject({ phase: "listening", deliveredExtent: {} });
    expect(events).toContainEqual(expect.objectContaining({ type: "failure", payload: expect.objectContaining({ code: "response_failed" }) }));
    await session.handleStableFinal(turn(1, "Second thought checks bounded context"));
    expect(pi.inputs[1]!.boundedContext).not.toContain("Zero audio reply to: First thought receives zero audio");
  });

  it("lets playback completion terminally resolve a provisional race without revival", async () => {
    const scheduler = new FakeScheduler();
    const { session, speech, events } = setup({ scheduler });
    await session.handleStableFinal(turn(0));
    const { activeResponseId, deliveredExtent } = session.snapshot();
    const playbackId = Object.keys(deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(activeResponseId!);
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6400, reason: "completed" });
    expect(session.snapshot()).toMatchObject({ epoch: 0, phase: "listening", deliveredExtent: { [playbackId]: 6400 } });
    expect(session.rejectBargeIn()).toBe(false);
    scheduler.fire();
    expect(scheduler.callbacks).toEqual([]);
    expect((speech as FakeSpeech).resumed).toEqual([]);
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    expect(events.filter(event => event.type === "barge_in.rejected")).toHaveLength(1);
  });

  it("keeps delivery monotonic across reordered progress, old-epoch receipts, and immutable duplicates", async () => {
    const { session } = setup();
    await session.handleStableFinal(turn(0));
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    for (const playedSampleOffset of [-1, Number.NaN, 6401]) {
      session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset, generatedSamples: 6400 });
    }
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6401, reason: "cancelled" });
    expect(session.snapshot().deliveredExtent[playbackId]).toBe(0);
    session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset: 3000, generatedSamples: 6400 });
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    session.confirmBargeIn();
    session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset: 6000, generatedSamples: 6400 });
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 4000, reason: "cancelled" });
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6000, reason: "cancelled" });
    expect(session.snapshot()).toMatchObject({ epoch: 1, phase: "listening", deliveredExtent: { [playbackId]: 4000 } });
  });

  it("makes stop and receipt interleavings idempotent", async () => {
    const { session, speech } = setup();
    await session.handleStableFinal(turn(0));
    const { activeResponseId, deliveredExtent } = session.snapshot();
    const playbackId = Object.keys(deliveredExtent)[0]!;
    session.stop(); session.stop();
    for (let index = 0; index < 100; index++) {
      session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: index % 2 ? 2000 : 1000, reason: "stopped" });
      session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset: 6000, generatedSamples: 6400 });
    }
    expect(session.snapshot()).toMatchObject({ phase: "stopped", epoch: 1, deliveredExtent: { [playbackId]: 1000 } });
    expect(session.retentionSnapshot()).toEqual({ contextTurns: 0, recentDecisions: 0, seenTurns: 0 });
    expect((speech as FakeSpeech).cancelled.filter(id => id === activeResponseId)).toHaveLength(1);
  });

  it("preserves invariants across deterministic provisional race permutations", async () => {
    const terminals = ["confirm", "reject", "timeout"] as const;
    const challengers = ["stop", "new-final", "playback-complete"] as const;
    const orders = ["terminal-first", "challenger-first"] as const;
    for (const terminal of terminals) for (const challenger of challengers) for (const order of orders) {
      const scheduler = new FakeScheduler();
      const { session, speech, events } = setup({ scheduler });
      await session.handleStableFinal(turn(0));
      const { activeResponseId, deliveredExtent } = session.snapshot();
      const oldResponseId = activeResponseId!;
      const playbackId = Object.keys(deliveredExtent)[0]!;
      expect(session.beginProvisionalBargeIn(oldResponseId)).toBe(true);
      expect(session.beginProvisionalBargeIn(oldResponseId)).toBe(false);

      const runTerminal = () => {
        if (terminal === "confirm") session.confirmBargeIn();
        else if (terminal === "reject") session.rejectBargeIn();
        else scheduler.fire();
      };
      const runChallenger = async () => {
        if (challenger === "stop") session.stop();
        else if (challenger === "new-final") await session.handleStableFinal(turn(1, "A new stable final supersedes output"));
        else session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6400, reason: "completed" });
      };
      if (order === "terminal-first") { runTerminal(); await runChallenger(); }
      else { await runChallenger(); runTerminal(); }

      const expectedEpoch = order === "challenger-first"
        ? (challenger === "playback-complete" ? 0 : 1)
        : terminal === "timeout"
          ? (challenger === "playback-complete" ? 0 : 1)
          : (challenger === "stop" ? 2 : 1);
      expect(session.snapshot().epoch, `${terminal}/${challenger}/${order}`).toBe(expectedEpoch);
      const playbackFinishedBeforeCancellation = challenger === "playback-complete" && (order === "challenger-first" || terminal === "timeout");
      const expectedOldCancellation = playbackFinishedBeforeCancellation ? 0 : 1;
      expect(speech.cancelled.filter(id => id === oldResponseId), `${terminal}/${challenger}/${order}`).toHaveLength(expectedOldCancellation);
      expect(speech.resumed).toEqual(terminal === "timeout" && order === "terminal-first" ? [oldResponseId] : []);
      expect(session.beginProvisionalBargeIn(oldResponseId)).toBe(false);
      expect(events.filter(event => event.type === "barge_in.provisional")).toHaveLength(1);
      expect(events.filter(event => ["barge_in.confirmed", "barge_in.rejected", "barge_in.timed_out"].includes(event.type))).toHaveLength(1);

      session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 1000, reason: "cancelled" });
      session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6000, reason: "cancelled" });
      session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset: 6400, generatedSamples: 6400 });
      expect(session.snapshot().deliveredExtent[playbackId]).toBe(challenger === "playback-complete" ? 6400 : 1000);
      expect(session.snapshot().activeResponseId).not.toBe(oldResponseId);
      expect(session.snapshot().phase).not.toBe("echo_provisional");
    }
  });
});
