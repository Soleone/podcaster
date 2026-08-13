// Browser-local settings persistence. One atomic row in the existing `meta`
// store (no schema version bump), validated on every read. A failed save
// preserves the last committed row and reports failure to the caller.

import { isValidSessionSettingsSnapshot, type SessionSettingsSnapshot } from '@app/contracts/settings';
import { openPodcasterDatabase, requestResult, STORES, transactionDone, type DatabaseFactory } from '../storage/schema';

export const SETTINGS_KEY = 'settings:v1';
export type StoredSettings = SessionSettingsSnapshot;

export class SettingsStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: DatabaseFactory = indexedDB, name?: string): Promise<SettingsStore> {
    return new SettingsStore(await openPodcasterDatabase(factory, name));
  }

  async load(): Promise<StoredSettings | undefined> {
    try {
      const transaction = this.db.transaction(STORES.meta, 'readonly');
      const row = await requestResult(transaction.objectStore(STORES.meta).get(SETTINGS_KEY)) as StoredSettings | undefined;
      return row && isValidSessionSettingsSnapshot(row) ? row : undefined;
    } catch { return undefined; }
  }

  /** Returns false (and leaves the committed row untouched) on any failure. */
  async save(settings: StoredSettings): Promise<boolean> {
    try {
      if (!isValidSessionSettingsSnapshot(settings)) return false;
      const transaction = this.db.transaction(STORES.meta, 'readwrite');
      transaction.objectStore(STORES.meta).put({ key: SETTINGS_KEY, ...settings });
      await transactionDone(transaction);
      return true;
    } catch { return false; }
  }
}
