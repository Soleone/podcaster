// Browser-local settings persistence. One atomic row in the existing `meta`
// store (no schema version bump), validated on every read. A failed save
// preserves the last committed row and reports failure to the caller.

import { DEFAULT_AGENT_PERSONA, MAX_PERSONA_BYTES, type SessionSettingsSnapshot } from '@app/contracts/settings';
import { openPodcasterDatabase, requestResult, STORES, transactionDone, type DatabaseFactory } from '../storage/schema';

export const SETTINGS_KEY = 'settings:v1';
export type StoredSettings = SessionSettingsSnapshot;

export const DEFAULT_SETTINGS: StoredSettings = { version: 1, persona: DEFAULT_AGENT_PERSONA, voice: { catalogId: '', voiceId: '' } };

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
  if (record.version !== 1 || typeof record.persona !== 'string') return false;
  if (utf8ByteLength(record.persona) > MAX_PERSONA_BYTES) return false;
  const voice = record.voice as Record<string, unknown> | undefined;
  if (!voice || typeof voice !== 'object' || typeof voice.catalogId !== 'string' || typeof voice.voiceId !== 'string') return false;
  return true;
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
      return isValidStoredSettings(settings) ? (settings as StoredSettings) : undefined;
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
