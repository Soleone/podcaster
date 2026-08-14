import { createServer } from 'node:http';
import { encodeBinaryAudioFrame } from '@app/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { AudioClient, type VadEndEvent, type VadStartEvent } from '../../src/sidecar/AudioClient.js';
import type { SidecarProcess } from '../../src/sidecar/process.js';

const streamId = '018f1f32-7abc-7def-8abc-0123456789ab';
const playbackId = '018f1f32-7abd-7def-8abc-0123456789ab';
const responseId = '018f1f32-7abe-7def-8abc-0123456789ab';
const responseId2 = '018f1f32-7abf-7def-8abc-0123456789ab';
const playbackId2 = '018f1f32-7ac0-7def-8abc-0123456789ab';
const voiceCatalog = Object.freeze({ catalogId: 'sess-catalog', backendId: 'kokoro', modelId: 'kokoro-82m-onnx', runtimeConfigId: 'rc', revision: 'rev', defaultVoiceId: 'af_heart', voices: [{ id: 'af_heart', label: 'af_heart' }, { id: 'af_bella', label: 'Bella' }] });
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

async function fakeSidecar(options: { gap?: boolean; cancelRace?: boolean; cancelWithEnded?: boolean; unexpectedPartial?: boolean } = {}) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  wss.on('connection', (socket, request) => {
    let ttsCount = 0;
    expect(request.headers.authorization).toBe('Bearer secret');
    expect(request.headers.origin).toBeUndefined();
    socket.send(JSON.stringify({ type: 'readiness.snapshot', payload: { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1', voiceCatalog } }));
    socket.on('message', raw => {
      if (Buffer.isBuffer(raw) && raw[0] === 1) return;
      const message = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
      if (message.type === 'stream.open') {
        socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: message.payload.streamId } }));
        if (options.unexpectedPartial) socket.send(JSON.stringify({ type: 'stt.partial', payload: { streamId: message.payload.streamId, utteranceId: streamId, epoch: 0, sequence: 0, text: 'invalid', replacedCharacters: 0 } }));
      }
      if (message.type === 'tts.request' || message.type === 'tts.open') {
        const requestIndex = ttsCount;
        // Only increment for tts.request (one-shot); tts.open waits for commit
        const responseId = message.payload.responseId as string;
        const epoch = message.payload.epoch as number;
        const outputStreamId = 55 + requestIndex;
        const currentPlaybackId = requestIndex === 0 ? playbackId : playbackId2;

        if (message.type === 'tts.request') {
          ttsCount++;
          // Legacy one-shot: emit immediately
          socket.send(JSON.stringify({ type: 'tts.started', payload: { streamId: message.payload.streamId, responseId, epoch, playbackId: currentPlaybackId, outputStreamId, sampleRate: 24000, voiceId: 'af_heart' } }));
          socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: outputStreamId, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024));
          if (!options.cancelRace || requestIndex > 0) setTimeout(() => {
            socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: outputStreamId, sequence: options.gap && requestIndex === 0 ? 2 : 1, monotonicUs: 2n, pcm16: new Int16Array(480) }, 64 * 1024));
            socket.send(JSON.stringify({ type: 'tts.ended', payload: { streamId: message.payload.streamId, responseId, epoch, playbackId: currentPlaybackId, generatedSamples: 960 } }));
          }, 20);
        }
      }
      if (message.type === 'tts.commit') {
        // Progressive stream: commit triggers the full synthesis
        const requestIndex = ttsCount++;
        const outputStreamId = 55 + requestIndex;
        const currentPlaybackId = requestIndex === 0 ? playbackId : playbackId2;
        const responseId = message.payload.responseId as string;
        const epoch = message.payload.epoch as number;
        socket.send(JSON.stringify({ type: 'tts.started', payload: { streamId: message.payload.streamId, responseId, epoch, playbackId: currentPlaybackId, outputStreamId, sampleRate: 24000, voiceId: 'af_heart' } }));
        socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: outputStreamId, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024));
        if (!options.cancelRace || requestIndex > 0) setTimeout(() => {
          socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: outputStreamId, sequence: options.gap && requestIndex === 0 ? 2 : 1, monotonicUs: 2n, pcm16: new Int16Array(480) }, 64 * 1024));
          socket.send(JSON.stringify({ type: 'tts.ended', payload: { streamId: message.payload.streamId, responseId, epoch, playbackId: currentPlaybackId, generatedSamples: 960 } }));
        }, 20);
      }
      if (message.type === 'tts.cancel' && options.cancelRace) {
        socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: 55, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(480) }, 64 * 1024));
        socket.send(JSON.stringify(options.cancelWithEnded
          ? { type: 'tts.ended', payload: { streamId: message.payload.streamId, responseId: message.payload.responseId, epoch: message.payload.epoch, playbackId, generatedSamples: 960 } }
          : { type: 'tts.cancelled', payload: { streamId: message.payload.streamId, responseId: message.payload.responseId, epoch: message.payload.epoch } }));
      }
    });
  });
  const closer = { close: async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); } };
  servers.push(closer);
  return { child: {} as SidecarProcess['child'], origin: `http://127.0.0.1:${address.port}`, secret: 'secret', stop: closer.close } satisfies SidecarProcess;
}

