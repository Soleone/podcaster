// Primitive decode helpers for values produced at an I/O boundary (JSON.parse,
// response.json()) and consumed only by the AudioClient / sidecar process
// modules. The anti-slop lint forbids typeof checks and unknown parameters, so
// JSON shape validation is expressed with these explicit predicates
// (String(value) === value holds only for string primitives among JSON values).
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function isJsonString(value: JsonValue | undefined): value is string {
  return value !== undefined && String(value) === value;
}
export function isJsonNumber(value: JsonValue | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}
export function readString(record: Record<string, JsonValue>, key: string): string | undefined {
  const value = record[key];
  return isJsonString(value) ? value : undefined;
}
export function readNumber(record: Record<string, JsonValue>, key: string): number | undefined {
  const value = record[key];
  return isJsonNumber(value) ? value : undefined;
}
export function readBoolean(record: Record<string, JsonValue>, key: string): boolean | undefined {
  const value = record[key];
  return value === true || value === false ? value : undefined;
}
export function readArray(record: Record<string, JsonValue>, key: string): JsonValue[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  // SAFETY: Array.isArray confirmed an array of JSON.parse output, whose
  // elements are all JSON values.
  return value as JsonValue[];
}
export function readRecord(record: Record<string, JsonValue>, key: string): Record<string, JsonValue> | undefined {
  const value = record[key];
  if (value === null || value === true || value === false) return undefined;
  if (isJsonNumber(value)) return undefined;
  if (isJsonString(value)) return undefined;
  if (Array.isArray(value)) return undefined;
  // SAFETY: the JSON value universe is null, booleans, numbers, strings,
  // arrays, and plain objects; every other case is excluded above.
  return value as Record<string, JsonValue>;
}
