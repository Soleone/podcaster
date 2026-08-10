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
  data: Blob;
}

export class RecordingStore {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: DatabaseFactory, name?: string): Promise<RecordingStore> {
    return new RecordingStore(await openPodcasterDatabase(factory, name));
  }

  close(): void { this.db.close(); }

  async getRecordingEnabled(): Promise<boolean> {
    const transaction = this.db.transaction(STORES.meta, 'readonly');
    const meta = await requestResult(transaction.objectStore(STORES.meta).get('recordingEnabled')) as { enabled?: boolean } | undefined;
    return meta?.enabled === true;
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
    const item = await requestResult(store.get(itemId)) as StoredRecordingItem | undefined;
    if (item && item.turnId !== turnId) store.put({ ...item, turnId });
    await transactionDone(transaction);
  }

  async getSessionItems(sessionId: string): Promise<StoredRecordingItem[]> {
    const transaction = this.db.transaction(STORES.recordingItems, 'readonly');
    return await requestResult(transaction.objectStore(STORES.recordingItems).index('sessionId').getAll(sessionId)) as StoredRecordingItem[];
  }

  async countSessionItems(sessionId: string): Promise<number> {
    return (await this.getSessionItems(sessionId)).length;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const transaction = this.db.transaction(STORES.recordingItems, 'readwrite');
    const store = transaction.objectStore(STORES.recordingItems);
    const items = await requestResult(store.index('sessionId').getAll(sessionId)) as StoredRecordingItem[];
    for (const item of items) store.delete(item.itemId);
    await transactionDone(transaction);
  }
}
