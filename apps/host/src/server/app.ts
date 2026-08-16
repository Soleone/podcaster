import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { SidecarProcess } from '../sidecar/process.js';
import { sidecarSnapshot } from '../sidecar/process.js';
import { createPiClient, type PiClient, type PiReadiness } from '../pi/PiClient.js';
import { createPiResearchClient, type PiResearchClient } from '../pi/PiResearchClient.js';
import { CLASSIFIER_SYSTEM_PROMPT } from '../session/InterruptionIntentClassifier.js';
import { BrowserSession } from './BrowserSession.js';
import { encodeWav } from '../sidecar/wav.js';
import { synthesizeVoicePreview } from '../sidecar/voice-preview.js';
import { DEFAULT_TTS_MODEL, DEFAULT_VOICE_SPEED_MODIFIER, MAX_VOICE_SPEED_MODIFIER, MIN_VOICE_SPEED_MODIFIER, randomVoicePreviewPhrases } from '@app/contracts';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_DISCONNECT_GRACE_MS = 30_000;
const SOCKET_HEARTBEAT_MS = 15_000;
const COOKIE = 'podcaster_session';
interface Session { capability: string; expiresAt: number; wsAuthenticated: boolean; sockets: Set<WebSocket>; activeSocket: WebSocket | undefined; lastPongAt: number; messageChain: Promise<void>; conversation: BrowserSession | undefined; stopPromise: Promise<void> | undefined; disconnectTimer: NodeJS.Timeout | undefined; }
const unavailablePi: PiClient = {
  async probe() { return { status: 'unavailable', detail: 'Pi is unavailable.', correctiveAction: 'Retry, or use transcript-only mode.' }; },
  async *request() { yield { type: 'error' as const, state: 'unavailable' as const, detail: 'Pi is unavailable.', correctiveAction: 'Continue transcript-only.' }; },
  async shutdown() {},
};
export interface BuildOptions { sidecar: SidecarProcess; pi?: PiClient; researchPi?: PiResearchClient; createResponseClient?: (personaAppend: string) => PiClient; createResearchClient?: (personaAppend: string) => PiResearchClient; createClassifierClient?: () => PiClient; multiPartEnabled?: boolean; webRoot?: string; now?: () => number; sessionTtlMs?: number; sessionDisconnectGraceMs?: number; voicePreview?: (input: { catalogId: string; voiceId: string; speedModifier?: number; backendId?: string; modelId?: string; phrases: string[] }, signal: AbortSignal) => Promise<{ pcm16: Int16Array; sampleRate: number }>; }
function sameSecret(a: string, b: string): boolean { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function cookieValue(header: string | undefined): string | undefined { return header?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1); }

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 16 * 1024, logger: false, forceCloseConnections: true });
  // Per-session client factories: session-owned Pi children are created lazily at
  // validated session.start, each frozen with the session's persona append.
  const createResponseClient = options.createResponseClient ?? ((personaAppend: string) => createPiClient({ personaAppend }));
  const createResearchClient = options.createResearchClient ?? ((personaAppend: string) => createPiResearchClient({ personaAppend }));
  const createClassifierClient = options.createClassifierClient ?? (() => createPiClient({ systemPrompt: CLASSIFIER_SYSTEM_PROMPT }));
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const sessionDisconnectGraceMs = options.sessionDisconnectGraceMs ?? SESSION_DISCONNECT_GRACE_MS;
  // Keep previews bounded per host process. The sidecar accepts a dedicated
  // TTS-only preview stream alongside the session capture stream.
  let voicePreviewInFlight = false;
  const voicePreview = options.voicePreview ?? (async (input: { catalogId: string; voiceId: string; speedModifier?: number; backendId?: string; modelId?: string; phrases: string[] }, signal: AbortSignal) => {
    const result = await synthesizeVoicePreview(options.sidecar, input, { signal });
    return { pcm16: result.pcm16, sampleRate: result.sampleRate };
  });
  const shutdowns = new Set<Promise<void>>();
  const stopConversation = (session: Session): Promise<void> => {
    if (session.disconnectTimer) { clearTimeout(session.disconnectTimer); session.disconnectTimer = undefined; }
    if (session.stopPromise) return session.stopPromise;
    const conversation = session.conversation;
    const work = (async () => { await conversation?.stop(); })();
    session.stopPromise = work;
    shutdowns.add(work);
    void work.finally(() => {
      shutdowns.delete(work);
      if (session.stopPromise === work) session.stopPromise = undefined;
    });
    return work;
  };
  const scheduleConversationStop = (session: Session): void => {
    if (session.disconnectTimer || session.stopPromise || session.wsAuthenticated || !session.conversation) return;
    session.disconnectTimer = setTimeout(() => {
      session.disconnectTimer = undefined;
      if (!session.wsAuthenticated) void stopConversation(session);
    }, Math.max(0, sessionDisconnectGraceMs));
    session.disconnectTimer.unref?.();
  };
  // Readiness polls every couple of seconds, but a Pi probe is a full provider
  // round trip. Never make the browser wait for that probe: share one in-flight
  // probe, return a checking snapshot immediately, and reuse fresh results.
  const PROBE_TTL_MS = 10_000;
  const piChecking: PiReadiness = { status: 'unavailable', detail: 'Pi is still starting.', correctiveAction: 'You can start now; the first response may take a little longer.' };
  let probeValue: PiReadiness | undefined;
  let probeAt = 0;
  let probePromise: Promise<PiReadiness> | undefined;
  const probePi = (): Promise<PiReadiness> => {
    if (probeValue && now() - probeAt < PROBE_TTL_MS) return Promise.resolve(probeValue);
    if (!probePromise) {
      probePromise = (options.pi ?? unavailablePi).probe()
        .catch(() => unavailablePi.probe())
        .then(value => { probeAt = now(); probeValue = value; return value; })
        .finally(() => { probePromise = undefined; });
    }
    return Promise.resolve(piChecking);
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
    const [snapshot, pi] = await Promise.all([sidecarSnapshot(options.sidecar), probePi()]);
    const audioReady = Boolean(snapshot?.status === 'ready' && snapshot.voiceCatalog !== undefined);
    const unavailableTts = snapshot?.ttsModels?.filter(model => model.status === 'unavailable') ?? [];
    const voiceOutputReason = audioReady
      ? unavailableTts.length > 0
        ? `Kokoro is ready. ${unavailableTts.map(model => `${model.label} is unavailable`).join('; ')}. Kokoro remains the local fallback.`
        : 'Your local audio engine is running.'
      : "Your local audio engine isn't running yet.";
    return {
      capabilities: [
        {
          id: 'voice_input', label: 'Voice input',
          state: microphoneGranted ? 'ready' : 'needs_action',
          reason: microphoneGranted ? 'Microphone access is allowed.' : 'Microphone access is needed before capture.',
          action: microphoneGranted ? 'No action needed.' : 'Enable the microphone below.',
        },
        { id: 'voice_output', label: 'Voice output', state: audioReady ? 'ready' : 'unavailable', reason: voiceOutputReason, action: audioReady ? (unavailableTts.length > 0 ? 'Choose Kokoro in Voice settings, or install the unavailable model runtime.' : 'No action needed.') : 'Wait a moment, then check again.' },
        { id: 'cloud_reasoning', label: 'Cloud reasoning', state: pi.status === 'ready' ? 'ready' : 'needs_action', reason: pi.detail, action: pi.correctiveAction },
      ], sidecar: audioReady ? 'ready' : 'unavailable', reasoning: pi === piChecking ? 'checking' : pi.status,
      ...(snapshot?.voiceCatalog ? { voiceCatalog: snapshot.voiceCatalog } : {}),
      ...(snapshot?.ttsModels ? { ttsModels: snapshot.ttsModels } : {}),
      ...(snapshot?.activeTtsModel ? { activeTtsModel: snapshot.activeTtsModel } : {}),
    };
  });
  app.post('/api/voice-preview', { schema: { body: { type: 'object', additionalProperties: false, required: ['voiceId'], properties: { voiceId: { type: 'string', minLength: 1, maxLength: 128 }, catalogId: { type: 'string', minLength: 1, maxLength: 128 }, backendId: { type: 'string', minLength: 1, maxLength: 128 }, modelId: { type: 'string', minLength: 1, maxLength: 256 }, speedModifier: { type: 'number', minimum: MIN_VOICE_SPEED_MODIFIER, maximum: MAX_VOICE_SPEED_MODIFIER } } } } }, async (request, reply) => {
    if (!authenticate(request)) return reply.code(401).send({ error: 'unauthorized' });
    const { voiceId, catalogId, backendId = DEFAULT_TTS_MODEL.backendId, modelId = DEFAULT_TTS_MODEL.modelId, speedModifier = DEFAULT_VOICE_SPEED_MODIFIER } = request.body as { voiceId: string; catalogId?: string; backendId?: string; modelId?: string; speedModifier?: number };
    const snapshot = await sidecarSnapshot(options.sidecar);
    if (!snapshot || snapshot.status !== 'ready') return reply.code(409).send({ error: 'voice_catalog_unavailable' });
    const descriptor = snapshot.ttsModels?.find(model => model.backendId === backendId && model.modelId === modelId);
    const selectedCatalog = descriptor?.voiceCatalog ?? (backendId === DEFAULT_TTS_MODEL.backendId && modelId === DEFAULT_TTS_MODEL.modelId ? snapshot.voiceCatalog : undefined);
    if (descriptor?.status === 'unavailable' || !selectedCatalog) return reply.code(409).send({ error: 'tts_model_unavailable' });
    if (catalogId !== undefined && selectedCatalog.catalogId !== catalogId) return reply.code(422).send({ error: 'catalog_mismatch' });
    if (!selectedCatalog.voices.some(voice => voice.id === voiceId)) return reply.code(422).send({ error: 'unknown_voice' });
    const speed = descriptor?.speed ?? selectedCatalog.speed;
    if (speed && (speedModifier < speed.min || speedModifier > speed.max || (!speed.supported && speedModifier !== speed.default))) return reply.code(422).send({ error: 'unsupported_speed' });
    if (voicePreviewInFlight) return reply.code(429).send({ error: 'preview_in_flight' });
    voicePreviewInFlight = true;
    // Abort synthesis when the browser disconnects; request.raw.signal is not
    // available on the current Node types, so wire the stream event directly.
    const controller = new AbortController();
    const onAborted = () => controller.abort();
    request.raw.once('aborted', onAborted);
    try {
      const { pcm16, sampleRate } = await voicePreview({ catalogId: selectedCatalog.catalogId, voiceId, speedModifier, backendId, modelId, phrases: randomVoicePreviewPhrases() }, controller.signal);
      const wav = encodeWav(pcm16, sampleRate);
      reply.header('content-type', 'audio/wav').header('cache-control', 'no-store');
      return reply.send(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
    } catch {
      // A preview is isolated from the session stream. If the local engine is
      // actually unavailable (or the TTS adapter is poisoned), report that
      // without disturbing the live session.
      return reply.code(503).send({ error: 'preview_unavailable' });
    } finally {
      request.raw.removeListener('aborted', onAborted);
      voicePreviewInFlight = false;
    }
  });
  app.post('/api/bootstrap', { schema: { body: { type: 'object', additionalProperties: false, required: ['disclosureAcknowledged'], properties: { disclosureAcknowledged: { const: true } } } } }, async (_request, reply) => {
    const id = randomBytes(32).toString('base64url'); const capability = randomBytes(32).toString('base64url');
    sessions.set(id, { capability, expiresAt: now() + sessionTtlMs, wsAuthenticated: false, sockets: new Set(), activeSocket: undefined, lastPongAt: 0, messageChain: Promise.resolve(), conversation: undefined, stopPromise: undefined, disconnectTimer: undefined });
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
    let pending = true; let expiryTimer: NodeJS.Timeout | undefined;
    let heartbeatAlive = true;
    const heartbeatTimer = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      if (!heartbeatAlive) { socket.terminate(); return; }
      heartbeatAlive = false;
      // Hold host output while this ping is outstanding. If the path is dead,
      // frames generated during the missed-heartbeat window are queued for the
      // replacement socket instead of being written into a black hole.
      if (session?.activeSocket === socket) session.conversation?.detachSocket(socket);
      socket.ping();
    }, SOCKET_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
    socket.on('pong', () => {
      heartbeatAlive = true;
      if (session?.activeSocket === socket) {
        session.lastPongAt = Date.now();
        session.conversation?.attachSocket(socket);
      }
    });
    const timer = setTimeout(() => socket.close(1008, 'authentication required'), 1000);
    socket.on('close', () => {
      clearTimeout(timer);
      clearTimeout(heartbeatTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      session?.sockets.delete(socket);
      if (session?.activeSocket === socket) {
        session.activeSocket = undefined;
        session.lastPongAt = 0;
      }
      if (session && session.sockets.size === 0) {
        session.wsAuthenticated = false;
        session.conversation?.detachSocket(socket);
        scheduleConversationStop(session);
      }
    });
    socket.on('message', (raw, binary) => {
      if (!pending) {
        if (!session || session.expiresAt <= now() || !id || sessions.get(id) !== session) { socket.close(1008, 'session expired'); return; }
        const size = Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength;
        if (size > 64 * 1024) { socket.close(1009, 'frame too large'); return; }
        const conversation = session.conversation;
        if (!conversation) { socket.close(1011, 'session composition missing'); return; }
        session.messageChain = session.messageChain.then(() => conversation.handle(raw, binary)).catch(() => socket.close(1011, 'conversation failure'));
        return;
      }
      pending = false; clearTimeout(timer);
      if (binary) { socket.close(1008, 'invalid authentication'); return; }
      let value: unknown; try { value = JSON.parse(raw.toString()); } catch { socket.close(1008, 'invalid authentication'); return; }
      const cap = typeof value === 'object' && value !== null ? (value as { capability?: unknown }).capability : undefined;
      if (!session || session.expiresAt <= now() || typeof cap !== 'string' || !sameSecret(cap, session.capability)) { socket.close(1008, 'invalid authentication'); return; }
      // A dead TCP path can leave the old ws object OPEN until the heartbeat
      // timeout. Once it has missed a full heartbeat interval, let the same
      // capability take over instead of making the browser wait for that stale
      // object to be terminated.
      if (session.wsAuthenticated && session.activeSocket && Date.now() - session.lastPongAt > SOCKET_HEARTBEAT_MS) {
        const stale = session.activeSocket;
        stale.terminate();
        session.sockets.delete(stale);
        session.conversation?.detachSocket(stale);
        session.activeSocket = undefined;
        session.lastPongAt = 0;
        session.wsAuthenticated = false;
      }
      if (session.wsAuthenticated || session.sockets.size > 0) { socket.close(1008, 'invalid authentication'); return; }
      if (session.disconnectTimer) { clearTimeout(session.disconnectTimer); session.disconnectTimer = undefined; }
      session.wsAuthenticated = true; session.sockets.add(socket); session.activeSocket = socket; session.lastPongAt = Date.now();
      if (!session.conversation || session.conversation.isStopped()) {
        session.stopPromise = undefined;
        session.conversation = new BrowserSession(socket, options.sidecar, {
          multiPartEnabled: options.multiPartEnabled !== false,
          createResponseClient,
          createResearchClient,
          createClassifierClient,
        });
      }
      expiryTimer = setTimeout(() => socket.close(1008, 'session expired'), Math.max(0, session.expiresAt - now()));
      expiryTimer.unref?.();
      socket.send(JSON.stringify({ type: 'authenticated' }));
      session.conversation.attachSocket(socket);
    });
  });
  await app.register(fastifyStatic, { root: resolve(options.webRoot ?? 'apps/web/dist'), wildcard: false });
  app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  return app;
}

declare module 'fastify' { interface FastifyInstance { setCanonicalOrigin(value: string): void; } }
