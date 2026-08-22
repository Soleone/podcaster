// Voice preview playback for the settings dialog. Fetches a synthesized WAV
// from POST /api/voice-preview (the host renders it through the real local TTS
// engine with the selected voice) and plays it through a shared AudioContext.
//
// The AudioContext is created synchronously inside the click handler so the
// browser's autoplay policy treats the gesture as the unlock.

export interface VoicePreviewHandle {
  /** Resolves when playback ends naturally or via stop(); never rejects. */
  finished: Promise<void>;
  stop(): void;
}

let context: AudioContext | undefined;
let activeSource: AudioBufferSourceNode | undefined;

/**
 * Human-readable copy for each server rejection code on POST /api/voice-preview.
 * Anything not listed falls back to a status-based message, and truly unknown
 * node/local failures land on the dialog's own fallback copy.
 */
const VOICE_PREVIEW_SERVER_ERROR_COPY: Readonly<Record<string, string>> = Object.freeze({
  unauthorized: 'Your session timed out. Refresh the page, then try the preview again.',
  voice_catalog_unavailable: 'The audio engine isn\u2019t ready yet. Check readiness, then try the preview again.',
  tts_model_unavailable: 'That speech model isn\u2019t available on this device. Pick another model, then try again.',
  catalog_mismatch:
    'The saved voice no longer matches the audio engine\u2019s catalog. Re-select the voice, then try again.',
  unknown_voice: 'That voice isn\u2019t loaded in the audio engine yet. Try again in a moment, or re-select it.',
  unsupported_speed: 'The selected speed isn\u2019t supported by this voice. Use its normal speed, then try again.',
  preview_in_flight: 'Another voice preview is still playing. Wait a moment, then try again.',
  preview_unavailable:
    'The audio engine couldn\u2019t synthesize this preview. Try again, or check that the model and voice are available.',
});

function previewServerMessage(detail: { error?: string } | undefined, status: number): string {
  const copy = detail?.error ? VOICE_PREVIEW_SERVER_ERROR_COPY[detail.error] : undefined;
  return copy ?? `voice preview failed with status ${status}`;
}

/** Stops whatever preview is currently audible, if any. */
export function stopVoicePreview(): void {
  const source = activeSource;
  activeSource = undefined;
  if (!source) return;
  try {
    source.stop();
  } catch {
    /* already stopped or never started */
  }
}

/**
 * Fetches and plays a preview for one voice. Starting a new preview stops any
 * preview still playing. An in-flight request can be cancelled when the user
 * changes backend, voice, or closes the settings dialog.
 */
export async function startVoicePreview(input: {
  voiceId: string;
  speedModifier?: number;
  backendId?: string;
  modelId?: string;
  catalogId?: string;
  tonePrompt?: string;
  language?: string;
  capability: string;
  signal?: AbortSignal;
}): Promise<VoicePreviewHandle> {
  stopVoicePreview();
  context ??= new AudioContext();
  if (context.state === 'suspended') await context.resume();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('voice preview timed out')), 30_000);
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    let response: Response;
    try {
      response = await fetch('/api/voice-preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-podcaster-capability': input.capability },
        body: JSON.stringify({
          voiceId: input.voiceId,
          speedModifier: input.speedModifier ?? 1.0,
          ...(input.backendId !== undefined ? { backendId: input.backendId } : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.catalogId !== undefined ? { catalogId: input.catalogId } : {}),
          ...(input.tonePrompt ? { tonePrompt: input.tonePrompt } : {}),
          ...(input.language ? { language: input.language } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // The caller owns its signal; only the internal timeout aborts here, so
      // translate anything else to a clear engine-unreachable message. Propagate
      // the caller's own abort reason so cancellation is never masked.
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      throw new Error(
        controller.signal.aborted
          ? 'Voice preview took too long to start. Try again.'
          : 'The audio engine couldn\u2019t start the preview. Try again.',
      );
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new Error(previewServerMessage(detail, response.status));
    }
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('voice preview cancelled');
    if (controller.signal.aborted) throw new Error('Voice preview took too long to start. Try again.');
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await context.decodeAudioData(await response.arrayBuffer());
    } catch {
      throw new Error('The audio engine returned audio this browser couldn\u2019t play. Try again.');
    }
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('voice preview cancelled');
    if (controller.signal.aborted) throw new Error('Voice preview took too long to start. Try again.');
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const finished = new Promise<void>((resolve) => {
      source.onended = () => {
        if (activeSource === source) activeSource = undefined;
        resolve();
      };
    });
    source.start();
    activeSource = source;
    return {
      finished,
      stop() {
        if (activeSource === source) activeSource = undefined;
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
      },
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
