import {
  CUSTOM_VOICE_SAMPLE_RATE,
  MAX_CUSTOM_VOICE_TOTAL_BYTES,
  MAX_CUSTOM_VOICES,
  MAX_VOICE_NAME_BYTES,
  isReferenceSizeValid,
  isValidCustomVoiceId,
  type CustomVoiceMetadata,
} from '@app/contracts/settings';
import {
  openPodcasterDatabase,
  requestResult,
  STORES,
  transactionDone,
  type DatabaseFactory,
  type StoredCustomVoice,
} from './schema';

export type CustomVoiceRecord = StoredCustomVoice;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validRecord(value: unknown): value is CustomVoiceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<CustomVoiceRecord>;
  return (
    isValidCustomVoiceId(row.voiceId) &&
    typeof row.name === 'string' &&
    row.name.trim().length > 0 &&
    utf8Bytes(row.name) <= MAX_VOICE_NAME_BYTES &&
    typeof row.refSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(row.refSha256) &&
    row.voiceId === `custom:${row.refSha256.slice(0, 24)}` &&
    row.sampleRate === CUSTOM_VOICE_SAMPLE_RATE &&
    typeof row.durationMs === 'number' &&
    Number.isInteger(row.durationMs) &&
    row.durationMs >= 3_000 &&
    row.durationMs <= 20_000 &&
    row.wav instanceof Blob &&
    typeof row.byteLength === 'number' &&
    row.byteLength === row.wav.size &&
    isReferenceSizeValid(row.byteLength) &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string'
  );
}

export class CustomVoiceStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: DatabaseFactory = indexedDB, name?: string): Promise<CustomVoiceStore> {
    return new CustomVoiceStore(await openPodcasterDatabase(factory, name));
  }

  async list(): Promise<CustomVoiceRecord[]> {
    try {
      const transaction = this.db.transaction(STORES.customVoices, 'readonly');
      const rows = (await requestResult(transaction.objectStore(STORES.customVoices).getAll())) as unknown[];
      return rows.filter(validRecord).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch {
      return [];
    }
  }

  async get(voiceId: string): Promise<CustomVoiceRecord | undefined> {
    try {
      const transaction = this.db.transaction(STORES.customVoices, 'readonly');
      const row = (await requestResult(transaction.objectStore(STORES.customVoices).get(voiceId))) as unknown;
      return validRecord(row) ? row : undefined;
    } catch {
      return undefined;
    }
  }

  /** Returns false without changing the committed store when a limit is hit. */
  async save(record: CustomVoiceRecord): Promise<boolean> {
    if (!validRecord(record)) return false;
    try {
      const transaction = this.db.transaction(STORES.customVoices, 'readwrite');
      const store = transaction.objectStore(STORES.customVoices);
      const existing = (await requestResult(store.get(record.voiceId))) as CustomVoiceRecord | undefined;
      const all = (await requestResult(store.getAll())) as unknown[];
      const valid = all.filter(validRecord);
      const total =
        valid.reduce((sum, item) => sum + item.byteLength, 0) - (existing?.byteLength ?? 0) + record.byteLength;
      if (!existing && valid.length >= MAX_CUSTOM_VOICES) {
        transaction.abort();
        return false;
      }
      if (total > MAX_CUSTOM_VOICE_TOTAL_BYTES) {
        transaction.abort();
        return false;
      }
      store.put(record);
      await transactionDone(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async rename(voiceId: string, name: string): Promise<boolean> {
    const existing = await this.get(voiceId);
    if (!existing || !name.trim() || utf8Bytes(name) > MAX_VOICE_NAME_BYTES) return false;
    return this.save({ ...existing, name: name.trim(), updatedAt: new Date().toISOString() });
  }

  async delete(voiceId: string): Promise<boolean> {
    try {
      const transaction = this.db.transaction(STORES.customVoices, 'readwrite');
      transaction.objectStore(STORES.customVoices).delete(voiceId);
      await transactionDone(transaction);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }
}

export type CustomVoiceInput = Omit<CustomVoiceMetadata, 'byteLength'> & { wav: Blob; byteLength?: number };
