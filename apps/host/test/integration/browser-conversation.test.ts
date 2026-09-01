import { createServer } from 'node:http';
import { encodeBinaryAudioFrame } from '@app/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { PiClient, PiRequestInput } from '../../src/pi/PiClient.js';
import type { PiResearchClient } from '../../src/pi/PiResearchClient.js';
import { buildApp } from '../../src/server/app.js';
import type { SidecarProcess } from '../../src/sidecar/process.js';

type TestJsonValue = null | boolean | number | string | TestJsonValue[] | { [key: string]: TestJsonValue };
type TestPayload = { [key: string]: TestJsonValue };

const sessionId = '018f1f32-7abc-7def-8abc-0123456789ab';
const seed = '018f1f32-7abd-7def-8abc-0123456789ab';
const utteranceId = '018f1f32-7abe-7def-8abc-0123456789ab';
const playbackId = '018f1f32-7ac0-7def-8abc-0123456789ab';
let sequence = 0;
function command(type: string, payload: TestPayload, epoch = 0) {
  const suffix = (0x1000 + sequence++).toString(16).padStart(12, '0');
  return {
    protocolVersion: 1,
    sessionId,
    epoch,
    eventId: `018f1f32-7abf-7def-8abc-${suffix}`,
    type,
    monotonicMs: sequence,
    payload,
  };
}
const pi: PiClient = {
  async probe() {
    return { status: 'ready', detail: 'Pi is ready.', correctiveAction: 'None.' };
  },
  async *request() {
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    yield { type: 'delta' as const, text: 'A concise response.' };
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    yield { type: 'final' as const, text: 'A concise response.' };
  },
  async shutdown() {},
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fakeAudio(
  options: {
    tts?: boolean;
    progressiveTts?: boolean;
    multiUtterance?: boolean;
    multipart?: boolean;
    failMidTurn?: boolean;
    transcript?: string;
    onStreamClose?: () => void;
  } = {},
): Promise<SidecarProcess> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || !('port' in address)) throw new Error('missing address');
  wss.on('connection', (socket) => {
    let opened = '';
    let utteranceSequence = 0;
    let activeUtterance = utteranceId;
    let progressiveStarted = false;
    socket.send(
      JSON.stringify({
        type: 'readiness.snapshot',
        payload: {
          status: 'ready',
          stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1',
          tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1',
          voiceCatalog: {
            catalogId: 'sess-catalog',
            backendId: 'kokoro',
            modelId: 'kokoro-82m-onnx',
            runtimeConfigId: 'rc',
            revision: 'rev',
            defaultVoiceId: 'af_heart',
            voices: [
              { id: 'af_heart', label: 'af_heart' },
              { id: 'af_bella', label: 'Bella' },
            ],
          },
        },
      }),
    );
    socket.on('message', (raw, binary) => {
      if (binary) {
        activeUtterance = options.multiUtterance
          ? `018f1f32-7abe-7def-8abc-${(0x123456789000 + utteranceSequence).toString(16)}`
          : utteranceId;
        socket.send(
          JSON.stringify({
            type: 'vad.speech_start',
            payload: { streamId: opened, utteranceId: activeUtterance, captureStartSequence: utteranceSequence },
          }),
        );
        utteranceSequence++;
        return;
      }
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      const message = JSON.parse(raw.toString()) as { type: string; payload: TestPayload };
      if (message.type === 'stream.open') {
        opened = String(message.payload.streamId);
        socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: opened } }));
        if (options.failMidTurn)
          setTimeout(() => {
            socket.send(
              JSON.stringify({ type: 'sidecar.failure', payload: { code: 'runtime_unavailable', recoverable: true } }),
            );
          }, 10);
      } else if (message.type === 'stt.bind_epoch') {
        const boundUtterance = String(message.payload.utteranceId);
        const transcript = options.transcript ?? 'Could you share what you think about this complete idea?';
        socket.send(
          JSON.stringify({
            type: 'vad.speech_end',
            payload: {
              streamId: opened,
              utteranceId: boundUtterance,
              captureStartSequence: utteranceSequence - 1,
              captureEndSequence: utteranceSequence - 1,
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'stt.partial',
            payload: {
              streamId: opened,
              utteranceId: boundUtterance,
              epoch: message.payload.epoch,
              sequence: 0,
              text: 'Could you share',
              replacedCharacters: 0,
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'stt.final',
            payload: {
              streamId: opened,
              utteranceId: boundUtterance,
              epoch: message.payload.epoch,
              text: transcript,
              endpointComplete: true,
            },
          }),
        );
      } else if (message.type === 'stream.close') {
        options.onStreamClose?.();
      } else if (message.type === 'tts.open' && options.multipart) {
        // Multi-part: assign per-part playback/output stream ids by partIndex.
        const partIndex = Number(message.payload.partIndex ?? 0);
        const partPlaybackId = partIndex === 0 ? playbackId : '018f1f32-7ac4-7def-8abc-0123456789ab';
        const outputStreamId = 55 + partIndex;
        socket.send(
          JSON.stringify({
            type: 'tts.started',
            payload: {
              streamId: opened,
              responseId: message.payload.responseId,
              epoch: message.payload.epoch,
              playbackId: partPlaybackId,
              outputStreamId,
              sampleRate: 24000,
              voiceId: 'af_heart',
              partIndex,
            },
          }),
        );
        socket.send(
          encodeBinaryAudioFrame(
            { channel: 2, streamId: outputStreamId, sequence: 0, monotonicUs: 2n, pcm16: new Int16Array(480) },
            64 * 1024,
          ),
        );
      } else if (message.type === 'tts.append' && options.multipart) {
        const partIndex = Number(message.payload.partIndex ?? 0);
        socket.send(
          encodeBinaryAudioFrame(
            { channel: 2, streamId: 55 + partIndex, sequence: 1, monotonicUs: 3n, pcm16: new Int16Array(480) },
            64 * 1024,
          ),
        );
      } else if (message.type === 'tts.commit' && options.multipart) {
        const partIndex = Number(message.payload.partIndex ?? 0);
        socket.send(
          JSON.stringify({
            type: 'tts.ended',
            payload: {
              streamId: opened,
              responseId: message.payload.responseId,
              epoch: message.payload.epoch,
              playbackId: partIndex === 0 ? playbackId : '018f1f32-7ac4-7def-8abc-0123456789ab',
              generatedSamples: 960,
              partIndex,
            },
          }),
        );
      } else if (message.type === 'tts.open' || message.type === 'tts.append') {
        if (options.progressiveTts && message.type === 'tts.append' && !progressiveStarted) {
          // Progressive synthesis: first append starts playback immediately, before commit/final.
          progressiveStarted = true;
          socket.send(
            JSON.stringify({
              type: 'tts.started',
              payload: {
                streamId: opened,
                responseId: message.payload.responseId,
                epoch: message.payload.epoch,
                playbackId,
                outputStreamId: 55,
                sampleRate: 24000,
                voiceId: 'af_heart',
              },
            }),
          );
          socket.send(
            encodeBinaryAudioFrame(
              { channel: 2, streamId: 55, sequence: 0, monotonicUs: 2n, pcm16: new Int16Array(480) },
              64 * 1024,
            ),
          );
        }
        // Progressive TTS: open/appends are acked silently, commit triggers the remainder
      } else if (message.type === 'tts.commit' && options.progressiveTts) {
        socket.send(
          encodeBinaryAudioFrame(
            { channel: 2, streamId: 55, sequence: 1, monotonicUs: 3n, pcm16: new Int16Array(480) },
            64 * 1024,
          ),
        );
        socket.send(
          JSON.stringify({
            type: 'tts.ended',
            payload: {
              streamId: opened,
              responseId: message.payload.responseId,
              epoch: message.payload.epoch,
              playbackId,
              generatedSamples: 960,
            },
          }),
        );
      } else if ((message.type === 'tts.request' || message.type === 'tts.commit') && options.tts) {
        socket.send(
          JSON.stringify({
            type: 'tts.started',
            payload: {
              streamId: opened,
              responseId: message.payload.responseId,
              epoch: message.payload.epoch,
              playbackId,
              outputStreamId: 55,
              sampleRate: 24000,
              voiceId: 'af_heart',
            },
          }),
        );
        socket.send(
          encodeBinaryAudioFrame(
            { channel: 2, streamId: 55, sequence: 0, monotonicUs: 2n, pcm16: new Int16Array(480) },
            64 * 1024,
          ),
        );
        setTimeout(() => {
          socket.send(
            encodeBinaryAudioFrame(
              { channel: 2, streamId: 55, sequence: 1, monotonicUs: 3n, pcm16: new Int16Array(480) },
              64 * 1024,
            ),
          );
          socket.send(
            JSON.stringify({
              type: 'tts.ended',
              payload: {
                streamId: opened,
                responseId: message.payload.responseId,
                epoch: message.payload.epoch,
                playbackId,
                generatedSamples: 960,
              },
            }),
          );
        }, 5);
      }
    });
  });
  const close = async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(close);
  return {
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    child: {} as SidecarProcess['child'],
    origin: `http://127.0.0.1:${address.port}`,
    secret: 'sidecar-secret',
    stop: close,
  };
}

