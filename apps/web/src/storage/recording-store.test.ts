import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingStore, type StoredRecordingItem } from './recording-store';

let dbName = '';
afterEach(async () => {
  if (dbName) {
    await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(dbName); request.onsuccess = request.onerror = request.onblocked = () => resolve(); });
    dbName = '';
  }
});

const SESSION = '018f1f32-7abc-7def-8abc-0123456789ab';
const OTHER = '018f1f32-7acc-7def-8abc-0123456789ab';

function item(itemId: string, sessionId = SESSION, partial: Partial<StoredRecordingItem> = {}): StoredRecordingItem {
  return {
    itemId, sessionId, recordSeq: 0, role: 'user', turnId: null, responseId: null, partIndex: null, playbackId: null,
    outputEpoch: null, sampleRate: 16000, sampleCount: 0, interrupted: false, deliveredSamples: null, terminalReason: null,
    captureStartSequence: null, captureEndSequence: null, truncated: false, durationMs: 0, createdAt: '2026-01-01T00:00:00Z',
    monotonicMs: 0, trimmed: false, data: new Blob([], { type: 'audio/mpeg' }), ...partial,
  };
}

describe('RecordingStore trim', () => {
  it('round-trips trim and undo across close/reopen without losing the Blob', async () => {
    dbName = `store-${Date.now()}-${Math.random()}`;
    let store = await RecordingStore.open(indexedDB, dbName);
    await store.put(item('a', SESSION, { data: new Blob([new Uint8Array([9, 8, 7])], { type: 'audio/mpeg' }) }));
    await store.setItemTrimmed('a', true);
    let summaries = await store.getSessionItemSummaries(SESSION);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ itemId: 'a', trimmed: true, role: 'user' });
    expect('data' in summaries[0]!).toBe(false);
    store.close();

    store = await RecordingStore.open(indexedDB, dbName);
    summaries = await store.getSessionItemSummaries(SESSION);
    expect(summaries[0]!.trimmed).toBe(true);
    await store.setItemTrimmed('a', false);
    summaries = await store.getSessionItemSummaries(SESSION);
    expect(summaries[0]!.trimmed).toBe(false);
    const full = (await store.getSessionItems(SESSION))[0]!;
    expect(full.trimmed).toBe(false);
    expect(new Uint8Array(await full.data.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    store.close();
  });

  it('updates a whole batch atomically and rejects missing or cross-session members without partial writes', async () => {
    dbName = `store-batch-${Date.now()}-${Math.random()}`;
    const store = await RecordingStore.open(indexedDB, dbName);
    await store.put(item('a'));
    await store.put(item('b'));
    await store.put(item('c', OTHER));
    await store.setItemsTrimmed(SESSION, ['a', 'b'], true);
    expect((await store.getSessionItemSummaries(SESSION)).every(summary => summary.trimmed)).toBe(true);

    await expect(store.setItemsTrimmed(SESSION, ['a', 'b', 'missing'], false)).rejects.toThrow();
    const afterMissing = await store.getSessionItemSummaries(SESSION);
    expect(afterMissing.every(summary => summary.trimmed)).toBe(true);

    await expect(store.setItemsTrimmed(SESSION, ['a', 'c'], false)).rejects.toThrow();
    const afterCrossSession = await store.getSessionItemSummaries(SESSION);
    expect(afterCrossSession.every(summary => summary.trimmed)).toBe(true);
    store.close();
  });

  it('treats an empty batch as a no-op', async () => {
    dbName = `store-empty-${Date.now()}-${Math.random()}`;
    const store = await RecordingStore.open(indexedDB, dbName);
    await expect(store.setItemsTrimmed(SESSION, [], true)).resolves.toBeUndefined();
    store.close();
  });

  it('counts items through the index without materializing Blob handles', async () => {
    dbName = `store-count-${Date.now()}-${Math.random()}`;
    const store = await RecordingStore.open(indexedDB, dbName);
    await store.put(item('a'));
    await store.put(item('b'));
    await store.put(item('c', OTHER));
    expect(await store.countSessionItems(SESSION)).toBe(2);
    store.close();
  });
});
