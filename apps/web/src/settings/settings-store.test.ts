import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { openPodcasterDatabase, requestResult, STORES } from '../storage/schema';
import { SettingsStore } from './settings-store';

let dbName = '';
afterEach(async () => {
  if (dbName) {
    await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(dbName); request.onsuccess = request.onerror = request.onblocked = () => resolve(); });
    dbName = '';
  }
});

const settings = () => ({ version: 1 as const, agentName: 'Ada', persona: 'You are a sharp skeptic.', voice: { catalogId: 'c1', voiceId: 'af_heart' } });

describe('SettingsStore', () => {
  it('persists and reloads settings across store opens on the same database', async () => {
    dbName = 'settings-test-a';
    const store = await SettingsStore.open(indexedDB, dbName);
    expect(await store.load()).toBeUndefined();
    expect(await store.save(settings())).toBe(true);
    const reopened = await SettingsStore.open(indexedDB, dbName);
    expect(await reopened.load()).toEqual(settings());
  });

  it('returns undefined for a corrupt or invalid stored row', async () => {
    dbName = 'settings-test-b';
    const db = await openPodcasterDatabase(indexedDB, dbName);
    const transaction = db.transaction(STORES.meta, 'readwrite');
    transaction.objectStore(STORES.meta).put({ key: 'settings:v1', notTheRightShape: true });
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    const store = await SettingsStore.open(indexedDB, dbName);
    expect(await store.load()).toBeUndefined();
  });

  it('rejects an invalid save without overwriting the last committed row', async () => {
    dbName = 'settings-test-c';
    const store = await SettingsStore.open(indexedDB, dbName);
    expect(await store.save(settings())).toBe(true);
    const oversized = { version: 1 as const, agentName: 'Ada', persona: 'x'.repeat(9000), voice: { catalogId: 'c1', voiceId: 'af_heart' } };
    expect(await store.save(oversized)).toBe(false);
    expect(await store.load()).toEqual(settings());
  });

  it('rejects an agent name over the byte limit', async () => {
    dbName = 'settings-test-d';
    const store = await SettingsStore.open(indexedDB, dbName);
    const longName = { version: 1 as const, agentName: 'x'.repeat(65), persona: 'You are a sharp skeptic.', voice: { catalogId: 'c1', voiceId: 'af_heart' } };
    expect(await store.save(longName)).toBe(false);
    expect(await store.load()).toBeUndefined();
  });
});
