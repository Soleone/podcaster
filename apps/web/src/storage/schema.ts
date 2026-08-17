import type { SessionSettingsSnapshot } from '@app/contracts/settings';

export const PODCASTER_DB_NAME = 'podcaster-local-v1';
export const PODCASTER_DB_VERSION = 4;

export const STORES = {
  sessions: 'sessions',
  turns: 'turns',
  appliedEvents: 'appliedEvents',
  terminalReceipts: 'terminalReceipts',
  meta: 'meta',
  recordingItems: 'recordingItems',
} as const;

export interface StoredSession {
  sessionId: string;
  sessionSeed: string;
  personaDigest: string;
  /** Frozen TTS/persona settings used by the active session, when recorded. */
  settings?: SessionSettingsSnapshot;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  state: 'active' | 'paused' | 'stopped';
  /** Total foreground time accumulated before the current run, when available. */
  activeDurationMs?: number;
  /** Start of the current foreground run. Null while paused or ended. */
  runningSince?: string | null;
  pausedAt?: string | null;
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
  pausedSampleOffset: number | null;
  interruptionDisposition: 'resume_noise' | 'resume_fragment' | 'resume_requested' | 'accept_takeover' | null;
  interruptionIntent: 'non_substantive' | 'continue_previous' | 'new_request' | 'correction' | 'topic_change' | 'stop_previous' | null;
  interruptedResponseId: string | null;
  controlOnly: boolean;
  continuationState: 'none' | 'paused' | 'resumed' | 'discarded';
  timelineSequence: number;
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
    request.onupgradeneeded = event => {
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
      ensureIndex(turns, 'timelineSequence', 'timelineSequence');
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        const rowsRequest = turns.getAll();
        rowsRequest.onsuccess = () => {
          const rows = (rowsRequest.result as Array<Record<string, unknown>>).sort((left, right) => {
            const compare = (a: unknown, b: unknown) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
            const sessionOrder = compare(left.sessionId, right.sessionId);
            if (sessionOrder !== 0) return sessionOrder;
            const chronology = compare(left.createdAt, right.createdAt);
            return chronology !== 0 ? chronology : compare(left.key, right.key);
          });
          let sessionId: string | undefined;
          let sequence = 0;
          for (const value of rows) {
            const rowSessionId = String(value.sessionId);
            if (rowSessionId !== sessionId) { sessionId = rowSessionId; sequence = 0; }
            turns.put({ ...value, pausedSampleOffset: null, interruptionDisposition: null, interruptionIntent: null, interruptedResponseId: null, controlOnly: false, continuationState: value.interrupted ? 'discarded' : 'none', timelineSequence: ++sequence });
          }
        };
      }
      if (!db.objectStoreNames.contains(STORES.appliedEvents)) db.createObjectStore(STORES.appliedEvents, { keyPath: 'eventId' });
      if (!db.objectStoreNames.contains(STORES.terminalReceipts)) db.createObjectStore(STORES.terminalReceipts, { keyPath: 'playbackId' });
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.recordingItems)) {
        const recordingItems = db.createObjectStore(STORES.recordingItems, { keyPath: 'itemId' });
        ensureIndex(recordingItems, 'sessionId', 'sessionId');
        ensureIndex(recordingItems, 'turnId', 'turnId');
        ensureIndex(recordingItems, 'playbackId', 'playbackId');
        ensureIndex(recordingItems, 'recordSeq', 'recordSeq');
      } else if (event.oldVersion >= 3) {
        // Version 4 adds the required `trimmed` flag. Backfill every existing
        // version-3 row (preserving all fields and the audio Blob) as included.
        const recordingItems = transaction.objectStore(STORES.recordingItems);
        const cursorRequest = recordingItems.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const row = cursor.value as Record<string, unknown>;
          if (typeof row.trimmed !== 'boolean') cursor.update({ ...row, trimmed: false });
          cursor.continue();
        };
      }
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
