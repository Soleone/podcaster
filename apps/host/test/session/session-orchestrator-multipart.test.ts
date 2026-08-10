import { describe, expect, it } from "vitest";
import { decide, type PolicyDecision, type PolicyInput } from "@app/policy";
import type { PiClient, PiEvent, PiRequestInput } from "../../src/pi/PiClient.js";
import type { PiResearchClient, PiResearchRequestInput } from "../../src/pi/PiResearchClient.js";
import { SessionOrchestrator, type Scheduler, type SessionEvent, type SpeechOutputPort, type SpeechOutputStream } from "../../src/session/SessionOrchestrator.js";

const SESSION_ID = "018f06b5-3c8d-7b2a-9f35-8b3388a857f1";
const ids = Array.from({ length: 100 }, (_, index) => `018f06b5-3c8d-7b2a-9f35-${(0x8b3388a85000 + index).toString(16)}`);
const policy = (posture: PolicyDecision["posture"]): ((input: PolicyInput) => PolicyDecision) => () => ({ policyVersion: "v1.experimental", eligible: true, posture, reasonCodes: ["selected"], inputDigest: "a".repeat(64) });

class FakePi implements PiClient {
  readonly inputs: PiRequestInput[] = [];
  constructor(private readonly respond: (input: PiRequestInput, signal: AbortSignal) => AsyncIterable<PiEvent> = async function* () {
    yield { type: "delta", text: "Let me look that up for you." };
    yield { type: "final", text: "Let me look that up for you." };
  }) {}
  async probe() { return { status: "ready" as const, detail: "ready", correctiveAction: "None." }; }
  request(input: PiRequestInput, signal: AbortSignal): AsyncIterable<PiEvent> { this.inputs.push(input); return this.respond(input, signal); }
  async shutdown() {}
}
class FakeResearchPi implements PiResearchClient {
  readonly inputs: PiResearchRequestInput[] = [];
  constructor(private readonly respond: (input: PiResearchRequestInput, signal: AbortSignal) => AsyncIterable<PiEvent> = async function* () {}) {}
  requestBody(input: PiResearchRequestInput, signal: AbortSignal): AsyncIterable<PiEvent> { this.inputs.push(input); return this.respond(input, signal); }
  async shutdown() {}
}
class FakeSpeech implements SpeechOutputPort {
  readonly begins: Array<{ responseId: string; partIndex?: number }> = [];
  readonly appended: Array<{ responseId: string; partIndex?: number; text: string }> = [];
  readonly finished: Array<{ responseId: string; partIndex?: number }> = [];
  readonly paused: string[] = [];
  readonly cancelled: Array<{ responseId: string; partIndex?: number }> = [];
  private speechIndex = 0;
  begin(input: { responseId: string; partIndex?: number; signal: AbortSignal; onGeneratedSamples?: (total: number) => void }): SpeechOutputStream {
    this.begins.push({ responseId: input.responseId, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}) });
    this.speechIndex++;
    const playbackId = ids[80 + this.speechIndex]!;
    const self = this;
    const meta = { playbackId, sampleRate: 24000, completion: Promise.resolve({ generatedSamples: 6400 }) };
    return {
      started: Promise.resolve(meta),
      append(text: string): void { self.appended.push({ responseId: input.responseId, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), text }); },
      finish(): void { self.finished.push({ responseId: input.responseId, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}) }); },
    };
  }
  synthesize(input: { responseId: string; partIndex?: number; text: string; signal?: AbortSignal }): Promise<{ playbackId: string; sampleRate: number; generatedSamples: number; completion?: Promise<{ generatedSamples: number }> }> {
    const stream = this.begin({ responseId: input.responseId, ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}), signal: input.signal ?? new AbortController().signal });
    stream.append(input.text);
    stream.finish();
    return stream.started;
  }
  pause(responseId: string) { this.paused.push(responseId); }
  resume(_responseId: string) {}
  cancel(responseId: string, partIndex?: number) { this.cancelled.push({ responseId, ...(partIndex !== undefined ? { partIndex } : {}) }); }
  release?(_responseId: string, _partIndex?: number) {}
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
  const researchPi = overrides.researchPi ?? new FakeResearchPi();
  let id = 0;
  const session = new SessionOrchestrator({ sessionId: SESSION_ID, sessionSeed: "seed", pi, speech, researchPi, multiPartEnabled: true, emit: event => events.push(event), idFactory: () => ids[id++]!, now: () => 10, policyDecide: policy("question"), interruptionClassifier: { decide: async () => ({ action: "accept", intent: "new_request", confidence: "high", reason: "Clear new request." }) }, ...overrides });
  session.start();
  return { session, events, pi, speech, researchPi };
}
function turn(index: number, text = "What is the capital of France and why does it matter?", epoch = 0) { return { epoch, turnId: ids[60 + index]!, text, endpointComplete: true }; }
const byType = (events: SessionEvent[], type: string) => events.filter(event => event.type === type);

