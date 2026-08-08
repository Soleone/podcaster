import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { SidecarProcess } from '../sidecar/process.js';
import { sidecarHealth } from '../sidecar/process.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'podcaster_session';
interface Session { capability: string; expiresAt: number; wsAuthenticated: boolean; sockets: Set<WebSocket>; }
export interface BuildOptions { sidecar: SidecarProcess; webRoot?: string; now?: () => number; sessionTtlMs?: number; }
function sameSecret(a: string, b: string): boolean { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function cookieValue(header: string | undefined): string | undefined { return header?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1); }

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 16 * 1024, logger: false, forceCloseConnections: true });
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
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
      for (const client of this.websocketServer.clients) client.terminate();
      done();
    },
  });
  const authenticate = (request: FastifyRequest): Session | undefined => {
    const id = cookieValue(request.headers.cookie); const capability = request.headers['x-podcaster-capability'];
    if (!id || typeof capability !== 'string') return;
    const session = sessions.get(id);
    if (!session || session.expiresAt <= now() || !sameSecret(session.capability, capability)) return;
    return session;
  };
  app.post('/api/readiness', async (request, reply) => {
    if (!authenticate(request)) return reply.code(401).send({ error: 'unauthorized' });
    return {
      capabilities: [
        { id: 'voice_input', label: 'Voice input', state: 'needs_action', reason: 'Microphone is not enabled in this stub.', action: 'Enable microphone after acknowledging the disclosure.' },
        { id: 'voice_output', label: 'Voice output', state: 'ready', reason: 'Local voice output stub is available.', action: 'No action needed.' },
        { id: 'cloud_reasoning', label: 'Cloud reasoning', state: 'needs_action', reason: 'Pi/Codex is not connected in Milestone 0.', action: 'Pi sign-in will be added in a later milestone.' },
      ], sidecar: await sidecarHealth(options.sidecar) ? 'ready' : 'unavailable',
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
    for (const socket of session.sockets) socket.close(1008, 'session stopped');
    return { stopped: true };
  });
  app.get('/ws', { websocket: true }, (socket, request) => {
    const id = cookieValue(request.headers.cookie); const session = id ? sessions.get(id) : undefined;
    let pending = true; let expiryTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => socket.close(1008, 'authentication required'), 1000);
    socket.on('close', () => { clearTimeout(timer); if (expiryTimer) clearTimeout(expiryTimer); session?.sockets.delete(socket); });
    socket.on('message', (raw, binary) => {
      if (!pending) {
        if (!session || session.expiresAt <= now() || !id || sessions.get(id) !== session) { socket.close(1008, 'session expired'); return; }
        const size = Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength;
        if (binary && size > 64 * 1024) socket.close(1009, 'frame too large');
        return;
      }
      pending = false; clearTimeout(timer);
      if (binary) { socket.close(1008, 'invalid authentication'); return; }
      let value: unknown; try { value = JSON.parse(raw.toString()); } catch { socket.close(1008, 'invalid authentication'); return; }
      const cap = typeof value === 'object' && value !== null ? (value as { capability?: unknown }).capability : undefined;
      if (!session || session.expiresAt <= now() || session.wsAuthenticated || typeof cap !== 'string' || !sameSecret(cap, session.capability)) { socket.close(1008, 'invalid authentication'); return; }
      session.wsAuthenticated = true; session.sockets.add(socket);
      expiryTimer = setTimeout(() => socket.close(1008, 'session expired'), Math.max(0, session.expiresAt - now()));
      socket.send(JSON.stringify({ type: 'authenticated' }));
    });
  });
  await app.register(fastifyStatic, { root: resolve(options.webRoot ?? 'apps/web/dist'), wildcard: false });
  app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  return app;
}

declare module 'fastify' { interface FastifyInstance { setCanonicalOrigin(value: string): void; } }
