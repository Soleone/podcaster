import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { SidecarProcess } from '../sidecar/process.js';
import { sidecarHealth } from '../sidecar/process.js';
import type { PiClient, PiReadiness } from '../pi/PiClient.js';
import { BrowserSession } from './BrowserSession.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'podcaster_session';
interface Session { capability: string; expiresAt: number; wsAuthenticated: boolean; sockets: Set<WebSocket>; conversation?: BrowserSession; stopPromise?: Promise<void>; }
const unavailablePi: PiClient = {
  async probe() { return { status: 'unavailable', detail: 'Pi is unavailable.', correctiveAction: 'Retry, or use transcript-only mode.' }; },
  async *request() { yield { type: 'error' as const, state: 'unavailable' as const, detail: 'Pi is unavailable.', correctiveAction: 'Continue transcript-only.' }; },
  async shutdown() {},
};
export interface BuildOptions { sidecar: SidecarProcess; pi?: PiClient; webRoot?: string; now?: () => number; sessionTtlMs?: number; }
function sameSecret(a: string, b: string): boolean { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function cookieValue(header: string | undefined): string | undefined { return header?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1); }

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 16 * 1024, logger: false, forceCloseConnections: true });
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const shutdowns = new Set<Promise<void>>();
  const stopConversation = (session: Session): Promise<void> => {
    if (session.stopPromise) return session.stopPromise;
    const work = (async () => { await session.conversation?.stop(); })();
    session.stopPromise = work;
    shutdowns.add(work);
    void work.finally(() => shutdowns.delete(work));
    return work;
  };
  // Readiness polls every couple of seconds and each Pi probe is a full provider
  // round trip serialized behind the client mutex, so share one in-flight probe
  // and reuse fresh results instead of queueing probes that outlive the request.
  const PROBE_TTL_MS = 10_000;
  let probeValue: PiReadiness | undefined;
  let probeAt = 0;
  let probePromise: Promise<PiReadiness> | undefined;
  const probePi = (): Promise<PiReadiness> => {
    if (probeValue && now() - probeAt < PROBE_TTL_MS) return Promise.resolve(probeValue);
    probePromise ??= (options.pi ?? unavailablePi).probe().finally(() => { probePromise = undefined; });
    return probePromise.then(value => { probeAt = now(); probeValue = value; return value; });
  };
  let origin = '';
  app.decorate('setCanonicalOrigin', (value: string) => { origin = value; });
  app.addHook('onRequest', async (request, reply) => {
    if (!origin && (request.url.startsWith('/api/') || request.url.startsWith('/ws'))) return reply.code(503).send({ error: 'origin_not_ready' });
    if (!origin) return;
    const expectedHost = new URL(origin).host;
    if (request.headers.host !== expectedHost) return reply.code(421).send({ error: 'invalid_host' });
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      if (request.headers.origin !== origin) return reply.code(403).send({ error: 'invalid_origin' });
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
    });
    return payload;
  });
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
    preClose(done) {
      const conversations = [...sessions.values()].map(session => stopConversation(session));
      void Promise.allSettled(conversations).then(() => {
        for (const client of this.websocketServer.clients) client.terminate();
        done();
      });
    },
  });
  app.addHook('onClose', async () => { await Promise.allSettled([...shutdowns]); });
  const authenticate = (request: FastifyRequest): Session | undefined => {
    const id = cookieValue(request.headers.cookie); const capability = request.headers['x-podcaster-capability'];
    if (!id || typeof capability !== 'string') return;
    const session = sessions.get(id);
    if (!session || session.expiresAt <= now() || !sameSecret(session.capability, capability)) return;
    return session;
  };
  app.post('/api/readiness', async (request, reply) => {
    if (!authenticate(request)) return reply.code(401).send({ error: 'unauthorized' });
    // The browser owns microphone permission; the server cannot observe it, so the
    // readiness screen reports the client's granted state instead of always showing
    // a perpetual needs-action warning for voice input.
    const body = (request.body ?? {}) as { microphoneGranted?: unknown };
    const microphoneGranted = body.microphoneGranted === true;
    const [audioReady, pi] = await Promise.all([sidecarHealth(options.sidecar), probePi()]);
    return {
      capabilities: [
        {
          id: 'voice_input', label: 'Voice input',
          state: microphoneGranted ? 'ready' : 'needs_action',
          reason: microphoneGranted ? 'Microphone permission is granted.' : 'Microphone permission is required before capture.',
          action: microphoneGranted ? 'No action needed.' : 'Enable microphone after acknowledging the disclosure.',
        },
        { id: 'voice_output', label: 'Voice output', state: audioReady ? 'ready' : 'unavailable', reason: audioReady ? 'Selected Nemotron and Kokoro runtime is ready.' : 'Selected local audio runtime is not ready.', action: audioReady ? 'No action needed.' : 'Wait for selected model startup or restart the host.' },
        { id: 'cloud_reasoning', label: 'Cloud reasoning', state: pi.status === 'ready' ? 'ready' : 'needs_action', reason: pi.detail, action: pi.correctiveAction },
      ], sidecar: audioReady ? 'ready' : 'unavailable', reasoning: pi.status,
    };
  });
  app.post('/api/bootstrap', { schema: { body: { type: 'object', additionalProperties: false, required: ['disclosureAcknowledged'], properties: { disclosureAcknowledged: { const: true } } } } }, async (_request, reply) => {
    const id = randomBytes(32).toString('base64url'); const capability = randomBytes(32).toString('base64url');
    sessions.set(id, { capability, expiresAt: now() + sessionTtlMs, wsAuthenticated: false, sockets: new Set() });
    reply.header('set-cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict`);
    return { capability, expiresInSeconds: sessionTtlMs / 1000 };
  });
  app.post('/api/stop', async (request, reply) => {
    const id = cookieValue(request.headers.cookie); const session = authenticate(request);
    if (!session || !id) return reply.code(401).send({ error: 'unauthorized' });
    sessions.delete(id);
    await stopConversation(session);
    for (const socket of session.sockets) socket.close(1008, 'session stopped');
    return { stopped: true };
  });
  app.get('/ws', { websocket: true }, (socket, request) => {
    const id = cookieValue(request.headers.cookie); const session = id ? sessions.get(id) : undefined;
    let pending = true; let expiryTimer: NodeJS.Timeout | undefined; let messageChain = Promise.resolve();
    const timer = setTimeout(() => socket.close(1008, 'authentication required'), 1000);
    socket.on('close', () => { clearTimeout(timer); if (expiryTimer) clearTimeout(expiryTimer); session?.sockets.delete(socket); if (session) void stopConversation(session); });
    socket.on('message', (raw, binary) => {
      if (!pending) {
        if (!session || session.expiresAt <= now() || !id || sessions.get(id) !== session) { socket.close(1008, 'session expired'); return; }
        const size = Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength;
        if (size > 64 * 1024) { socket.close(1009, 'frame too large'); return; }
        const conversation = session.conversation;
        if (!conversation) { socket.close(1011, 'session composition missing'); return; }
        messageChain = messageChain.then(() => conversation.handle(raw, binary)).catch(() => socket.close(1011, 'conversation failure'));
        return;
      }
      pending = false; clearTimeout(timer);
      if (binary) { socket.close(1008, 'invalid authentication'); return; }
      let value: unknown; try { value = JSON.parse(raw.toString()); } catch { socket.close(1008, 'invalid authentication'); return; }
      const cap = typeof value === 'object' && value !== null ? (value as { capability?: unknown }).capability : undefined;
      if (!session || session.expiresAt <= now() || session.wsAuthenticated || typeof cap !== 'string' || !sameSecret(cap, session.capability)) { socket.close(1008, 'invalid authentication'); return; }
      session.wsAuthenticated = true; session.sockets.add(socket);
      session.conversation = new BrowserSession(socket, options.sidecar, options.pi ?? unavailablePi);
      expiryTimer = setTimeout(() => socket.close(1008, 'session expired'), Math.max(0, session.expiresAt - now()));
      socket.send(JSON.stringify({ type: 'authenticated' }));
    });
  });
  await app.register(fastifyStatic, { root: resolve(options.webRoot ?? 'apps/web/dist'), wildcard: false });
  app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  return app;
}

declare module 'fastify' { interface FastifyInstance { setCanonicalOrigin(value: string): void; } }
