// Browser-safe validators for the shared settings shapes. These are plain
// functions (no Ajv/JSON-schema dependency) because the settings module is
// imported from the browser and the host alike.

import type { SessionSettingsSnapshot, VoiceCatalog, VoiceInfo, VoicePreference } from './types.js';
import { normalizePersona } from './persona.js';
import { DEFAULT_PI_SETTINGS, MAX_PI_MODEL_BYTES, PI_THINKING_LEVELS, type PiSettings } from './pi.js';
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_SPEED_CAPABILITY,
  DEFAULT_VOICE_SPEED_MODIFIER,
  MAX_PLANNING_NOTES_BYTES,
  MAX_PLANNING_TOPIC_BYTES,
  MAX_VOICE_SPEED_MODIFIER,
  MAX_VOICE_TONE_PROMPT_BYTES,
  MIN_VOICE_SPEED_MODIFIER,
  PLANNING_DEPTHS,
  QWEN_VOICE_LANGUAGES,
  type SessionPlanningRequest,
  type TtsModelDescriptor,
  type VoiceSpeedCapability,
} from './types.js';

function isNonEmptyString(cause: unknown): cause is string {
  return cause !== null && String(cause) === cause && cause.length > 0;
}

function isFiniteString(cause: unknown): cause is string {
  return cause !== null && String(cause) === cause;
}

type SettingsValue = string | number | boolean | null | SettingsValue[] | SettingsRecord;
type SettingsRecord = { [key: string]: SettingsValue | undefined };

function isPlainObject(cause: unknown): cause is SettingsRecord {
  return cause !== null && Object(cause) === cause && !Array.isArray(cause);
}

function isQwenVoiceLanguage(cause: string): cause is NonNullable<VoicePreference['language']> {
  return QWEN_VOICE_LANGUAGES.some((language) => language === cause);
}

function isPlanningDepth(cause: string): cause is SessionPlanningRequest['depth'] {
  return PLANNING_DEPTHS.some((depth) => depth === cause);
}

function isPiThinkingLevel(cause: string): cause is PiSettings['thinkingLevel'] {
  return PI_THINKING_LEVELS.some((level) => level === cause);
}

function validateVoiceInfo(cause: unknown): cause is VoiceInfo {
  return (
    isPlainObject(cause) &&
    isNonEmptyString(cause.id) &&
    isFiniteString(cause.label) &&
    Object.keys(cause).every((key) => ['id', 'label'].includes(key))
  );
}

function isValidSpeedCapability(cause: unknown): cause is VoiceSpeedCapability {
  if (!isPlainObject(cause)) return false;
  return (
    (cause.supported === true || cause.supported === false) &&
    Number(cause.min) === cause.min &&
    Number.isFinite(cause.min) &&
    Number(cause.max) === cause.max &&
    Number.isFinite(cause.max) &&
    Number(cause.default) === cause.default &&
    Number.isFinite(cause.default) &&
    cause.min >= MIN_VOICE_SPEED_MODIFIER &&
    cause.max <= MAX_VOICE_SPEED_MODIFIER &&
    cause.min <= cause.max &&
    cause.default >= cause.min &&
    cause.default <= cause.max &&
    Object.keys(cause).every((key) => ['supported', 'min', 'max', 'default'].includes(key))
  );
}

export function isValidVoiceCatalog(cause: unknown): cause is VoiceCatalog {
  if (!isPlainObject(cause) || !Array.isArray(cause.voices) || !cause.voices.every(validateVoiceInfo)) return false;
  const voices: VoiceInfo[] = [];
  for (const candidate of cause.voices) {
    if (validateVoiceInfo(candidate)) voices.push(candidate);
  }
  const defaultVoiceId = cause.defaultVoiceId;
  if (!isFiniteString(defaultVoiceId)) return false;
  return (
    voices.length === cause.voices.length &&
    isFiniteString(cause.catalogId) &&
    cause.catalogId.length > 0 &&
    isFiniteString(cause.backendId) &&
    cause.backendId.length > 0 &&
    isFiniteString(cause.modelId) &&
    cause.modelId.length > 0 &&
    isFiniteString(cause.runtimeConfigId) &&
    cause.runtimeConfigId.length > 0 &&
    isFiniteString(cause.revision) &&
    cause.revision.length > 0 &&
    voices.length > 0 &&
    voices.some((voice) => voice.id === defaultVoiceId) &&
    new Set(voices.map((voice) => voice.id)).size === voices.length &&
    (cause.speed === undefined || isValidSpeedCapability(cause.speed)) &&
    Object.keys(cause).every((key) =>
      [
        'catalogId',
        'backendId',
        'modelId',
        'runtimeConfigId',
        'revision',
        'defaultVoiceId',
        'voices',
        'speed',
      ].includes(key),
    )
  );
}

