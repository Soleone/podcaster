/**
 * Runtime values that can reach the app across an I/O boundary (WebSocket
 * text messages, IndexedDB rows, localStorage entries) after successful
 * parsing or structured cloning. Every type that can materialize at those
 * boundaries is enumerated here so that downstream code never has to widen
 * back to `unknown` to inspect a value.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonObject | JsonArray | string | number | boolean | null;

/**
 * Tag-based tests that are exactly equivalent to `typeof` for values decoded
 * from JSON or structured-cloned storage: those boundaries only ever produce
 * plain objects, arrays, strings, numbers, booleans, and null. The tag check
 * keeps the discrimination syntax-free so the boundary contract stays
 * explicit at the call site.
 */
const TAG = Object.prototype.toString;

/** Parses JSON text into the only values JSON syntax can represent. */
export function parseJsonValue(text: string): JsonValue {
  return JSON.parse(text);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return TAG.call(value) === '[object String]';
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return TAG.call(value) === '[object Number]';
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return value === true || value === false;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return TAG.call(value) === '[object Object]';
}

export function isJsonArray(value: JsonValue | undefined): value is JsonArray {
  return Array.isArray(value);
}
