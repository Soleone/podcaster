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

type ExternalValue = string | number | boolean | null | undefined | ExternalRecord | readonly ExternalValue[];
interface ExternalRecord {
  readonly [key: string]: ExternalValue;
}
/** Structured-cloned row values: JSON shapes plus the Blob that stores voice audio. */
type StoredValue = ExternalValue | Blob;
type StorableInput = StoredValue | CustomVoiceRecord;
const valueTag = Object.prototype.toString;
const isJsonString = (value: StorableInput): value is string => valueTag.call(value) === '[object String]';
const isJsonNumber = (value: StorableInput): value is number => valueTag.call(value) === '[object Number]';
const isJsonObject = (value: StorableInput): value is ExternalRecord => valueTag.call(value) === '[object Object]';
const isJsonArray = (value: StorableInput): value is readonly ExternalValue[] => Array.isArray(value);

export type CustomVoiceRecord = StoredCustomVoice;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validRecord(value: StorableInput): value is CustomVoiceRecord {
  if (!value || !isJsonObject(value) || isJsonArray(value)) return false;
  // SAFETY: The value is validated or constructed with this declared contract at this boundary.
  const row = value as Partial<CustomVoiceRecord>;
  return (
    isValidCustomVoiceId(row.voiceId) &&
    isJsonString(row.name) &&
    row.name.trim().length > 0 &&
    utf8Bytes(row.name) <= MAX_VOICE_NAME_BYTES &&
    isJsonString(row.refSha256) &&
    /^[a-f0-9]{64}$/.test(row.refSha256) &&
    row.voiceId === `custom:${row.refSha256.slice(0, 24)}` &&
    row.sampleRate === CUSTOM_VOICE_SAMPLE_RATE &&
    isJsonNumber(row.durationMs) &&
    Number.isInteger(row.durationMs) &&
    row.durationMs >= 3_000 &&
    row.durationMs <= 20_000 &&
    row.wav instanceof Blob &&
    isJsonNumber(row.byteLength) &&
    row.byteLength === row.wav.size &&
    isReferenceSizeValid(row.byteLength) &&
    isJsonString(row.createdAt) &&
    isJsonString(row.updatedAt)
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
      // SAFETY: The value is validated or constructed with this declared contract at this boundary.
      const rows = (await requestResult(
        transaction.objectStore(STORES.customVoices).getAll(),
      )) as readonly StorableInput[];
      return rows.filter(validRecord).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch {
      return [];
    }
  }

  async get(voiceId: string): Promise<CustomVoiceRecord | undefined> {
    try {
      const transaction = this.db.transaction(STORES.customVoices, 'readonly');
      // SAFETY: The value is validated or constructed with this declared contract at this boundary.
      const row = (await requestResult(transaction.objectStore(STORES.customVoices).get(voiceId))) as StorableInput;
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
      // SAFETY: The value is validated or constructed with this declared contract at this boundary.
      const existing = (await requestResult(store.get(record.voiceId))) as CustomVoiceRecord | undefined;
      // SAFETY: The value is validated or constructed with this declared contract at this boundary.
      const all = (await requestResult(store.getAll())) as readonly StorableInput[];
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
