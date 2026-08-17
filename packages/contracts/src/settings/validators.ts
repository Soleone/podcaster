// Browser-safe validators for the shared settings shapes. These are plain
// functions (no Ajv/JSON-schema dependency) because the settings module is
// imported from the browser and the host alike.

import type {
  SessionSettingsSnapshot,
  VoiceCatalog,
  VoiceInfo,
  VoicePreference,
} from "./types.js";
import { normalizePersona } from "./persona.js";
import { DEFAULT_TTS_MODEL, DEFAULT_VOICE_SPEED_CAPABILITY, DEFAULT_VOICE_SPEED_MODIFIER, MAX_VOICE_SPEED_MODIFIER, MAX_VOICE_TONE_PROMPT_BYTES, MIN_VOICE_SPEED_MODIFIER, QWEN_VOICE_LANGUAGES, type TtsModelDescriptor, type VoiceSpeedCapability } from "./types.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteString(value: unknown): value is string {
  return typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateVoiceInfo(value: unknown): value is VoiceInfo {
  return isPlainObject(value) && isNonEmptyString(value.id) && isFiniteString(value.label) && Object.keys(value).every(key => ["id", "label"].includes(key));
}

function isValidSpeedCapability(value: unknown): value is VoiceSpeedCapability {
  if (!isPlainObject(value)) return false;
  return typeof value.supported === "boolean"
    && typeof value.min === "number" && Number.isFinite(value.min)
    && typeof value.max === "number" && Number.isFinite(value.max)
    && typeof value.default === "number" && Number.isFinite(value.default)
    && value.min >= MIN_VOICE_SPEED_MODIFIER
    && value.max <= MAX_VOICE_SPEED_MODIFIER
    && value.min <= value.max
    && value.default >= value.min
    && value.default <= value.max
    && Object.keys(value).every(key => ["supported", "min", "max", "default"].includes(key));
}

export function isValidVoiceCatalog(value: unknown): value is VoiceCatalog {
  return (
    isPlainObject(value)
    && typeof value.catalogId === "string" && value.catalogId.length > 0
    && typeof value.backendId === "string" && value.backendId.length > 0
    && typeof value.modelId === "string" && value.modelId.length > 0
    && typeof value.runtimeConfigId === "string" && value.runtimeConfigId.length > 0
    && typeof value.revision === "string" && value.revision.length > 0
    && typeof value.defaultVoiceId === "string"
    && Array.isArray(value.voices)
    && value.voices.length > 0
    && value.voices.every(validateVoiceInfo)
    && value.voices.some(voice => voice.id === value.defaultVoiceId)
    && new Set(value.voices.map(voice => voice.id)).size === value.voices.length
    && (value.speed === undefined || isValidSpeedCapability(value.speed))
    && Object.keys(value).every(key => ["catalogId", "backendId", "modelId", "runtimeConfigId", "revision", "defaultVoiceId", "voices", "speed"].includes(key))
  );
}

export function isValidTtsModelDescriptor(value: unknown): value is TtsModelDescriptor {
  if (!isPlainObject(value)
    || typeof value.backendId !== "string" || value.backendId.length === 0
    || typeof value.modelId !== "string" || value.modelId.length === 0
    || typeof value.label !== "string" || value.label.length === 0
    || (value.status !== "ready" && value.status !== "unavailable")
    || (value.speed !== undefined && !isValidSpeedCapability(value.speed))
    || (value.voiceCatalog !== undefined && !isValidVoiceCatalog(value.voiceCatalog))
    || (value.voiceCatalog !== undefined && (value.voiceCatalog.backendId !== value.backendId || value.voiceCatalog.modelId !== value.modelId))
    || (value.reason !== undefined && typeof value.reason !== "string")
    || (value.fallback !== undefined && (!isPlainObject(value.fallback) || typeof value.fallback.backendId !== "string" || typeof value.fallback.modelId !== "string"))) return false;
  if (value.status === "ready" && value.voiceCatalog === undefined) return false;
  return Object.keys(value).every(key => ["backendId", "modelId", "label", "status", "speed", "voiceCatalog", "reason", "fallback"].includes(key));
}

export function isValidVoicePreference(value: unknown): value is VoicePreference {
  return isPlainObject(value)
    && isNonEmptyString(value.catalogId)
    && isNonEmptyString(value.voiceId)
    && typeof value.speedModifier === "number"
    && Number.isFinite(value.speedModifier)
    && value.speedModifier >= MIN_VOICE_SPEED_MODIFIER
    && value.speedModifier <= MAX_VOICE_SPEED_MODIFIER
    && (value.tonePrompt === undefined || (isNonEmptyString(value.tonePrompt) && new TextEncoder().encode(value.tonePrompt).length <= MAX_VOICE_TONE_PROMPT_BYTES))
    && (value.language === undefined || (typeof value.language === "string" && (QWEN_VOICE_LANGUAGES as readonly string[]).includes(value.language)))
    && (value.backendId === undefined || isNonEmptyString(value.backendId))
    && (value.modelId === undefined || isNonEmptyString(value.modelId))
    && ((value.backendId === undefined && value.modelId === undefined) || (isNonEmptyString(value.backendId) && isNonEmptyString(value.modelId)));
}

/** Normalize a persisted or wire preference, retaining compatibility with pre-speed settings. */
export function normalizeVoicePreference(value: unknown): VoicePreference | undefined {
  if (!isPlainObject(value) || !isNonEmptyString(value.catalogId) || !isNonEmptyString(value.voiceId)) return undefined;
  const speedModifier = value.speedModifier === undefined ? DEFAULT_VOICE_SPEED_MODIFIER : value.speedModifier;
  if (typeof speedModifier !== "number") return undefined;
  const normalized: VoicePreference = {
    catalogId: value.catalogId,
    voiceId: value.voiceId,
    speedModifier,
    ...(typeof value.tonePrompt === "string" && value.tonePrompt.trim() ? { tonePrompt: value.tonePrompt.trim() } : {}),
    ...(typeof value.language === "string" && (QWEN_VOICE_LANGUAGES as readonly string[]).includes(value.language) ? { language: value.language as Exclude<VoicePreference["language"], undefined> } : {}),
    ...(value.backendId === undefined && value.modelId === undefined ? {} : { backendId: value.backendId as string, modelId: value.modelId as string }),
  };
  return isValidVoicePreference(normalized) ? normalized : undefined;
}

export function normalizeTtsModel(value: unknown): { backendId: string; modelId: string } {
  if (isPlainObject(value) && isNonEmptyString(value.backendId) && isNonEmptyString(value.modelId)) {
    return { backendId: value.backendId, modelId: value.modelId };
  }
  return { ...DEFAULT_TTS_MODEL };
}

export function normalizeVoiceSpeedCapability(value: unknown): VoiceSpeedCapability {
  return isValidSpeedCapability(value) ? value : DEFAULT_VOICE_SPEED_CAPABILITY;
}

export function isVoiceInCatalog(catalog: VoiceCatalog, voiceId: string): boolean {
  return catalog.voices.some(voice => voice.id === voiceId);
}

export function isValidSessionSettingsSnapshot(value: unknown): value is SessionSettingsSnapshot {
  if (!isPlainObject(value) || value.version !== 1) return false;
  if (typeof value.persona !== "string") return false;
  try { normalizePersona(value.persona); } catch { return false; }
  return normalizeVoicePreference(value.voice) !== undefined;
}
