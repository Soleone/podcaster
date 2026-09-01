import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { openPodcasterDatabase, requestResult, STORES } from '../storage/schema';
import { SettingsStore } from './settings-store';

let dbName = '';
afterEach(async () => {
  if (dbName) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
    dbName = '';
  }
});

const settings = () => ({
  // SAFETY: The value is validated or constructed with this declared contract at this boundary.
  version: 1 as const,
  agentName: 'Ada',
  persona: 'You are a sharp skeptic.',
  voice: { catalogId: 'c1', voiceId: 'af_heart', speedModifier: 1.0 },
});

describe('SettingsStore', () => {
  it('closes safely and idempotently', async () => {
    dbName = 'settings-test-close';
    const store = await SettingsStore.open(indexedDB, dbName);
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it('persists and reloads settings across store opens on the same database', async () => {
    dbName = 'settings-test-a';
    const store = await SettingsStore.open(indexedDB, dbName);
    expect(await store.load()).toBeUndefined();
    expect(await store.save(settings())).toBe(true);
    const reopened = await SettingsStore.open(indexedDB, dbName);
    expect(await reopened.load()).toEqual(settings());
  });

  it('closes safely and idempotently', async () => {
    dbName = 'settings-test-close';
    const store = await SettingsStore.open(indexedDB, dbName);
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it('returns undefined for a corrupt or invalid stored row', async () => {
    dbName = 'settings-test-b';
    const db = await openPodcasterDatabase(indexedDB, dbName);
    const transaction = db.transaction(STORES.meta, 'readwrite');
    transaction.objectStore(STORES.meta).put({ key: 'settings:v1', invalidStoredSettings: true });
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
    });
    const store = await SettingsStore.open(indexedDB, dbName);
    expect(await store.load()).toBeUndefined();
  });

  it('rejects an invalid save without overwriting the last committed row', async () => {
    dbName = 'settings-test-c';
    const store = await SettingsStore.open(indexedDB, dbName);
    expect(await store.save(settings())).toBe(true);
    const oversized = {
      // SAFETY: The value is validated or constructed with this declared contract at this boundary.
      version: 1 as const,
      agentName: 'Ada',
      persona: 'x'.repeat(9000),
      voice: { catalogId: 'c1', voiceId: 'af_heart', speedModifier: 1.0 },
    };
    expect(await store.save(oversized)).toBe(false);
    expect(await store.load()).toEqual(settings());
  });

  it('persists the selected model and independent voice profiles across reload', async () => {
    dbName = 'settings-test-models';
    const store = await SettingsStore.open(indexedDB, dbName);
    const value = {
      // SAFETY: The value is validated or constructed with this declared contract at this boundary.
      version: 1 as const,
      agentName: 'Ada',
      persona: 'You are a sharp skeptic.',
      selectedModel: { backendId: 'qwen3', modelId: 'qwen3-tts-0.6b' },
      voice: { backendId: 'qwen3', modelId: 'qwen3-tts-0.6b', catalogId: 'q1', voiceId: 'Serena', speedModifier: 1.0 },
      voiceProfiles: {
        'kokoro:kokoro-82m-onnx': {
          backendId: 'kokoro',
          modelId: 'kokoro-82m-onnx',
          catalogId: 'k1',
          voiceId: 'af_bella',
          speedModifier: 1.4,
        },
        'qwen3:qwen3-tts-0.6b': {
          backendId: 'qwen3',
          modelId: 'qwen3-tts-0.6b',
          catalogId: 'q1',
          voiceId: 'Serena',
          speedModifier: 1.0,
        },
      },
    };
    expect(await store.save(value)).toBe(true);
    const reopened = await SettingsStore.open(indexedDB, dbName);
    expect(await reopened.load()).toEqual(value);
  });

  it('rejects an agent name over the byte limit', async () => {
    dbName = 'settings-test-d';
    const store = await SettingsStore.open(indexedDB, dbName);
    const longName = {
      // SAFETY: The value is validated or constructed with this declared contract at this boundary.
      version: 1 as const,
      agentName: 'x'.repeat(65),
      persona: 'You are a sharp skeptic.',
      voice: { catalogId: 'c1', voiceId: 'af_heart', speedModifier: 1.0 },
    };
    expect(await store.save(longName)).toBe(false);
    expect(await store.load()).toBeUndefined();
  });

  it('rejects empty or cross-key model identities in persisted profiles', async () => {
    dbName = 'settings-test-invalid-model-profile';
    const store = await SettingsStore.open(indexedDB, dbName);
    const base = {
      // SAFETY: The value is validated or constructed with this declared contract at this boundary.
      version: 1 as const,
      agentName: 'Ada',
      persona: 'You are a sharp skeptic.',
      voice: { backendId: 'qwen3', modelId: 'qwen3-model', catalogId: 'q1', voiceId: 'Ryan', speedModifier: 1.0 },
    };
    expect(
      await store.save({
        ...base,
        selectedModel: { backendId: 'qwen3', modelId: 'qwen3-model' },
        voiceProfiles: { 'qwen3:qwen3-model': { ...base.voice, backendId: '', modelId: 'qwen3-model' } },
      }),
    ).toBe(false);
    expect(
      await store.save({
        ...base,
        selectedModel: { backendId: 'qwen3', modelId: 'qwen3-model' },
        voiceProfiles: { 'kokoro:kokoro-82m-onnx': base.voice },
      }),
    ).toBe(false);
  });
});