async function bootstrap(app: FastifyInstance, origin: string) {
  const headers = { host: new URL(origin).host, origin, 'content-type': 'application/json' };
  const response = await fetch(`${origin}/api/bootstrap`, {
    method: 'POST',
    headers,
    body: '{"disclosureAcknowledged":true}',
  });
  // SAFETY: this test fixture is constructed in this file with the asserted shape.
  const body = (await response.json()) as { capability: string };
  return { body, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}
function waitFor(messages: Array<TestPayload>, type: string): Promise<TestPayload> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const timer = setInterval(() => {
      const found = messages.find((message) => message.type === type);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`missing ${type}`));
      }
    }, 5);
  });
}
function waitForWhere(
  messages: Array<TestPayload>,
  predicate: (message: TestPayload) => boolean,
): Promise<TestPayload> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('missing matching message'));
      }
    }, 5);
  });
}

async function fakeBoundedAudio(): Promise<SidecarProcess> {
  // Enforces the real sidecar bound: at most two nonterminal progressive TTS
  // streams. A third tts.open is a protocol violation (sidecar.failure), which
  // the client-side admission gate must never trigger. tts.ended arrives ~30ms
  // after commit (synthesis duration), so streams hold their slot briefly.
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || !('port' in address)) throw new Error('missing address');
  wss.on('connection', (socket) => {
    let opened = '';
    const nonterminal = new Map<number, { responseId: string; epoch: number }>();
    const sentSeq1 = new Set<number>();
    let utteranceSequence = 0;
    socket.send(
      JSON.stringify({
        type: 'readiness.snapshot',
        payload: {
          status: 'ready',
          stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1',
          tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1',
          voiceCatalog: {
            catalogId: 'sess-catalog',
            backendId: 'kokoro',
            modelId: 'kokoro-82m-onnx',
            runtimeConfigId: 'rc',
            revision: 'rev',
            defaultVoiceId: 'af_heart',
            voices: [
              { id: 'af_heart', label: 'af_heart' },
              { id: 'af_bella', label: 'Bella' },
            ],
          },
        },
      }),
    );
    socket.on('message', (raw, binary) => {
      if (binary) {
        socket.send(
          JSON.stringify({
            type: 'vad.speech_start',
            payload: { streamId: opened, utteranceId, captureStartSequence: utteranceSequence },
          }),
        );
        utteranceSequence++;
        return;
      }
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      const message = JSON.parse(raw.toString()) as { type: string; payload: TestPayload };
      if (message.type === 'stream.open') {
        opened = String(message.payload.streamId);
        socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: opened } }));
      } else if (message.type === 'stt.bind_epoch') {
        socket.send(
          JSON.stringify({
            type: 'vad.speech_end',
            payload: {
              streamId: opened,
              utteranceId,
              captureStartSequence: utteranceSequence - 1,
              captureEndSequence: utteranceSequence - 1,
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'stt.partial',
            payload: {
              streamId: opened,
              utteranceId,
              epoch: message.payload.epoch,
              sequence: 0,
              text: 'Could you share',
              replacedCharacters: 0,
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'stt.final',
            payload: {
              streamId: opened,
              utteranceId,
              epoch: message.payload.epoch,
              text: 'Could you share what you think about this complete idea?',
              endpointComplete: true,
            },
          }),
        );
      } else if (message.type === 'tts.open') {
        const partIndex = Number(message.payload.partIndex ?? 0);
        if (nonterminal.size >= 2) {
          socket.send(
            JSON.stringify({ type: 'sidecar.failure', payload: { code: 'runtime_poisoned', recoverable: false } }),
          );
          return;
        }
        const responseId = String(message.payload.responseId);
        const epoch = Number(message.payload.epoch);
        nonterminal.set(partIndex, { responseId, epoch });
        socket.send(
          JSON.stringify({
            type: 'tts.started',
            payload: {
              streamId: opened,
              responseId,
              epoch,
              playbackId,
              outputStreamId: 55 + partIndex,
              sampleRate: 24000,
              voiceId: 'af_heart',
              partIndex,
            },
          }),
        );
        socket.send(
          encodeBinaryAudioFrame(
            { channel: 2, streamId: 55 + partIndex, sequence: 0, monotonicUs: 2n, pcm16: new Int16Array(480) },
            64 * 1024,
          ),
        );
      } else if (message.type === 'tts.append') {
        const partIndex = Number(message.payload.partIndex ?? 0);
        if (!sentSeq1.has(partIndex)) {
          sentSeq1.add(partIndex);
          socket.send(
            encodeBinaryAudioFrame(
              { channel: 2, streamId: 55 + partIndex, sequence: 1, monotonicUs: 3n, pcm16: new Int16Array(480) },
              64 * 1024,
            ),
          );
        }
      } else if (message.type === 'tts.commit') {
        const partIndex = Number(message.payload.partIndex ?? 0);
        const entry = nonterminal.get(partIndex);
        if (!entry) return;
        setTimeout(() => {
          nonterminal.delete(partIndex);
          socket.send(
            JSON.stringify({
              type: 'tts.ended',
              payload: {
                streamId: opened,
                responseId: entry.responseId,
                epoch: entry.epoch,
                playbackId,
                generatedSamples: 960,
                partIndex,
              },
            }),
          );
        }, 30);
      }
    });
  });
  const close = async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(close);
  return {
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    child: {} as SidecarProcess['child'],
    origin: `http://127.0.0.1:${address.port}`,
    secret: 'sidecar-secret',
    stop: close,
  };
}

