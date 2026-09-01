// Browser-local settings persistence. One atomic row in the existing `meta`
// store (no schema version bump), validated on every read. A failed save
// preserves the last committed row and reports failure to the caller.

import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_PERSONA,
  DEFAULT_PI_SETTINGS,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_SPEED_MODIFIER,
  MAX_AGENT_NAME_BYTES,
  MAX_PERSONA_BYTES,
  MAX_VOICE_SPEED_MODIFIER,
  MAX_VOICE_TONE_PROMPT_BYTES,
  MAX_PI_MODEL_BYTES,
  MIN_VOICE_SPEED_MODIFIER,
  PI_THINKING_LEVELS,
  QWEN_VOICE_LANGUAGES,
  SETTINGS_VERSION,
  ttsModelKey,
  type PiSettings,
  type TtsModelSelection,
  type VoicePreference,
} from '@app/contracts/settings';
import { openPodcasterDatabase, requestResult, STORES, transactionDone, type DatabaseFactory } from '../storage/schema';

export const SETTINGS_KEY = 'settings:v1';

/** The browser-persisted settings row: the display name plus the frozen session snapshot. */

type ExternalValue = string | number | boolean | null | undefined | ExternalRecord | readonly ExternalValue[];
interface ExternalRecord {
  readonly [key: string]: ExternalValue;
}
/** Values that reach these normalizers: raw IndexedDB rows plus already-typed settings fields. */
type StorableInput =
  | ExternalValue
  | StoredSettings
  | VoicePreference
  | PiSettings
  | TtsModelSelection
  | Record<string, VoicePreference>;
const valueTag = Object.prototype.toString;
const isJsonString = (value: StorableInput): value is string => valueTag.call(value) === '[object String]';
const isJsonNumber = (value: StorableInput): value is number => valueTag.call(value) === '[object Number]';
const isJsonObject = (value: StorableInput): value is ExternalRecord => valueTag.call(value) === '[object Object]';
const isJsonArray = (value: StorableInput): value is readonly ExternalValue[] => Array.isArray(value);

export interface StoredSettings {
  version: typeof SETTINGS_VERSION;
  /** Editable agent display name used in the conversation bubbles; never sent to the host. */
  agentName: string;
  persona: string;
  /** Pi controls, optional for rows written before this setting existed. */
  pi?: PiSettings;
  /** Active model, optional for rows written before model selection existed. */
  selectedModel?: TtsModelSelection;
  /** Active preference retained for wire/session compatibility. */
  voice: VoicePreference;
  /** Backend/model-scoped profiles. A profile is never reused across models. */
  voiceProfiles?: Record<string, VoicePreference>;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  version: 1,
  agentName: DEFAULT_AGENT_NAME,
  persona: DEFAULT_AGENT_PERSONA,
  pi: { ...DEFAULT_PI_SETTINGS },
  selectedModel: { ...DEFAULT_TTS_MODEL },
  voice: { catalogId: '', voiceId: '', speedModifier: DEFAULT_VOICE_SPEED_MODIFIER, ...DEFAULT_TTS_MODEL },
};

function normalizeStoredVoice(value: ExternalValue | VoicePreference): VoicePreference | undefined {
  if (!value || !isJsonObject(value) || isJsonArray(value)) return undefined;
  // SAFETY: The value is validated or constructed with this declared contract at this boundary.
  const voice = value as ExternalRecord;
  const speedModifier = voice.speedModifier === undefined ? DEFAULT_VOICE_SPEED_MODIFIER : voice.speedModifier;
  if (
    !isJsonString(voice.catalogId) ||
    !isJsonString(voice.voiceId) ||
    !isJsonNumber(speedModifier) ||
    !Number.isFinite(speedModifier) ||
    speedModifier < MIN_VOICE_SPEED_MODIFIER ||
    speedModifier > MAX_VOICE_SPEED_MODIFIER
  )
    return undefined;
  const tonePrompt = voice.tonePrompt === undefined ? undefined : voice.tonePrompt;
  if (
    tonePrompt !== undefined &&
    (!isJsonString(tonePrompt) ||
      !tonePrompt.trim() ||
      new TextEncoder().encode(tonePrompt).length > MAX_VOICE_TONE_PROMPT_BYTES)
  )
    return undefined;
  const language = voice.language === undefined ? undefined : voice.language;
  // SAFETY: The language is a member of the validated Qwen language list.
  if (
    language !== undefined &&
    // SAFETY: The value is validated or constructed with this declared contract at this boundary.
    // SAFETY: IndexedDB returned the row written under this local storage contract.
    (!isJsonString(language) || !(QWEN_VOICE_LANGUAGES as readonly string[]).includes(language))
  )
    return undefined;
  const hasBackend = voice.backendId !== undefined || voice.modelId !== undefined;
  if (
    hasBackend &&
    (!isJsonString(voice.backendId) ||
      voice.backendId.length === 0 ||
      !isJsonString(voice.modelId) ||
      voice.modelId.length === 0)
  )
    return undefined;
  return {
    catalogId: voice.catalogId,
    voiceId: voice.voiceId,
    speedModifier,
    ...(tonePrompt !== undefined ? { tonePrompt: tonePrompt.trim() } : undefined),
    // SAFETY: The value is validated or constructed with this declared contract at this boundary.
    ...(language !== undefined ? { language: language as Exclude<VoicePreference['language'], undefined> } : undefined),
    // SAFETY: The value is validated or constructed with this declared contract at this boundary.
    ...(hasBackend ? { backendId: voice.backendId as string, modelId: voice.modelId as string } : undefined),
  };
}

