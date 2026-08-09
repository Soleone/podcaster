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
    socket.send(JSON.stringify({ type: 'readiness.snapshot', payload: { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cpu-v1' } }));
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
          socket.send(JSON.stringify({ type: 'tts.started', payload: { streamId: message.payload.streamId, responseId, epoch, playbackId: currentPlaybackId, outputStreamId, sampleRate: 24000 } }));
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
        socket.send(JSON.stringify({ type: 'tts.started', payload: { streamId: message.payload.streamId, responseId, epoch, playbackId: currentPlaybackId, outputStreamId, sampleRate: 24000 } }));
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
    socket.send(JSON.stringify({ type: 'readiness.snapshot', payload: { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cpu-v1' } }));
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
});