async function fakeVadSidecar() {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  let sidecarSocket: WebSocket | undefined;
  wss.on('connection', socket => {
    sidecarSocket = socket;
    socket.send(JSON.stringify({ type: 'readiness.snapshot', payload: { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1', voiceCatalog } }));
    socket.on('message', raw => {
      if (Buffer.isBuffer(raw) && raw[0] === 1) return;
      const message = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
      if (message.type === 'stream.open') socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: message.payload.streamId } }));
    });
  });
  const closer = { close: async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); } };
  servers.push(closer);
  return { sidecar: { child: {} as SidecarProcess['child'], origin: `http://127.0.0.1:${address.port}`, secret: 'secret', stop: closer.close } satisfies SidecarProcess, send: (message: unknown) => sidecarSocket!.send(JSON.stringify(message)) };
}

async function fakeMultipartSidecar(options: { echoPartIndex?: boolean; echoPartId?: boolean } = {}) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  let ttsCount = 0;
  wss.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer secret');
    expect(request.headers.origin).toBeUndefined();
    socket.send(JSON.stringify({ type: 'readiness.snapshot', payload: { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1', voiceCatalog } }));
    socket.on('message', raw => {
      if (Buffer.isBuffer(raw) && raw[0] === 1) return;
      const message = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
      if (message.type === 'stream.open') {
        socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: message.payload.streamId } }));
      }
      if (message.type === 'tts.commit') {
        // Multi-part progressive stream: commit triggers synthesis. Echo the
        // part fields only when the fake is configured to honor decision 007.
        const requestIndex = ttsCount++;
        const outputStreamId = 55 + requestIndex;
        const responseId = message.payload.responseId as string;
        const epoch = message.payload.epoch as number;
        const partIndex = message.payload.partIndex as number | undefined;
        const partId = message.payload.partId as string | undefined;
        socket.send(JSON.stringify({ type: 'tts.started', payload: { streamId: message.payload.streamId, responseId, epoch, playbackId, outputStreamId, sampleRate: 24000, voiceId: 'af_heart', ...(options.echoPartIndex && partIndex !== undefined ? { partIndex } : {}), ...(options.echoPartId && partId !== undefined ? { partId } : {}) } }));
        if (!options.echoPartIndex) return;
        socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: outputStreamId, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024));
        socket.send(encodeBinaryAudioFrame({ channel: 2, streamId: outputStreamId, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(480) }, 64 * 1024));
        socket.send(JSON.stringify({ type: 'tts.ended', payload: { streamId: message.payload.streamId, responseId, epoch, playbackId, generatedSamples: 960, ...(partIndex !== undefined ? { partIndex } : {}) } }));
      }
    });
  });
  const closer = { close: async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); } };
  servers.push(closer);
  return { child: {} as SidecarProcess['child'], origin: `http://127.0.0.1:${address.port}`, secret: 'secret', stop: closer.close } satisfies SidecarProcess;
}