function normalizePiSettings(value: ExternalValue | PiSettings): PiSettings | undefined {
  if (!value || !isJsonObject(value) || isJsonArray(value)) return undefined;
  // SAFETY: The value is validated or constructed with this declared contract at this boundary.
  const pi = value as ExternalRecord;
  if (
    !isJsonString(pi.model) ||
    !pi.model ||
    pi.model.startsWith('-') ||
    new TextEncoder().encode(pi.model).length > MAX_PI_MODEL_BYTES ||
    /\s/u.test(pi.model)
  )
    return undefined;
  // SAFETY: The value is validated or constructed with this declared contract at this boundary.
  if (!isJsonString(pi.thinkingLevel) || !(PI_THINKING_LEVELS as readonly string[]).includes(pi.thinkingLevel))
    return undefined;
  // SAFETY: The value is validated or constructed with this declared contract at this boundary.
  return { model: pi.model, thinkingLevel: pi.thinkingLevel as PiSettings['thinkingLevel'] };
}

function normalizeSelectedModel(value: ExternalValue | TtsModelSelection): TtsModelSelection | undefined {
  if (!value || !isJsonObject(value) || isJsonArray(value)) return undefined;
  // SAFETY: The value is validated or constructed with this declared contract at this boundary.
  const model = value as ExternalRecord;
  if (!isJsonString(model.backendId) || !model.backendId || !isJsonString(model.modelId) || !model.modelId)
    return undefined;
  return { backendId: model.backendId, modelId: model.modelId };
}

function normalizeVoiceProfiles(
  value: ExternalValue | Record<string, VoicePreference>,
): Record<string, VoicePreference> | undefined {
  if (value === undefined) return undefined;
  if (!value || !isJsonObject(value) || isJsonArray(value)) return undefined;
  const profiles: Record<string, VoicePreference> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const normalized = normalizeStoredVoice(candidate);
    if (!normalized || !normalized.backendId || !normalized.modelId) return undefined;
    if (key !== ttsModelKey({ backendId: normalized.backendId, modelId: normalized.modelId })) return undefined;
    profiles[key] = normalized;
  }
  return profiles;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Storage-level validation: admits persona-only saves even before a verified
 * catalog exists (empty voice is allowed here). The strict session.start
 * contract validator still gates what is actually sent to the host.
 */
export function isValidStoredSettings(value: ExternalValue | StoredSettings): value is StoredSettings {
  if (!value || !isJsonObject(value) || isJsonArray(value)) return false;
  // SAFETY: The value is validated or constructed with this declared contract at this boundary.
  const record = value as ExternalRecord;
  if (record.version !== 1 || !isJsonString(record.persona) || !isJsonString(record.agentName)) return false;
  const pi = normalizePiSettings(record.pi);
  if (record.pi !== undefined && !pi) return false;
  const selectedModel = normalizeSelectedModel(record.selectedModel);
  if (record.selectedModel !== undefined && !selectedModel) return false;
  const activeVoice = normalizeStoredVoice(record.voice);
  if (selectedModel && activeVoice && (activeVoice.backendId === undefined) !== (activeVoice.modelId === undefined))
    return false;
  if (
    selectedModel &&
    activeVoice?.backendId &&
    activeVoice.modelId &&
    ttsModelKey(selectedModel) !== ttsModelKey({ backendId: activeVoice.backendId, modelId: activeVoice.modelId })
  )
    return false;
  if (record.voiceProfiles !== undefined && !normalizeVoiceProfiles(record.voiceProfiles)) return false;
  if (utf8ByteLength(record.agentName) > MAX_AGENT_NAME_BYTES) return false;
  if (utf8ByteLength(record.persona) > MAX_PERSONA_BYTES) return false;
  return normalizeStoredVoice(record.voice) !== undefined;
}

export class SettingsStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: DatabaseFactory = indexedDB, name?: string): Promise<SettingsStore> {
    return new SettingsStore(await openPodcasterDatabase(factory, name));
  }

  close(): void {
    this.db.close();
  }

  async load(): Promise<StoredSettings | undefined> {
    try {
      const transaction = this.db.transaction(STORES.meta, 'readonly');
      // SAFETY: IndexedDB returned the row written under this local storage contract.
      const row = (await requestResult(transaction.objectStore(STORES.meta).get(SETTINGS_KEY))) as
        | (StoredSettings & { key: string })
        | undefined;
      if (!row) return undefined;
      const { key: _key, ...settings } = row;
      if (!isValidStoredSettings(settings)) return undefined;
      const voice = normalizeStoredVoice(settings.voice)!;
      const pi = normalizePiSettings(settings.pi);
      const selectedModel = normalizeSelectedModel(settings.selectedModel);
      const voiceProfiles = normalizeVoiceProfiles(settings.voiceProfiles);
      return {
        ...settings,
        voice,
        ...(pi ? { pi } : undefined),
        ...(selectedModel ? { selectedModel } : undefined),
        ...(voiceProfiles ? { voiceProfiles } : undefined),
      };
    } catch {
      return undefined;
    }
  }

  /** Returns false (and leaves the committed row untouched) on any failure. */
  async save(settings: StoredSettings): Promise<boolean> {
    try {
      if (!isValidStoredSettings(settings)) return false;
      const transaction = this.db.transaction(STORES.meta, 'readwrite');
      transaction.objectStore(STORES.meta).put({ key: SETTINGS_KEY, ...settings });
      await transactionDone(transaction);
      return true;
    } catch {
      return false;
    }
  }
}
