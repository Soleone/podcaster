// Shared settings semantics for the Podcaster web app and host. This module is
// imported from the browser as well as Node, so it must stay free of Node
// built-ins (Buffer, node:crypto, etc.). Use TextEncoder for byte lengths.

export const SETTINGS_VERSION = 1 as const;

export const MAX_PERSONA_BYTES = 8 * 1024;

/** Upper bound on the editable agent display name, in UTF-8 bytes. */
export const MAX_AGENT_NAME_BYTES = 64;

/** Normal conversational playback speed. */
export const DEFAULT_VOICE_SPEED_MODIFIER = 1.0;
/** Safe lower bound for the editable playback speed modifier. */
export const MIN_VOICE_SPEED_MODIFIER = 0.5;
/** Safe upper bound for the editable playback speed modifier. */
export const MAX_VOICE_SPEED_MODIFIER = 2.0;
/** Upper bound for an optional Qwen delivery-style instruction. */
export const MAX_VOICE_TONE_PROMPT_BYTES = 1024;

/** Languages supported by Qwen3-TTS CustomVoice and Base voice cloning. */
export const QWEN_VOICE_LANGUAGES = [
  "Chinese",
  "English",
  "Japanese",
  "Korean",
  "German",
  "French",
  "Russian",
  "Portuguese",
  "Spanish",
  "Italian",
] as const;
export type QwenVoiceLanguage = (typeof QWEN_VOICE_LANGUAGES)[number];
export const DEFAULT_QWEN_VOICE_LANGUAGE: QwenVoiceLanguage = "English";

/** The stable identity of one selectable local TTS backend/model. */
export interface TtsModelSelection {
  backendId: string;
  modelId: string;
}

/** A backend-owned speed contract. Unsupported speed is explicit, not implied. */
export interface VoiceSpeedCapability {
  supported: boolean;
  min: number;
  max: number;
  default: number;
}

export const DEFAULT_TTS_MODEL: TtsModelSelection = Object.freeze({
  backendId: "kokoro",
  modelId: "kokoro-82m-onnx",
});

export const DEFAULT_VOICE_SPEED_CAPABILITY: VoiceSpeedCapability = Object.freeze({
  supported: true,
  min: MIN_VOICE_SPEED_MODIFIER,
  max: MAX_VOICE_SPEED_MODIFIER,
  default: DEFAULT_VOICE_SPEED_MODIFIER,
});

/** The first-run editable default agent name shown above the assistant's bubbles. */
export const DEFAULT_AGENT_NAME = "Oliver";

/** A single advertised voice from a verified TTS backend/model catalog. */
export interface VoiceInfo {
  /** Stable, authoritative voice identifier used on every tts.open. */
  id: string;
  /** Human-friendly label for display; the id remains authoritative. */
  label: string;
}

/**
 * A strict, attested catalog of the voices actually available from the active
 * TTS backend/model/runtime. The host and sidecar revalidate this identity
 * before any stream opens.
 */
export interface VoiceCatalog {
  /** Stable identity derived from backend/model/runtime plus the verified voices SHA-256. */
  catalogId: string;
  backendId: string;
  modelId: string;
  runtimeConfigId: string;
  revision: string;
  /** The verified default voice, always present in `voices`. */
  defaultVoiceId: string;
  voices: VoiceInfo[];
  /** Optional for old snapshots; new adapters must declare their speed contract. */
  speed?: VoiceSpeedCapability;
}

/** A selectable backend/model and its current verified catalog state. */
export interface TtsModelDescriptor extends TtsModelSelection {
  label: string;
  status: "ready" | "unavailable";
  speed?: VoiceSpeedCapability;
  voiceCatalog?: VoiceCatalog;
  reason?: string;
  /** The model that remains usable when this optional model is unavailable. */
  fallback?: TtsModelSelection;
}

/** The browser's persisted voice selection, bound to one catalog. */
export interface VoicePreference {
  catalogId: string;
  voiceId: string;
  /** Multiplier passed to the verified TTS backend; 1.0 is normal speed. */
  speedModifier: number;
  /** Optional Qwen CustomVoice delivery/style instruction; ignored by Kokoro. */
  tonePrompt?: string;
  /** Optional Qwen synthesis language; ignored by Kokoro. */
  language?: QwenVoiceLanguage;
  /** Optional to keep settings/session snapshots written before model selection valid. */
  backendId?: string;
  /** Optional to keep settings/session snapshots written before model selection valid. */
  modelId?: string;
}

/**
 * The frozen settings snapshot sent in `session.start`. Immutable for the
 * lifetime of a session; later edits only affect the next session.
 */
export interface SessionSettingsSnapshot {
  version: typeof SETTINGS_VERSION;
  /** Free-form AGENTS.md-like persona text; empty is valid. */
  persona: string;
  voice: VoicePreference;
}

/** Stable storage/wire key for a backend/model-owned voice profile. */
export function ttsModelKey(model: TtsModelSelection): string {
  return `${model.backendId}:${model.modelId}`;
}

/** Return a catalog's declared speed contract, with the legacy safe range. */
export function voiceSpeedCapability(catalog: VoiceCatalog | undefined): VoiceSpeedCapability {
  return catalog?.speed ?? DEFAULT_VOICE_SPEED_CAPABILITY;
}