describe('AudioClient', () => {
  it('validates captureEndSequence on speech_end and relays VAD ownership events', async () => {
    const { sidecar, send } = await fakeVadSidecar();
    const starts: VadStartEvent[] = [];
    const ends: VadEndEvent[] = [];
    const client = new AudioClient(sidecar, { speechStart: event => starts.push(event), speechEnd: event => ends.push(event) });
    await client.connect();
    const openedStream = await client.open(7);
    send({ type: 'vad.speech_start', payload: { streamId: openedStream, utteranceId: streamId, captureStartSequence: 0 } });
    send({ type: 'vad.speech_end', payload: { streamId: openedStream, utteranceId: streamId, captureStartSequence: 0, captureEndSequence: 3 } });
    await expect.poll(() => starts.length + ends.length).toBe(2);
    expect(starts).toEqual([{ streamId: openedStream, utteranceId: streamId, captureStartSequence: 0 }]);
    expect(ends).toEqual([{ streamId: openedStream, utteranceId: streamId, captureStartSequence: 0, captureEndSequence: 3 }]);
    expect(client.readiness()).toBe('ready');
    await client.close();
  });

  it('reuses the sidecar stream when capture is paused and resumed', async () => {
    const { sidecar } = await fakeVadSidecar();
    const client = new AudioClient(sidecar);
    await client.connect();
    const openedStream = await client.open(7);
    await expect(client.open(8)).resolves.toBe(openedStream);
    expect(client.readiness()).toBe('ready');
    await client.close();
  });

  it('fails closed when speech_end omits captureEndSequence or inverts the capture range', async () => {
    const first = await fakeVadSidecar();
    const client = new AudioClient(first.sidecar, {});
    await client.connect();
    const openedStream = await client.open(7);
    first.send({ type: 'vad.speech_start', payload: { streamId: openedStream, utteranceId: streamId, captureStartSequence: 0 } });
    first.send({ type: 'vad.speech_end', payload: { streamId: openedStream, utteranceId: streamId, captureStartSequence: 0 } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(client.readiness()).toBe('failed');
    await client.close();

    const second = await fakeVadSidecar();
    const inverted = new AudioClient(second.sidecar, {});
    await inverted.connect();
    const opened = await inverted.open(7);
    second.send({ type: 'vad.speech_start', payload: { streamId: opened, utteranceId: streamId, captureStartSequence: 2 } });
    second.send({ type: 'vad.speech_end', payload: { streamId: opened, utteranceId: streamId, captureStartSequence: 2, captureEndSequence: 1 } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(inverted.readiness()).toBe('failed');
    await inverted.close();
  });

  it('releases metadata first and then forwards ordered PCM while synthesis continues', async () => {
    const sidecar = await fakeSidecar();
    const output: Uint8Array[] = [];
    const client = new AudioClient(sidecar, {}, frame => output.push(frame));
    await client.connect();
    await client.open(7);
    const result = await client.synthesize({ sessionId: streamId, epoch: 0, responseId, text: 'safe response', signal: new AbortController().signal });
    expect(result.playbackId).toBe(playbackId);
    expect(result.sampleRate).toBe(24000);
    expect(result.completion).toBeInstanceOf(Promise);
    expect(output).toHaveLength(0);
    client.release(responseId);
    await expect(result.completion).resolves.toEqual({ generatedSamples: 960 });
    expect(output).toHaveLength(2);
    await client.close();
  });

  it('establishes the local cutoff before remote cancellation acknowledgement', async () => {
    const sidecar = await fakeSidecar({ cancelRace: true });
    const output: Uint8Array[] = [];
    const client = new AudioClient(sidecar, {}, frame => output.push(frame));
    await client.connect();
    await client.open(7);
    const controller = new AbortController();
    const generated: number[] = [];
    const started = await client.synthesize({ sessionId: streamId, epoch: 0, responseId, text: 'safe response', signal: controller.signal, onGeneratedSamples: total => generated.push(total) });
    client.release(responseId);
    await new Promise(resolve => setTimeout(resolve, 5));
    const countAtCutoff = output.length;
    controller.abort();
    await expect(started.completion).rejects.toThrow(/cancelled/);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(output).toHaveLength(countAtCutoff);
    expect(generated).toEqual([480]);
    expect(client.readiness()).toBe('ready');

    const recovered = await client.synthesize({ sessionId: streamId, epoch: 1, responseId: responseId2, text: 'safe response', signal: new AbortController().signal });
    expect(recovered.playbackId).toBe(playbackId2);
    client.release(responseId2);
    await expect(recovered.completion).resolves.toEqual({ generatedSamples: 960 });
    expect(client.readiness()).toBe('ready');
    await client.close();
  });

  it('accepts synthesis completion as the remote terminal when cancellation races tts.ended', async () => {
    const sidecar = await fakeSidecar({ cancelRace: true, cancelWithEnded: true });
    const client = new AudioClient(sidecar);
    await client.connect();
    await client.open(7);
    const controller = new AbortController();
    const started = await client.synthesize({ sessionId: streamId, epoch: 0, responseId, text: 'safe response', signal: controller.signal });
    client.release(responseId);
    controller.abort();
    await expect(started.completion).rejects.toThrow(/cancelled/);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(client.readiness()).toBe('ready');
    const recovered = await client.synthesize({ sessionId: streamId, epoch: 1, responseId: responseId2, text: 'safe response', signal: new AbortController().signal });
    client.release(responseId2);
    await expect(recovered.completion).resolves.toEqual({ generatedSamples: 960 });
    await client.close();
  });

  it('ignores cancellation immediately after a completed request', async () => {
    const sidecar = await fakeSidecar();
    const client = new AudioClient(sidecar);
    await client.connect();
    await client.open(7);
    const controller = new AbortController();
    const started = await client.synthesize({ sessionId: streamId, epoch: 0, responseId, text: 'safe response', signal: controller.signal });
    client.release(responseId);
    await expect(started.completion).resolves.toEqual({ generatedSamples: 960 });
    controller.abort();
    expect(client.readiness()).toBe('ready');
    await client.close();
  });

  it('fails closed on STT output before VAD ownership and epoch binding', async () => {
    const sidecar = await fakeSidecar({ unexpectedPartial: true });
    const failures: string[] = [];
    const client = new AudioClient(sidecar, { failure: code => failures.push(code) });
    await client.connect();
    await client.open(7);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(failures).toContain('invalid_message');
    expect(client.readiness()).toBe('failed');
    await client.close();
  });

  it('fails closed on a gapped sidecar output sequence', async () => {
    const sidecar = await fakeSidecar({ gap: true });
    const failures: string[] = [];
    const client = new AudioClient(sidecar, { failure: code => failures.push(code) });
    await client.connect();
    await client.open(7);
    const started = await client.synthesize({ sessionId: streamId, epoch: 0, responseId, text: 'safe response', signal: new AbortController().signal });
    client.release(responseId);
    await expect(started.completion).rejects.toThrow(/protocol/);
    expect(failures).toContain('invalid_message');
    await client.close();
  });

  it('resolves a multipart begin({partIndex}) when the sidecar echoes partIndex (decision 007 contract)', async () => {
    const sidecar = await fakeMultipartSidecar({ echoPartIndex: true, echoPartId: true });
    const client = new AudioClient(sidecar);
    await client.connect();
    await client.open(7);
    const stream = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 0, partId: playbackId, signal: new AbortController().signal });
    stream.append('Paris is the capital of France. It sits on the Seine. ');
    stream.finish();
    const started = await stream.started;
    expect(started.partIndex).toBe(0);
    expect(started.partId).toBe(playbackId);
    expect(started.playbackId).toBe(playbackId);
    expect(started.outputStreamId).toBe(55);
    await expect(started.completion).resolves.toEqual({ generatedSamples: 960 });
    expect(client.readiness()).toBe('ready');
    await client.close();
  });

  it('fails closed when the sidecar omits partIndex from a multipart tts.started (documenting decision 007)', async () => {
    const sidecar = await fakeMultipartSidecar();
    const failures: string[] = [];
    const client = new AudioClient(sidecar, { failure: code => failures.push(code) });
    await client.connect();
    await client.open(7);
    const stream = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 0, signal: new AbortController().signal });
    stream.append('Paris is the capital of France. ');
    stream.finish();
    await expect(stream.started).rejects.toThrow(/protocol/);
    expect(failures).toContain('invalid_message');
    expect(client.readiness()).toBe('failed');
    await client.close();
  });

  it('fails closed when the verified catalog drifts from the session voice selection', async () => {
    const sidecar = await fakeSidecar();
    const failures: string[] = [];
    const client = new AudioClient(sidecar, { failure: code => failures.push(code) }, () => {}, { catalogId: 'other-catalog', voiceId: 'af_heart' });
    await client.connect();
    await expect(client.open(7)).rejects.toThrow(/catalog|not ready/);
    expect(failures).toContain('catalog_mismatch');
    expect(client.readiness()).toBe('failed');
    await client.close();
  });

  it('rejects a stream whose tts.started echoes a different voice than the session selection', async () => {
    const sidecar = await fakeSidecar();
    const failures: string[] = [];
    const client = new AudioClient(sidecar, { failure: code => failures.push(code) }, () => {}, { catalogId: 'sess-catalog', voiceId: 'af_bella' });
    await client.connect();
    await client.open(7);
    const stream = client.begin({ sessionId: streamId, epoch: 0, responseId, signal: new AbortController().signal });
    stream.append('Paris is the capital of France. ');
    stream.finish();
    await expect(stream.started).rejects.toThrow(/protocol/);
    expect(failures).toContain('invalid_message');
    expect(client.readiness()).toBe('failed');
    await client.close();
  });
});

