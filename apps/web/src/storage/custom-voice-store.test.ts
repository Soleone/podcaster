import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomVoiceStore, type CustomVoiceRecord } from './custom-voice-store';

let name = '';
afterEach(async () => { if (name) await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); }); });

function voice(index = 0): CustomVoiceRecord {
  const hash = `${index.toString(16).padStart(2, '0')}${'a'.repeat(62)}`;
  const bytes = new Uint8Array(160_044);
  return {
    voiceId: `custom:${hash.slice(0, 24)}`,
    name: `Voice ${index}`,
    refSha256: hash,
    sampleRate: 16_000,
    durationMs: 5_000,
    byteLength: bytes.byteLength,
    createdAt: `2026-08-17T00:00:0${index}.000Z`,
    updatedAt: `2026-08-17T00:00:0${index}.000Z`,
    wav: new Blob([bytes], { type: 'audio/wav' }),
  };
}

describe('CustomVoiceStore', () => {
  it('persists metadata and WAV bytes across reopen', async () => {
    name = `custom-voices-${Date.now()}`;
    const first = await CustomVoiceStore.open(indexedDB, name);
    expect(await first.save(voice())).toBe(true);
    first.close();
    const second = await CustomVoiceStore.open(indexedDB, name);
    const rows = await second.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ voiceId: 'custom:00aaaaaaaaaaaaaaaaaaaaaa', name: 'Voice 0', durationMs: 5_000 });
    expect(new Uint8Array(await rows[0]!.wav.arrayBuffer()).byteLength).toBe(160_044);
    second.close();
  });

  it('renames and deletes without changing the reference identity', async () => {
    name = `custom-voices-edit-${Date.now()}`;
    const store = await CustomVoiceStore.open(indexedDB, name);
    const row = voice();
    expect(await store.save(row)).toBe(true);
    expect(await store.rename(row.voiceId, 'Renamed')).toBe(true);
    expect((await store.get(row.voiceId))?.name).toBe('Renamed');
    expect(await store.delete(row.voiceId)).toBe(true);
    expect(await store.get(row.voiceId)).toBeUndefined();
    store.close();
  });

  it('enforces the eight-voice count limit', async () => {
    name = `custom-voices-limit-${Date.now()}`;
    const store = await CustomVoiceStore.open(indexedDB, name);
    for (let index = 0; index < 8; index++) expect(await store.save(voice(index))).toBe(true);
    expect(await store.save(voice(8))).toBe(false);
    expect(await store.list()).toHaveLength(8);
    store.close();
  });
});
