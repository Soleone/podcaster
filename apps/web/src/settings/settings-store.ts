// Browser-local settings persistence. One atomic row in the existing `meta`
// store (no schema version bump), validated on every read. A failed save
// preserves the last committed row and reports failure to the caller.

import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_PERSONA, DEFAULT_VOICE_SPEED_MODIFIER, MAX_AGENT_NAME_BYTES, MAX_PERSONA_BYTES, MAX_VOICE_SPEED_MODIFIER, MIN_VOICE_SPEED_MODIFIER, SETTINGS_VERSION, type VoicePreference } from '@app/contracts/settings';
import { openPodcasterDatabase, requestResult, STORES, transactionDone, type DatabaseFactory } from '../storage/schema';

export const SETTINGS_KEY = 'settings:v1';

/** The browser-persisted settings row: the display name plus the frozen session snapshot. */
export interface StoredSettings {
  version: typeof SETTINGS_VERSION;
  /** Editable agent display name used in the conversation bubbles; never sent to the host. */
  agentName: string;
  persona: string;
  voice: VoicePreference;
}

export const DEFAULT_SETTINGS: StoredSettings = { version: 1, agentName: DEFAULT_AGENT_NAME, persona: DEFAULT_AGENT_PERSONA, voice: { catalogId: '', voiceId: '', speedModifier: DEFAULT_VOICE_SPEED_MODIFIER } };

function normalizeStoredVoice(value: unknown): VoicePreference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const voice = value as Record<string, unknown>;
  const speedModifier = voice.speedModifier === undefined ? DEFAULT_VOICE_SPEED_MODIFIER : voice.speedModifier;
  if (typeof voice.catalogId !== 'string' || typeof voice.voiceId !== 'string' || typeof speedModifier !== 'number' || !Number.isFinite(speedModifier) || speedModifier < MIN_VOICE_SPEED_MODIFIER || speedModifier > MAX_VOICE_SPEED_MODIFIER) return undefined;
  return { catalogId: voice.catalogId, voiceId: voice.voiceId, speedModifier };
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
      return { ...settings, voice: normalizeStoredVoice(settings.voice)! };
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
