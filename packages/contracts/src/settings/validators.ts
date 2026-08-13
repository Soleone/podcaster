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
  );
}

export function isValidVoicePreference(value: unknown): value is VoicePreference {
  return isPlainObject(value)
    && isNonEmptyString(value.catalogId)
    && isNonEmptyString(value.voiceId);
}

export function isVoiceInCatalog(catalog: VoiceCatalog, voiceId: string): boolean {
  return catalog.voices.some(voice => voice.id === voiceId);
}

export function isValidSessionSettingsSnapshot(value: unknown): value is SessionSettingsSnapshot {
  if (!isPlainObject(value) || value.version !== 1) return false;
  if (typeof value.persona !== "string") return false;
  try { normalizePersona(value.persona); } catch { return false; }
  return isValidVoicePreference(value.voice);
}
