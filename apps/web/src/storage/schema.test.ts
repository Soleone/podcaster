import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { openPodcasterDatabase, STORES } from './schema';

let name = '';
afterEach(async () => { if (name) await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); }); });

describe('IndexedDB schema', () => {
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
