import { createServer } from 'node:http';
import { encodeBinaryAudioFrame } from '@app/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { PiClient, PiRequestInput } from '../../src/pi/PiClient.js';
import { buildApp } from '../../src/server/app.js';
import type { SidecarProcess } from '../../src/sidecar/process.js';

const sessionId = '018f1f32-7abc-7def-8abc-0123456789ab';
const seed = '018f1f32-7abd-7def-8abc-0123456789ab';
const utteranceId = '018f1f32-7abe-7def-8abc-0123456789ab';
const playbackId = '018f1f32-7ac0-7def-8abc-0123456789ab';
let sequence = 0;
function command(type: string, payload: Record<string, unknown>, epoch = 0) {
  const suffix = (0x1000 + sequence++).toString(16).padStart(12, '0');
  return { protocolVersion: 1, sessionId, epoch, eventId: `018f1f32-7abf-7def-8abc-${suffix}`, type, monotonicMs: sequence, payload };
}
const pi: PiClient = {
  async probe() { return { status: 'ready', detail: 'Pi is ready.', correctiveAction: 'None.' }; },
  async *request() { yield { type: 'delta' as const, text: 'A concise response.' }; yield { type: 'final' as const, text: 'A concise response.' }; },
  async shutdown() {},
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fakeAudio(options: { tts?: boolean; progressiveTts?: boolean; multiUtterance?: boolean; onStreamClose?: () => void } = {}): Promise<SidecarProcess> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  wss.on('connection', socket => {
    let opened = '';
    let utteranceSequence = 0;
    let activeUtterance = utteranceId;
    let progressiveStarted = false;
    socket.send(JSON.stringify({ type: 'readiness.snapshot', payload: { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cpu-v1' } }));
    socket.on('message', (raw, binary) => {
      if (binary) {
        activeUtterance = options.multiUtterance
          ? `018f1f32-7abe-7def-8abc-${(0x123456789000 + utteranceSequence).toString(16)}`
          : utteranceId;
        socket.send(JSON.stringify({ type: 'vad.speech_start', payload: { streamId: opened, utteranceId: activeUtterance, captureStartSequence: utteranceSequence } }));
        utteranceSequence++;
        return;
      }
      const message = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
      if (message.type === 'stream.open') {
        opened = String(message.payload.streamId);
        socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: opened } }));
      } else if (message.type === 'stt.bind_epoch') {
        const boundUtterance = String(message.payload.utteranceId);
        socket.send(JSON.stringify({ type: 'vad.speech_end', payload: { streamId: opened, utteranceId: boundUtterance, captureStartSequence: utteranceSequence - 1 } }));
        socket.send(JSON.stringify({ type: 'stt.partial', payload: { streamId: opened, utteranceId: boundUtterance, epoch: message.payload.epoch, sequence: 0, text: 'Could you share', replacedCharacters: 0 } }));
        socket.send(JSON.stringify({ type: 'stt.final', payload: { streamId: opened, utteranceId: boundUtterance, epoch: message.payload.epoch, text: 'Could you share what you think about this complete idea?', endpointComplete: true } }));
      } else if (message.type === 'stream.close') {
        options.onStreamClose?.();
      } else if (message.type === 'tts.open' || message.type === 'tts.append') {
        if (options.progressiveTts && message.type === 'tts.append' && !progressiveStarted) {
          // Progressive synthesis: first append starts playback immediately, before commit/final.
          progressiveStarted = true;
          socket.send(JSON.stringify({ type: 'tts.started', payload: { streamId: opened, responseId: message.payload.responseId, epoch: message.payload.epoch, playbackId, outputStreamId: 55, sampleRate: 24000 } }));
          socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: 55, sequence: 0, monotonicUs: 2n, pcm16: new Int16Array(480) }, 64 * 1024));
        }
        // Progressive TTS: open/appends are acked silently, commit triggers the remainder
      } else if (message.type === 'tts.commit' && options.progressiveTts) {
        socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: 55, sequence: 1, monotonicUs: 3n, pcm16: new Int16Array(480) }, 64 * 1024));
        socket.send(JSON.stringify({ type: 'tts.ended', payload: { streamId: opened, responseId: message.payload.responseId, epoch: message.payload.epoch, playbackId, generatedSamples: 960 } }));
      } else if ((message.type === 'tts.request' || message.type === 'tts.commit') && options.tts) {
        socket.send(JSON.stringify({ type: 'tts.started', payload: { streamId: opened, responseId: message.payload.responseId, epoch: message.payload.epoch, playbackId, outputStreamId: 55, sampleRate: 24000 } }));
        socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: 55, sequence: 0, monotonicUs: 2n, pcm16: new Int16Array(480) }, 64 * 1024));
        setTimeout(() => {
          socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: 55, sequence: 1, monotonicUs: 3n, pcm16: new Int16Array(480) }, 64 * 1024));
          socket.send(JSON.stringify({ type: 'tts.ended', payload: { streamId: opened, responseId: message.payload.responseId, epoch: message.payload.epoch, playbackId, generatedSamples: 960 } }));
        }, 5);
      }
    });
  });
  const close = async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); };
  cleanup.push(close);
  return { child: {} as SidecarProcess['child'], origin: `http://127.0.0.1:${address.port}`, secret: 'sidecar-secret', stop: close };
}