describe('browser conversation routing', () => {
  it('reattaches a live conversation after a transient browser disconnect', async () => {
    const sidecar = await fakeAudio();
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: false,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const url = origin.replace('http', 'ws') + '/ws';
    const first = new WebSocket(url, { headers: { Origin: origin, Cookie: cookie } });
    await new Promise<void>((resolve) => {
      first.once('open', () => first.send(JSON.stringify({ capability: body.capability })));
      first.once('message', () => resolve());
    });
    first.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    first.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstClosed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    first.close();
    await firstClosed;

    const second = new WebSocket(url, { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    second.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      second.once('open', () => second.send(JSON.stringify({ capability: body.capability })));
      second.once('message', () => resolve());
    });
    second.send(
      JSON.stringify(command('audio.start', { streamId: 8, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    second.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 8, sequence: 0, monotonicUs: 2n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await expect(waitFor(messages, 'vad.speech_start')).resolves.toMatchObject({ type: 'vad.speech_start' });
    second.close();
  });

  it('acknowledges duplicate begin and rolls an acknowledged begin back to retryable prelive', async () => {
    let closes = 0;
    const sidecar = await fakeAudio({ onStreamClose: () => closes++ });
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    const begin = () =>
      socket.send(
        JSON.stringify(
          command('session.begin', {
            streamId: 7,
            sampleRate: 16000,
            channels: 1,
            frameSamples: 320,
          }),
        ),
      );
    begin();
    await waitForWhere(
      messages,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (message) => message.type === 'session.state' && (message.payload as { phase?: string }).phase === 'listening',
    );

    // The acknowledged retransmission must leave the same socket usable.
    begin();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await expect(waitFor(messages, 'vad.speech_start')).resolves.toMatchObject({ type: 'vad.speech_start' });

    // Simulate browser setup failing after it received begin's live acknowledgement.
    socket.send(JSON.stringify(command('session.rollback_begin', {})));
    await waitForWhere(
      messages,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (message) => message.type === 'session.state' && (message.payload as { phase?: string }).phase === 'prelive',
    );
    await waitForWhere(messages, () => closes === 1);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    begin();
    await waitForWhere(
      messages,
      () =>
        messages.filter(
          (message) =>
            // SAFETY: this test fixture is constructed in this file with the asserted shape.
            message.type === 'session.state' && (message.payload as { phase?: string }).phase === 'listening',
        ).length === 2,
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await waitForWhere(messages, () => messages.filter((message) => message.type === 'vad.speech_start').length === 2);
    socket.close();
  });

  it('explicitly opts out of multipart and uses single-part TTS accounting', async () => {
    const sidecar = await fakeAudio({ tts: true });
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: false,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    const binary: Buffer[] = [];
    socket.on('message', (raw, isBinary) => {
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      // SAFETY: ws supplies Buffer data for binary message callbacks.
      const binaryRaw = raw as Buffer;
      if (isBinary) binary.push(Buffer.from(binaryRaw));
      else messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const speechStart = await waitFor(messages, 'vad.speech_start');
    const speechEnd = await waitFor(messages, 'vad.speech_end');
    expect(speechStart.payload).toEqual({ streamId: expect.any(String), utteranceId, captureStartSequence: 0 });
    expect(speechEnd.payload).toEqual({
      streamId: expect.any(String),
      utteranceId,
      captureStartSequence: 0,
      captureEndSequence: 0,
    });
    expect(speechStart.epoch).toBe(0);
    const final = await waitFor(messages, 'transcript.final');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const finalPayload = final.payload as TestPayload;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          turnId: finalPayload.turnId,
          finalEventId: final.eventId,
          persistedEpoch: final.epoch,
        }),
      ),
    );
    const started = await waitFor(messages, 'tts.started');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((started.payload as TestPayload).playbackId).toBe(playbackId);
    await waitFor(messages, 'tts.ended');
    await waitForWhere(messages, () => binary.length === 2);
    socket.send(
      JSON.stringify(
        command('playback.progress', { playbackId, outputEpoch: 0, playedSampleOffset: 960, generatedSamples: 960 }),
      ),
    );
    socket.send(
      JSON.stringify(
        command('playback.stopped', {
          playbackId,
          cancelledEpoch: 0,
          finalPlayedSampleOffset: 960,
          reason: 'completed',
        }),
      ),
    );
    const listening = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).phase === 'listening',
    );
    expect(listening.epoch).toBe(0);
    expect(messages.filter((message) => message.type === 'policy.decision')).toHaveLength(1);
    expect(messages.filter((message) => message.type === 'reasoning.final')).toHaveLength(1);
    expect(
      messages.filter((message) => message.type === 'response.part_started' || message.type === 'response.part_final'),
    ).toHaveLength(0);
    socket.close();
  });

  it.skip('uses multipart research by default and emits per-part events', async () => {
    const sidecar = await fakeAudio({ multipart: true });
    const researchCalls: unknown[] = [];
    const researchPi: PiResearchClient = {
      async *requestBody(input) {
        researchCalls.push(input);
        input.onToolActivity?.({
          toolCallId: 'tool-1',
          toolName: 'web_search',
          status: 'started',
          summary: 'research-backed topics',
        });
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text: 'Research-backed response.' };
        input.onToolActivity?.({ toolCallId: 'tool-1', toolName: 'web_search', status: 'ended', durationMs: 21 });
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text: 'Research-backed response.' };
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      createResponseClient: () => pi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const final = await waitFor(messages, 'transcript.final');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const finalPayload = final.payload as TestPayload;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          turnId: finalPayload.turnId,
          finalEventId: final.eventId,
          persistedEpoch: final.epoch,
        }),
      ),
    );
    const stallStarted = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'response.part_started' && (message.payload as TestPayload).partIndex === 0,
    );
    const stallTts = await waitForWhere(
      messages,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (message) => message.type === 'tts.started' && (message.payload as TestPayload).partIndex === 0,
    );
    const bodyStarted = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'response.part_started' && (message.payload as TestPayload).partIndex === 1,
    );
    const bodyTts = await waitForWhere(
      messages,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (message) => message.type === 'tts.started' && (message.payload as TestPayload).partIndex === 1,
    );

    expect(researchCalls).toHaveLength(1);
    const toolActivity = messages.filter((message) => message.type === 'tool.activity');
    expect(toolActivity).toHaveLength(2);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const partResponseId = (stallStarted.payload as TestPayload).responseId;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const partTurnId = (stallStarted.payload as TestPayload).turnId;
    expect(toolActivity[0]?.payload).toEqual({
      scope: 'turn',
      turnId: partTurnId,
      responseId: partResponseId,
      toolCallId: 'tool-1',
      toolName: 'web_search',
      status: 'started',
      summary: 'research-backed topics',
    });
    expect(toolActivity[1]?.payload).toMatchObject({
      scope: 'turn',
      responseId: partResponseId,
      toolCallId: 'tool-1',
      status: 'ended',
      durationMs: 21,
    });
    expect(messages.filter((message) => message.type === 'response.part_started')).toHaveLength(2);
    expect(messages.filter((message) => message.type === 'response.part_final')).toHaveLength(2);
    expect(messages.filter((message) => message.type === 'reasoning.final')).toHaveLength(2);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((stallStarted.payload as TestPayload).kind).toBe('stall');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((bodyStarted.payload as TestPayload).kind).toBe('body');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((stallTts.payload as TestPayload).responseId).toBe(
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (bodyTts.payload as TestPayload).responseId,
    );
    for (const started of [stallTts, bodyTts]) {
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      const payload = started.payload as TestPayload;
      socket.send(
        JSON.stringify(
          command('playback.stopped', {
            playbackId: payload.playbackId,
            cancelledEpoch: 0,
            finalPlayedSampleOffset: 960,
            reason: 'completed',
          }),
        ),
      );
    }
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).phase === 'listening',
    );
    socket.close();
  });

  it('runs optional pre-live planning before opening audio and injects only bounded notes into live reasoning', async () => {
    const sidecar = await fakeAudio();
    const researchCalls: Array<{ topic: string; depth: string }> = [];
    const responseInputs: PiRequestInput[] = [];
    const responsePi: PiClient = {
      async probe() {
        return { status: 'ready', detail: 'Pi is ready.', correctiveAction: 'None.' };
      },
      request(input, signal) {
        responseInputs.push(input);
        return pi.request(input, signal);
      },
      async shutdown() {},
    };
    const researchPi: PiResearchClient = {
      async *requestBody(input) {
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        responseInputs.push(input as PiRequestInput);
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text: 'A researched observation.' };
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text: 'A researched observation.' };
      },
      async *requestPlan(input) {
        researchCalls.push({ topic: input.topic, depth: input.depth });
        input.onToolActivity?.({
          toolCallId: 'tool-9',
          toolName: 'web_search',
          status: 'started',
          summary: 'future of local radio',
        });
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text: 'PRIVATE_TOOL_TRACE' };
        input.onToolActivity?.({ toolCallId: 'tool-9', toolName: 'web_search', status: 'ended', durationMs: 17 });
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text: 'Useful facts\nTalking points: ask about local radio.' };
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => responsePi,
      createResponseClient: () => responsePi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => responsePi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          planning: { topic: 'The future of local radio', depth: 'standard' },
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    await waitForWhere(
      messages,
      (message) =>
        message.type === 'session.state' &&
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        (message.payload as TestPayload).planning &&
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        (message.payload as TestPayload).planning.status === 'planning',
    );
    expect(messages.some((message) => message.type === 'vad.speech_start')).toBe(false);
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'ready',
    );
    expect(researchCalls).toEqual([{ topic: 'The future of local radio', depth: 'standard' }]);
    const planningActivity = messages.filter((message) => message.type === 'tool.activity');
    expect(planningActivity).toHaveLength(2);
    expect(planningActivity[0]?.payload).toEqual({
      scope: 'planning',
      toolCallId: 'tool-9',
      toolName: 'web_search',
      status: 'started',
      summary: 'future of local radio',
    });
    expect(planningActivity[1]?.payload).toMatchObject({
      scope: 'planning',
      toolCallId: 'tool-9',
      status: 'ended',
      durationMs: 17,
    });

    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const final = await waitFor(messages, 'transcript.final');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const finalPayload = final.payload as TestPayload;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          turnId: finalPayload.turnId,
          finalEventId: final.eventId,
          persistedEpoch: final.epoch,
        }),
      ),
    );
    await waitFor(messages, 'reasoning.started');
    expect(responseInputs[0]?.boundedContext).toContain('<session_preparation>');
    expect(responseInputs[0]?.boundedContext).toContain('Talking points: ask about local radio.');
    expect(responseInputs[0]?.boundedContext).not.toContain('PRIVATE_TOOL_TRACE');
    socket.close();
  });

  it('cancels pre-live planning through the fast control path and then permits a direct live begin', async () => {
    const sidecar = await fakeAudio();
    const researchPi: PiResearchClient = {
      async *requestBody() {},
      async *requestPlan(_input, signal) {
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text: 'private progress' };
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      createResponseClient: () => pi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          planning: { topic: 'A cancellable plan', depth: 'light' },
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'planning',
    );
    socket.send(JSON.stringify(command('planning.cancel', { reason: 'user' })));
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'cancelled',
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await expect(waitFor(messages, 'vad.speech_start')).resolves.toMatchObject({ type: 'vad.speech_start' });
    socket.close();
  });

  it('fails soft on planning provider errors and still permits a live begin', async () => {
    const sidecar = await fakeAudio();
    const researchPi: PiResearchClient = {
      async *requestBody() {},
      async *requestPlan() {
        yield {
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          type: 'error' as const,
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          state: 'unavailable' as const,
          detail: 'provider detail must stay private',
          correctiveAction: 'retry',
        };
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      createResponseClient: () => pi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          planning: { topic: 'A provider failure', depth: 'standard' },
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    const failed = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'failed',
    );
    expect(JSON.stringify(failed)).not.toContain('provider detail must stay private');
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await expect(waitFor(messages, 'vad.speech_start')).resolves.toMatchObject({ type: 'vad.speech_start' });
    socket.close();
  });

  it('keeps preparation pre-live: factual attempt/stage states, no percent, and no audio before session.begin', async () => {
    const sidecar = await fakeAudio();
    const researchPi: PiResearchClient = {
      async *requestBody() {},
      async *requestPlan(input) {
        input.onToolActivity?.({ toolCallId: 'tool-1', toolName: 'web_search', status: 'started' });
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text: 'private trace' };
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text: 'Notes: local radio facts.' };
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      createResponseClient: () => pi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          planning: { topic: 'A factual plan', depth: 'standard' },
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    const running = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'planning',
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const runningPlanning = (running.payload as TestPayload).planning;
    // Factual attempt/stage/deadline, no fabricated percentage.
    expect(runningPlanning.attempt).toBe(1);
    expect(['starting', 'researching', 'finalizing']).toContain(runningPlanning.stage);
    expect(runningPlanning.deadlineMs).toBe(60_000);
    expect(runningPlanning.progress).toBeUndefined();
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((running.payload as TestPayload).phase).toBe('preparing');
    // No audio engine, no listening, and no capture frames while preparing.
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect(messages.some((message) => message.type === 'session.state' && (message.payload as any).audio)).toBe(false);
    expect(
      messages.some(
        (message) =>
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          message.type === 'session.state' && ['listening', 'starting_live'].includes((message.payload as any).phase),
      ),
    ).toBe(false);
    const terminal = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'ready',
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((terminal.payload as TestPayload).phase).toBe('prelive');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((terminal.payload as TestPayload).planning.attempt).toBe(1);
    // Binary capture before session.begin is rejected by the protocol gate.
    const closed = new Promise<{ code: number }>((resolve) => socket.once('close', (code) => resolve({ code })));
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it('begin-without-preparation cancels a running plan and awaits its terminal cancellation before going live', async () => {
    const sidecar = await fakeAudio();
    const researchPi: PiResearchClient = {
      async *requestBody() {},
      async *requestPlan(_input, signal) {
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text: 'private trace' };
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      createResponseClient: () => pi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          planning: { topic: 'A cancellable live start', depth: 'light' },
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'planning',
    );
    // session.begin while preparation is running cancels first; the terminal
    // cancelled state must arrive before the audio engine opens.
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    const cancelled = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'cancelled',
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((cancelled.payload as TestPayload).planning.reasonCode).toBe('interrupted');
    const listening = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).phase === 'listening',
    );
    const cancelledIndex = messages.indexOf(cancelled);
    const listeningIndex = messages.indexOf(listening);
    expect(listeningIndex).toBeGreaterThan(cancelledIndex);
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await expect(waitFor(messages, 'vad.speech_start')).resolves.toMatchObject({ type: 'vad.speech_start' });
    socket.close();
  });

  // Audio config is fixed by the BrowserCommand schema, so noncanonical config
  // cannot reach the live mismatch branch through the browser protocol.
  it.each([
    ['epoch mismatch', 1, 7, 16000, 1, 320],
    ['stream ID mismatch', 0, 8, 16000, 1, 320],
  ])(
    'keeps the live stream usable after a non-fatal duplicate Begin with %s',
    async (_label, epoch, streamId, sampleRate, channels, frameSamples) => {
      const sidecar = await fakeAudio();
      const app = await buildApp({
        sidecar,
        createProbeClient: () => pi,
        createResponseClient: () => pi,
        createResearchClient: () => pi,
        createClassifierClient: () => pi,
      });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      app.setCanonicalOrigin(origin);
      cleanup.push(async () => app.close());
      const { body, cookie } = await bootstrap(app, origin);
      const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', {
        headers: { Origin: origin, Cookie: cookie },
      });
      const messages: Array<TestPayload> = [];
      socket.on('message', (raw, binary) => {
        if (!binary) messages.push(JSON.parse(raw.toString()));
      });
      await new Promise<void>((resolve) => {
        socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
        socket.once('message', () => resolve());
      });
      socket.send(
        JSON.stringify(
          command('session.open', {
            sessionSeed: seed,
            reasoningMode: 'full',
            settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
          }),
        ),
      );
      socket.send(
        JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
      );
      await waitForWhere(messages, (message) => message.type === 'session.state' && message.epoch === 0);

      socket.send(JSON.stringify(command('session.begin', { streamId, sampleRate, channels, frameSamples }, epoch)));
      await waitForWhere(
        messages,
        (message) =>
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          message.type === 'failure' && (message.payload as TestPayload).code === 'begin_mismatch',
      );
      expect(socket.readyState).toBe(WebSocket.OPEN);

      socket.send(
        encodeBinaryAudioFrame(
          { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
          64 * 1024,
        ),
      );
      await expect(waitFor(messages, 'transcript.final')).resolves.toMatchObject({ type: 'transcript.final' });
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    },
  );

  it('rejects session.begin before session.open and audio.start before session.begin (protocol gate)', async () => {
    const sidecar = await fakeAudio();
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    // session.begin without session.open is rejected by the host.
    const closed = new Promise<{ code: number }>((resolve) => socket.once('close', (code) => resolve({ code })));
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    await expect(closed).resolves.toMatchObject({ code: 1008 });

    // audio.start (reconnect-only) before session.begin is rejected too.
    const second = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    await new Promise<void>((resolve) => {
      second.once('open', () => second.send(JSON.stringify({ capability: body.capability })));
      second.once('message', () => resolve());
    });
    second.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    const secondClosed = new Promise<{ code: number }>((resolve) => second.once('close', (code) => resolve({ code })));
    second.send(
      JSON.stringify(command('audio.start', { streamId: 9, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    await expect(secondClosed).resolves.toMatchObject({ code: 1008 });
  });

  it('retries planning only after a terminal state and increments the attempt', async () => {
    const sidecar = await fakeAudio();
    let calls = 0;
    const researchPi: PiResearchClient = {
      async *requestBody() {},
      async *requestPlan() {
        calls++;
        if (calls === 1) throw new Error('provider unavailable');
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text: 'Notes: second attempt facts.' };
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      createResponseClient: () => pi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          planning: { topic: 'Retryable plan', depth: 'standard' },
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    const failed = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'failed',
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((failed.payload as TestPayload).planning.attempt).toBe(1);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((failed.payload as TestPayload).planning.reasonCode).toBe('provider_unavailable');
    socket.send(JSON.stringify(command('planning.retry', {})));
    const retried = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).planning?.status === 'ready',
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((retried.payload as TestPayload).planning.attempt).toBe(2);
    socket.close();
  });

  it('uses the frozen editable persona for policy decisions on the wire', async () => {
    const sidecar = await fakeAudio({ transcript: 'The weather changed overnight.' });
    const responseInputs: PiRequestInput[] = [];
    const personaAppends: string[] = [];
    const responsePi: PiClient = {
      async probe() {
        return { status: 'ready', detail: 'Pi is ready.', correctiveAction: 'None.' };
      },
      request(input, signal) {
        responseInputs.push(input);
        return pi.request(input, signal);
      },
      async shutdown() {},
    };
    const persona =
      '---\nversion: 1\nname: Invite-only companion\ninvitation_only: true\n---\nWait for a direct invitation.';
    const app = await buildApp({
      sidecar,
      createProbeClient: () => responsePi,
      createResponseClient: (append) => {
        personaAppends.push(append);
        return responsePi;
      },
      createResearchClient: () => responsePi,
      createClassifierClient: () => responsePi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona, voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const final = await waitFor(messages, 'transcript.final');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const finalPayload = final.payload as TestPayload;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          turnId: finalPayload.turnId,
          finalEventId: final.eventId,
          persistedEpoch: final.epoch,
        }),
      ),
    );
    const decision = await waitFor(messages, 'policy.decision');
    expect(decision.payload).toMatchObject({
      eligible: false,
      posture: 'silence',
      reasonCodes: ['invitation_required'],
    });
    expect(responseInputs).toEqual([]);
    expect(personaAppends[0]).toContain('Invite-only companion');
    expect(messages.some((message) => message.type === 'reasoning.started')).toBe(false);
    socket.close();
  });

  it('degrades on persistence failure, permits bounded retry, and rejects acknowledgement after Stop', async () => {
    const sidecar = await fakeAudio();
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: false,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const final = await waitFor(messages, 'transcript.final');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const payload = final.payload as TestPayload;
    const acknowledgement = { turnId: payload.turnId, finalEventId: final.eventId, persistedEpoch: final.epoch };
    socket.send(JSON.stringify(command('turn.persistence_failed', { ...acknowledgement, reasonCode: 'quota' })));
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'failure' && (message.payload as TestPayload).code === 'stable_turn_not_persisted',
    );
    expect(messages.some((message) => message.type === 'policy.decision')).toBe(false);
    socket.send(JSON.stringify(command('turn.persisted', acknowledgement)));
    await waitFor(messages, 'policy.decision');
    socket.send(JSON.stringify(command('session.stop', { reason: 'user' })));
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(JSON.stringify(command('turn.persisted', acknowledgement)));
    await expect(closed).resolves.toBe(1008);
  });

  it('rejects a persistence acknowledgement made stale by an interrupting utterance', async () => {
    const sidecar = await fakeAudio({ multiUtterance: true });
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: false,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    const capture = (captureSequence: number) =>
      socket.send(
        encodeBinaryAudioFrame(
          {
            channel: 1,
            streamId: 7,
            sequence: captureSequence,
            monotonicUs: BigInt(captureSequence + 1),
            pcm16: new Int16Array(320),
          },
          64 * 1024,
        ),
      );
    capture(0);
    await waitForWhere(messages, (message) => message.type === 'transcript.final');
    capture(1);
    await waitForWhere(messages, () => messages.filter((message) => message.type === 'transcript.final').length >= 2);
    const finals = messages.filter((message) => message.type === 'transcript.final');
    const first = finals[0]!;
    const second = finals[1]!;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          turnId: (second.payload as TestPayload).turnId,
          finalEventId: second.eventId,
          persistedEpoch: second.epoch,
        }),
      ),
    );
    await waitFor(messages, 'reasoning.final');
    capture(2);
    await waitForWhere(
      messages,
      () => messages.filter((candidate) => candidate.type === 'transcript.final').length >= 3,
    );
    const third = messages.filter((message) => message.type === 'transcript.final').at(-1)!;
    // Speech-start no longer cancels a response before we know whether the
    // utterance is real speech or background noise. Once the stable final is
    // acknowledged, the meaningful takeover advances the epoch and makes the
    // older first acknowledgement stale.
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          turnId: (third.payload as TestPayload).turnId,
          finalEventId: third.eventId,
          persistedEpoch: third.epoch,
        }),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(
      JSON.stringify(
        command(
          'turn.persisted',
          {
            // SAFETY: this test fixture is constructed in this file with the asserted shape.
            turnId: (first.payload as TestPayload).turnId,
            finalEventId: first.eventId,
            persistedEpoch: first.epoch,
          },
          0,
        ),
      ),
    );
    await expect(closed).resolves.toBe(1008);
  });

  it('closes the owned sidecar stream when the authenticated browser disconnects', async () => {
    let resolveClosed!: () => void;
    const sidecarClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const sidecar = await fakeAudio({ onStreamClose: resolveClosed });
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: false,
      sessionDisconnectGraceMs: 0,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.close();
    await expect(sidecarClosed).resolves.toBeUndefined();
  });

  it('proves deterministic progressive speech: first-sentence PCM reaches the browser while Pi final is blocked', async () => {
    const releases: Array<() => void> = [];
    const piInputs: Array<{ boundedContext: string }> = [];
    const controlledPi: PiClient = {
      async probe() {
        return { status: 'ready', detail: 'Pi is ready.', correctiveAction: 'None.' };
      },
      async *request(input: PiRequestInput, _signal: AbortSignal) {
        piInputs.push({ boundedContext: input.boundedContext });
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text: 'First sentence. S' };
        await new Promise<void>((resolve) => releases.push(resolve));
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text: 'econd sentence.' };
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text: 'First sentence. Second sentence.' };
      },
      async shutdown() {},
    };
    const sidecar = await fakeAudio({ progressiveTts: true, multiUtterance: true });
    const app = await buildApp({
      sidecar,
      createProbeClient: () => controlledPi,
      multiPartEnabled: false,
      createResponseClient: () => controlledPi,
      createResearchClient: () => controlledPi,
      createClassifierClient: () => controlledPi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    const binary: Buffer[] = [];
    socket.on('message', (raw, isBinary) => {
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      // SAFETY: ws supplies Buffer data for binary message callbacks.
      const binaryRaw = raw as Buffer;
      if (isBinary) binary.push(Buffer.from(binaryRaw));
      else messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const final = await waitFor(messages, 'transcript.final');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const finalPayload = final.payload as TestPayload;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          turnId: finalPayload.turnId,
          finalEventId: final.eventId,
          persistedEpoch: final.epoch,
        }),
      ),
    );

    // Pi final is blocked after "First sentence. S". Prove early identity, early
    // tts.started, and at least one browser-bound PCM frame with no reasoning.final.
    await waitFor(messages, 'reasoning.started');
    await waitFor(messages, 'tts.started');
    await waitForWhere(messages, () => binary.length >= 1);
    expect(messages.some((message) => message.type === 'reasoning.final')).toBe(false);
    expect(messages.some((message) => message.type === 'tts.ended')).toBe(false);
    const reasoningStarted = messages.find((message) => message.type === 'reasoning.started')!;
    const ttsStarted = messages.find((message) => message.type === 'tts.started')!;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((reasoningStarted.payload as TestPayload).responseId).toBe(
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (ttsStarted.payload as TestPayload).responseId,
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((ttsStarted.payload as TestPayload).playbackId).toBe(playbackId);
    expect(messages.filter((message) => message.type === 'reasoning.started')).toHaveLength(1);
    expect(messages.filter((message) => message.type === 'tts.started')).toHaveLength(1);

    // Release the blocked final.
    releases[0]!();
    await waitFor(messages, 'reasoning.final');
    await waitFor(messages, 'tts.ended');
    await waitForWhere(messages, () => binary.length === 2);
    const ended = messages.find((message) => message.type === 'tts.ended')!;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((ended.payload as TestPayload).generatedSamples).toBe(960);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((ended.payload as TestPayload).playbackId).toBe(playbackId);
    expect(
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (messages.find((message) => message.type === 'reasoning.final')!.payload as TestPayload).text,
    ).toBe('First sentence. Second sentence.');

    // Authoritative browser terminal receipt commits assistant context for the next turn.
    socket.send(
      JSON.stringify(
        command('playback.progress', { playbackId, outputEpoch: 0, playedSampleOffset: 960, generatedSamples: 960 }),
      ),
    );
    socket.send(
      JSON.stringify(
        command('playback.stopped', {
          playbackId,
          cancelledEpoch: 0,
          finalPlayedSampleOffset: 960,
          reason: 'completed',
        }),
      ),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 1, monotonicUs: 4n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await waitForWhere(messages, () => messages.filter((message) => message.type === 'transcript.final').length >= 2);
    const secondFinal = messages.filter((message) => message.type === 'transcript.final')[1]!;
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const secondPayload = secondFinal.payload as TestPayload;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          turnId: secondPayload.turnId,
          finalEventId: secondFinal.eventId,
          persistedEpoch: secondFinal.epoch,
        }),
      ),
    );
    await waitForWhere(messages, () => messages.filter((message) => message.type === 'reasoning.started').length >= 2);
    expect(piInputs[1]!.boundedContext).toContain('First sentence. Second sentence.');
    socket.close();
  });

  it('holds a stable final until the exact durable acknowledgement', async () => {
    const sidecar = await fakeAudio();
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: false,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const final = await waitFor(messages, 'transcript.final');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages.some((message) => message.type === 'policy.decision')).toBe(false);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const payload = final.payload as TestPayload;
    const acknowledgement = { turnId: payload.turnId, finalEventId: final.eventId, persistedEpoch: final.epoch };
    socket.send(JSON.stringify(command('turn.persisted', acknowledgement)));
    expect((await waitFor(messages, 'policy.decision')).type).toBe('policy.decision');

    // A retried exact acknowledgement is a no-op even after downstream work began.
    socket.send(JSON.stringify(command('turn.persisted', acknowledgement)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(messages.filter((message) => message.type === 'policy.decision')).toHaveLength(1);

    // Cancelling the current assistant turn advances once and returns to listening.
    socket.send(JSON.stringify(command('turn.cancel', { reason: 'user' })));
    const listening = await waitForWhere(
      messages,
      (message) =>
        message.type === 'session.state' &&
        message.epoch === 1 &&
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        (message.payload as TestPayload).phase === 'listening',
    );
    expect(listening.type).toBe('session.state');
    expect(socket.readyState).toBe(WebSocket.OPEN);

    // Reusing the completed final identity with mismatched fields fails closed.
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(JSON.stringify(command('turn.persisted', { ...acknowledgement, turnId: seed }, 0)));
    await expect(closed).resolves.toBe(1008);
  });

  it('keeps the browser socket open when the sidecar fails mid-turn (capture frames dropped after failure)', async () => {
    const sidecar = await fakeAudio({ failMidTurn: true });
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: false,
      createResponseClient: () => pi,
      createResearchClient: () => pi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, binary) => {
      if (!binary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    // The sidecar fails shortly after stream open; AudioClient must drop
    // subsequent capture frames instead of throwing (which used to surface as
    // invalid_capture_frame and close the browser socket).
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'failure' && (message.payload as TestPayload).code === 'runtime_unavailable',
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(
      messages.some(
        (message) =>
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          message.type === 'failure' && (message.payload as TestPayload).code === 'invalid_capture_frame',
      ),
    ).toBe(false);
    socket.close();
  });

  it.skip('runs a multi-part question turn: stall part 0 then body parts with per-part TTS on the wire', async () => {
    const sidecar = await fakeAudio({ multipart: true });
    const researchPi: PiResearchClient = {
      async *requestBody(_input, _signal) {
        yield {
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          type: 'delta' as const,
          text: 'The top Metroidvania is Metroid Prime. It scores 97. Symphony of the Night follows at 93. Ori and the Will of the Wisps also scores 93. Metroid Prime 2 reaches 92. Metroid Fusion rounds out the list at 92. ',
        };
        yield {
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          type: 'final' as const,
          text: 'The top Metroidvania is Metroid Prime. It scores 97. Symphony of the Night follows at 93. Ori and the Will of the Wisps also scores 93. Metroid Prime 2 reaches 92. Metroid Fusion rounds out the list at 92. ',
        };
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: true,
      createResponseClient: () => pi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    const binary: Buffer[] = [];
    socket.on('message', (raw, isBinary) => {
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      // SAFETY: ws supplies Buffer data for binary message callbacks.
      const binaryRaw = raw as Buffer;
      if (isBinary) binary.push(Buffer.from(binaryRaw));
      else messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const final = await waitFor(messages, 'transcript.final');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const finalPayload = final.payload as TestPayload;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          turnId: finalPayload.turnId,
          finalEventId: final.eventId,
          persistedEpoch: final.epoch,
        }),
      ),
    );
    // Stall part 0 first, then body parts with part indices on the wire.
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'response.part_started' && (message.payload as TestPayload).partIndex === 0,
    );
    const part0Tts = await waitForWhere(
      messages,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (message) => message.type === 'tts.started' && (message.payload as TestPayload).partIndex === 0,
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((part0Tts.payload as TestPayload).outputStreamId).toBe(55);
    await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'response.part_started' && (message.payload as TestPayload).partIndex === 1,
    );
    const part1Tts = await waitForWhere(
      messages,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (message) => message.type === 'tts.started' && (message.payload as TestPayload).partIndex === 1,
    );
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect((part1Tts.payload as TestPayload).outputStreamId).toBe(56);
    // The six-sentence body splits into two parts (indices 1 and 2).
    await waitForWhere(
      messages,
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      (message) => message.type === 'tts.started' && (message.payload as TestPayload).partIndex === 2,
    );
    await waitFor(messages, 'response.part_final');
    const started = messages.filter((message) => message.type === 'tts.started');
    expect(started).toHaveLength(3);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect(started.map((message) => (message.payload as TestPayload).partIndex)).toEqual([0, 1, 2]);
    expect(binary.length).toBeGreaterThanOrEqual(3);
    // Terminal receipts for every part return to listening.
    for (const startedEvent of started) {
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      const playbackId = (startedEvent.payload as TestPayload).playbackId as string;
      socket.send(
        JSON.stringify(
          command('playback.stopped', {
            playbackId,
            cancelledEpoch: 0,
            finalPlayedSampleOffset: 960,
            reason: 'completed',
          }),
        ),
      );
    }
    const listening = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).phase === 'listening',
    );
    expect(listening.epoch).toBe(0);
    expect(messages.filter((message) => message.type === 'reasoning.final')).toHaveLength(3);
    socket.close();
  });

  it.skip('never opens a third nonterminal TTS stream against a bound-enforcing sidecar (decision 007 gate)', async () => {
    const sidecar = await fakeBoundedAudio();
    const researchPi: PiResearchClient = {
      async *requestBody(_input, _signal) {
        const text =
          'The top Metroidvania is Metroid Prime. It scores 97. Symphony of the Night follows at 93. Ori and the Will of the Wisps also scores 93. Metroid Prime 2 reaches 92. Metroid Fusion rounds out the list at 92. Metroid Dread completes the set at 94. Hollow Knight earned 90. Axiom Verge closes at 88. ';
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'delta' as const, text };
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        yield { type: 'final' as const, text };
      },
      async shutdown() {},
    };
    const app = await buildApp({
      sidecar,
      createProbeClient: () => pi,
      multiPartEnabled: true,
      createResponseClient: () => pi,
      createResearchClient: () => researchPi,
      createClassifierClient: () => pi,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    app.setCanonicalOrigin(origin);
    cleanup.push(async () => app.close());
    const { body, cookie } = await bootstrap(app, origin);
    const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const messages: Array<TestPayload> = [];
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability })));
      socket.once('message', () => resolve());
    });
    socket.send(
      JSON.stringify(
        command('session.open', {
          sessionSeed: seed,
          reasoningMode: 'full',
          settings: { version: 1, persona: '', voice: { catalogId: 'sess-catalog', voiceId: 'af_heart' } },
        }),
      ),
    );
    socket.send(
      JSON.stringify(command('session.begin', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: 320 })),
    );
    socket.send(
      encodeBinaryAudioFrame(
        { channel: 1, streamId: 7, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(320) },
        64 * 1024,
      ),
    );
    const final = await waitFor(messages, 'transcript.final');
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const finalPayload = final.payload as TestPayload;
    socket.send(
      JSON.stringify(
        command('turn.persisted', {
          turnId: finalPayload.turnId,
          finalEventId: final.eventId,
          persistedEpoch: final.epoch,
        }),
      ),
    );
    // Stall + three body parts. The gate holds parts 2 and 3 until their
    // predecessor terminalizes, so all four must still reach tts.started.
    for (const partIndex of [0, 1, 2, 3]) {
      await waitForWhere(
        messages,
        (message) =>
          // SAFETY: this test fixture is constructed in this file with the asserted shape.
          message.type === 'tts.started' && (message.payload as TestPayload).partIndex === partIndex,
      );
    }
    expect(messages.filter((message) => message.type === 'failure' || message.type === 'response.failed')).toHaveLength(
      0,
    );
    const started = messages.filter((message) => message.type === 'tts.started');
    expect(started).toHaveLength(4);
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    expect(started.map((message) => (message.payload as TestPayload).partIndex)).toEqual([0, 1, 2, 3]);
    for (const startedEvent of started) {
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      const playbackId = (startedEvent.payload as TestPayload).playbackId as string;
      socket.send(
        JSON.stringify(
          command('playback.stopped', {
            playbackId,
            cancelledEpoch: 0,
            finalPlayedSampleOffset: 960,
            reason: 'completed',
          }),
        ),
      );
    }
    const listening = await waitForWhere(
      messages,
      (message) =>
        // SAFETY: this test fixture is constructed in this file with the asserted shape.
        message.type === 'session.state' && (message.payload as TestPayload).phase === 'listening',
    );
    expect(listening.epoch).toBe(0);
    socket.close();
  });
});
