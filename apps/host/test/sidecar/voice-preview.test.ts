type TestJsonValue = null | boolean | number | string | TestJsonValue[] | { [key: string]: TestJsonValue };
type TestJsonRecord = { [key: string]: TestJsonValue };
import { createServer } from 'node:http';
import { encodeBinaryAudioFrame } from '@app/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { SidecarProcess } from '../../src/sidecar/process.js';
import { synthesizeVoicePreview } from '../../src/sidecar/voice-preview.js';

const voiceCatalog = Object.freeze({
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
});
const playbackId = '018f1f32-7abd-7def-8abc-0123456789ab';
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

interface RecordedRequest {
  type: string;
  payload: TestJsonRecord;
}

async function fakePreviewSidecar(options: { busy?: boolean; driftVoice?: string } = {}) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || !('port' in address)) throw new Error('missing address');
  const requests: RecordedRequest[] = [];
  let requestedVoiceId = 'af_heart';
  wss.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer secret');
    socket.send(
      JSON.stringify({
        type: 'readiness.snapshot',
        payload: {
          status: 'ready',
          stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1',
          tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1',
          voiceCatalog,
        },
      }),
    );
    socket.on('message', (raw) => {
      if (Buffer.isBuffer(raw) && raw[0] === 1) return;
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      const message = JSON.parse(raw.toString()) as RecordedRequest;
      requests.push(message);
      if (message.type === 'stream.open') {
        if (options.busy) {
          socket.send(
            JSON.stringify({ type: 'sidecar.failure', payload: { code: 'invalid_message', recoverable: false } }),
          );
          socket.close(1008, 'one active stream is allowed');
          return;
        }
        socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: message.payload.streamId } }));
      }
      if (message.type === 'tts.open') {
        // SAFETY: the fake sends tts.open literals with a string voiceId.
        requestedVoiceId = message.payload.voiceId as string;
      }
      if (message.type === 'tts.commit') {
        const streamId = message.payload.streamId;
        const outputStreamId = 77;
        const voiceId = options.driftVoice ?? requestedVoiceId;
        socket.send(
          JSON.stringify({
            type: 'tts.started',
            payload: {
              streamId,
              responseId: message.payload.responseId,
              epoch: message.payload.epoch,
              playbackId,
              outputStreamId,
              sampleRate: 24000,
              voiceId,
            },
          }),
        );
        setTimeout(() => {
          for (let sequence = 0; sequence < 3; sequence++) {
            socket.send(
              encodeBinaryAudioFrame(
                {
                  channel: 2,
                  streamId: outputStreamId,
                  sequence,
                  monotonicUs: BigInt(sequence + 1),
                  pcm16: new Int16Array(480),
                },
                64 * 1024,
              ),
            );
          }
          socket.send(
            JSON.stringify({
              type: 'tts.ended',
              payload: {
                streamId,
                responseId: message.payload.responseId,
                epoch: message.payload.epoch,
                playbackId,
                generatedSamples: 1440,
              },
            }),
          );
        }, 20);
      }
    });
  });
  const closer = {
    close: async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
  servers.push(closer);
  return {
    sidecar: {
      // SAFETY: this test fixture is constructed in this file with the asserted shape.
      child: {} as SidecarProcess['child'],
      origin: `http://127.0.0.1:${address.port}`,
      secret: 'secret',
      stop: closer.close,
    } satisfies SidecarProcess,
    requests,
  };
}

describe('synthesizeVoicePreview', () => {
  it('synthesizes the joined phrases with the chosen voice and returns contiguous PCM', async () => {
    const { sidecar, requests } = await fakePreviewSidecar();
    const result = await synthesizeVoicePreview(sidecar, {
      catalogId: 'sess-catalog',
      voiceId: 'af_bella',
      phrases: ['Hello there!', 'How are you?'],
    });
    expect(requests.some((request) => request.type === 'stream.open' && request.payload.streamMode === 'preview')).toBe(
      true,
    );
    expect(requests.some((request) => request.type === 'tts.open' && request.payload.voiceId === 'af_bella')).toBe(
      true,
    );
    const appends = requests
      .filter((request) => request.type === 'tts.append')
      .map((request) => String(request.payload.text));
    expect(appends.join('')).toBe('Hello there! How are you?');
    expect(requests.some((request) => request.type === 'tts.commit')).toBe(true);
    expect(result.sampleRate).toBe(24000);
    expect(result.generatedSamples).toBe(1440);
    expect(result.pcm16).toHaveLength(1440);
  });

  it('rejects when the sidecar refuses a second stream (session already active)', async () => {
    const { sidecar, requests } = await fakePreviewSidecar({ busy: true });
    await expect(
      synthesizeVoicePreview(sidecar, { catalogId: 'sess-catalog', voiceId: 'af_heart', phrases: ['Hello there!'] }),
    ).rejects.toThrow();
    expect(requests.filter((request) => request.type.startsWith('tts.')).map((request) => request.type)).toEqual([]);
  });

  it('fails closed when the sidecar echoes a different voice than requested', async () => {
    const { sidecar } = await fakePreviewSidecar({ driftVoice: 'af_heart' });
    await expect(
      synthesizeVoicePreview(sidecar, { catalogId: 'sess-catalog', voiceId: 'af_bella', phrases: ['Hello there!'] }),
    ).rejects.toThrow(/protocol/);
  });

  it('fails closed when the verified catalog drifts from the preview selection', async () => {
    const { sidecar } = await fakePreviewSidecar();
    await expect(
      synthesizeVoicePreview(sidecar, { catalogId: 'other-catalog', voiceId: 'af_heart', phrases: ['Hello there!'] }),
    ).rejects.toThrow(/catalog|not ready/);
  });

  it('aborts cleanly when the caller cancels before completion', async () => {
    const { sidecar } = await fakePreviewSidecar();
    const controller = new AbortController();
    const pending = synthesizeVoicePreview(
      sidecar,
      { catalogId: 'sess-catalog', voiceId: 'af_heart', phrases: ['Hello there!'] },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