export function isValidTtsModelDescriptor(cause: unknown): cause is TtsModelDescriptor {
  if (
    !isPlainObject(cause) ||
    !isFiniteString(cause.backendId) ||
    cause.backendId.length === 0 ||
    !isFiniteString(cause.modelId) ||
    cause.modelId.length === 0 ||
    !isFiniteString(cause.label) ||
    cause.label.length === 0 ||
    (cause.status !== 'ready' && cause.status !== 'unavailable') ||
    (cause.speed !== undefined && !isValidSpeedCapability(cause.speed)) ||
    (cause.voiceCatalog !== undefined && !isValidVoiceCatalog(cause.voiceCatalog)) ||
    (cause.voiceCatalog !== undefined &&
      (cause.voiceCatalog.backendId !== cause.backendId || cause.voiceCatalog.modelId !== cause.modelId)) ||
    (cause.reason !== undefined && !isFiniteString(cause.reason)) ||
    (cause.fallback !== undefined &&
      (!isPlainObject(cause.fallback) ||
        !isFiniteString(cause.fallback.backendId) ||
        !isFiniteString(cause.fallback.modelId)))
  )
    return false;
  if (cause.status === 'ready' && cause.voiceCatalog === undefined) return false;
  return Object.keys(cause).every((key) =>
    ['backendId', 'modelId', 'label', 'status', 'speed', 'voiceCatalog', 'reason', 'fallback'].includes(key),
  );
}

export function isValidVoicePreference(cause: unknown): cause is VoicePreference {
  return (
    isPlainObject(cause) &&
    isNonEmptyString(cause.catalogId) &&
    isNonEmptyString(cause.voiceId) &&
    Number(cause.speedModifier) === cause.speedModifier &&
    Number.isFinite(cause.speedModifier) &&
    cause.speedModifier >= MIN_VOICE_SPEED_MODIFIER &&
    cause.speedModifier <= MAX_VOICE_SPEED_MODIFIER &&
    (cause.tonePrompt === undefined ||
      (isNonEmptyString(cause.tonePrompt) &&
        new TextEncoder().encode(cause.tonePrompt).length <= MAX_VOICE_TONE_PROMPT_BYTES)) &&
    (cause.language === undefined || (isFiniteString(cause.language) && isQwenVoiceLanguage(cause.language))) &&
    (cause.backendId === undefined || isNonEmptyString(cause.backendId)) &&
    (cause.modelId === undefined || isNonEmptyString(cause.modelId)) &&
    ((cause.backendId === undefined && cause.modelId === undefined) ||
      (isNonEmptyString(cause.backendId) && isNonEmptyString(cause.modelId)))
  );
}

/** Normalize a persisted or wire preference, retaining compatibility with pre-speed settings. */
export function normalizeVoicePreference(cause: unknown): VoicePreference | undefined {
  if (!isPlainObject(cause) || !isNonEmptyString(cause.catalogId) || !isNonEmptyString(cause.voiceId)) return undefined;
  const speedModifier = cause.speedModifier === undefined ? DEFAULT_VOICE_SPEED_MODIFIER : cause.speedModifier;
  if (Number(speedModifier) !== speedModifier) return undefined;
  const normalized: VoicePreference = { catalogId: cause.catalogId, voiceId: cause.voiceId, speedModifier };
  if (isFiniteString(cause.tonePrompt) && cause.tonePrompt.trim()) normalized.tonePrompt = cause.tonePrompt.trim();
  if (isFiniteString(cause.language) && isQwenVoiceLanguage(cause.language)) normalized.language = cause.language;
  const hasBackendId = isNonEmptyString(cause.backendId);
  const hasModelId = isNonEmptyString(cause.modelId);
  if (hasBackendId !== hasModelId) return undefined;
  if (isNonEmptyString(cause.backendId) && isNonEmptyString(cause.modelId)) {
    normalized.backendId = cause.backendId;
    normalized.modelId = cause.modelId;
  }
  return isValidVoicePreference(normalized) ? normalized : undefined;
}

