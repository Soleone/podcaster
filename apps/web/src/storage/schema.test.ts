import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { openPodcasterDatabase, PODCASTER_DB_VERSION, STORES } from './schema';

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

  it('closes an old connection on versionchange so a higher-version open is not blocked', async () => {
    name = `schema-versionchange-${Date.now()}-${Math.random()}`;
    const db = await openPodcasterDatabase(indexedDB, name);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, PODCASTER_DB_VERSION + 1);
      request.onblocked = () => reject(new Error('versionchange open was blocked'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('versionchange open failed'));
    });
    expect(upgraded.version).toBe(PODCASTER_DB_VERSION + 1);
    upgraded.close();
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

  it('closes connections on versionchange so a higher-version open is not blocked', async () => {
    name = `schema-versionchange-${Date.now()}-${Math.random()}`;
    const db = await openPodcasterDatabase(indexedDB, name);
    let blocked = false;
    const request = indexedDB.open(name, PODCASTER_DB_VERSION + 1);
    request.onblocked = () => { blocked = true; };
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(blocked).toBe(false);
    expect(upgraded.version).toBe(PODCASTER_DB_VERSION + 1);
    upgraded.close();
    db.close();
  });

  it('migrates a version-2 database to the current version with the recordingItems store and indexes', async () => {
    name = `schema-v2-${Date.now()}-${Math.random()}`;
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const turns = db.createObjectStore(STORES.turns, { keyPath: 'key' });
        turns.createIndex('sessionId', 'sessionId');
        turns.createIndex('responseId', 'responseId');
        turns.createIndex('playbackId', 'playbackId');
        db.createObjectStore(STORES.sessions, { keyPath: 'sessionId' });
        db.createObjectStore(STORES.appliedEvents, { keyPath: 'eventId' });
        db.createObjectStore(STORES.terminalReceipts, { keyPath: 'playbackId' });
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
        turns.put({ key: 'kept', sessionId: 's', turnId: 't', stableText: 'kept words', interrupted: false, createdAt: '2026-01-01T00:00:00Z', timelineSequence: 1 });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();
    const db = await openPodcasterDatabase(indexedDB, name);
    expect(Array.from(db.objectStoreNames)).toEqual(expect.arrayContaining([...Object.values(STORES)]));
    expect(db.version).toBe(5);
    const recordingItems = db.transaction(STORES.recordingItems, 'readonly').objectStore(STORES.recordingItems);
    expect(Array.from(recordingItems.indexNames)).toEqual(expect.arrayContaining(['sessionId', 'turnId', 'playbackId', 'recordSeq']));
    const kept = db.transaction(STORES.turns, 'readonly').objectStore(STORES.turns).get('kept');
    expect(await new Promise(resolve => { kept.onsuccess = () => resolve(kept.result); })).toMatchObject({ stableText: 'kept words' });
    db.close();
  });

  it('migrates a version-3 recording item to version 4 with trimmed:false and preserved bytes', async () => {
    name = `schema-v3-${Date.now()}-${Math.random()}`;
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        const turns = db.createObjectStore(STORES.turns, { keyPath: 'key' });
        turns.createIndex('sessionId', 'sessionId');
        turns.createIndex('responseId', 'responseId');
        turns.createIndex('playbackId', 'playbackId');
        turns.createIndex('timelineSequence', 'timelineSequence');
        db.createObjectStore(STORES.sessions, { keyPath: 'sessionId' });
        db.createObjectStore(STORES.appliedEvents, { keyPath: 'eventId' });
        db.createObjectStore(STORES.terminalReceipts, { keyPath: 'playbackId' });
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
        const recordingItems = db.createObjectStore(STORES.recordingItems, { keyPath: 'itemId' });
        recordingItems.createIndex('sessionId', 'sessionId');
        recordingItems.createIndex('turnId', 'turnId');
        recordingItems.createIndex('playbackId', 'playbackId');
        recordingItems.createIndex('recordSeq', 'recordSeq');
        recordingItems.put({ itemId: 'item-1', sessionId: 's', recordSeq: 0, role: 'user', turnId: 't', responseId: null, partIndex: null, playbackId: null, outputEpoch: null, sampleRate: 16000, sampleCount: 10, interrupted: false, deliveredSamples: null, terminalReason: null, captureStartSequence: 0, captureEndSequence: 5, truncated: false, durationMs: 10, createdAt: '2026-01-01T00:00:00Z', monotonicMs: 0, data: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/mpeg' }) });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();
    const db = await openPodcasterDatabase(indexedDB, name);
    expect(db.version).toBe(5);
    const read = db.transaction(STORES.recordingItems, 'readonly').objectStore(STORES.recordingItems).get('item-1');
    const row = await new Promise<any>(resolve => { read.onsuccess = () => resolve(read.result); });
    expect(row.trimmed).toBe(false);
    expect(row).toMatchObject({ sessionId: 's', recordSeq: 0, role: 'user', turnId: 't', captureStartSequence: 0, captureEndSequence: 5 });
    expect(row.data.type).toBe('audio/mpeg');
    expect(new Uint8Array(await row.data.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    db.close();
  });
});
