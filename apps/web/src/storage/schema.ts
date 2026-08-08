export const PODCASTER_DB_NAME = 'podcaster-local-v1';
export const PODCASTER_DB_VERSION = 1;

export const STORES = {
  sessions: 'sessions',
  turns: 'turns',
  appliedEvents: 'appliedEvents',
  terminalReceipts: 'terminalReceipts',
  meta: 'meta',
} as const;

export interface StoredSession {
  sessionId: string;
  sessionSeed: string;
  personaDigest: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  state: 'active' | 'stopped';
  failures: string[];
}

export interface StoredTurn {
  key: string;
  sessionId: string;
  turnId: string;
  stableText: string | null;
  posture: 'riff' | 'question' | 'challenge' | 'silence' | null;
  eligible: boolean | null;
  policyReason?: string | null;
  responseId: string | null;
  assistantText: string | null;
  playbackId: string | null;
  outputEpoch: number | null;
  sampleRate: number | null;
  generatedSamples: number;
  deliveredSampleOffset: number;
  pendingDeliveredOffset: number;
  terminalReason: 'completed' | 'cancelled' | 'stopped' | 'failed' | null;
  interrupted: boolean;
  failures: string[];
  createdAt: string;
  updatedAt: string;
}

export type DatabaseFactory = Pick<IDBFactory, 'open'>;

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
}

export function openPodcasterDatabase(factory: DatabaseFactory = indexedDB, name = PODCASTER_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, PODCASTER_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction!;
      const sessions = db.objectStoreNames.contains(STORES.sessions)
        ? transaction.objectStore(STORES.sessions)
        : db.createObjectStore(STORES.sessions, { keyPath: 'sessionId' });
      ensureIndex(sessions, 'updatedAt', 'updatedAt');
      const turns = db.objectStoreNames.contains(STORES.turns)
        ? transaction.objectStore(STORES.turns)
        : db.createObjectStore(STORES.turns, { keyPath: 'key' });
      ensureIndex(turns, 'sessionId', 'sessionId');
      ensureIndex(turns, 'responseId', 'responseId');
      ensureIndex(turns, 'playbackId', 'playbackId');
      if (!db.objectStoreNames.contains(STORES.appliedEvents)) db.createObjectStore(STORES.appliedEvents, { keyPath: 'eventId' });
      if (!db.objectStoreNames.contains(STORES.terminalReceipts)) db.createObjectStore(STORES.terminalReceipts, { keyPath: 'playbackId' });
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked'));
  });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}