export function isValidSessionPlanningRequest(cause: unknown): cause is SessionPlanningRequest {
  if (
    !isPlainObject(cause) ||
    (cause.enabled !== undefined && cause.enabled !== true) ||
    !isFiniteString(cause.topic) ||
    cause.topic.trim().length === 0 ||
    new TextEncoder().encode(cause.topic).length > MAX_PLANNING_TOPIC_BYTES ||
    !isFiniteString(cause.depth) ||
    !isPlanningDepth(cause.depth)
  )
    return false;
  if (
    cause.notes !== undefined &&
    (!isFiniteString(cause.notes) || new TextEncoder().encode(cause.notes).length > MAX_PLANNING_NOTES_BYTES)
  )
    return false;
  if (cause.reuse !== undefined && cause.reuse !== true && cause.reuse !== false) return false;
  return Object.keys(cause).every((key) => ['enabled', 'topic', 'depth', 'notes', 'reuse'].includes(key));
}

export function normalizeSessionPlanningRequest(cause: unknown): SessionPlanningRequest | undefined {
  if (!isValidSessionPlanningRequest(cause)) return undefined;
  const topic = cause.topic.trim();
  const notes = cause.notes?.trim();
  const normalized: SessionPlanningRequest = { topic, depth: cause.depth };
  if (cause.enabled === true) normalized.enabled = true;
  if (notes) normalized.notes = notes;
  if (cause.reuse === true) normalized.reuse = true;
  return normalized;
}

export function isValidPiSettings(cause: unknown): cause is PiSettings {
  if (
    !isPlainObject(cause) ||
    !isFiniteString(cause.model) ||
    cause.model.length === 0 ||
    cause.model.startsWith('-') ||
    new TextEncoder().encode(cause.model).length > MAX_PI_MODEL_BYTES ||
    /\s/u.test(cause.model)
  )
    return false;
  return isFiniteString(cause.thinkingLevel) && isPiThinkingLevel(cause.thinkingLevel);
}

export function normalizePiSettings(cause: unknown): PiSettings {
  return isValidPiSettings(cause)
    ? { model: cause.model, thinkingLevel: cause.thinkingLevel }
    : { ...DEFAULT_PI_SETTINGS };
}

export function normalizeTtsModel(cause: unknown): Pick<TtsModelDescriptor, 'backendId' | 'modelId'> {
  if (isPlainObject(cause) && isNonEmptyString(cause.backendId) && isNonEmptyString(cause.modelId)) {
    return { backendId: cause.backendId, modelId: cause.modelId };
  }
  return { ...DEFAULT_TTS_MODEL };
}

export function normalizeVoiceSpeedCapability(cause: unknown): VoiceSpeedCapability {
  return isValidSpeedCapability(cause) ? cause : DEFAULT_VOICE_SPEED_CAPABILITY;
}

export function isVoiceInCatalog(catalog: VoiceCatalog, voiceId: string): boolean {
  return catalog.voices.some((voice) => voice.id === voiceId);
}

export function isValidSessionSettingsSnapshot(cause: unknown): cause is SessionSettingsSnapshot {
  if (!isPlainObject(cause) || cause.version !== 1) return false;
  if (!isFiniteString(cause.persona)) return false;
  try {
    normalizePersona(cause.persona);
  } catch {
    return false;
  }
  return normalizeVoicePreference(cause.voice) !== undefined && (cause.pi === undefined || isValidPiSettings(cause.pi));
}
