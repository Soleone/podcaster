// One-shot voice preview synthesis through the audio sidecar. The preview opens
// its own private sidecar stream (never the session's), sends a single TTS
// request with the chosen voice, and collects the PCM until tts.ended. It
// reuses AudioClient wholesale so catalog validation, frame sequencing, and
// sample reconciliation are identical to session speech. The preview stream is
// TTS-only, so it can coexist with session capture; the runtime serializes
// access to the single synthesis adapter and never disturbs the session.

import { randomUUID } from 'node:crypto';
import { decodeBinaryAudioFrame, joinPreviewPhrases } from '@app/contracts';
import { AudioClient } from './AudioClient.js';
import type { SidecarProcess } from './process.js';

const MAX_PAYLOAD = 64 * 1024;
const MAX_FRAME_PAYLOAD = MAX_PAYLOAD - 20;

/** Default budget for a single preview, plenty for three short phrases. */
export const VOICE_PREVIEW_TIMEOUT_MS = 20_000;

export interface VoicePreviewRequest {
  catalogId: string;
  voiceId: string;
  speedModifier?: number;
  tonePrompt?: string;
  backendId?: string;
  modelId?: string;
  phrases: string[];
}

export interface VoicePreviewResult {
  pcm16: Int16Array;
  sampleRate: number;
  generatedSamples: number;
}

export async function synthesizeVoicePreview(
  sidecar: SidecarProcess,
  input: VoicePreviewRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<VoicePreviewResult> {
  const text = joinPreviewPhrases(input.phrases);
  const timeoutMs = options.timeoutMs ?? VOICE_PREVIEW_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('voice preview timed out')), timeoutMs);
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const chunks: Int16Array[] = [];
  const client = new AudioClient(
    sidecar,
    {},
    encoded => { chunks.push(decodeBinaryAudioFrame(encoded, MAX_FRAME_PAYLOAD).pcm16); },
    { catalogId: input.catalogId, voiceId: input.voiceId, ...(input.speedModifier !== undefined ? { speedModifier: input.speedModifier } : {}), ...(input.tonePrompt ? { tonePrompt: input.tonePrompt } : {}), ...(input.backendId !== undefined ? { backendId: input.backendId } : {}), ...(input.modelId !== undefined ? { modelId: input.modelId } : {}) },
  );
  try {
    await client.connect();
    // Preview streams are TTS-only and may coexist with the session's capture
    // stream. The runtime still serializes access to the single TTS adapter.
    await client.open(0, 'preview');
    const responseId = randomUUID();
    // begin() rather than synthesize(): a signal aborted before admit rejects
    // the start promise inside begin() and then makes append() throw. The
    // start promise is guarded here (and by AudioClient itself) so no rejection
    // can leak; the awaited copy below still rethrows to callers.
    const stream = client.begin({ sessionId: 'voice-preview', epoch: 0, responseId, signal: controller.signal });
    void stream.started.catch(() => undefined);
    try {
      stream.append(text);
      stream.finish();
    } catch {
      // Aborted before admit: begin() already recorded the local cutoff; its
      // rejection surfaces through the awaited start promise below.
    }
    const started = await stream.started;
    const { sampleRate, completion } = started;
    if (!completion) throw new Error('voice preview did not open a completion stream');
    // Drain from the first chunk so a multi-second preview never trips the
    // client's small buffered-chunk cap (it is tuned for conversational speech).
    client.release(responseId);
    const finished = await completion;
    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalSamples !== finished.generatedSamples) throw new Error('voice preview sample count mismatch');
    const pcm16 = new Int16Array(totalSamples);
    let offset = 0;
    for (const chunk of chunks) { pcm16.set(chunk, offset); offset += chunk.length; }
    return { pcm16, sampleRate, generatedSamples: finished.generatedSamples };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onExternalAbort);
    await client.close().catch(() => undefined);
  }
}