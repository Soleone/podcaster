import { openPodcasterDatabase, requestResult, STORES, transactionDone, type DatabaseFactory } from './schema';

export type RecordingRole = 'user' | 'agent';
export type RecordingSampleRate = 16000 | 24000;
export type TerminalReason = 'completed' | 'cancelled' | 'stopped' | 'failed' | null;

export interface StoredRecordingItem {
  itemId: string;
  sessionId: string;
  recordSeq: number;
  role: RecordingRole;
  turnId: string | null;
  responseId: string | null;
  partIndex: number | null;
  playbackId: string | null;
  outputEpoch: number | null;
  sampleRate: RecordingSampleRate;
  sampleCount: number;
  interrupted: boolean;
  deliveredSamples: number | null;
  terminalReason: TerminalReason;
  captureStartSequence: number | null;
  captureEndSequence: number | null;
  truncated: boolean;
  durationMs: number;
  createdAt: string;
  monotonicMs: number;
  trimmed: boolean;
  data: Blob;
}

/** Blob-free projection of a stored recording row for UI trim state. */
export interface RecordingItemSummary {
  itemId: string;
  sessionId: string;
  recordSeq: number;
  role: RecordingRole;
  turnId: string | null;
  responseId: string | null;
  partIndex: number | null;
  trimmed: boolean;
}

export class RecordingStore {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: DatabaseFactory, name?: string): Promise<RecordingStore> {
    return new RecordingStore(await openPodcasterDatabase(factory, name));
  }

  close(): void {
    this.db.close();
  }

  // Recording is always on for every session; there is no user toggle to persist.
  async getRecordingEnabled(): Promise<boolean> {
    return true;
  }

  async setRecordingEnabled(enabled: boolean): Promise<void> {
    const transaction = this.db.transaction(STORES.meta, 'readwrite');
    transaction.objectStore(STORES.meta).put({ key: 'recordingEnabled', enabled });
    await transactionDone(transaction);
  }

  async put(item: StoredRecordingItem): Promise<void> {
    const transaction = this.db.transaction(STORES.recordingItems, 'readwrite');
    transaction.objectStore(STORES.recordingItems).put(item);
    await transactionDone(transaction);
  }

  async updateTurnId(itemId: string, turnId: string): Promise<void> {
    const transaction = this.db.transaction(STORES.recordingItems, 'readwrite');
    const store = transaction.objectStore(STORES.recordingItems);
    // SAFETY: this store is populated only with StoredRecordingItem rows by this repository.
    const item = (await requestResult(store.get(itemId))) as StoredRecordingItem | undefined;
    if (item && item.turnId !== turnId) store.put({ ...item, turnId });
    await transactionDone(transaction);
  }

  async getSessionItems(sessionId: string): Promise<StoredRecordingItem[]> {
    const transaction = this.db.transaction(STORES.recordingItems, 'readonly');
    // SAFETY: this indexed query reads rows written as StoredRecordingItem values by this repository.
    return (await requestResult(
      transaction.objectStore(STORES.recordingItems).index('sessionId').getAll(sessionId),
    )) as StoredRecordingItem[];
  }

  async getSessionItemSummaries(sessionId: string): Promise<RecordingItemSummary[]> {
    const items = await this.getSessionItems(sessionId);
    return items.map((item) => ({
      itemId: item.itemId,
      sessionId: item.sessionId,
      recordSeq: item.recordSeq,
      role: item.role,
      turnId: item.turnId,
      responseId: item.responseId,
      partIndex: item.partIndex,
      trimmed: item.trimmed,
    }));
  }

  async setItemTrimmed(itemId: string, trimmed: boolean): Promise<void> {
    const transaction = this.db.transaction(STORES.recordingItems, 'readwrite');
    const store = transaction.objectStore(STORES.recordingItems);
    // SAFETY: this store is populated only with StoredRecordingItem rows by this repository.
    const item = (await requestResult(store.get(itemId))) as StoredRecordingItem | undefined;
    if (item) store.put({ ...item, trimmed });
    await transactionDone(transaction);
  }

  /**
   * Atomically marks every supplied row for one session as trimmed or included.
   * Empty input is a no-op. Every row must exist and belong to the session; the
   * transaction aborts without partial writes otherwise.
   */
  async setItemsTrimmed(sessionId: string, itemIds: string[], trimmed: boolean): Promise<void> {
    if (itemIds.length === 0) return;
    const transaction = this.db.transaction(STORES.recordingItems, 'readwrite');
    const store = transaction.objectStore(STORES.recordingItems);
    const updates: StoredRecordingItem[] = [];
    for (const itemId of itemIds) {
      // SAFETY: this store is populated only with StoredRecordingItem rows by this repository.
      const item = (await requestResult(store.get(itemId))) as StoredRecordingItem | undefined;
      if (!item || item.sessionId !== sessionId) {
        transaction.abort();
        await transactionDone(transaction).catch(() => undefined);
        throw new Error(`Trim batch rejected: recording item ${itemId} is missing or belongs to another session.`);
      }
      updates.push(item);
    }
    for (const item of updates) store.put({ ...item, trimmed });
    await transactionDone(transaction);
  }

  async countSessionItems(sessionId: string): Promise<number> {
    const transaction = this.db.transaction(STORES.recordingItems, 'readonly');
    // SAFETY: IndexedDB count requests always resolve to a number.
    return (await requestResult(
      transaction.objectStore(STORES.recordingItems).index('sessionId').count(sessionId),
    )) as number;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const transaction = this.db.transaction(STORES.recordingItems, 'readwrite');
    const store = transaction.objectStore(STORES.recordingItems);
    // SAFETY: this indexed query reads rows written as StoredRecordingItem values by this repository.
    const items = (await requestResult(store.index('sessionId').getAll(sessionId))) as StoredRecordingItem[];
    for (const item of items) store.delete(item.itemId);
    await transactionDone(transaction);
  }
}
