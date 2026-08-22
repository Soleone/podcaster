import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { SidecarProcess, SidecarRuntimeSnapshot } from '../sidecar/process.js';
import { sidecarSnapshot } from '../sidecar/process.js';
import { createPiClient, PI_PROBE_DEADLINE_MS, type PiClient } from '../pi/PiClient.js';
import { createPiResearchClient, type PiResearchClient } from '../pi/PiResearchClient.js';
import { PI_CHECKING, PiReadinessProbe } from '../pi/readiness-probe.js';
import { CLASSIFIER_SYSTEM_PROMPT } from '../session/InterruptionIntentClassifier.js';
import { BrowserSession } from './BrowserSession.js';
import { encodeWav } from '../sidecar/wav.js';
import { synthesizeVoicePreview } from '../sidecar/voice-preview.js';
import { enrollCustomVoiceInSidecar, removeCustomVoiceFromSidecar } from '../sidecar/voice-enrollment.js';
import {
  CUSTOM_VOICE_SAMPLE_RATE,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_SPEED_MODIFIER,
  isValidPiSettings,
  MAX_CUSTOM_VOICE_ENROLLMENT_BODY,
  MAX_CUSTOM_VOICE_MS,
  MAX_VOICE_TONE_PROMPT_BYTES,
  MIN_CUSTOM_VOICE_MS,
  MAX_VOICE_SPEED_MODIFIER,
  MIN_VOICE_SPEED_MODIFIER,
  QWEN_VOICE_LANGUAGES,
  customVoiceId,
  isValidCustomVoiceId,
  normalizeCustomVoiceName,
  randomVoicePreviewPhrases,
  type PiSettings,
  type QwenVoiceLanguage,
  type TtsModelSelection,
} from '@app/contracts';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_DISCONNECT_GRACE_MS = 30_000;
const SOCKET_HEARTBEAT_MS = 15_000;
const COOKIE = 'podcaster_session';
interface Session {
  capability: string;
  expiresAt: number;
  wsAuthenticated: boolean;
  sockets: Set<WebSocket>;
  activeSocket: WebSocket | undefined;
  lastPongAt: number;
  messageChain: Promise<void>;
  conversation: BrowserSession | undefined;
  stopPromise: Promise<void> | undefined;
  disconnectTimer: NodeJS.Timeout | undefined;
}
export interface BuildOptions {
  sidecar: SidecarProcess;
  createProbeClient?: (piSettings: PiSettings) => PiClient;
  createResponseClient?: (personaAppend: string, piSettings?: PiSettings) => PiClient;
  createResearchClient?: (personaAppend: string, piSettings?: PiSettings) => PiResearchClient;
  createClassifierClient?: (piSettings?: PiSettings) => PiClient;
  multiPartEnabled?: boolean;
  webRoot?: string;
  now?: () => number;
  sessionTtlMs?: number;
  sessionDisconnectGraceMs?: number;
  voicePreview?: (
    input: {
      catalogId: string;
      voiceId: string;
      speedModifier?: number;
      tonePrompt?: string;
      language?: QwenVoiceLanguage;
      backendId?: string;
      modelId?: string;
      phrases: string[];
    },
    signal: AbortSignal,
  ) => Promise<{ pcm16: Int16Array; sampleRate: number }>;
}
function sameSecret(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function cookieValue(header: string | undefined): string | undefined {
  return header
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
}
function parseTtsModel(value: unknown): TtsModelSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model = value as { backendId?: unknown; modelId?: unknown };
  if (
    typeof model.backendId !== 'string' ||
    model.backendId.length === 0 ||
    typeof model.modelId !== 'string' ||
    model.modelId.length === 0
  )
    return undefined;
  return { backendId: model.backendId, modelId: model.modelId };
}
function sameTtsModel(left: TtsModelSelection, right: TtsModelSelection): boolean {
  return left.backendId === right.backendId && left.modelId === right.modelId;
}

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 16 * 1024, logger: false, forceCloseConnections: true });
  // Per-session client factories: session-owned Pi children are created lazily at
  // validated session.start, each frozen with the session's persona append.
  // Readiness only needs to verify that the selected model can answer. Keep
  // the probe cheap and bounded; live response clients still use the user's
  // configured thinking level.
  const createProbeClient =
    options.createProbeClient ??
    ((piSettings: PiSettings) =>
      createPiClient({ model: piSettings.model, thinkingLevel: 'off', probeDeadlineMs: PI_PROBE_DEADLINE_MS }));
  const createResponseClient =
    options.createResponseClient ??
    ((personaAppend: string, piSettings?: PiSettings) =>
      createPiClient({
        personaAppend,
        ...(piSettings ? { model: piSettings.model, thinkingLevel: piSettings.thinkingLevel } : {}),
      }));
  const createResearchClient =
    options.createResearchClient ??
    ((personaAppend: string, piSettings?: PiSettings) =>
      createPiResearchClient({
        personaAppend,
        ...(piSettings ? { model: piSettings.model, thinkingLevel: piSettings.thinkingLevel } : {}),
      }));
  const createClassifierClient =
    options.createClassifierClient ??
    ((piSettings?: PiSettings) =>
      createPiClient({
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        ...(piSettings ? { model: piSettings.model, thinkingLevel: piSettings.thinkingLevel } : {}),
      }));
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const piProbe = new PiReadinessProbe({ createClient: createProbeClient, now });
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const sessionDisconnectGraceMs = options.sessionDisconnectGraceMs ?? SESSION_DISCONNECT_GRACE_MS;
  // Keep previews bounded per host process. The sidecar accepts a dedicated
  // TTS-only preview stream alongside the session capture stream.
  let voicePreviewInFlight = false;
  let voiceEnrollmentInFlight = false;
  const voicePreview =
    options.voicePreview ??
    (async (
      input: {
        catalogId: string;
        voiceId: string;
        speedModifier?: number;
        tonePrompt?: string;
        language?: QwenVoiceLanguage;
        backendId?: string;
        modelId?: string;
        phrases: string[];
      },
      signal: AbortSignal,
    ) => {
      const result = await synthesizeVoicePreview(options.sidecar, input, { signal });
      return { pcm16: result.pcm16, sampleRate: result.sampleRate };
    });
  const shutdowns = new Set<Promise<void>>();
  const stopConversation = (session: Session): Promise<void> => {
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
    }
    if (session.stopPromise) return session.stopPromise;
    const conversation = session.conversation;
    const work = (async () => {
      await conversation?.stop();
    })();
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
    session.disconnectTimer = setTimeout(
      () => {
        session.disconnectTimer = undefined;
        if (!session.wsAuthenticated) void stopConversation(session);
      },
      Math.max(0, sessionDisconnectGraceMs),
    );
    session.disconnectTimer.unref?.();
  };
  // Readiness polls every couple of seconds. A single missed loopback health
  // response is not evidence that a loaded audio runtime disappeared, so retain
  // the last valid snapshot briefly while later polls confirm or clear the miss.
  const SIDECAR_SNAPSHOT_GRACE_MS = 15_000;
  let sidecarValue: SidecarRuntimeSnapshot | undefined;
  let sidecarAt = 0;
  let sidecarPromise: Promise<SidecarRuntimeSnapshot | undefined> | undefined;
  const snapshotSidecar = async (): Promise<SidecarRuntimeSnapshot | undefined> => {
    if (!sidecarPromise) {
      sidecarPromise = sidecarSnapshot(options.sidecar)
        .then((value) => {
          if (value) {
            sidecarValue = value;
            sidecarAt = now();
          }
          return value;
        })
        .finally(() => {
          sidecarPromise = undefined;
        });
    }
    const value = await sidecarPromise;
    return value ?? (sidecarValue && now() - sidecarAt < SIDECAR_SNAPSHOT_GRACE_MS ? sidecarValue : undefined);
  };

  // A Pi probe is a full provider round trip. The settings-keyed owner keeps
  // it asynchronous to browser polling while isolating cache and lifecycle
  // state for the selected model/thinking tuple.
  const probePi = (piSettings: PiSettings) => piProbe.probe(piSettings);
  let origin = '';
  app.decorate('setCanonicalOrigin', (value: string) => {
    origin = value;
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!origin && (request.url.startsWith('/api/') || request.url.startsWith('/ws')))
      return reply.code(503).send({ error: 'origin_not_ready' });
    if (!origin) return;
    const expectedHost = new URL(origin).host;
    if (request.headers.host !== expectedHost) return reply.code(421).send({ error: 'invalid_host' });
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      if (request.headers.origin !== origin) return reply.code(403).send({ error: 'invalid_origin' });
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    });
    return payload;
  });
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
    preClose(done) {
      const conversations = [...sessions.values()].map((session) => stopConversation(session));
      void Promise.allSettled(conversations).then(() => {
        for (const client of this.websocketServer.clients) client.terminate();
        done();
      });
    },
  });
  app.addHook('onClose', async () => {
    await Promise.allSettled([...shutdowns, piProbe.shutdown()]);
  });
  const authenticate = (request: FastifyRequest): Session | undefined => {
    const id = cookieValue(request.headers.cookie);
    const capability = request.headers['x-podcaster-capability'];
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
    const body = (
      request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}
    ) as { microphoneGranted?: unknown; ttsModel?: unknown; selectedModel?: unknown; pi?: unknown };
    if (!isValidPiSettings(body.pi)) return reply.code(422).send({ error: 'invalid_pi_settings' });
    const piSettings: PiSettings = { model: body.pi.model, thinkingLevel: body.pi.thinkingLevel };
    const microphoneGranted = body.microphoneGranted === true;
    const [snapshot, pi] = await Promise.all([snapshotSidecar(), probePi(piSettings)]);
    const requestedModel =
      parseTtsModel(body.ttsModel ?? body.selectedModel) ?? snapshot?.activeTtsModel ?? DEFAULT_TTS_MODEL;
    const descriptor = snapshot?.ttsModels?.find((model) => sameTtsModel(model, requestedModel));
    const selectedCatalog =
      descriptor?.status === 'ready'
        ? descriptor.voiceCatalog
        : !descriptor && sameTtsModel(requestedModel, DEFAULT_TTS_MODEL)
          ? snapshot?.voiceCatalog
          : undefined;
    const activeReady = Boolean(
      snapshot?.status === 'ready' && selectedCatalog && (descriptor === undefined || descriptor.status === 'ready'),
    );
    const responseCatalog = selectedCatalog ?? snapshot?.voiceCatalog;
    const activeLabel =
      descriptor?.label ??
      (sameTtsModel(requestedModel, DEFAULT_TTS_MODEL)
        ? 'Kokoro'
        : `${requestedModel.backendId} · ${requestedModel.modelId}`);
    const unavailableTts = snapshot?.ttsModels?.filter((model) => model.status === 'unavailable') ?? [];
    const voiceOutputReason = activeReady
      ? unavailableTts.length > 0
        ? `${activeLabel} is ready. ${unavailableTts.map((model) => `${model.label} is unavailable`).join('; ')}. Kokoro remains the local fallback.`
        : `${activeLabel} is ready. Your local audio engine is running.`
      : descriptor?.status === 'unavailable'
        ? `${activeLabel} is unavailable. ${descriptor.reason ?? 'Install its local runtime or choose another backend.'}`
        : `${activeLabel} is not available from the local audio engine yet.`;
    const warmup = snapshot?.warmup ?? {
      vad: snapshot?.status === 'ready' ? ('ready' as const) : ('starting' as const),
      tts: snapshot?.status === 'ready' ? ('ready' as const) : ('starting' as const),
    };
    const checkState = (
      state: 'starting' | 'warming' | 'ready' | 'failed',
    ): 'starting' | 'warming' | 'ready' | 'unavailable' => (state === 'failed' ? 'unavailable' : state);
    const audioChecks = [
      {
        label: 'Microphone',
        state: microphoneGranted ? ('ready' as const) : ('needs_action' as const),
        detail: microphoneGranted ? 'Permission granted.' : 'Permission is required before capture can start.',
      },
      {
        label: 'Speech detection',
        state: checkState(warmup.vad),
        detail: warmup.vad === 'ready' ? 'VAD is ready.' : 'VAD is warming up.',
      },
      {
        label: 'Voice engine',
        state: activeReady
          ? checkState(warmup.tts)
          : snapshot?.status === 'starting'
            ? ('starting' as const)
            : ('unavailable' as const),
        detail: activeReady
          ? `${activeLabel} is ${warmup.tts === 'ready' ? 'ready' : 'warming up'}.`
          : voiceOutputReason,
      },
    ];
    const audioReadyChecks = audioChecks.filter((check) => check.state === 'ready').length;
    const audioOperational = activeReady && warmup.vad === 'ready' && warmup.tts === 'ready';
    const audioService = !snapshot
      ? {
          state: 'unavailable' as const,
          label: 'Audio server',
          detail: 'The local audio server could not be reached.',
          correctiveAction: 'Retry the readiness check.',
          checks: audioChecks,
        }
      : snapshot.status === 'starting'
        ? {
            state: 'starting' as const,
            label: 'Audio server',
            detail: 'The audio server is loading its speech models.',
            correctiveAction: 'Keep this page open while the local runtime starts.',
            progress: Math.round((audioReadyChecks / audioChecks.length) * 100),
            checks: audioChecks,
          }
        : snapshot.status === 'failed'
          ? {
              state: 'unavailable' as const,
              label: 'Audio server',
              detail: 'The audio server failed to load its runtime.',
              correctiveAction: 'Restart Podcaster and check the local runtime logs.',
              checks: audioChecks,
            }
          : audioOperational
            ? {
                state: 'ready' as const,
                label: 'Audio server',
                detail: `${activeLabel} and local speech recognition are ready.`,
                correctiveAction: 'No action needed.',
                progress: 100,
                checks: audioChecks,
              }
            : activeReady
              ? {
                  state: 'starting' as const,
                  label: 'Audio server',
                  detail: `${activeLabel} is still warming up.`,
                  correctiveAction: 'Keep this page open while the local runtime starts.',
                  progress: Math.round((audioReadyChecks / audioChecks.length) * 100),
                  checks: audioChecks,
                }
              : {
                  state: 'degraded' as const,
                  label: 'Audio server',
                  detail: voiceOutputReason,
                  correctiveAction: 'Choose an available voice backend in settings, then retry.',
                  progress: Math.round((audioReadyChecks / audioChecks.length) * 100),
                  checks: audioChecks,
                };
    const piStarting = pi === PI_CHECKING;
    const piService = piStarting
      ? {
          state: 'starting' as const,
          label: 'Pi service',
          detail: pi.detail,
          correctiveAction: 'Keep this page open while Pi verifies provider access.',
          progress: 0,
          checks: [{ label: 'Reasoning backend', state: 'starting' as const, detail: pi.detail }],
        }
      : {
          state: pi.status,
          label: 'Pi service',
          detail: pi.detail,
          correctiveAction: pi.correctiveAction,
          progress: pi.status === 'ready' ? 100 : 0,
          checks: [
            {
              label: 'Reasoning backend',
              state: pi.status === 'ready' ? ('ready' as const) : ('unavailable' as const),
              detail: pi.detail,
            },
          ],
        };
    return {
      capabilities: [
        {
          id: 'voice_input',
          label: 'Voice input',
          state: microphoneGranted ? 'ready' : 'needs_action',
          reason: microphoneGranted ? 'Microphone access is allowed.' : 'Microphone access is needed before capture.',
          action: microphoneGranted ? 'No action needed.' : 'Enable the microphone below.',
        },
        {
          id: 'voice_output',
          label: 'Voice output',
          state: audioOperational ? 'ready' : activeReady ? 'needs_action' : 'unavailable',
          reason: audioOperational
            ? voiceOutputReason
            : activeReady
              ? `${activeLabel} is still warming up.`
              : voiceOutputReason,
          action: audioOperational
            ? unavailableTts.length > 0
              ? 'Choose another backend in Voice settings, or install the unavailable model runtime.'
              : 'No action needed.'
            : 'Keep this page open while the local voice engine warms up.',
        },
        {
          id: 'cloud_reasoning',
          label: 'Cloud reasoning',
          state: pi.status === 'ready' ? 'ready' : 'needs_action',
          reason: pi.detail,
          action: pi.correctiveAction,
        },
      ],
      sidecar: audioOperational ? 'ready' : snapshot?.status === 'starting' || activeReady ? 'starting' : 'unavailable',
      reasoning: pi === PI_CHECKING ? 'checking' : pi.status,
      services: { audio: audioService, pi: piService },
      ...(responseCatalog ? { voiceCatalog: responseCatalog } : {}),
      ...(snapshot?.ttsModels ? { ttsModels: snapshot.ttsModels } : {}),
      activeTtsModel: requestedModel,
    };
  });
  app.post(
    '/api/voice-preview',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['voiceId'],
          properties: {
            voiceId: { type: 'string', minLength: 1, maxLength: 128 },
            catalogId: { type: 'string', minLength: 1, maxLength: 128 },
            backendId: { type: 'string', minLength: 1, maxLength: 128 },
            modelId: { type: 'string', minLength: 1, maxLength: 256 },
            speedModifier: { type: 'number', minimum: MIN_VOICE_SPEED_MODIFIER, maximum: MAX_VOICE_SPEED_MODIFIER },
            tonePrompt: { type: 'string', minLength: 1, maxLength: MAX_VOICE_TONE_PROMPT_BYTES },
            language: { enum: [...QWEN_VOICE_LANGUAGES] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!authenticate(request)) return reply.code(401).send({ error: 'unauthorized' });
      const {
        voiceId,
        catalogId,
        backendId = DEFAULT_TTS_MODEL.backendId,
        modelId = DEFAULT_TTS_MODEL.modelId,
        speedModifier = DEFAULT_VOICE_SPEED_MODIFIER,
        tonePrompt,
        language,
      } = request.body as {
        voiceId: string;
        catalogId?: string;
        backendId?: string;
        modelId?: string;
        speedModifier?: number;
        tonePrompt?: string;
        language?: QwenVoiceLanguage;
      };
      const snapshot = await sidecarSnapshot(options.sidecar);
      if (!snapshot || snapshot.status !== 'ready') return reply.code(409).send({ error: 'voice_catalog_unavailable' });
      const descriptor = snapshot.ttsModels?.find(
        (model) => model.backendId === backendId && model.modelId === modelId,
      );
      const selectedCatalog =
        descriptor?.voiceCatalog ??
        (backendId === DEFAULT_TTS_MODEL.backendId && modelId === DEFAULT_TTS_MODEL.modelId
          ? snapshot.voiceCatalog
          : undefined);
      if (descriptor?.status === 'unavailable' || !selectedCatalog)
        return reply.code(409).send({ error: 'tts_model_unavailable' });
      if (catalogId !== undefined && selectedCatalog.catalogId !== catalogId)
        return reply.code(422).send({ error: 'catalog_mismatch' });
      if (!selectedCatalog.voices.some((voice) => voice.id === voiceId))
        return reply.code(422).send({ error: 'unknown_voice' });
      const speed = descriptor?.speed ?? selectedCatalog.speed;
      if (
        speed &&
        (speedModifier < speed.min ||
          speedModifier > speed.max ||
          (!speed.supported && speedModifier !== speed.default))
      )
        return reply.code(422).send({ error: 'unsupported_speed' });
      const normalizedTonePrompt = tonePrompt?.trim();
      if (
        normalizedTonePrompt &&
        (backendId !== 'qwen3' || Buffer.byteLength(normalizedTonePrompt, 'utf8') > MAX_VOICE_TONE_PROMPT_BYTES)
      )
        return reply.code(422).send({ error: 'unsupported_tone_prompt' });
      if (language !== undefined && backendId !== 'qwen3')
        return reply.code(422).send({ error: 'unsupported_language' });
      if (voicePreviewInFlight) return reply.code(429).send({ error: 'preview_in_flight' });
      voicePreviewInFlight = true;
      // Abort synthesis when the browser disconnects; request.raw.signal is not
      // available on the current Node types, so wire the stream event directly.
      const controller = new AbortController();
      const onAborted = () => controller.abort();
      request.raw.once('aborted', onAborted);
      try {
        const { pcm16, sampleRate } = await voicePreview(
          {
            catalogId: selectedCatalog.catalogId,
            voiceId,
            speedModifier,
            ...(normalizedTonePrompt ? { tonePrompt: normalizedTonePrompt } : {}),
            ...(language ? { language } : {}),
            backendId,
            modelId,
            phrases: randomVoicePreviewPhrases(),
          },
          controller.signal,
        );
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
    },
  );
  app.post(
    '/api/voices/custom',
    {
      bodyLimit: MAX_CUSTOM_VOICE_ENROLLMENT_BODY,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['voiceId', 'name', 'refSha256', 'sampleRate', 'durationMs', 'byteLength', 'wavBase64'],
          properties: {
            voiceId: { type: 'string', pattern: '^custom:[0-9a-f]{24}$' },
            name: { type: 'string', minLength: 1, maxLength: 64 },
            refSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            sampleRate: { const: CUSTOM_VOICE_SAMPLE_RATE },
            durationMs: { type: 'integer', minimum: MIN_CUSTOM_VOICE_MS, maximum: MAX_CUSTOM_VOICE_MS },
            byteLength: { type: 'integer', minimum: 1, maximum: 640044 },
            wavBase64: { type: 'string', minLength: 1, maxLength: 900000 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!authenticate(request)) return reply.code(401).send({ error: 'unauthorized' });
      if (voiceEnrollmentInFlight) return reply.code(429).send({ error: 'voice_enrollment_in_flight' });
      const body = request.body as {
        voiceId: string;
        name: string;
        refSha256: string;
        sampleRate: number;
        durationMs: number;
        byteLength: number;
        wavBase64: string;
      };
      const name = normalizeCustomVoiceName(body.name);
      if (
        !name ||
        !isValidCustomVoiceId(body.voiceId) ||
        body.voiceId !== customVoiceId(body.refSha256) ||
        body.sampleRate !== CUSTOM_VOICE_SAMPLE_RATE ||
        body.durationMs < MIN_CUSTOM_VOICE_MS ||
        body.durationMs > MAX_CUSTOM_VOICE_MS
      ) {
        return reply.code(422).send({ error: 'invalid_reference' });
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.wavBase64) || body.wavBase64.length % 4 !== 0)
        return reply.code(422).send({ error: 'invalid_reference' });
      const wav = Buffer.from(body.wavBase64, 'base64');
      if (wav.byteLength !== body.byteLength || wav.byteLength > 640044)
        return reply.code(413).send({ error: 'reference_too_large' });
      const actualHash = createHash('sha256').update(wav).digest('hex');
      if (actualHash !== body.refSha256) return reply.code(422).send({ error: 'reference_digest_mismatch' });
      voiceEnrollmentInFlight = true;
      try {
        await enrollCustomVoiceInSidecar(options.sidecar, {
          voiceId: body.voiceId,
          name,
          refSha256: body.refSha256,
          sampleRate: body.sampleRate,
          durationMs: body.durationMs,
          wav,
        });
        return { voiceId: body.voiceId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'voice enrollment failed';
        return reply
          .code(message.includes('unavailable') || message.includes('closed') ? 503 : 422)
          .send({ error: 'voice_enrollment_failed', detail: message });
      } finally {
        voiceEnrollmentInFlight = false;
      }
    },
  );
  app.delete(
    '/api/voices/custom/:voiceId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['voiceId'],
          properties: { voiceId: { type: 'string', pattern: '^custom:[0-9a-f]{24}$' } },
        },
      },
    },
    async (request, reply) => {
      if (!authenticate(request)) return reply.code(401).send({ error: 'unauthorized' });
      if (voiceEnrollmentInFlight) return reply.code(429).send({ error: 'voice_enrollment_in_flight' });
      const { voiceId } = request.params as { voiceId: string };
      voiceEnrollmentInFlight = true;
      try {
        await removeCustomVoiceFromSidecar(options.sidecar, voiceId);
        return { voiceId, deleted: true };
      } catch (error) {
        return reply.code(503).send({
          error: 'voice_deletion_failed',
          detail: error instanceof Error ? error.message : 'voice deletion failed',
        });
      } finally {
        voiceEnrollmentInFlight = false;
      }
    },
  );
  app.post(
    '/api/bootstrap',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['disclosureAcknowledged'],
          properties: { disclosureAcknowledged: { const: true } },
        },
      },
    },
    async (_request, reply) => {
      const id = randomBytes(32).toString('base64url');
      const capability = randomBytes(32).toString('base64url');
      sessions.set(id, {
        capability,
        expiresAt: now() + sessionTtlMs,
        wsAuthenticated: false,
        sockets: new Set(),
        activeSocket: undefined,
        lastPongAt: 0,
        messageChain: Promise.resolve(),
        conversation: undefined,
        stopPromise: undefined,
        disconnectTimer: undefined,
      });
      reply.header('set-cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict`);
      return { capability, expiresInSeconds: sessionTtlMs / 1000 };
    },
  );
  app.post('/api/stop', async (request, reply) => {
    const id = cookieValue(request.headers.cookie);
    const session = authenticate(request);
    if (!session || !id) return reply.code(401).send({ error: 'unauthorized' });
    sessions.delete(id);
    await stopConversation(session);
    for (const socket of session.sockets) socket.close(1008, 'session stopped');
    return { stopped: true };
  });
  app.get('/ws', { websocket: true }, (socket, request) => {
    const id = cookieValue(request.headers.cookie);
    const session = id ? sessions.get(id) : undefined;
    let pending = true;
    let expiryTimer: NodeJS.Timeout | undefined;
    let heartbeatAlive = true;
    const heartbeatTimer = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      if (!heartbeatAlive) {
        socket.terminate();
        return;
      }
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
        if (!session || session.expiresAt <= now() || !id || sessions.get(id) !== session) {
          socket.close(1008, 'session expired');
          return;
        }
        const size = Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength;
        if (size > 64 * 1024) {
          socket.close(1009, 'frame too large');
          return;
        }
        const conversation = session.conversation;
        if (!conversation) {
          socket.close(1011, 'session composition missing');
          return;
        }
        // Planning runs inside session.start, so cancellation/retry must bypass
        // the ordered command chain or it could wait behind the in-flight Pi
        // request forever. All ordinary audio/turn commands remain serialized.
        if (conversation.isPlanningControl(raw, binary)) {
          void conversation
            .handlePlanningControl(raw, binary)
            .catch(() => socket.close(1011, 'planning control failure'));
          return;
        }
        session.messageChain = session.messageChain
          .then(() => conversation.handle(raw, binary))
          .catch(() => socket.close(1011, 'conversation failure'));
        return;
      }
      pending = false;
      clearTimeout(timer);
      if (binary) {
        socket.close(1008, 'invalid authentication');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, 'invalid authentication');
        return;
      }
      const cap =
        typeof value === 'object' && value !== null ? (value as { capability?: unknown }).capability : undefined;
      if (!session || session.expiresAt <= now() || typeof cap !== 'string' || !sameSecret(cap, session.capability)) {
        socket.close(1008, 'invalid authentication');
        return;
      }
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
      if (session.wsAuthenticated || session.sockets.size > 0) {
        socket.close(1008, 'invalid authentication');
        return;
      }
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = undefined;
      }
      session.wsAuthenticated = true;
      session.sockets.add(socket);
      session.activeSocket = socket;
      session.lastPongAt = Date.now();
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

declare module 'fastify' {
  interface FastifyInstance {
    setCanonicalOrigin(value: string): void;
  }
}