async function fakeRecordedSidecar() {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let sidecarSocket: WebSocket | undefined;
  wss.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer secret');
    sidecarSocket = socket;
    socket.send(JSON.stringify({ type: 'readiness.snapshot', payload: { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1', voiceCatalog } }));
    socket.on('message', raw => {
      if (Buffer.isBuffer(raw) && raw[0] === 1) return;
      const message = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
      if (message.type === 'stream.open') socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: message.payload.streamId } }));
      else if (message.type.startsWith('tts.')) commands.push(message);
    });
  });
  const closer = { close: async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); } };
  servers.push(closer);
  return {
    sidecar: { child: {} as SidecarProcess['child'], origin: `http://127.0.0.1:${address.port}`, secret: 'secret', stop: closer.close } satisfies SidecarProcess,
    commands,
    push: (message: unknown) => sidecarSocket!.send(message instanceof Uint8Array ? message : JSON.stringify(message)),
  };
}

describe('AudioClient TTS admission gate (decision 007 two-stream prefetch)', () => {
  it('opens at most two streams; a third flushes only after the oldest terminalizes', async () => {
    const { sidecar, commands, push } = await fakeRecordedSidecar();
    const client = new AudioClient(sidecar);
    await client.connect();
    const opened = await client.open(7);
    const stall = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 0, signal: new AbortController().signal });
    const body1 = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 1, signal: new AbortController().signal });
    const body2 = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 2, signal: new AbortController().signal });
    stall.append('stall text');
    body1.append('body one');
    body2.append('body two');
    stall.finish();
    body1.finish();
    body2.finish();
    await new Promise(resolve => setTimeout(resolve, 30));
    const opens = commands.filter(c => c.type === 'tts.open');
    expect(opens).toHaveLength(2);
    expect(opens.map(c => c.payload.partIndex)).toEqual([0, 1]);
    // The queued body2 must not have sent wire commands yet.
    expect(commands.some(c => c.type === 'tts.append' && c.payload.partIndex === 2)).toBe(false);
    expect(commands.some(c => c.type === 'tts.commit' && c.payload.partIndex === 2)).toBe(false);
    // Oldest (stall) terminalizes -> body2 flushes open/append/commit in order.
    push({ type: 'tts.started', payload: { streamId: opened, responseId, epoch: 0, playbackId, outputStreamId: 55, sampleRate: 24000, voiceId: 'af_heart', partIndex: 0 } });
    push(encodeBinaryAudioFrame({ channel: 2, streamId: 55, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024));
    push(encodeBinaryAudioFrame({ channel: 2, streamId: 55, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(480) }, 64 * 1024));
    push({ type: 'tts.ended', payload: { streamId: opened, responseId, epoch: 0, playbackId, generatedSamples: 960, partIndex: 0 } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(commands.filter(c => c.type === 'tts.open')).toHaveLength(3);
    expect(commands.filter(c => c.type === 'tts.open').at(-1)!.payload.partIndex).toBe(2);
    const appends = commands.filter(c => c.type === 'tts.append' && c.payload.partIndex === 2);
    expect(appends.map(c => c.payload.text)).toEqual(['body two']);
    expect(appends.map(c => c.payload.sequence)).toEqual([0]);
    expect(commands.filter(c => c.type === 'tts.commit' && c.payload.partIndex === 2)).toHaveLength(1);
    await client.close();
  });

  it('queued stream abort sends no sidecar command', async () => {
    const { sidecar, commands } = await fakeRecordedSidecar();
    const client = new AudioClient(sidecar);
    await client.connect();
    await client.open(7);
    client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 0, signal: new AbortController().signal });
    client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 1, signal: new AbortController().signal });
    const controller = new AbortController();
    const queued = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 2, signal: controller.signal });
    queued.append('queued text');
    queued.finish();
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(commands.filter(c => c.type === 'tts.open')).toHaveLength(2);
    expect(commands.filter(c => c.type === 'tts.cancel')).toHaveLength(0);
    await expect(queued.started).rejects.toThrow('TTS cancelled');
    await client.close();
  });

  it('parent cancel cancels admitted streams and rejects queued streams', async () => {
    const { sidecar, commands } = await fakeRecordedSidecar();
    const client = new AudioClient(sidecar);
    await client.connect();
    await client.open(7);
    const stall = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 0, signal: new AbortController().signal });
    const body1 = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 1, signal: new AbortController().signal });
    const queued = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 2, signal: new AbortController().signal });
    client.cancel(responseId);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(commands.filter(c => c.type === 'tts.cancel')).toHaveLength(2);
    await expect(stall.started).rejects.toThrow('TTS cancelled');
    await expect(body1.started).rejects.toThrow('TTS cancelled');
    await expect(queued.started).rejects.toThrow('TTS cancelled');
    await client.close();
  });

  it('sidecar failure rejects both admitted and queued streams', async () => {
    const { sidecar, push } = await fakeRecordedSidecar();
    const failures: string[] = [];
    const client = new AudioClient(sidecar, { failure: code => failures.push(code) });
    await client.connect();
    await client.open(7);
    const stall = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 0, signal: new AbortController().signal });
    const body1 = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 1, signal: new AbortController().signal });
    const queued = client.begin({ sessionId: streamId, epoch: 0, responseId, partIndex: 2, signal: new AbortController().signal });
    push({ type: 'sidecar.failure', payload: { code: 'runtime_unavailable', recoverable: false } });
    await expect(stall.started).rejects.toThrow(/failed/);
    await expect(body1.started).rejects.toThrow(/failed/);
    await expect(queued.started).rejects.toThrow(/failed/);
    expect(failures).toEqual(['runtime_unavailable']);
    await client.close();
  });
});
