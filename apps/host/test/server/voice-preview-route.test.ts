import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { WAV_HEADER_BYTES } from '../../src/sidecar/wav.js';
import { VOICE_PREVIEW_MAX_PHRASE_CHARS, VOICE_PREVIEW_MAX_TEXT_CHARS, VOICE_PREVIEW_PHRASE_COUNT } from '@app/contracts/settings';
import type { SidecarProcess } from '../../src/sidecar/process.js';

const voiceCatalog = Object.freeze({ catalogId: 'catalog-1', backendId: 'kokoro', modelId: 'kokoro-82m-onnx', runtimeConfigId: 'rc', revision: 'rev-1', defaultVoiceId: 'af_heart', voices: [{ id: 'af_heart', label: 'af_heart' }, { id: 'af_bella', label: 'Bella' }] });

interface CapturedPreview { catalogId: string; voiceId: string; phrases: string[] }

type PreviewStub = (input: CapturedPreview, signal: AbortSignal) => Promise<{ pcm16: Int16Array; sampleRate: number }>;

async function fakeSidecarHealth(options: { ready: boolean }) {
  const http = createServer();
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  http.on('request', (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(options.ready
      ? { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1', voiceCatalog }
      : { status: 'starting', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1' }));
  });
  return {
    sidecar: { child: {} as SidecarProcess['child'], origin: `http://127.0.0.1:${address.port}`, secret: 'secret', stop: async () => undefined } satisfies SidecarProcess,
    close: async () => { await new Promise<void>(resolve => http.close(() => resolve())); },
  };
}

const apps: FastifyInstance[] = [];
const closed: Array<Promise<void>> = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const close of closed.splice(0)) await close; });

async function makeApp(voicePreview: PreviewStub, ready: boolean = true): Promise<{ app: FastifyInstance; origin: string }> {
  const { sidecar, close } = await fakeSidecarHealth({ ready });
  closed.push(close);
  const app = await buildApp({ sidecar, voicePreview });
  apps.push(app);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  app.setCanonicalOrigin(origin);
  return { app, origin };
}

async function bootstrap(origin: string) {
  const headers = () => ({ host: new URL(origin).host, origin });
  const response = await fetch(`${origin}/api/bootstrap`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: '{"disclosureAcknowledged":true}' });
  const body = await response.json() as { capability: string };
  return { capability: body.capability, cookie: response.headers.get('set-cookie')!.split(';')[0]!, headers: headers() };
}

async function preview(origin: string, auth: { capability: string; cookie: string; headers: Record<string, string> }, voiceId: string) {
  return fetch(`${origin}/api/voice-preview`, { method: 'POST', headers: { ...auth.headers, cookie: auth.cookie, 'x-podcaster-capability': auth.capability, 'content-type': 'application/json' }, body: JSON.stringify({ voiceId }) });
}

describe('POST /api/voice-preview', () => {
  it('returns a playable WAV for a verified voice with three randomized phrases', async () => {
    const captured: CapturedPreview[] = [];
    const { origin } = await makeApp(async input => { captured.push(input); return { pcm16: new Int16Array([100, -200, 300, -400]), sampleRate: 24_000 }; });
    const auth = await bootstrap(origin);
    const response = await preview(origin, auth, 'af_bella');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 8);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getInt16(WAV_HEADER_BYTES, true)).toBe(100);
    expect(view.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(-200);
    const capturedPreview = captured.at(-1)!;
    expect(capturedPreview.catalogId).toBe('catalog-1');
    expect(capturedPreview.voiceId).toBe('af_bella');
    expect(capturedPreview.phrases).toHaveLength(VOICE_PREVIEW_PHRASE_COUNT);
    for (const phrase of capturedPreview.phrases) {
      expect(phrase.length).toBeGreaterThan(0);
      expect(phrase.length).toBeLessThanOrEqual(VOICE_PREVIEW_MAX_PHRASE_CHARS);
    }
    expect(capturedPreview.phrases.join(' ').length).toBeLessThanOrEqual(VOICE_PREVIEW_MAX_TEXT_CHARS);
  });

  it('requires an authenticated session', async () => {
    const { origin } = await makeApp(async input => ({ pcm16: new Int16Array(input.phrases.length), sampleRate: 24_000 }));
    const h = { host: new URL(origin).host, origin, 'content-type': 'application/json' };
    const response = await fetch(`${origin}/api/voice-preview`, { method: 'POST', headers: h, body: JSON.stringify({ voiceId: 'af_heart' }) });
    expect(response.status).toBe(401);
  });

  it('rejects a malformed body and an unknown voice', async () => {
    const { origin } = await makeApp(async input => ({ pcm16: new Int16Array(input.phrases.length), sampleRate: 24_000 }));
    const auth = await bootstrap(origin);
    const h = { ...auth.headers, cookie: auth.cookie, 'x-podcaster-capability': auth.capability, 'content-type': 'application/json' };
    expect((await fetch(`${origin}/api/voice-preview`, { method: 'POST', headers: h, body: JSON.stringify({}) })).status).toBe(400);
    expect((await fetch(`${origin}/api/voice-preview`, { method: 'POST', headers: h, body: JSON.stringify({ voiceId: 'nope' }) })).status).toBe(422);
  });

  it('serves one preview at a time and rejects overlaps cleanly', async () => {
    const gates: Array<() => void> = [];
    const { origin } = await makeApp(async () => {
      await new Promise<void>(resolve => gates.push(resolve));
      return { pcm16: new Int16Array(4), sampleRate: 24_000 };
    });
    const auth = await bootstrap(origin);
    const first = preview(origin, auth, 'af_heart');
    await new Promise(resolve => setTimeout(resolve, 20)); // let the first preview reach its gate
    const overlap = await preview(origin, auth, 'af_heart');
    expect(overlap.status).toBe(429);
    expect((await overlap.json() as { error: string }).error).toBe('preview_in_flight');
    gates[0]!();
    expect((await first).status).toBe(200);
  });

  it('reports 409 while the audio engine has no verified catalog', async () => {
    const { origin } = await makeApp(async input => ({ pcm16: new Int16Array(input.phrases.length), sampleRate: 24_000 }), false);
    const auth = await bootstrap(origin);
    const response = await preview(origin, auth, 'af_heart');
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe('voice_catalog_unavailable');
  });
});