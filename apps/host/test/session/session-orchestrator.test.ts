import { describe, expect, it } from 'vitest';
import { CONTRACT_VALIDATORS } from '@app/contracts';
import { decide, type PolicyDecision, type PolicyInput } from '@app/policy';
import type { PiClient, PiEvent, PiRequestInput } from '../../src/pi/PiClient.js';
import type { PiResearchClient } from '../../src/pi/PiResearchClient.js';
import {
  SessionOrchestrator,
  type Scheduler,
  type SessionEvent,
  type SpeechOutputPort,
} from '../../src/session/SessionOrchestrator.js';

const SESSION_ID = '018f06b5-3c8d-7b2a-9f35-8b3388a857f1';
const ids = Array.from(
  { length: 100 },
  (_, index) => `018f06b5-3c8d-7b2a-9f35-${(0x8b3388a85000 + index).toString(16)}`,
);
const policy =
  (posture: PolicyDecision['posture']): ((input: PolicyInput) => PolicyDecision) =>
  (input) => ({
    policyVersion: 'v1.experimental',
    eligible: posture !== 'silence',
    posture,
    reasonCodes: [posture === 'silence' ? 'too_short' : 'selected'],
    inputDigest: 'a'.repeat(64),
  });

class FakePi implements PiClient {
  readonly inputs: PiRequestInput[] = [];
  constructor(
    private readonly respond: (
      input: PiRequestInput,
      signal: AbortSignal,
    ) => AsyncIterable<PiEvent> = async function* () {
      yield { type: 'delta', text: 'A concise response for this turn.' };
      yield { type: 'final', text: 'A concise response for this turn.' };
    },
  ) {}
  async probe() {
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    return { status: 'ready' as const, detail: 'ready', correctiveAction: 'None.' };
  }
  request(input: PiRequestInput, signal: AbortSignal): AsyncIterable<PiEvent> {
    this.inputs.push(input);
    return this.respond(input, signal);
  }
  async shutdown() {}
}
class FakeSpeech implements SpeechOutputPort {
  readonly synthesized: Array<{ responseId: string; text: string }> = [];
  readonly appended: Array<{ responseId: string; text: string }> = [];
  readonly finished: Array<{ responseId: string }> = [];
  readonly paused: string[] = [];
  readonly resumed: string[] = [];
  readonly cancelled: string[] = [];
  readonly releases: string[] = [];
  private speechIndex = 0;
  synthesize(input: { responseId: string; text: string; signal?: AbortSignal }): Promise<{
    playbackId: string;
    sampleRate: number;
    generatedSamples: number;
    completion?: Promise<{ generatedSamples: number }>;
  }> {
    this.synthesized.push({ responseId: input.responseId, text: input.text });
    const stream = this.begin({ responseId: input.responseId, signal: input.signal ?? new AbortController().signal });
    stream.append(input.text);
    stream.finish();
    return stream.started;
  }
  begin(input: {
    responseId: string;
    signal: AbortSignal;
    onGeneratedSamples?: (total: number) => void;
  }): SpeechOutputStream {
    const self = this;
    self.speechIndex++;
    const playbackId = ids[80 + self.speechIndex]!;
    const meta = {
      playbackId,
      sampleRate: 24000,
      generatedSamples: 6400,
      completion: Promise.resolve({ generatedSamples: 6400 }),
    };
    return {
      started: Promise.resolve(meta),
      append(text: string): void {
        self.appended.push({ responseId: input.responseId, text });
      },
      finish(): void {
        self.finished.push(input.responseId);
      },
    };
  }
  pause(responseId: string) {
    this.paused.push(responseId);
  }
  resume(responseId: string) {
    this.resumed.push(responseId);
  }
  cancel(responseId: string) {
    this.cancelled.push(responseId);
  }
  release?(responseId: string): void {
    this.releases.push(responseId);
  }
}
class FakeScheduler implements Scheduler {
  callbacks: Array<() => void> = [];
  schedule(_delayMs: number, callback: () => void): () => void {
    this.callbacks.push(callback);
    let live = true;
    return () => {
      live = false;
      this.callbacks = this.callbacks.filter((found) => found !== callback);
    };
  }
  fire(): void {
    const callback = this.callbacks.shift();
    callback?.();
  }
}
function setup(overrides: Partial<ConstructorParameters<typeof SessionOrchestrator>[0]> = {}) {
  const events: SessionEvent[] = [];
  const pi = overrides.pi ?? new FakePi();
  const speech = overrides.speech ?? new FakeSpeech();
  let id = 0;
  const session = new SessionOrchestrator({
    sessionId: SESSION_ID,
    sessionSeed: 'seed',
    pi,
    speech,
    emit: (event) => events.push(event),
    idFactory: () => ids[id++]!,
    now: () => 10,
    policyDecide: policy('question'),
    interruptionClassifier: {
      decide: async () => ({
        action: 'accept',
        intent: 'new_request',
        confidence: 'high',
        reason: 'Clear new request.',
      }),
    },
    ...overrides,
  });
  session.start();
  return { session, events, pi, speech };
}
function turn(index: number, text = 'This is a stable user thought', epoch = 0) {
  return { epoch, turnId: ids[60 + index]!, text, endpointComplete: true };
}

const schemaForType = {
  'session.state': 'SessionStateEvent',
  'policy.decision': 'PolicyDecisionEvent',
  'reasoning.started': 'ReasoningStartedEvent',
  'reasoning.delta': 'ReasoningDeltaEvent',
  'reasoning.final': 'ReasoningFinalEvent',
  'response.failed': 'ResponseFailedEvent',
  'tts.started': 'TtsStartedEvent',
  'tts.ended': 'TtsEndedEvent',
  failure: 'FailureEvent',
  'barge_in.provisional': 'BargeInEvent',
  'barge_in.confirmed': 'BargeInEvent',
  'barge_in.rejected': 'BargeInEvent',
  'barge_in.timed_out': 'BargeInEvent',
} satisfies Record<string, keyof typeof CONTRACT_VALIDATORS>;