describe("safe session orchestrator multi-part", () => {
  it("emits stall part 0 before body parts with correct event ordering", async () => {
    const body = async function* (): AsyncIterable<PiEvent> {
      yield { type: "delta", text: "The capital of France is Paris. It has been the capital for centuries. The city sits on the Seine river. It is a major cultural center. The metro system is extensive. Millions visit every year. " };
      yield { type: "final", text: "The capital of France is Paris. It has been the capital for centuries. The city sits on the Seine river. It is a major cultural center. The metro system is extensive. Millions visit every year. " };
    };
    const { session, events, researchPi } = setup({ researchPi: new FakeResearchPi(body) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    const indexOf = (type: string, payload?: Record<string, unknown>) => events.findIndex(event => event.type === type && (!payload || Object.entries(payload).every(([key, value]) => event.payload[key] === value)));
    const stallStarted = indexOf("response.part_started", { partIndex: 0 });
    const stallReasoning = indexOf("reasoning.started", { partIndex: 0 });
    const stallFinal = indexOf("reasoning.final", { partIndex: 0 });
    const stallPartFinal = indexOf("response.part_final", { partIndex: 0 });
    const body1Started = indexOf("response.part_started", { partIndex: 1 });
    const body1Final = indexOf("response.part_final", { partIndex: 1 });
    expect(stallStarted).toBeGreaterThanOrEqual(0);
    expect(stallStarted).toBeLessThan(stallReasoning);
    expect(stallReasoning).toBeLessThan(stallFinal);
    expect(stallFinal).toBeLessThan(stallPartFinal);
    expect(stallPartFinal).toBeLessThan(body1Started);
    expect(body1Started).toBeLessThan(body1Final);
    const partStarted = byType(events, "response.part_started").map(event => event.payload.partIndex as number);
    expect(partStarted[0]).toBe(0);
    expect(partStarted.slice(1).every((index, i) => index === i + 1)).toBe(true);
    expect(researchPi.inputs[0]!.stallText).toContain("look that up");
  });

  it("starts TTS for stall then each body part with partIndex", async () => {
    const body = async function* (): AsyncIterable<PiEvent> {
      yield { type: "delta", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
      yield { type: "final", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
    };
    const { session, events, speech } = setup({ researchPi: new FakeResearchPi(body) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    const partIndices = speech.begins.map(begin => begin.partIndex);
    expect(partIndices).toEqual([0, 1, 2]);
    const started = byType(events, "tts.started").map(event => event.payload.partIndex as number);
    expect(started).toEqual([0, 1, 2]);
  });

  it("adds the concatenated parent text to context once after all parts complete", async () => {
    const body = async function* (): AsyncIterable<PiEvent> {
      yield { type: "delta", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
      yield { type: "final", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
    };
    const { session, speech } = setup({ researchPi: new FakeResearchPi(body) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    // Terminal receipts for each playback in order.
    for (const begin of speech.begins) {
      session.playbackStopped({ playbackId: ids[81 + speech.begins.indexOf(begin)]!, cancelledEpoch: 0, finalPlayedSampleOffset: 6400, reason: "completed" });
    }
    await handling;
    const snapshot = session.retentionSnapshot();
    expect(snapshot.contextTurns).toBe(2);
  });

  it("keeps the streamed stall prefix when the stall request errors after emitting sentence chunks", async () => {
    const stallThenError = async function* (): AsyncIterable<PiEvent> {
      yield { type: "delta", text: "I will check that. One moment please." };
      yield { type: "error", state: "unavailable", detail: "stall failed", correctiveAction: "Retry" };
    };
    const body = async function* (): AsyncIterable<PiEvent> {
      yield { type: "delta", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
      yield { type: "final", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
    };
    const { session, events, speech, researchPi } = setup({ pi: new FakePi(stallThenError), researchPi: new FakeResearchPi(body) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    expect(byType(events, "response.failed")).toHaveLength(0);
    const stallFinal = byType(events, "reasoning.final").find(event => event.payload.partIndex === 0);
    expect(stallFinal?.payload.text).toBe("I will check that.");
    expect(byType(events, "response.part_final").some(event => event.payload.partIndex === 0)).toBe(true);
    // The emitted prefix was streamed to the stall TTS and the stall stream finished.
    expect(speech.appended.some(item => item.partIndex === 0 && item.text === "I will check that.")).toBe(true);
    expect(speech.finished.some(item => item.partIndex === 0)).toBe(true);
    // The research body still starts and receives exactly the streamed stall text.
    expect(researchPi.inputs[0]!.stallText).toBe("I will check that.");
    const started = byType(events, "response.part_started").map(event => event.payload.partIndex as number);
    expect(started).toEqual([0, 1, 2]);
    // The session returns to listening once every part has played out.
    for (const begin of speech.begins) {
      session.playbackStopped({ playbackId: ids[81 + speech.begins.indexOf(begin)]!, cancelledEpoch: 0, finalPlayedSampleOffset: 6400, reason: "completed" });
    }
    await handling;
    expect(session.snapshot().activeResponseId).toBeUndefined();
    expect(session.snapshot().phase).toBe("listening");
    expect(session.retentionSnapshot().contextTurns).toBe(2);
  });

  it("fails with reasoning_unavailable when the stall request errors before emitting any chunk", async () => {
    const stallErrors = async function* (): AsyncIterable<PiEvent> {
      yield { type: "error", state: "unavailable", detail: "stall failed", correctiveAction: "Retry" };
    };
    const { session, events, researchPi } = setup({ pi: new FakePi(stallErrors) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    const failed = byType(events, "response.failed")[0];
    expect(failed?.payload.reasonCode).toBe("reasoning_unavailable");
    expect(failed?.payload.partIndex).toBe(0);
    expect(byType(events, "reasoning.final")).toHaveLength(0);
    expect(byType(events, "response.part_final")).toHaveLength(0);
    expect(researchPi.inputs).toHaveLength(0);
    expect(session.snapshot().activeResponseId).toBeUndefined();
    expect(session.snapshot().phase).toBe("listening");
  });

  it("keeps the streamed stall prefix when stall final validation fails after emitting sentence chunks", async () => {
    const stallMismatchFinal = async function* (): AsyncIterable<PiEvent> {
      yield { type: "delta", text: "I will check that. One moment please." };
      yield { type: "final", text: "Completely different text." };
    };
    const { session, events, researchPi } = setup({ pi: new FakePi(stallMismatchFinal) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    expect(byType(events, "response.failed")).toHaveLength(0);
    const stallFinal = byType(events, "reasoning.final").find(event => event.payload.partIndex === 0);
    expect(stallFinal?.payload.text).toBe("I will check that.");
    expect(byType(events, "response.part_final").some(event => event.payload.partIndex === 0)).toBe(true);
    expect(researchPi.inputs[0]!.stallText).toBe("I will check that.");
  });

  it("emits response.failed with the failed body part index and preserves the stall", async () => {
    const body = async function* (): AsyncIterable<PiEvent> {
      yield { type: "error", state: "unavailable", detail: "research failed", correctiveAction: "Retry" };
    };
    const { session, events } = setup({ researchPi: new FakeResearchPi(body) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    const failed = byType(events, "response.failed")[0];
    expect(failed?.payload.reasonCode).toBe("reasoning_unavailable");
    expect(failed?.payload.partIndex).toBe(1);
    expect(byType(events, "response.part_final").length).toBe(1);
  });

  it("cancels all parts when the current turn is cancelled", async () => {
    const body = async function* (): AsyncIterable<PiEvent> {
      yield { type: "delta", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
      yield { type: "final", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
    };
    const { session, speech } = setup({ researchPi: new FakeResearchPi(body) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    session.cancelCurrentTurn();
    await handling;
    expect(speech.cancelled.filter(item => item.partIndex === undefined).length).toBe(1);
  });

  it("pauses the whole multi-part response on barge-in and confirms cancels every part", async () => {
    const body = async function* (): AsyncIterable<PiEvent> {
      yield { type: "delta", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
      yield { type: "final", text: "Paris is the capital of France. It sits on the Seine. The city is a cultural hub. Millions of people visit it. The metro is very extensive. The food is world famous. " };
    };
    const { session, speech, events } = setup({ researchPi: new FakeResearchPi(body) });
    const handling = session.handleStableFinal(turn(0));
    await handling;
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    expect(byType(events, "barge_in.provisional").length).toBe(1);
    expect(speech.paused).toContain(responseId);
    session.confirmBargeIn();
    await handling;
    expect(speech.cancelled.filter(item => item.partIndex === undefined).length).toBe(1);
    expect(session.snapshot().activeResponseId).toBeUndefined();
  });
});