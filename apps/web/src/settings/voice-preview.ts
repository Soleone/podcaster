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

/** Stops whatever preview is currently audible, if any. */
export function stopVoicePreview(): void {
  const source = activeSource;
  activeSource = undefined;
  if (!source) return;
  try { source.stop(); } catch { /* already stopped or never started */ }
}

/**
 * Fetches and plays a preview for one voice. Starting a new preview stops any
 * preview still playing.
 */
export async function startVoicePreview(input: { voiceId: string; speedModifier?: number; backendId?: string; modelId?: string; catalogId?: string; capability: string }): Promise<VoicePreviewHandle> {
  stopVoicePreview();
  context ??= new AudioContext();
  if (context.state === 'suspended') await context.resume();
  const response = await fetch('/api/voice-preview', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-podcaster-capability': input.capability },
    body: JSON.stringify({ voiceId: input.voiceId, speedModifier: input.speedModifier ?? 1.0, ...(input.backendId !== undefined ? { backendId: input.backendId } : {}), ...(input.modelId !== undefined ? { modelId: input.modelId } : {}), ...(input.catalogId !== undefined ? { catalogId: input.catalogId } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(detail?.error ?? `voice preview failed with status ${response.status}`);
  }
  const audioBuffer = await context.decodeAudioData(await response.arrayBuffer());
  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(context.destination);
  const finished = new Promise<void>(resolve => {
    source.onended = () => { if (activeSource === source) activeSource = undefined; resolve(); };
  });
  source.start();
  activeSource = source;
  return {
    finished,
    stop() {
      if (activeSource === source) activeSource = undefined;
      try { source.stop(); } catch { /* already stopped */ }
    },
  };
}