describe('safe session orchestrator', () => {
  it('emits tts.started before streaming completion and tts.ended only after completion', async () => {
    let finish!: (value: { generatedSamples: number }) => void;
    const released: string[] = [];
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const speech = new FakeSpeech() as FakeSpeech & { release(responseId: string): void };
    speech.release = (responseId) => released.push(responseId);
    speech.begin = (input) => {
      speech.synthesized.push({ responseId: input.responseId, text: '' });
      const meta = {
        playbackId: ids[81]!,
        sampleRate: 24_000,
        completion: new Promise<{ generatedSamples: number }>((resolve) => {
          finish = resolve;
        }),
      };
      return {
        started: Promise.resolve(meta),
        append(text: string): void {
          speech.appended.push({ responseId: input.responseId, text });
        },
        finish(): void {
          speech.finished.push(input.responseId);
        },
      };
    };
    const { session, events } = setup({ speech });
    const handling = session.handleStableFinal(turn(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.map((value) => value.type)).toContain('tts.started');
    expect(events.map((value) => value.type)).not.toContain('tts.ended');
    expect(released).toEqual([speech.synthesized[0]!.responseId]);
    finish({ generatedSamples: 960 });
    await handling;
    expect(events.find((value) => value.type === 'tts.ended')?.payload.generatedSamples).toBe(960);
  });

  it('emits tts.ended after progressive research synthesis completes', async () => {
    let finish!: (value: { generatedSamples: number }) => void;
    const speech = new FakeSpeech();
    speech.begin = (input) => {
      const meta = {
        playbackId: ids[82]!,
        sampleRate: 24_000,
        completion: new Promise<{ generatedSamples: number }>((resolve) => {
          finish = resolve;
        }),
      };
      return {
        started: Promise.resolve(meta),
        append(text: string): void {
          speech.appended.push({ responseId: input.responseId, text });
        },
        finish(): void {
          speech.finished.push(input.responseId);
        },
      };
    };
    const researchPi: PiResearchClient = {
      async *requestBody() {
        const text = 'A researched response reaches a clear conclusion.';
        yield { type: 'delta', text };
        yield { type: 'final', text };
      },
      async shutdown() {},
    };
    const { session, events } = setup({ researchPi, multiPartEnabled: true, speech });

    await session.handleStableFinal(turn(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.map((event) => event.type)).toContain('tts.started');
    expect(events.map((event) => event.type)).not.toContain('tts.ended');

    finish({ generatedSamples: 960 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.find((event) => event.type === 'tts.ended')?.payload.generatedSamples).toBe(960);
  });

  it('accepts an old-epoch terminal receipt up to the incrementally generated streaming extent', async () => {
    let finish!: (value: { generatedSamples: number }) => void;
    let generated!: (total: number) => void;
    const speech = new FakeSpeech();
    speech.begin = (input) => {
      speech.synthesized.push({ responseId: input.responseId, text: '' });
      generated = input.onGeneratedSamples!;
      const meta = {
        playbackId: ids[82]!,
        sampleRate: 24_000,
        completion: new Promise<{ generatedSamples: number }>((resolve) => {
          finish = resolve;
        }),
      };
      return {
        started: Promise.resolve(meta),
        append(text: string): void {
          speech.appended.push({ responseId: input.responseId, text });
        },
        finish(): void {
          speech.finished.push(input.responseId);
        },
      };
    };
    const { session } = setup({ speech });
    const handling = session.handleStableFinal(turn(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    generated(480);
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    session.confirmBargeIn();
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 320, reason: 'cancelled' });
    expect(session.snapshot()).toMatchObject({ epoch: 1, deliveredExtent: { [playbackId]: 320 } });
    finish({ generatedSamples: 960 });
    await handling;
  });

  it('keeps transcript-only turns local without invoking Pi or TTS', async () => {
    const { session, pi, speech, events } = setup({ transcriptOnly: true });
    await session.handleStableFinal(turn(0));
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).synthesized).toEqual([]);
    expect(events.map((value) => value.type)).toContain('policy.decision');
    expect(session.snapshot().phase).toBe('listening');
  });

  it('cancels only the current turn and remains available for listening', async () => {
    let release!: (value: string) => void;
    const pi = new FakePi(() => ({
      async *[Symbol.asyncIterator]() {
        const text = await new Promise<string>((resolve) => {
          release = resolve;
        });
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text };
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text };
      },
    }));
    const { session, speech, events } = setup({ pi });
    const handling = session.handleStableFinal(turn(0));
    await Promise.resolve();
    const responseId = session.snapshot().activeResponseId!;
    session.cancelCurrentTurn();
    expect(session.snapshot()).toMatchObject({ phase: 'listening', epoch: 1 });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([responseId]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.cancelled',
        payload: expect.objectContaining({ responseId, reason: 'user' }),
      }),
    );
    release('late response');
    await handling;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).synthesized).toEqual([]);
  });

  it('validates persona before policy or Pi can run', () => {
    const pi = new FakePi();
    expect(() => setup({ pi, personaSource: '---\nunknown: true\n---\nbody' })).toThrow(
      'session persona validation failed',
    );
    expect(pi.inputs).toEqual([]);
  });

  it('accepts plain-text personas with the supported parser defaults', async () => {
    let policyPersona: PolicyInput['persona'] | undefined;
    const { session } = setup({
      personaSource: 'You are a plain-text companion.',
      policyDecide: (input) => {
        policyPersona = input.persona;
        return policy('silence')(input);
      },
    });
    await session.handleStableFinal(turn(0));
    expect(policyPersona).toMatchObject({
      name: 'Oliver',
      invitation_only: false,
      posture_weights: { riff: 50, question: 35, challenge: 15 },
      challenge_enabled: true,
      body: 'You are a plain-text companion.',
    });
  });

  it('keeps parsed persona interpretations and digests session-local', async () => {
    const observations: Array<{ name: string; digest: string }> = [];
    const observe = (input: PolicyInput): PolicyDecision => {
      observations.push({ name: input.persona.name, digest: input.personaDigest });
      return policy('silence')(input);
    };
    const first = setup({ personaSource: '---\nname: Ada\n---\nA sharp skeptic.', policyDecide: observe });
    const second = setup({ personaSource: '---\nname: Lin\n---\nA gentle storyteller.', policyDecide: observe });
    await first.session.handleStableFinal(turn(0));
    await second.session.handleStableFinal(turn(1));
    expect(observations.map((value) => value.name)).toEqual(['Ada', 'Lin']);
    expect(observations[0]!.digest).not.toBe(observations[1]!.digest);
  });

  it('keeps the structured persona out of user-facing Pi requests while it still drives policy', async () => {
    const personaSource = `---\nversion: 1\nname: Detailed companion\ninvitation_only: true\nposture_weights: { riff: 40, question: 40, challenge: 20 }\nchallenge_enabled: true\ninterests: [audio systems, safety]\nexperiences:\n  - Spent a winter logging shipping forecasts for a community radio night show\n---\nBody text.`;
    let policyPersona: unknown;
    const pi = new FakePi();
    const { session } = setup({
      pi,
      personaSource,
      policyDecide: (input) => {
        policyPersona = input.persona;
        return policy('riff')(input);
      },
    });
    await session.handleStableFinal(turn(0));
    const input = pi.inputs[0]!;
    expect(Object.keys(input).sort()).toEqual(['boundedContext', 'maxWords', 'posture', 'transcript']);
    expect(JSON.stringify(input)).not.toContain('Detailed companion');
    expect(policyPersona).toMatchObject({ name: 'Detailed companion', interests: ['audio systems', 'safety'] });
  });

  it('emits schema-valid events and deduplicates stable finals', async () => {
    const { session, events, pi, speech } = setup();
    await Promise.all([session.handleStableFinal(turn(0)), session.handleStableFinal(turn(0))]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(1);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).appended).toHaveLength(1);
    expect(events.filter((event) => event.type === 'policy.decision')).toHaveLength(1);
    for (const event of events) {
      // SAFETY: indexing a plain object with an arbitrary event type string yields undefined for unmapped types instead of throwing.
      const title = schemaForType[event.type as keyof typeof schemaForType];
      if (title)
        expect(CONTRACT_VALIDATORS[title](event), JSON.stringify(CONTRACT_VALIDATORS[title].errors)).toBe(true);
    }
  });

  it('silence invokes neither Pi nor speech', async () => {
    const { session, pi, speech, events } = setup({ policyDecide: policy('silence') });
    await session.handleStableFinal(turn(0, 'only three words'));
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).synthesized).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'policy.decision', payload: expect.objectContaining({ posture: 'silence' }) }),
    );
  });

  it('does not cancel a still-generating response for a short noise final', async () => {
    const speech = new FakeSpeech();
    let resolveStarted!: (meta: { playbackId: string; sampleRate: number; generatedSamples: number }) => void;
    speech.begin = (input) => ({
      started: new Promise((resolve) => {
        resolveStarted = resolve;
      }),
      append(): void {},
      finish(): void {},
    });
    const { session } = setup({ speech, policyDecide: decide });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;

    // VAD may fire on chewing or another brief noise before TTS has started.
    expect(session.handleSpeechStart()).toBe(0);
    await session.handleStableFinal(turn(1, 'uh'));

    expect(session.snapshot()).toMatchObject({ phase: 'reasoning', epoch: 0, activeResponseId: responseId });
    expect(speech.cancelled).toEqual([]);
    resolveStarted({ playbackId: ids[99]!, sampleRate: 24_000, generatedSamples: 6400 });
  });

  it.each(['', `${'word '.repeat(46)}`, 'Why one? Why two?', '```json bad protocol'])(
    'fails silent for invalid Pi final %j',
    async (text) => {
      const pi = new FakePi(async function* () {
        yield { type: 'delta', text: 'untrusted' };
        yield { type: 'final', text };
      });
      const { session, speech, events } = setup({ pi });
      await session.handleStableFinal(turn(0));
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      expect((speech as FakeSpeech).synthesized).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'failure', payload: expect.objectContaining({ code: 'reasoning_invalid' }) }),
      );
      // reasoning.delta previews are presentational and may stream before the final is
      // known to be invalid, but an invalid final must never materialize: no
      // reasoning.final, no synthesized speech, and a response.failed for the client.
      expect(events.some((event) => event.type === 'reasoning.final')).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'response.failed',
          payload: expect.objectContaining({ reasonCode: 'reasoning_invalid' }),
        }),
      );
      for (const delta of events.filter((event) => event.type === 'reasoning.delta'))
        expect(delta.payload.responseId).toBe(
          events.find((event) => event.type === 'reasoning.started')!.payload.responseId,
        );
    },
  );

  it('streams coalesced reasoning.delta previews and flushes the full text before final', async () => {
    const finalText = 'A short answer that flows naturally across the whole stream.';
    const pi = new FakePi(async function* () {
      for (const character of finalText) yield { type: 'delta', text: character };
      yield { type: 'final', text: finalText };
    });
    const { session, events } = setup({ pi, reasoningDeltaCoalesceChars: 10 });
    await session.handleStableFinal(turn(0));
    const deltas = events.filter((event) => event.type === 'reasoning.delta');
    // Coalescing emits the first preview immediately but batches the rest.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThan(finalText.length);
    let previous = '';
    for (const delta of deltas) {
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      const text = delta.payload.text as string;
      expect(finalText.startsWith(text)).toBe(true);
      expect(text.length).toBeGreaterThan(previous.length);
      previous = text;
    }
    // The last preview is flushed to the authoritative text before it materializes.
    expect(previous).toBe(finalText);
    const types = events.map((event) => event.type);
    expect(types.lastIndexOf('reasoning.delta')).toBeLessThan(types.indexOf('reasoning.final'));
  });

  it('stops streaming reasoning.delta for a response once a newer turn supersedes it', async () => {
    const gates: Array<(value: string) => void> = [];
    const pi = new FakePi((input) => ({
      async *[Symbol.asyncIterator]() {
        if (input.transcript.includes('first')) {
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          yield { type: 'delta' as const, text: 'A first preview that starts to stream.' };
          const rest = await new Promise<string>((resolve) => gates.push(resolve));
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          yield { type: 'delta' as const, text: rest };
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          yield { type: 'final' as const, text: 'A first preview that starts to stream.' + rest };
        } else {
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          yield { type: 'delta' as const, text: 'A second complete answer.' };
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          yield { type: 'final' as const, text: 'A second complete answer.' };
        }
      },
    }));
    const { session, events } = setup({ pi });
    const first = session.handleStableFinal(turn(0, 'the first words spoken'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const firstResponseId = events.find((event) => event.type === 'reasoning.started')!.payload.responseId as string;
    expect(
      events.filter((event) => event.type === 'reasoning.delta' && event.payload.responseId === firstResponseId),
    ).toHaveLength(1);
    // A newer turn supersedes the first response and bumps the epoch.
    const second = session.handleStableFinal(turn(1, 'the second words spoken'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Release the first generator; its continuation must be dropped by the cutoff.
    for (const release of gates.splice(0)) release(' and a trailing continuation.');
    await Promise.all([first, second]);
    // The first response kept exactly its single pre-cancel preview.
    expect(
      events.filter((event) => event.type === 'reasoning.delta' && event.payload.responseId === firstResponseId),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) => event.type === 'reasoning.delta' && String(event.payload.text).includes('trailing continuation'),
      ),
    ).toBe(false);
    // Only the second, current response materialized.
    expect(events.filter((event) => event.type === 'reasoning.final')).toHaveLength(1);
  });

  it('passes bounded prior context and the literal 45-word limit', async () => {
    const pi = new FakePi();
    const { session } = setup({ pi, maxContextBytes: 64, maxContextTurns: 2 });
    for (let index = 0; index < 4; index++) {
      await session.handleStableFinal(turn(index, `This is stable turn ${index} with extra context words`));
      const snapshot = session.snapshot();
      const playbackId = Object.keys(snapshot.deliveredExtent).at(-1)!;
      session.playbackStopped({
        playbackId,
        cancelledEpoch: snapshot.epoch,
        finalPlayedSampleOffset: 6400,
        reason: 'completed',
      });
    }
    expect(pi.inputs).toHaveLength(4);
    expect(
      pi.inputs.every((input) => Buffer.byteLength(input.boundedContext, 'utf8') <= 64 && input.maxWords === 45),
    ).toBe(true);
    expect(pi.inputs[0]!.boundedContext).toBe('');
  });

  it('suppresses stale Pi completion after a superseding final', async () => {
    const releases: Array<(value: string) => void> = [];
    const pi = new FakePi((_input, _signal) => ({
      async *[Symbol.asyncIterator]() {
        const text = await new Promise<string>((resolve) => releases.push(resolve));
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text };
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text };
      },
    }));
    const { session, speech, events } = setup({ pi });
    const first = session.handleStableFinal(turn(0));
    await Promise.resolve();
    const second = session.handleStableFinal(turn(1));
    await Promise.resolve();
    releases[0]!('First stale response');
    releases[1]!('Second current response');
    await Promise.all([first, second]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).appended.map((item) => item.text)).toEqual(['Second current response']);
    expect(session.snapshot().epoch).toBe(1);
    expect(events.filter((event) => event.type === 'reasoning.final')).toHaveLength(1);
  });

  it('keeps output paused when synthesis completes during provisional state', async () => {
    let resolveStart!: (value: {
      playbackId: string;
      sampleRate: number;
      generatedSamples: number;
      completion?: Promise<{ generatedSamples: number }>;
    }) => void;
    const speech = new FakeSpeech();
    speech.begin = (input) => {
      speech.synthesized.push({ responseId: input.responseId, text: '' });
      const deferred = new Promise<{
        playbackId: string;
        sampleRate: number;
        generatedSamples: number;
        completion?: Promise<{ generatedSamples: number }>;
      }>((resolve) => {
        resolveStart = resolve;
      });
      const completion = Promise.resolve({ generatedSamples: 6400 });
      return {
        started: deferred.then((meta) => ({ ...meta, completion })),
        append(text: string): void {
          speech.appended.push({ responseId: input.responseId, text });
        },
        finish(): void {
          speech.finished.push(input.responseId);
        },
      };
    };
    const { session } = setup({ speech });
    const handling = session.handleStableFinal(turn(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    resolveStart({ playbackId: ids[90]!, sampleRate: 24000, generatedSamples: 6400 });
    await handling;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot().phase).toBe('echo_provisional');
    expect(speech.paused).toEqual([responseId, responseId]);
    session.playbackPaused({
      responseId,
      playbackId: ids[90]!,
      outputEpoch: 0,
      pausedSampleOffset: 0,
      generatedSamples: 6400,
    });
    session.setEchoRecovered(true);
    session.rejectBargeIn();
    expect(session.snapshot().phase).toBe('playing');
  });

  it('keeps provisional barge-in non-destructive and confirms exactly once', async () => {
    const { session, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    expect(session.beginProvisionalBargeIn(responseId)).toBe(true);
    expect(session.snapshot().epoch).toBe(0);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).paused).toEqual([responseId]);
    expect(session.confirmBargeIn()).toBe(true);
    expect(session.confirmBargeIn()).toBe(false);
    expect(session.snapshot()).toMatchObject({ epoch: 1, phase: 'listening' });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled.filter((id) => id === responseId)).toHaveLength(1);
    expect(events.filter((event) => event.type === 'barge_in.confirmed')).toHaveLength(1);
  });

  it('does not let a short false-positive transcript cancel playback', async () => {
    const { session, speech, events } = setup({
      interruptionClassifier: {
        decide: async () => ({ action: 'accept', intent: 'new_request', confidence: 'high', reason: 'Noisy guess.' }),
      },
    });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(responseId);
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 0, generatedSamples: 6400 });
    await session.handleStableFinal(turn(1, 'I'));
    expect(session.snapshot()).toMatchObject({ epoch: 0, phase: 'playing', activeResponseId: responseId });
    expect(speech.cancelled).toEqual([]);
    expect(speech.resumed).toEqual([responseId]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'barge_in.rejected', payload: expect.objectContaining({ resumable: true }) }),
    );
  });

  it('resumes after persisted accidental noise without cancelling the response', async () => {
    const { session, speech, events } = setup({
      interruptionClassifier: {
        decide: async () => ({ action: 'resume', intent: 'non_substantive', confidence: 'high', reason: 'Noise.' }),
      },
    });
    await session.handleStableFinal(turn(0));
    const first = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(first);
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 0,
      generatedSamples: 6400,
    });
    await session.handleStableFinal(turn(1, 'um'));
    expect(session.snapshot()).toMatchObject({ epoch: 0, phase: 'playing', activeResponseId: first });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([first]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'barge_in.rejected', payload: expect.objectContaining({ resumable: true }) }),
    );
  });

  it('rewinds only resumes that follow a pause longer than one second', async () => {
    let now = 0;
    const { session, events } = setup({ now: () => now });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;

    session.beginProvisionalBargeIn(responseId);
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 0, generatedSamples: 6400 });
    now = 1_000;
    session.setEchoRecovered(true);
    expect(session.rejectBargeIn()).toBe(true);
    expect(events.filter((event) => event.type === 'barge_in.rejected').at(-1)!.payload.rewindMs).toBeUndefined();

    session.beginProvisionalBargeIn(responseId);
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 0, generatedSamples: 6400 });
    now = 2_001;
    session.setEchoRecovered(true);
    expect(session.rejectBargeIn()).toBe(true);
    expect(events.filter((event) => event.type === 'barge_in.rejected').at(-1)!.payload).toMatchObject({
      resumable: true,
      rewindMs: 500,
    });
  });

  it('uses one rewind directive for an interruption decision and its resolution', async () => {
    let now = 0;
    const { session, events } = setup({
      now: () => now,
      interruptionClassifier: {
        decide: async () => ({ action: 'resume', intent: 'non_substantive', confidence: 'high', reason: 'Noise.' }),
      },
    });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(responseId);
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 0, generatedSamples: 6400 });
    now = 1_001;

    await session.handleStableFinal(turn(1, 'um'));

    expect(events.find((event) => event.type === 'interruption.decision')!.payload.rewindMs).toBe(500);
    expect(events.find((event) => event.type === 'barge_in.rejected')!.payload.rewindMs).toBe(500);
  });

  it('defaults a low-confidence takeover decision to resuming the same epoch', async () => {
    const { session, speech, events } = setup({
      interruptionClassifier: {
        decide: async () => ({ action: 'accept', intent: 'new_request', confidence: 'low', reason: 'Ambiguous.' }),
      },
    });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(responseId);
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 120, generatedSamples: 6400 });
    await session.handleStableFinal(turn(1, 'Could I maybe ask something'));
    expect(session.snapshot()).toMatchObject({ epoch: 0, phase: 'playing', activeResponseId: responseId });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'interruption.decision',
        payload: expect.objectContaining({ action: 'resume', pausedSampleOffset: 120 }),
      }),
    );
  });

  it('accepts a deterministic correction even when the model says resume', async () => {
    const { session, pi, speech, events } = setup({
      interruptionClassifier: {
        decide: async () => ({
          action: 'resume',
          intent: 'continue_previous',
          confidence: 'high',
          reason: 'Carry on.',
        }),
      },
    });
    await session.handleStableFinal(turn(0, 'Let us discuss reliable voice agents'));
    const first = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(first);
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 320,
      generatedSamples: 6400,
    });
    session.handleSpeechEnd();
    await session.handleStableFinal(turn(1, 'No no no not those try to think of something else'));
    expect(session.snapshot()).toMatchObject({
      epoch: 0,
      phase: 'acceptance_pending_terminal',
      activeResponseId: first,
    });
    expect(events.filter((event) => event.type === 'interruption.decision').at(-1)!.payload).toMatchObject({
      action: 'accept',
      intent: 'correction',
      confidence: 'high',
      disposition: 'accept_takeover',
    });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([first]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([]);
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 320, reason: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot().epoch).toBe(1);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    expect(events.filter((event) => event.type === 'barge_in.confirmed')).toHaveLength(1);
  });

  it('accepts a bare redirection even when the model says resume', async () => {
    const { session, pi, speech, events } = setup({
      interruptionClassifier: {
        decide: async () => ({
          action: 'resume',
          intent: 'continue_previous',
          confidence: 'high',
          reason: 'Carry on.',
        }),
      },
    });
    await session.handleStableFinal(turn(0, 'Let us discuss reliable voice agents'));
    const first = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(first);
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 320,
      generatedSamples: 6400,
    });
    session.handleSpeechEnd();
    await session.handleStableFinal(turn(1, 'Fantasy setting'));
    expect(session.snapshot()).toMatchObject({
      epoch: 0,
      phase: 'acceptance_pending_terminal',
      activeResponseId: first,
    });
    expect(events.filter((event) => event.type === 'interruption.decision').at(-1)!.payload).toMatchObject({
      action: 'accept',
      intent: 'topic_change',
      disposition: 'accept_takeover',
    });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([first]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([]);
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 320, reason: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot().epoch).toBe(1);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    // The redirect becomes the next turn's content rather than being swallowed
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    // as control-only speech.
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs[1]!.transcript).toBe('Fantasy setting');
    expect(events.filter((event) => event.type === 'barge_in.confirmed')).toHaveLength(1);
  });

  it('accepts a bare redirection through the fallback when model classification fails', async () => {
    const { session, pi, events } = setup({
      interruptionClassifier: {
        decide: async () => {
          throw new Error('classifier unavailable');
        },
      },
    });
    await session.handleStableFinal(turn(0, 'Let us discuss reliable voice agents'));
    const first = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(first);
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 320,
      generatedSamples: 6400,
    });
    session.handleSpeechEnd();
    await session.handleStableFinal(turn(1, 'Fantasy setting'));
    expect(session.snapshot()).toMatchObject({
      epoch: 0,
      phase: 'acceptance_pending_terminal',
      activeResponseId: first,
    });
    expect(events.filter((event) => event.type === 'interruption.decision').at(-1)!.payload).toMatchObject({
      action: 'accept',
      intent: 'topic_change',
      confidence: 'medium',
      disposition: 'accept_takeover',
    });
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 320, reason: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot().epoch).toBe(1);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs[1]!.transcript).toBe('Fantasy setting');
    expect(events.filter((event) => event.type === 'barge_in.confirmed')).toHaveLength(1);
  });

  it('still resumes an explicit continue request when model classification fails', async () => {
    const { session, speech, events } = setup({
      interruptionClassifier: {
        decide: async () => {
          throw new Error('classifier unavailable');
        },
      },
    });
    await session.handleStableFinal(turn(0));
    const first = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(first);
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 120,
      generatedSamples: 6400,
    });
    session.handleSpeechEnd();
    await session.handleStableFinal(turn(1, 'Go on'));
    expect(session.snapshot()).toMatchObject({ epoch: 0, phase: 'playing', activeResponseId: first });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([first]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'barge_in.rejected', payload: expect.objectContaining({ resumable: true }) }),
    );
  });

  it('accepts a low-confidence correction verdict instead of downgrading it to resume', async () => {
    const { session, events } = setup({
      interruptionClassifier: {
        decide: async () => ({ action: 'accept', intent: 'correction', confidence: 'low', reason: 'Hedged.' }),
      },
    });
    await session.handleStableFinal(turn(0, 'Let us discuss reliable voice agents'));
    const first = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(first);
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 320,
      generatedSamples: 6400,
    });
    await session.handleStableFinal(turn(1, 'No no no not those try to think of something else'));
    expect(session.snapshot()).toMatchObject({
      epoch: 0,
      phase: 'acceptance_pending_terminal',
      activeResponseId: first,
    });
    expect(events.filter((event) => event.type === 'interruption.decision').at(-1)!.payload).toMatchObject({
      action: 'accept',
      intent: 'correction',
      disposition: 'accept_takeover',
    });
  });

  it('accepts a correction through the fallback when model classification fails', async () => {
    const { session, pi, events } = setup({
      interruptionClassifier: {
        decide: async () => {
          throw new Error('classifier unavailable');
        },
      },
    });
    await session.handleStableFinal(turn(0, 'Let us discuss reliable voice agents'));
    const first = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(first);
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 320,
      generatedSamples: 6400,
    });
    session.handleSpeechEnd();
    await session.handleStableFinal(turn(1, "No I no I don't mean that it's a more recent one"));
    expect(session.snapshot()).toMatchObject({
      epoch: 0,
      phase: 'acceptance_pending_terminal',
      activeResponseId: first,
    });
    expect(events.filter((event) => event.type === 'interruption.decision').at(-1)!.payload).toMatchObject({
      action: 'accept',
      intent: 'correction',
      disposition: 'accept_takeover',
    });
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 320, reason: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot().epoch).toBe(1);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    expect(events.filter((event) => event.type === 'barge_in.confirmed')).toHaveLength(1);
  });

  it('waits for the matching first terminal receipt before processing an accepted takeover exactly once', async () => {
    const { session, pi, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    const first = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(first);
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 0,
      generatedSamples: 6400,
    });
    await session.handleStableFinal(turn(1));
    expect(session.snapshot()).toMatchObject({
      epoch: 0,
      phase: 'acceptance_pending_terminal',
      activeResponseId: first,
    });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(1);
    expect(events.filter((event) => event.type === 'policy.decision')).toHaveLength(1);

    session.playbackStopped({
      playbackId: ids[99]!,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 0,
      reason: 'cancelled',
    });
    expect(session.snapshot().epoch).toBe(0);
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 0, reason: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot().epoch).toBe(1);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    expect(events.filter((event) => event.type === 'policy.decision')).toHaveLength(2);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled.filter((id) => id === first)).toHaveLength(1);
    expect(events.filter((event) => event.type === 'barge_in.confirmed')).toHaveLength(1);

    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 0, reason: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    expect(events.filter((event) => event.type === 'policy.decision')).toHaveLength(2);
  });

  it('ignores an unseen delayed old-epoch final after confirmed barge-in', async () => {
    const { session, pi, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    session.confirmBargeIn();
    const counts = {
      events: events.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      pi: (pi as FakePi).inputs.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      speech: (speech as FakeSpeech).synthesized.length,
    };
    const retention = session.retentionSnapshot();
    await session.handleStableFinal(turn(1, 'This delayed final was never seen', 0));
    expect(session.snapshot()).toMatchObject({ epoch: 1, phase: 'listening' });
    expect({
      events: events.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      pi: (pi as FakePi).inputs.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      speech: (speech as FakeSpeech).synthesized.length,
    }).toEqual(counts);
    expect(session.retentionSnapshot()).toEqual(retention);
  });

  it('ignores an unseen delayed old-epoch final after supersession', async () => {
    const { session, pi, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    await session.handleStableFinal(turn(1, 'A current final supersedes the response', 0));
    expect(session.snapshot().epoch).toBe(1);
    const counts = {
      events: events.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      pi: (pi as FakePi).inputs.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      speech: (speech as FakeSpeech).synthesized.length,
    };
    const retention = session.retentionSnapshot();
    await session.handleStableFinal(turn(2, 'This delayed final belongs to epoch zero', 0));
    expect(session.snapshot().epoch).toBe(1);
    expect({
      events: events.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      pi: (pi as FakePi).inputs.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      speech: (speech as FakeSpeech).synthesized.length,
    }).toEqual(counts);
    expect(session.retentionSnapshot()).toEqual(retention);
  });

  it('ignores an unseen delayed old-epoch final after stop', async () => {
    const { session, pi, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    session.stop();
    const counts = {
      events: events.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      pi: (pi as FakePi).inputs.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      speech: (speech as FakeSpeech).synthesized.length,
    };
    await session.handleStableFinal(turn(1, 'This delayed final arrived after stop', 0));
    expect(session.snapshot()).toMatchObject({ epoch: 1, phase: 'stopped' });
    expect({
      events: events.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      pi: (pi as FakePi).inputs.length,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      speech: (speech as FakeSpeech).synthesized.length,
    }).toEqual(counts);
    expect(session.retentionSnapshot()).toEqual({ contextTurns: 0, recentDecisions: 0, seenTurns: 0 });
  });

  it('resumes an explicit rejection for the same playable response', async () => {
    const { session, speech } = setup();
    await session.handleStableFinal(turn(0));
    const first = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(first);
    session.playbackPaused({
      responseId: first,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 0,
      generatedSamples: 6400,
    });
    session.setEchoRecovered(true);
    expect(session.rejectBargeIn()).toBe(true);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([first]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    expect(session.snapshot()).toMatchObject({ phase: 'playing', epoch: 0 });
  });

  it('resumes after a missing interruption final and ignores that final if it arrives late', async () => {
    const scheduler = new FakeScheduler();
    const { session, speech, events } = setup({ scheduler });
    await session.handleStableFinal(turn(0));
    const { activeResponseId, deliveredExtent } = session.snapshot();
    const playbackId = Object.keys(deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(activeResponseId!);
    session.playbackPaused({
      responseId: activeResponseId!,
      playbackId,
      outputEpoch: 0,
      pausedSampleOffset: 0,
      generatedSamples: 6400,
    });
    session.handleSpeechEnd();
    scheduler.fire();
    expect(session.snapshot()).toMatchObject({ phase: 'playing', epoch: 0, activeResponseId });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([activeResponseId]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'barge_in.timed_out', payload: expect.objectContaining({ resumable: true }) }),
    );
    const decisionCount = events.filter((event) => event.type === 'policy.decision').length;
    await session.handleStableFinal(turn(1, 'Late noise transcript'));
    expect(session.snapshot()).toMatchObject({ phase: 'playing', epoch: 0, activeResponseId });
    expect(events.filter((event) => event.type === 'policy.decision')).toHaveLength(decisionCount);
  });

  it('waits for the browser pause checkpoint before classifying a fast final', async () => {
    const { session, speech } = setup();
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(responseId);
    await session.handleStableFinal(turn(1, ''));
    expect(session.snapshot()).toMatchObject({
      phase: 'interruption_deciding',
      epoch: 0,
      activeResponseId: responseId,
    });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([]);
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 120, generatedSamples: 6400 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot()).toMatchObject({ phase: 'playing', epoch: 0, activeResponseId: responseId });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([responseId]);
  });

  it('does not resume recovered provisional input before a playable buffer exists', async () => {
    let release!: (value: string) => void;
    const pi = new FakePi(() => ({
      async *[Symbol.asyncIterator]() {
        const text = await new Promise<string>((resolve) => {
          release = resolve;
        });
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text };
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text };
      },
    }));
    const { session, speech } = setup({ pi });
    const handling = session.handleStableFinal(turn(0));
    await Promise.resolve();
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    session.setEchoRecovered(true);
    session.rejectBargeIn();
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([responseId]);
    expect(session.snapshot().epoch).toBe(1);
    release('late response');
    await handling;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).appended).toEqual([]);

    let finishSynthesis!: (value: { playbackId: string; sampleRate: number; generatedSamples: number }) => void;
    const pendingSpeech = new FakeSpeech();
    pendingSpeech.begin = (input) => {
      pendingSpeech.synthesized.push({ responseId: input.responseId, text: '' });
      const deferred = new Promise<{
        playbackId: string;
        sampleRate: number;
        generatedSamples: number;
        completion?: Promise<{ generatedSamples: number }>;
      }>((resolve) => {
        finishSynthesis = resolve;
      });
      const completion = Promise.resolve({ generatedSamples: 6400 });
      return {
        started: deferred.then((meta) => ({ ...meta, completion })),
        append(text: string): void {},
        finish(): void {},
      };
    };
    const pending = setup({ speech: pendingSpeech });
    const pendingHandling = pending.session.handleStableFinal(turn(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pendingId = pending.session.snapshot().activeResponseId!;
    pending.session.beginProvisionalBargeIn(pendingId);
    pending.session.setEchoRecovered(true);
    pending.session.rejectBargeIn();
    expect(pendingSpeech.resumed).toEqual([]);
    expect(pendingSpeech.cancelled).toEqual([pendingId]);
    finishSynthesis({ playbackId: ids[91]!, sampleRate: 24000, generatedSamples: 6400 });
    await pendingHandling;
    expect(pending.session.snapshot()).toMatchObject({ epoch: 1, phase: 'listening' });
  });

  it('terminally resolves provisional state when reasoning becomes invalid', async () => {
    let release!: (event: PiEvent) => void;
    const scheduler = new FakeScheduler();
    const pi = new FakePi(() => ({
      async *[Symbol.asyncIterator]() {
        yield await new Promise<PiEvent>((resolve) => {
          release = resolve;
        });
      },
    }));
    const { session, speech, events } = setup({ pi, scheduler });
    const handling = session.handleStableFinal(turn(0));
    await Promise.resolve();
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    release({ type: 'final', text: '' });
    await handling;
    expect(session.snapshot()).toMatchObject({ phase: 'listening', epoch: 1 });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([responseId]);
    expect(scheduler.callbacks).toEqual([]);
    expect(events.filter((event) => event.type === 'barge_in.rejected')).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'barge_in.rejected',
        payload: expect.objectContaining({ outputEpoch: 0, resumable: false }),
      }),
    );
  });

  it('terminally resolves provisional state on Pi and synthesis failures', async () => {
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    for (const mode of ['pi', 'synthesis'] as const) {
      const piEvents: PiEvent[] = [];
      let releasePi!: () => void;
      let rejectSynthesis!: (error: Error) => void;
      const scheduler = new FakeScheduler();
      const pi = new FakePi(() => ({
        async *[Symbol.asyncIterator]() {
          while (piEvents.length === 0)
            await new Promise<void>((resolve) => {
              releasePi = resolve;
            });
          while (piEvents.length > 0) yield piEvents.shift()!;
        },
      }));
      const speech = new FakeSpeech();
      if (mode === 'synthesis')
        speech.begin = (input) => {
          speech.synthesized.push({ responseId: input.responseId, text: '' });
          return {
            started: new Promise((_resolve, reject) => {
              rejectSynthesis = reject;
            }),
            append(text: string): void {},
            finish(): void {},
          };
        };
      const { session, events } = setup({ pi, speech, scheduler });
      const handling = session.handleStableFinal(turn(0));
      await Promise.resolve();
      if (mode === 'synthesis') {
        piEvents.push({ type: 'delta', text: 'A valid response for synthesis.' });
        piEvents.push({ type: 'final', text: 'A valid response for synthesis.' });
        releasePi!();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const responseId = session.snapshot().activeResponseId!;
      session.beginProvisionalBargeIn(responseId);
      if (mode === 'pi') {
        piEvents.push({ type: 'error', state: 'unavailable', detail: 'unavailable', correctiveAction: 'retry' });
        releasePi!();
      } else rejectSynthesis(new Error('failed'));
      await handling;
      expect(session.snapshot()).toMatchObject({ phase: 'listening', epoch: 1 });
      expect(speech.cancelled).toEqual([responseId]);
      expect(scheduler.callbacks).toEqual([]);
      expect(events.filter((event) => event.type === 'barge_in.rejected')).toHaveLength(1);
    }
  });

  it('adds assistant context only after current full successful playback', async () => {
    const pi = new FakePi(async function* (input) {
      yield { type: 'delta', text: `Reply to: ${input.transcript}` };
      yield { type: 'final', text: `Reply to: ${input.transcript}` };
    });
    const { session } = setup({ pi });
    await session.handleStableFinal(turn(0, 'First user thought for reply'));
    const oldPlayback = Object.keys(session.snapshot().deliveredExtent)[0]!;
    await session.handleStableFinal(turn(1, 'Second user thought for reply'));
    expect(pi.inputs[1]!.boundedContext).not.toContain('Reply to: First user thought for reply');
    session.playbackStopped({
      playbackId: oldPlayback,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 6400,
      reason: 'completed',
    });
    const currentPlayback = Object.keys(session.snapshot().deliveredExtent).at(-1)!;
    session.playbackStopped({
      playbackId: currentPlayback,
      cancelledEpoch: 1,
      finalPlayedSampleOffset: 6400,
      reason: 'completed',
    });
    await session.handleStableFinal(turn(2, 'This is a stable user thought', 1));
    expect(pi.inputs[2]!.boundedContext).not.toContain('Reply to: First user thought for reply');
    expect(pi.inputs[2]!.boundedContext).toContain('Reply to: Second user thought for reply');
  });

  it('rejects zero-audio synthesis and never commits its assistant text to context', async () => {
    const pi = new FakePi(async function* (input) {
      yield { type: 'delta', text: `Zero audio reply to: ${input.transcript}` };
      yield { type: 'final', text: `Zero audio reply to: ${input.transcript}` };
    });
    const speech = new FakeSpeech();
    speech.begin = (input) => {
      speech.synthesized.push({ responseId: input.responseId, text: '' });
      return {
        started: Promise.resolve({ playbackId: ids[92]!, sampleRate: 24000, generatedSamples: 0 }),
        append(text: string): void {},
        finish(): void {},
      };
    };
    const { session, events } = setup({ pi, speech });
    await session.handleStableFinal(turn(0, 'First thought receives zero audio'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot()).toMatchObject({ phase: 'listening', deliveredExtent: {} });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.failed',
        payload: expect.objectContaining({ reasonCode: 'tts_failed' }),
      }),
    );
    await session.handleStableFinal(turn(1, 'Second thought checks bounded context'));
    expect(pi.inputs[1]!.boundedContext).not.toContain('Zero audio reply to: First thought receives zero audio');
  });

  it('lets playback completion terminally resolve a provisional race without revival', async () => {
    const scheduler = new FakeScheduler();
    const { session, speech, events } = setup({ scheduler });
    await session.handleStableFinal(turn(0));
    const { activeResponseId, deliveredExtent } = session.snapshot();
    const playbackId = Object.keys(deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(activeResponseId!);
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6400, reason: 'completed' });
    expect(session.snapshot()).toMatchObject({ epoch: 0, phase: 'listening', deliveredExtent: { [playbackId]: 6400 } });
    expect(session.rejectBargeIn()).toBe(false);
    scheduler.fire();
    expect(scheduler.callbacks).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([]);
    expect(events.filter((event) => event.type === 'barge_in.rejected')).toHaveLength(1);
  });

  it('keeps delivery monotonic across reordered progress, old-epoch receipts, and immutable duplicates', async () => {
    const { session } = setup();
    await session.handleStableFinal(turn(0));
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    for (const playedSampleOffset of [-1, Number.NaN, 6401]) {
      session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset, generatedSamples: 6400 });
    }
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6401, reason: 'cancelled' });
    expect(session.snapshot().deliveredExtent[playbackId]).toBe(0);
    session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset: 3000, generatedSamples: 6400 });
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    session.confirmBargeIn();
    session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset: 6000, generatedSamples: 6400 });
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 4000, reason: 'cancelled' });
    session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6000, reason: 'cancelled' });
    expect(session.snapshot()).toMatchObject({ epoch: 1, phase: 'listening', deliveredExtent: { [playbackId]: 4000 } });
  });

  it('makes stop and receipt interleavings idempotent', async () => {
    const { session, speech, events } = setup();
    await session.handleStableFinal(turn(0));
    const { activeResponseId, deliveredExtent } = session.snapshot();
    const playbackId = Object.keys(deliveredExtent)[0]!;
    session.stop();
    session.stop();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.cancelled',
        payload: expect.objectContaining({ responseId: activeResponseId, reason: 'stopped' }),
      }),
    );
    for (let index = 0; index < 100; index++) {
      session.playbackStopped({
        playbackId,
        cancelledEpoch: 0,
        finalPlayedSampleOffset: index % 2 ? 2000 : 1000,
        reason: 'stopped',
      });
      session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset: 6000, generatedSamples: 6400 });
    }
    expect(session.snapshot()).toMatchObject({ phase: 'stopped', epoch: 1, deliveredExtent: { [playbackId]: 1000 } });
    expect(session.retentionSnapshot()).toEqual({ contextTurns: 0, recentDecisions: 0, seenTurns: 0 });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled.filter((id) => id === activeResponseId)).toHaveLength(1);
  });

  it('preserves invariants across deterministic provisional race permutations', async () => {
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const terminals = ['confirm', 'reject'] as const;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const challengers = ['stop', 'new-final', 'playback-complete'] as const;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const orders = ['terminal-first', 'challenger-first'] as const;
    for (const terminal of terminals)
      for (const challenger of challengers)
        for (const order of orders) {
          const scheduler = new FakeScheduler();
          const { session, speech, events } = setup({ scheduler });
          await session.handleStableFinal(turn(0));
          const { activeResponseId, deliveredExtent } = session.snapshot();
          const oldResponseId = activeResponseId!;
          const playbackId = Object.keys(deliveredExtent)[0]!;
          expect(session.beginProvisionalBargeIn(oldResponseId)).toBe(true);
          session.playbackPaused({
            responseId: oldResponseId,
            playbackId,
            outputEpoch: 0,
            pausedSampleOffset: 0,
            generatedSamples: 6400,
          });
          session.handleSpeechEnd();
          expect(session.beginProvisionalBargeIn(oldResponseId)).toBe(false);

          const runTerminal = () => {
            if (terminal === 'confirm') session.confirmBargeIn();
            else session.rejectBargeIn();
          };
          const runChallenger = async () => {
            if (challenger === 'stop') session.stop();
            else if (challenger === 'new-final') {
              await session.handleStableFinal(turn(1, 'A new stable final supersedes output'));
              if (session.snapshot().phase === 'acceptance_pending_terminal')
                session.playbackStopped({
                  playbackId,
                  cancelledEpoch: 0,
                  finalPlayedSampleOffset: 0,
                  reason: 'cancelled',
                });
            } else
              session.playbackStopped({
                playbackId,
                cancelledEpoch: 0,
                finalPlayedSampleOffset: 6400,
                reason: 'completed',
              });
          };
          if (order === 'terminal-first') {
            runTerminal();
            await runChallenger();
          } else {
            await runChallenger();
            runTerminal();
          }

          const expectedEpoch =
            order === 'challenger-first' ? (challenger === 'playback-complete' ? 0 : 1) : challenger === 'stop' ? 2 : 1;
          expect(session.snapshot().epoch, `${terminal}/${challenger}/${order}`).toBe(expectedEpoch);
          const playbackFinishedBeforeCancellation = challenger === 'playback-complete' && order === 'challenger-first';
          const expectedOldCancellation = playbackFinishedBeforeCancellation ? 0 : 1;
          expect(
            speech.cancelled.filter((id) => id === oldResponseId),
            `${terminal}/${challenger}/${order}`,
          ).toHaveLength(expectedOldCancellation);
          expect(speech.resumed).toEqual([]);
          expect(session.beginProvisionalBargeIn(oldResponseId)).toBe(false);
          expect(events.filter((event) => event.type === 'barge_in.provisional')).toHaveLength(1);
          expect(
            events.filter((event) =>
              ['barge_in.confirmed', 'barge_in.rejected', 'barge_in.timed_out'].includes(event.type),
            ),
          ).toHaveLength(1);

          session.playbackStopped({
            playbackId,
            cancelledEpoch: 0,
            finalPlayedSampleOffset: 1000,
            reason: 'cancelled',
          });
          session.playbackStopped({
            playbackId,
            cancelledEpoch: 0,
            finalPlayedSampleOffset: 6000,
            reason: 'cancelled',
          });
          session.playbackProgress({ playbackId, outputEpoch: 0, playedSampleOffset: 6400, generatedSamples: 6400 });
          const expectedDelivered =
            challenger === 'playback-complete'
              ? 6400
              : challenger === 'new-final' && order === 'challenger-first'
                ? 0
                : 1000;
          expect(session.snapshot().deliveredExtent[playbackId]).toBe(expectedDelivered);
          expect(session.snapshot().activeResponseId).not.toBe(oldResponseId);
          expect(session.snapshot().phase).not.toBe('echo_provisional');
        }
  });

  it('cancels progressive speech once after first-sentence audio on a Pi failure and keeps the next response usable', async () => {
    const pi = new FakePi(async function* (input) {
      if (input.transcript.includes('Second')) {
        yield { type: 'delta', text: 'A successful second reply.' };
        yield { type: 'final', text: 'A successful second reply.' };
        return;
      }
      yield { type: 'delta', text: 'First sentence. Second' };
      yield { type: 'error', state: 'unavailable', detail: 'provider unavailable', correctiveAction: 'retry' };
    });
    const { session, events, speech } = setup({ pi });
    await session.handleStableFinal(turn(0, 'A stable user thought'));
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const firstResponse = events.find((event) => event.type === 'reasoning.started')!.payload.responseId as string;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).appended).toContainEqual({ responseId: firstResponse, text: 'First sentence.' });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([firstResponse]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.failed',
        payload: expect.objectContaining({ responseId: firstResponse, reasonCode: 'reasoning_unavailable' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'failure', payload: expect.objectContaining({ code: 'reasoning_unavailable' }) }),
    );
    expect(events.filter((event) => event.type === 'reasoning.final')).toHaveLength(0);
    expect(session.snapshot().phase).toBe('listening');

    // The next response opens, appends, finishes, plays, and commits context.
    await session.handleStableFinal(turn(1, 'Second healthy thought'));
    // SAFETY: reasoning.started payloads in this test carry a string responseId set by the fixture.
    const secondResponse = events.filter((event) => event.type === 'reasoning.started').at(-1)!.payload
      .responseId as string;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).finished).toContain(secondResponse);
    const secondStarted = events.find(
      (event) => event.type === 'tts.started' && event.payload.responseId === secondResponse,
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const secondPlayback = secondStarted!.payload.playbackId as string;
    session.playbackStopped({
      playbackId: secondPlayback,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 6400,
      reason: 'completed',
    });
    await session.handleStableFinal(turn(2, 'Third thought checks context'));
    expect(pi.inputs[2]!.boundedContext).toContain('A successful second reply.');
    expect(pi.inputs[2]!.boundedContext).not.toContain('First sentence.');
  });

  it('routes completion rejection through response.failed(tts_failed) without committing context', async () => {
    let rejectCompletion!: (error: Error) => void;
    let playbackIndex = 0;
    const speech = new FakeSpeech();
    speech.begin = (input) => {
      speech.synthesized.push({ responseId: input.responseId, text: '' });
      const meta = {
        playbackId: ids[95 + playbackIndex++]!,
        sampleRate: 24_000,
        generatedSamples: 6400,
        completion: new Promise<{ generatedSamples: number }>((_resolve, reject) => {
          rejectCompletion = reject;
        }),
      };
      return {
        started: Promise.resolve(meta),
        append(text: string): void {
          speech.appended.push({ responseId: input.responseId, text });
        },
        finish(): void {
          speech.finished.push(input.responseId);
        },
      };
    };
    const pi = new FakePi(async function* (input) {
      yield { type: 'delta', text: `Reply to: ${input.transcript}` };
      yield { type: 'final', text: `Reply to: ${input.transcript}` };
    });
    const { session, events } = setup({ pi, speech });
    await session.handleStableFinal(turn(0, 'First failed thought'));
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const firstResponse = events.find((event) => event.type === 'reasoning.started')!.payload.responseId as string;
    rejectCompletion(new Error('synthesis failed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(speech.cancelled).toEqual([firstResponse]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.failed',
        payload: expect.objectContaining({ responseId: firstResponse, reasonCode: 'tts_failed' }),
      }),
    );
    expect(events.filter((event) => event.type === 'tts.ended')).toHaveLength(0);
    expect(session.snapshot().phase).toBe('listening');

    await session.handleStableFinal(turn(1, 'Second healthy thought'));
    // SAFETY: reasoning.started payloads in this test carry a string responseId set by the fixture.
    const secondResponse = events.filter((event) => event.type === 'reasoning.started').at(-1)!.payload
      .responseId as string;
    const secondStarted = events.find(
      (event) => event.type === 'tts.started' && event.payload.responseId === secondResponse,
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const secondPlayback = secondStarted!.payload.playbackId as string;
    session.playbackStopped({
      playbackId: secondPlayback,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 6400,
      reason: 'completed',
    });
    await session.handleStableFinal(turn(2, 'Third thought checks context'));
    expect(pi.inputs[2]!.boundedContext).toContain('Reply to: Second healthy thought');
    expect(pi.inputs[2]!.boundedContext).not.toContain('Reply to: First failed thought');
  });

  it('rejects a duplicate Pi final through response.failed(reasoning_invalid)', async () => {
    const pi = new FakePi(async function* () {
      yield { type: 'delta', text: 'A duplicate final reply.' };
      yield { type: 'final', text: 'A duplicate final reply.' };
      yield { type: 'final', text: 'A duplicate final reply.' };
    });
    const { session, events, speech } = setup({ pi });
    await session.handleStableFinal(turn(0));
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const firstResponse = events.find((event) => event.type === 'reasoning.started')!.payload.responseId as string;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.failed',
        payload: expect.objectContaining({ responseId: firstResponse, reasonCode: 'reasoning_invalid' }),
      }),
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([firstResponse]);
    expect(events.filter((event) => event.type === 'reasoning.final')).toHaveLength(0);
  });

  it('re-classifies newer speech and never orphans the provisional when speech arrives mid-classification', async () => {
    let releaseFirst!: () => void;
    const classified: string[] = [];
    const classifier = {
      decide: async (input: { transcript: string }) => {
        classified.push(input.transcript);
        if (classified.length === 1)
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        return {
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          action: 'resume' as const,
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          intent: 'continue_previous' as const,
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          confidence: 'high' as const,
          reason: 'Carry on.',
        };
      },
    };
    const { session, speech, events } = setup({ interruptionClassifier: classifier });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 320, generatedSamples: 6400 });
    session.handleSpeechEnd();
    const first = session.handleStableFinal(turn(1, 'Hold off for a second'));
    await Promise.resolve();
    expect(session.snapshot().phase).toBe('interruption_deciding');
    // New speech while classifying must not supersede the response or orphan the provisional.
    expect(session.handleSpeechStart()).toBe(0);
    expect(session.snapshot()).toMatchObject({ epoch: 0, activeResponseId: responseId });
    session.handleSpeechEnd();
    const second = session.handleStableFinal(turn(2, 'Okay continue'));
    await second;
    // Only the newest speech yields an authoritative decision.
    const decisions = events.filter((event) => event.type === 'interruption.decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload).toMatchObject({ turnId: ids[62]!, responseId, pausedSampleOffset: 320 });
    expect(session.snapshot()).toMatchObject({ phase: 'playing', epoch: 0, activeResponseId: responseId });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).resumed).toEqual([responseId]);
    // Releasing the stale first classification changes nothing.
    releaseFirst();
    await first;
    expect(events.filter((event) => event.type === 'interruption.decision')).toHaveLength(1);
    expect(session.snapshot()).toMatchObject({ phase: 'playing', epoch: 0 });
  });

  it('resolves an orphaned provisional when the response is cancelled while classifying', async () => {
    const classifier = { decide: async () => new Promise<never>(() => {}) };
    const { session, speech, events } = setup({ interruptionClassifier: classifier, classifierTimeoutMs: 60 });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    session.beginProvisionalBargeIn(responseId);
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 320, generatedSamples: 6400 });
    const handling = session.handleStableFinal(turn(1, 'Hold off for a second'));
    await Promise.resolve();
    // The user cancels the whole assistant turn while classification is pending.
    session.cancelCurrentTurn();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(
      events.some(
        (event) =>
          event.type === 'barge_in.confirmed' ||
          event.type === 'barge_in.rejected' ||
          event.type === 'barge_in.timed_out',
      ),
    ).toBe(true);
    expect(session.snapshot()).toMatchObject({ phase: 'listening', epoch: 1 });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([responseId]);
    await handling;
  });

  it('pauses playback when speech starts before delayed TTS becomes audible', async () => {
    let resolveStart!: (meta: { playbackId: string; sampleRate: number; generatedSamples: number }) => void;
    const speech = new FakeSpeech();
    speech.begin = (input) => ({
      started: new Promise((resolve) => {
        resolveStart = resolve;
      }),
      append(): void {},
      finish(): void {},
    });
    const { session, speech: fakeSpeech } = setup({ speech });
    const handling = session.handleStableFinal(turn(0, 'A response that takes time to synthesize'));
    await Promise.resolve();
    expect(session.handleSpeechStart()).toBe(0);
    resolveStart({ playbackId: ids[93]!, sampleRate: 24_000, generatedSamples: 6400 });
    await handling;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fakeSpeech.paused).toEqual([session.snapshot().activeResponseId!]);
    expect(session.snapshot().phase).toBe('echo_provisional');
  });

  it('keeps a superseding utterance eligible when the previous response never became audible', async () => {
    const speech = new FakeSpeech();
    speech.begin = () => ({ started: new Promise(() => {}), append(): void {}, finish(): void {} });
    const { session, events } = setup({ speech });
    void session.handleStableFinal(turn(0, 'First thought'));
    await Promise.resolve();
    await session.handleStableFinal(turn(1, 'Second superseding thought'));
    const decisions = events.filter((event) => event.type === 'policy.decision');
    expect(decisions).toHaveLength(2);
    expect(decisions[1]!.payload).toMatchObject({ eligible: true, posture: 'question', reasonCodes: ['selected'] });
  });

  it('responds to a meaningful accepted takeover instead of silencing it', async () => {
    const scheduler = new FakeScheduler();
    const { session, pi, events } = setup({ policyDecide: decide, scheduler });
    await session.handleStableFinal(turn(0, 'Let us discuss reliable voice agents'));
    const firstResponse = session.snapshot().activeResponseId!;
    const firstPlayback = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(firstResponse);
    session.playbackPaused({
      responseId: firstResponse,
      playbackId: firstPlayback,
      outputEpoch: 0,
      pausedSampleOffset: 320,
      generatedSamples: 6400,
    });
    session.handleSpeechEnd();
    await session.handleStableFinal(turn(1, 'Actually explain how interruption recovery works'));
    expect(session.snapshot().phase).toBe('acceptance_pending_terminal');
    session.playbackStopped({
      playbackId: firstPlayback,
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 320,
      reason: 'cancelled',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    const secondDecision = events.filter((event) => event.type === 'policy.decision').at(-1)!;
    expect(secondDecision.payload).toMatchObject({ eligible: true, reasonCodes: ['selected'] });
    expect(events.filter((event) => event.type === 'reasoning.started')).toHaveLength(2);
    expect(scheduler.callbacks).toEqual([]);
  });

  it('keeps responding across many turns under the production policy', async () => {
    const { session, pi, events } = setup({ policyDecide: decide });
    for (let index = 0; index < 8; index++) {
      session.handleSpeechEnd();
      await session.handleStableFinal(turn(index, `This is complete conversation thought number ${index}`));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const playbackId = Object.keys(session.snapshot().deliveredExtent).at(-1)!;
      session.playbackStopped({ playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 6400, reason: 'completed' });
    }
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(8);
    expect(events.filter((event) => event.type === 'reasoning.started')).toHaveLength(8);
    expect(
      events.filter((event) => event.type === 'policy.decision' && event.payload.posture === 'silence'),
    ).toHaveLength(0);
    expect(session.snapshot().phase).toBe('listening');
  });

  it('processes an accepted takeover when its terminal receipt is lost', async () => {
    const scheduler = new FakeScheduler();
    const { session, pi, events } = setup({ scheduler });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(responseId);
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 320, generatedSamples: 6400 });
    await session.handleStableFinal(turn(1, 'Please explain the new request now'));
    expect(session.snapshot().phase).toBe('acceptance_pending_terminal');
    scheduler.fire();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.snapshot()).toMatchObject({ epoch: 1, activeResponseId: expect.any(String) });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    expect(events.filter((event) => event.type === 'barge_in.confirmed')).toHaveLength(1);
  });

  it('supersedes an accepted takeover when newer speech starts before its receipt', async () => {
    const scheduler = new FakeScheduler();
    const { session, pi } = setup({ scheduler });
    await session.handleStableFinal(turn(0));
    const responseId = session.snapshot().activeResponseId!;
    const playbackId = Object.keys(session.snapshot().deliveredExtent)[0]!;
    session.beginProvisionalBargeIn(responseId);
    session.playbackPaused({ responseId, playbackId, outputEpoch: 0, pausedSampleOffset: 320, generatedSamples: 6400 });
    await session.handleStableFinal(turn(1, 'Please answer this first takeover'));
    expect(session.handleSpeechStart()).toBe(1);
    await session.handleStableFinal(turn(2, 'Please answer this newer request instead', 1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scheduler.callbacks).toEqual([]);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs).toHaveLength(2);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((pi as FakePi).inputs[1]!.transcript).toBe('Please answer this newer request instead');
  });

  it('ignores a stale late speech-start resolution after cancellation', async () => {
    let resolveStart!: (value: {
      playbackId: string;
      sampleRate: number;
      generatedSamples: number;
      completion?: Promise<{ generatedSamples: number }>;
    }) => void;
    const speech = new FakeSpeech();
    speech.begin = (input) => {
      speech.synthesized.push({ responseId: input.responseId, text: '' });
      const deferred = new Promise<{
        playbackId: string;
        sampleRate: number;
        generatedSamples: number;
        completion?: Promise<{ generatedSamples: number }>;
      }>((resolve) => {
        resolveStart = resolve;
      });
      return {
        started: deferred,
        append(text: string): void {
          speech.appended.push({ responseId: input.responseId, text });
        },
        finish(): void {
          speech.finished.push(input.responseId);
        },
      };
    };
    const { session, events } = setup({ speech });
    const handling = session.handleStableFinal(turn(0));
    await Promise.resolve();
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const firstResponse = events.find((event) => event.type === 'reasoning.started')!.payload.responseId as string;
    session.cancelCurrentTurn();
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((speech as FakeSpeech).cancelled).toEqual([firstResponse]);
    resolveStart({ playbackId: ids[90]!, sampleRate: 24000, generatedSamples: 6400 });
    await handling;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.filter((event) => event.type === 'tts.started')).toHaveLength(0);
    expect(session.snapshot()).toMatchObject({ phase: 'listening', epoch: 1 });
  });
});