async function bootstrap(app: FastifyInstance, origin: string) {
  const headers = { host: new URL(origin).host, origin, 'content-type': 'application/json' };
  const response = await fetch(`${origin}/api/bootstrap`, { method: 'POST', headers, body: '{"disclosureAcknowledged":true}' });
  const body = await response.json() as { capability: string };
  return { body, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}
function waitFor(messages: Array<Record<string, unknown>>, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const timer = setInterval(() => {
      const found = messages.find(message => message.type === type);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(`missing ${type}`)); }
    }, 5);
  });
}
function waitForWhere(messages: Array<Record<string, unknown>>, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('missing matching message')); }
    }, 5);
  });
}

describe('browser conversation routing', () => {
  it('completes fake Pi through streaming TTS and authoritative browser terminal accounting', async () => {
    const sidecar = await fakeAudio({ tts: true });
    const app = await buildApp({ sidecar, pi });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }); app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<Record<string, unknown>> = [];
    const binary: Buffer[] = [];
    socket.on('message', (raw, isBinary) => { if (isBinary) binary.push(Buffer.from(raw as Buffer)); else messages.push(JSON.parse(raw.toString())); });
    await new Promise<void>(resolve => { socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability }))); socket.once('message', () => resolve()); });
    socket.send(JSON.stringify(command('session.start', { sessionSeed: seed, reasoningMode: 'full' })));
    socket.send(JSON.stringify(command('audio.start', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })));
    socket.send(encodeBinaryAudioFrame({ channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) }, 64 * 1024));
    const final = await waitFor(messages, 'transcript.final');
    const finalPayload = final.payload as Record<string, unknown>;
    socket.send(JSON.stringify(command('turn.persisted', { turnId: finalPayload.turnId, finalEventId: final.eventId, persistedEpoch: final.epoch })));
    const started = await waitFor(messages, 'tts.started');
    expect((started.payload as Record<string, unknown>).playbackId).toBe(playbackId);
    await waitFor(messages, 'tts.ended');
    await waitForWhere(messages, () => binary.length === 2);
    socket.send(JSON.stringify(command('playback.progress', { playbackId, outputEpoch: 0, playedSampleOffset: 960, generatedSamples: 960 })));
    socket.send(JSON.stringify(command('playback.stopped', { playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 960, reason: 'completed' })));
    const listening = await waitForWhere(messages, message => message.type === 'session.state' && (message.payload as Record<string, unknown>).phase === 'listening');
    expect(listening.epoch).toBe(0);
    expect(messages.filter(message => message.type === 'policy.decision')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'reasoning.final')).toHaveLength(1);
    socket.close();
  });

  it('degrades on persistence failure, permits bounded retry, and rejects acknowledgement after Stop', async () => {
    const sidecar = await fakeAudio();
    const app = await buildApp({ sidecar, pi });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }); app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw.toString())); });
    await new Promise<void>(resolve => { socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability }))); socket.once('message', () => resolve()); });
    socket.send(JSON.stringify(command('session.start', { sessionSeed: seed, reasoningMode: 'full' })));
    socket.send(JSON.stringify(command('audio.start', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })));
    socket.send(encodeBinaryAudioFrame({ channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) }, 64 * 1024));
    const final = await waitFor(messages, 'transcript.final');
    const payload = final.payload as Record<string, unknown>;
    const acknowledgement = { turnId: payload.turnId, finalEventId: final.eventId, persistedEpoch: final.epoch };
    socket.send(JSON.stringify(command('turn.persistence_failed', { ...acknowledgement, reasonCode: 'quota' })));
    await waitForWhere(messages, message => message.type === 'failure' && (message.payload as Record<string, unknown>).code === 'stable_turn_not_persisted');
    expect(messages.some(message => message.type === 'policy.decision')).toBe(false);
    socket.send(JSON.stringify(command('turn.persisted', acknowledgement)));
    await waitFor(messages, 'policy.decision');
    socket.send(JSON.stringify(command('session.stop', { reason: 'user' })));
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
    socket.send(JSON.stringify(command('turn.persisted', acknowledgement)));
    await expect(closed).resolves.toBe(1008);
  });

  it('rejects a persistence acknowledgement made stale by an interrupting utterance', async () => {
    const sidecar = await fakeAudio({ multiUtterance: true });
    const app = await buildApp({ sidecar, pi });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }); app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw.toString())); });
    await new Promise<void>(resolve => { socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability }))); socket.once('message', () => resolve()); });
    socket.send(JSON.stringify(command('session.start', { sessionSeed: seed, reasoningMode: 'full' })));
    socket.send(JSON.stringify(command('audio.start', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })));
    const capture = (captureSequence: number) => socket.send(encodeBinaryAudioFrame({ channel: 1, streamId: 7, sequence: captureSequence, monotonicUs: BigInt(captureSequence + 1), pcm16: new Int16Array(320) }, 64 * 1024));
    capture(0);
    await waitForWhere(messages, message => message.type === 'transcript.final');
    capture(1);
    await waitForWhere(messages, () => messages.filter(message => message.type === 'transcript.final').length >= 2);
    const finals = messages.filter(message => message.type === 'transcript.final');
    const first = finals[0]!;
    const second = finals[1]!;
    socket.send(JSON.stringify(command('turn.persisted', { turnId: (second.payload as Record<string, unknown>).turnId, finalEventId: second.eventId, persistedEpoch: second.epoch })));
    await waitFor(messages, 'reasoning.final');
    capture(2);
    await waitForWhere(messages, message => message.type === 'transcript.final' && message.epoch === 1);
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
    socket.send(JSON.stringify(command('turn.persisted', { turnId: (first.payload as Record<string, unknown>).turnId, finalEventId: first.eventId, persistedEpoch: first.epoch }, 0)));
    await expect(closed).resolves.toBe(1008);
  });

  it('closes the owned sidecar stream when the authenticated browser disconnects', async () => {
    let resolveClosed!: () => void;
    const sidecarClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const sidecar = await fakeAudio({ onStreamClose: resolveClosed });
    const app = await buildApp({ sidecar, pi });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }); app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    await new Promise<void>(resolve => { socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability }))); socket.once('message', () => resolve()); });
    socket.send(JSON.stringify(command('session.start', { sessionSeed: seed, reasoningMode: 'full' })));
    socket.send(JSON.stringify(command('audio.start', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })));
    await new Promise(resolve => setTimeout(resolve, 20));
    socket.close();
    await expect(sidecarClosed).resolves.toBeUndefined();
  });

  it('proves deterministic progressive speech: first-sentence PCM reaches the browser while Pi final is blocked', async () => {
    const releases: Array<() => void> = [];
    const piInputs: Array<{ boundedContext: string }> = [];
    const controlledPi: PiClient = {
      async probe() { return { status: 'ready', detail: 'Pi is ready.', correctiveAction: 'None.' }; },
      async *request(input: PiRequestInput, _signal: AbortSignal) {
        piInputs.push({ boundedContext: input.boundedContext });
        yield { type: 'delta' as const, text: 'First sentence. S' };
        await new Promise<void>(resolve => releases.push(resolve));
        yield { type: 'delta' as const, text: 'econd sentence.' };
        yield { type: 'final' as const, text: 'First sentence. Second sentence.' };
      },
      async shutdown() {},
    };
    const sidecar = await fakeAudio({ progressiveTts: true, multiUtterance: true });
    const app = await buildApp({ sidecar, pi: controlledPi });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }); app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<Record<string, unknown>> = [];
    const binary: Buffer[] = [];
    socket.on('message', (raw, isBinary) => { if (isBinary) binary.push(Buffer.from(raw as Buffer)); else messages.push(JSON.parse(raw.toString())); });
    await new Promise<void>(resolve => { socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability }))); socket.once('message', () => resolve()); });
    socket.send(JSON.stringify(command('session.start', { sessionSeed: seed, reasoningMode: 'full' })));
    socket.send(JSON.stringify(command('audio.start', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })));
    socket.send(encodeBinaryAudioFrame({ channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) }, 64 * 1024));
    const final = await waitFor(messages, 'transcript.final');
    const finalPayload = final.payload as Record<string, unknown>;
    socket.send(JSON.stringify(command('turn.persisted', { turnId: finalPayload.turnId, finalEventId: final.eventId, persistedEpoch: final.epoch })));

    // Pi final is blocked after "First sentence. S". Prove early identity, early
    // tts.started, and at least one browser-bound PCM frame with no reasoning.final.
    await waitFor(messages, 'reasoning.started');
    await waitFor(messages, 'tts.started');
    await waitForWhere(messages, () => binary.length >= 1);
    expect(messages.some(message => message.type === 'reasoning.final')).toBe(false);
    expect(messages.some(message => message.type === 'tts.ended')).toBe(false);
    const reasoningStarted = messages.find(message => message.type === 'reasoning.started')!;
    const ttsStarted = messages.find(message => message.type === 'tts.started')!;
    expect((reasoningStarted.payload as Record<string, unknown>).responseId).toBe((ttsStarted.payload as Record<string, unknown>).responseId);
    expect((ttsStarted.payload as Record<string, unknown>).playbackId).toBe(playbackId);
    expect(messages.filter(message => message.type === 'reasoning.started')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'tts.started')).toHaveLength(1);

    // Release the blocked final.
    releases[0]!();
    await waitFor(messages, 'reasoning.final');
    await waitFor(messages, 'tts.ended');
    await waitForWhere(messages, () => binary.length === 2);
    const ended = messages.find(message => message.type === 'tts.ended')!;
    expect((ended.payload as Record<string, unknown>).generatedSamples).toBe(960);
    expect((ended.payload as Record<string, unknown>).playbackId).toBe(playbackId);
    expect((messages.find(message => message.type === 'reasoning.final')!.payload as Record<string, unknown>).text).toBe('First sentence. Second sentence.');

    // Authoritative browser terminal receipt commits assistant context for the next turn.
    socket.send(JSON.stringify(command('playback.progress', { playbackId, outputEpoch: 0, playedSampleOffset: 960, generatedSamples: 960 })));
    socket.send(JSON.stringify(command('playback.stopped', { playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: 960, reason: 'completed' })));
    socket.send(encodeBinaryAudioFrame({ channel: 1, streamId: 7, sequence: 1, monotonicUs: 4n, pcm16: new Int16Array(320) }, 64 * 1024));
    await waitForWhere(messages, () => messages.filter(message => message.type === 'transcript.final').length >= 2);
    const secondFinal = messages.filter(message => message.type === 'transcript.final')[1]!;
    const secondPayload = secondFinal.payload as Record<string, unknown>;
    socket.send(JSON.stringify(command('turn.persisted', { turnId: secondPayload.turnId, finalEventId: secondFinal.eventId, persistedEpoch: secondFinal.epoch })));
    await waitForWhere(messages, () => messages.filter(message => message.type === 'reasoning.started').length >= 2);
    expect(piInputs[1]!.boundedContext).toContain('First sentence. Second sentence.');
    socket.close();
  });

  it('holds a stable final until the exact durable acknowledgement', async () => {
    const sidecar = await fakeAudio();
    const app = await buildApp({ sidecar, pi });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }); app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw.toString())); });
    await new Promise<void>(resolve => { socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability }))); socket.once('message', () => resolve()); });
    socket.send(JSON.stringify(command('session.start', { sessionSeed: seed, reasoningMode: 'full' })));
    socket.send(JSON.stringify(command('audio.start', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })));
    socket.send(encodeBinaryAudioFrame({ channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) }, 64 * 1024));
    const final = await waitFor(messages, 'transcript.final');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(messages.some(message => message.type === 'policy.decision')).toBe(false);
    const payload = final.payload as Record<string, unknown>;
    const acknowledgement = { turnId: payload.turnId, finalEventId: final.eventId, persistedEpoch: final.epoch };
    socket.send(JSON.stringify(command('turn.persisted', acknowledgement)));
    expect((await waitFor(messages, 'policy.decision')).type).toBe('policy.decision');

    // A retried exact acknowledgement is a no-op even after downstream work began.
    socket.send(JSON.stringify(command('turn.persisted', acknowledgement)));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(messages.filter(message => message.type === 'policy.decision')).toHaveLength(1);

    // Cancelling the current assistant turn advances once and returns to listening.
    socket.send(JSON.stringify(command('turn.cancel', { reason: 'user' })));
    const listening = await waitForWhere(messages, message => message.type === 'session.state' && message.epoch === 1 && (message.payload as Record<string, unknown>).phase === 'listening');
    expect(listening.type).toBe('session.state');
    expect(socket.readyState).toBe(WebSocket.OPEN);

    // Reusing the completed final identity with mismatched fields fails closed.
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
    socket.send(JSON.stringify(command('turn.persisted', { ...acknowledgement, turnId: seed }, 0)));
    await expect(closed).resolves.toBe(1008);
  });
});
