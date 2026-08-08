import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { openPodcasterDatabase, STORES } from './schema';

let name = '';
afterEach(async () => { if (name) await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); }); });

describe('IndexedDB schema', () => {
  it('migrates a version-1 turn without losing stable conversation data', async () => {
    name = `schema-v1-${Date.now()}-${Math.random()}`;
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => { const store = request.result.createObjectStore(STORES.turns, { keyPath: 'key' }); store.createIndex('sessionId', 'sessionId'); store.createIndex('responseId', 'responseId'); store.createIndex('playbackId', 'playbackId'); store.put({ key: 's:t', sessionId: 's', turnId: 't', stableText: 'kept words', interrupted: false, createdAt: '2026-01-01T00:00:00Z' }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    legacy.close();
    const db = await openPodcasterDatabase(indexedDB, name);
    const read = db.transaction(STORES.turns, 'readonly').objectStore(STORES.turns).get('s:t');
    expect(await new Promise(resolve => { read.onsuccess = () => resolve(read.result); })).toMatchObject({ stableText: 'kept words', timelineSequence: 1, continuationState: 'none', controlOnly: false });
    db.close();
  });

  it('migrates chronology by creation time rather than conflicting object-store key order', async () => {
    name = `schema-v1-order-${Date.now()}-${Math.random()}`;
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORES.turns, { keyPath: 'key' });
        store.createIndex('sessionId', 'sessionId'); store.createIndex('responseId', 'responseId'); store.createIndex('playbackId', 'playbackId');
        store.put({ key: 's:a-key-last-time', sessionId: 's', turnId: 'later', createdAt: '2026-01-02T00:00:00Z', interrupted: false });
        store.put({ key: 's:z-key-first-time', sessionId: 's', turnId: 'earlier', createdAt: '2026-01-01T00:00:00Z', interrupted: false });
        store.put({ key: 's:m-tie', sessionId: 's', turnId: 'tie-first', createdAt: '2026-01-03T00:00:00Z', interrupted: false });
        store.put({ key: 's:n-tie', sessionId: 's', turnId: 'tie-second', createdAt: '2026-01-03T00:00:00Z', interrupted: false });
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    legacy.close();
    const db = await openPodcasterDatabase(indexedDB, name);
    const request = db.transaction(STORES.turns, 'readonly').objectStore(STORES.turns).getAll();
    const rows = await new Promise<any[]>(resolve => { request.onsuccess = () => resolve(request.result); });
    expect(rows.sort((a, b) => a.timelineSequence - b.timelineSequence).map(row => row.turnId)).toEqual(['earlier', 'later', 'tie-first', 'tie-second']);
    db.close();
  });

  it('creates versioned stores/indexes and preserves records on reopen', async () => {
    name = `schema-${Date.now()}-${Math.random()}`;
    let db = await openPodcasterDatabase(indexedDB, name);
    expect(Array.from(db.objectStoreNames)).toEqual(expect.arrayContaining(Object.values(STORES)));
    const transaction = db.transaction(STORES.turns, 'readwrite');
    const store = transaction.objectStore(STORES.turns);
    expect(Array.from(store.indexNames)).toEqual(expect.arrayContaining(['sessionId', 'responseId', 'playbackId']));
    store.put({ key: 'kept', sessionId: 's' });
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    db.close(); db = await openPodcasterDatabase(indexedDB, name);
    const read = db.transaction(STORES.turns, 'readonly').objectStore(STORES.turns).get('kept');
    expect(await new Promise(resolve => { read.onsuccess = () => resolve(read.result); })).toMatchObject({ key: 'kept' });
    db.close();
  });
});
