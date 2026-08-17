// Browser-local settings persistence. One atomic row in the existing `meta`
// store (no schema version bump), validated on every read. A failed save
// preserves the last committed row and reports failure to the caller.

import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_PERSONA, DEFAULT_TTS_MODEL, DEFAULT_VOICE_SPEED_MODIFIER, MAX_AGENT_NAME_BYTES, MAX_PERSONA_BYTES, MAX_VOICE_SPEED_MODIFIER, MIN_VOICE_SPEED_MODIFIER, SETTINGS_VERSION, ttsModelKey, type TtsModelSelection, type VoicePreference } from '@app/contracts/settings';
import { openPodcasterDatabase, requestResult, STORES, transactionDone, type DatabaseFactory } from '../storage/schema';

export const SETTINGS_KEY = 'settings:v1';

/** The browser-persisted settings row: the display name plus the frozen session snapshot. */
export interface StoredSettings {
  version: typeof SETTINGS_VERSION;
  /** Editable agent display name used in the conversation bubbles; never sent to the host. */
  agentName: string;
  persona: string;
  /** Active model, optional for rows written before model selection existed. */
  selectedModel?: TtsModelSelection;
  /** Active preference retained for wire/session compatibility. */
  voice: VoicePreference;
  /** Backend/model-scoped profiles. A profile is never reused across models. */
  voiceProfiles?: Record<string, VoicePreference>;
}

export const DEFAULT_SETTINGS: StoredSettings = { version: 1, agentName: DEFAULT_AGENT_NAME, persona: DEFAULT_AGENT_PERSONA, selectedModel: { ...DEFAULT_TTS_MODEL }, voice: { catalogId: '', voiceId: '', speedModifier: DEFAULT_VOICE_SPEED_MODIFIER, ...DEFAULT_TTS_MODEL }, voiceProfiles: {} };

function normalizeStoredVoice(value: unknown): VoicePreference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const voice = value as Record<string, unknown>;
  const speedModifier = voice.speedModifier === undefined ? DEFAULT_VOICE_SPEED_MODIFIER : voice.speedModifier;
  if (typeof voice.catalogId !== 'string' || typeof voice.voiceId !== 'string' || typeof speedModifier !== 'number' || !Number.isFinite(speedModifier) || speedModifier < MIN_VOICE_SPEED_MODIFIER || speedModifier > MAX_VOICE_SPEED_MODIFIER) return undefined;
  const hasBackend = voice.backendId !== undefined || voice.modelId !== undefined;
  if (hasBackend
    && (typeof voice.backendId !== 'string' || voice.backendId.length === 0
      || typeof voice.modelId !== 'string' || voice.modelId.length === 0)) return undefined;
  return {
    catalogId: voice.catalogId,
    voiceId: voice.voiceId,
    speedModifier,
    ...(hasBackend ? { backendId: voice.backendId as string, modelId: voice.modelId as string } : {}),
  };
}

function normalizeSelectedModel(value: unknown): TtsModelSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model = value as Record<string, unknown>;
  if (typeof model.backendId !== 'string' || !model.backendId || typeof model.modelId !== 'string' || !model.modelId) return undefined;
  return { backendId: model.backendId, modelId: model.modelId };
}

function normalizeVoiceProfiles(value: unknown): Record<string, VoicePreference> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
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
export function isValidStoredSettings(value: unknown): value is StoredSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.persona !== 'string' || typeof record.agentName !== 'string') return false;
  const selectedModel = normalizeSelectedModel(record.selectedModel);
  if (record.selectedModel !== undefined && !selectedModel) return false;
  const activeVoice = normalizeStoredVoice(record.voice);
  if (selectedModel && activeVoice && ((activeVoice.backendId === undefined) !== (activeVoice.modelId === undefined))) return false;
  if (selectedModel && activeVoice?.backendId && activeVoice.modelId && ttsModelKey(selectedModel) !== ttsModelKey({ backendId: activeVoice.backendId, modelId: activeVoice.modelId })) return false;
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

  async load(): Promise<StoredSettings | undefined> {
    try {
      const transaction = this.db.transaction(STORES.meta, 'readonly');
      const row = await requestResult(transaction.objectStore(STORES.meta).get(SETTINGS_KEY)) as (StoredSettings & { key: string }) | undefined;
      if (!row) return undefined;
      const { key: _key, ...settings } = row;
      if (!isValidStoredSettings(settings)) return undefined;
      const voice = normalizeStoredVoice(settings.voice)!;
      const selectedModel = normalizeSelectedModel(settings.selectedModel);
      const voiceProfiles = normalizeVoiceProfiles(settings.voiceProfiles);
      return {
        ...settings,
        voice,
        ...(selectedModel ? { selectedModel } : {}),
        ...(voiceProfiles ? { voiceProfiles } : {}),
      };
    } catch { return undefined; }
  }

  /** Returns false (and leaves the committed row untouched) on any failure. */
  async save(settings: StoredSettings): Promise<boolean> {
    try {
      if (!isValidStoredSettings(settings)) return false;
      const transaction = this.db.transaction(STORES.meta, 'readwrite');
      transaction.objectStore(STORES.meta).put({ key: SETTINGS_KEY, ...settings });
      await transactionDone(transaction);
      return true;
    } catch { return false; }
  }
}
