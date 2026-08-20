import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { PiClient, PiEvent, PiRequestInput } from '../../src/pi/PiClient.js';
import type { PiResearchClient, PiResearchRequestInput } from '../../src/pi/PiResearchClient.js';
import { buildApp } from '../../src/server/app.js';
import type { SidecarProcess } from '../../src/sidecar/process.js';
import type { PiSettings } from '@app/contracts';

let sequence = 0;
function command(sessionId: string, type: string, payload: Record<string, unknown>, epoch = 0) {
  return { protocolVersion: 1, sessionId, epoch, eventId: `018f1f32-7abf-7def-8abc-${(0x1000 + sequence++).toString(16).padStart(12, '0')}`, type, monotonicMs: sequence, payload };
}

const VOICE = { catalogId: 'sess-catalog', voiceId: 'af_heart' };

/** Records the persona it was created with and whether shutdown was called. */
class TrackingPi implements PiClient {
  readonly personaAppend: string;
  readonly piSettings: PiSettings | undefined;
  shutdownCalls = 0;
  constructor(personaAppend: string, piSettings?: PiSettings) { this.personaAppend = personaAppend; this.piSettings = piSettings; }
  async probe() { return { status: 'ready' as const, detail: '', correctiveAction: 'None.' }; }
  async *request(): AsyncIterable<PiEvent> { yield { type: 'final', text: 'ok' }; }
  async shutdown() { this.shutdownCalls++; }
}
class TrackingResearch implements PiResearchClient {
  readonly personaAppend: string;
  readonly piSettings: PiSettings | undefined;
  shutdownCalls = 0;
  constructor(personaAppend: string, piSettings?: PiSettings) { this.personaAppend = personaAppend; this.piSettings = piSettings; }
  async *requestBody(): AsyncIterable<PiEvent> { yield { type: 'final', text: 'ok' }; }
  async shutdown() { this.shutdownCalls++; }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function readinessSidecar(): Promise<SidecarProcess> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  wss.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'readiness.snapshot', payload: { status: 'ready', stt: 'nemotron-3.5-transformers-fp32-320ms-paced-v1', tts: 'kokoro-82m-onnx-fp32-af-heart-cuda-v1', voiceCatalog: { catalogId: 'sess-catalog', backendId: 'kokoro', modelId: 'kokoro-82m-onnx', runtimeConfigId: 'rc', revision: 'rev', defaultVoiceId: 'af_heart', voices: [{ id: 'af_heart', label: 'af_heart' }, { id: 'af_bella', label: 'Bella' }] } } }));
    socket.on('message', raw => {
      if (Buffer.isBuffer(raw)) return;
      const message = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
      if (message.type === 'stream.open') socket.send(JSON.stringify({ type: 'stream.opened', payload: { streamId: message.payload.streamId } }));
    });
  });
  const close = async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); };
  cleanups.push(close);
  return { child: {} as SidecarProcess['child'], origin: `http://127.0.0.1:${address.port}`, secret: 'sidecar-secret', stop: close };
}

interface SessionHarness { app: FastifyInstance; origin: string; close: () => Promise<void>; response: TrackingPi[]; research: TrackingResearch[]; classifier: TrackingPi[] }
async function build(pi: PiClient): Promise<SessionHarness> {
  const sidecar = await readinessSidecar();
  const response: TrackingPi[] = [];
  const research: TrackingResearch[] = [];
  const classifier: TrackingPi[] = [];
  const app = await buildApp({
    sidecar, createProbeClient: () => pi,
    createResponseClient: (append, piSettings) => { const client = new TrackingPi(append, piSettings); response.push(client); return client; },
    createResearchClient: (append, piSettings) => { const client = new TrackingResearch(append, piSettings); research.push(client); return client; },
    createClassifierClient: piSettings => { const client = new TrackingPi('', piSettings); classifier.push(client); return client; },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  app.setCanonicalOrigin(origin);
  return {
    app, origin, response, research, classifier,
    close: async () => { await app.close(); await sidecar.stop(); },
  };
}

async function bootstrapSession(app: FastifyInstance, origin: string, persona: string, sid: string) {
  const headers = { host: new URL(origin).host, origin, 'content-type': 'application/json' };
  const boot = await fetch(`${origin}/api/bootstrap`, { method: 'POST', headers, body: '{"disclosureAcknowledged":true}' });
  const body = await boot.json() as { capability: string };
  const cookie = boot.headers.get('set-cookie')!.split(';')[0]!;
  const socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
  await new Promise<void>((resolve, reject) => { socket.once('open', () => socket.send(JSON.stringify({ capability: body.capability }))); socket.once('message', (raw) => raw.toString().includes('authenticated') ? resolve() : reject(new Error('not authenticated'))); });
  socket.send(JSON.stringify(command(sid, 'session.start', { sessionSeed: '018f1f32-7abd-7def-8abc-0123456789ab', reasoningMode: 'full', settings: { version: 1, persona, voice: VOICE, pi: { model: 'openai-codex/gpt-5.6-sol', thinkingLevel: 'high' } } })));
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  return { cookie, close: () => new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.close(1000, 'done'); }) };
}

describe('per-session Pi isolation', () => {
  it('creates separate response/research/classifier clients per persona and shuts them all down on stop', async () => {
    const probe: PiClient = { async probe() { return { status: 'ready', detail: '', correctiveAction: 'None.' }; }, async *request() { yield { type: 'final', text: 'ok' }; }, async shutdown() {} };
    const harness = await build(probe);
    const app = harness.app;
    const origin = harness.origin;
    cleanups.push(harness.close);

    const personaA = 'You are Ada, a sharp skeptic.';
    const personaB = 'You are Lin, a gentle storyteller.';
    const sessionA = await bootstrapSession(app, origin, personaA, '018f1f32-7abc-7def-8abc-0123456789a1');
    const sessionB = await bootstrapSession(app, origin, personaB, '018f1f32-7abc-7def-8abc-0123456789a2');

    // Three session-owned clients per browser session, each frozen with the right persona append.
    expect(harness.response).toHaveLength(2);
    expect(harness.research).toHaveLength(2);
    expect(harness.classifier).toHaveLength(2);
    expect(harness.response.map(client => client.personaAppend)).toEqual([
      expect.stringContaining('Ada'), expect.stringContaining('Lin'),
    ]);
    expect(harness.research.map(client => client.personaAppend)).toEqual([
      expect.stringContaining('Ada'), expect.stringContaining('Lin'),
    ]);
    // Classifier clients are persona-neutral (empty append), but share the
    // frozen Pi controls for this session.
    expect(harness.classifier.every(client => client.personaAppend === '')).toBe(true);
    expect([...harness.response, ...harness.research, ...harness.classifier].every(client => client.piSettings?.thinkingLevel === 'high')).toBe(true);
    // No client is shared across sessions.
    expect(new Set(harness.response).size).toBe(2);

    await sessionA.close();
    await sessionB.close();
    await app.close();
    await new Promise(resolve => setTimeout(resolve, 50));

    for (const client of [...harness.response, ...harness.research, ...harness.classifier]) {
      expect(client.shutdownCalls).toBeGreaterThanOrEqual(1);
    }
  });
});
