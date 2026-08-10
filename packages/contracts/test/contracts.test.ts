import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, test } from "vitest";
import { CONTRACT_SCHEMAS } from "../src/generated/contracts.js";
import { CONTRACT_VALIDATORS } from "../src/validators.js";
import { decodeBinaryAudioFrame, encodeBinaryAudioFrame } from "../src/binary.js";

const root = resolve(import.meta.dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
const canonical = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(canonical);
canonical.addKeyword({
  keyword: "maxUtf8Bytes",
  type: "string",
  schemaType: "number",
  validate: (limit: number, value: string) => !hasUnpairedSurrogate(value) && Buffer.byteLength(value, "utf8") <= limit,
});
for (const directory of ["schema", "schema/events", "schema/benchmarks"]) {
  for (const file of readdirSync(resolve(root, directory)).filter((name) => name.endsWith(".json")).sort()) canonical.addSchema(readJson(`${directory}/${file}`));
}

const cases = [
  ["protocol-envelope.json", "core-event", "protocol-envelope"],
  ["events/core-events.json", "core-event", "core-events"],
  ["events/barge-in.json", "barge-in", "barge-in"],
  ["events/browser-command.json", "browser-command", "browser-command"],
  ["events/failure.json", "failure", "failure"],
  ["events/interruption-decision.json", "interruption-decision", "interruption-decision"],
  ["events/playback-progress.json", "playback-progress", "playback-progress"],
  ["events/playback-paused.json", "playback-paused", "playback-paused"],
  ["events/playback-stopped.json", "playback-stopped", "playback-stopped"],
  ["events/policy-decision.json", "policy-decision", "policy-decision"],
  ["events/reasoning-started.json", "reasoning-started", "reasoning-started"],
  ["events/reasoning-final.json", "reasoning-final", "reasoning-final"],
  ["events/reasoning-delta.json", "reasoning-delta", "reasoning-delta"],
  ["events/response-failed.json", "response-failed", "response-failed"],
  ["events/response-part-final.json", "response.part_final", "response-part-final"],
  ["events/response-part-started.json", "response.part_started", "response-part-started"],
  ["events/session-state.json", "session-state", "session-state"],
  ["events/sidecar-message.json", "sidecar-message", "sidecar-message"],
  ["events/transcript-final.json", "transcript-final", "transcript-final"],
  ["events/transcript-partial.json", "transcript-partial", "transcript-partial"],
  ["events/tts-ended.json", "tts-ended", "tts-ended"],
  ["events/tts-started.json", "tts-started", "tts-started"],
  ["persona.json", "persona", "persona"],
  ["history-export.json", "history-export", "history-export"],
  ["benchmarks/run.json", "benchmark-run", "benchmark-run"],
  ["benchmarks/item.json", "benchmark-item", "benchmark-item"],
  ["benchmarks/event.json", "benchmark-event", "benchmark-event"],
  ["benchmarks/summary.json", "benchmark-summary", "benchmark-summary"],
  ["benchmarks/rating.json", "benchmark-rating", "benchmark-rating"],
] as const;

type JsonSchema = Record<string, any>;
const schemasById = new Map<string, JsonSchema>(Object.values(CONTRACT_SCHEMAS).map(schema => [schema.$id, schema as JsonSchema]));
function resolveRef(ref: string, document: JsonSchema): { schema: JsonSchema; document: JsonSchema } {
  const url = new URL(ref, document.$id);
  const target = schemasById.get(url.origin + url.pathname) ?? document;
  let schema = target;
  if (url.hash) for (const segment of url.hash.slice(2).split("/")) schema = schema[segment];
  return { schema, document: target };
}
function setAt(root: any, path: (string | number)[], value: unknown) {
  let parent = root;
  for (const key of path.slice(0, -1)) parent = parent[key];
  parent[path.at(-1)!] = value;
}
function systematicMutations(schema: JsonSchema, exemplar: any) {
  const mutations: { name: string; value: unknown }[] = [];
  const add = (name: string, path: (string | number)[], replacement: unknown, remove = false) => {
    const value = structuredClone(exemplar); let parent = value;
    for (const key of path.slice(0, -1)) parent = parent[key];
    if (remove) delete parent[path.at(-1)!]; else setAt(value, path, structuredClone(replacement));
    mutations.push({ name, value });
  };
  const visit = (node: JsonSchema, value: any, path: (string | number)[], document: JsonSchema) => {
    if (node.$ref) { const resolved = resolveRef(node.$ref, document); visit(resolved.schema, value, path, resolved.document); return; }
    for (const branch of node.allOf ?? []) visit(branch, value, path, document);
    for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? [])]) {
      const types = Array.isArray(branch.type) ? branch.type : [branch.type];
      const matches = branch.$ref || types.includes(typeof value) || (types.includes("object") && value !== null && typeof value === "object" && !Array.isArray(value)) || (types.includes("null") && value === null);
      if (matches) visit(branch, value, path, document);
    }
    const label = `/${path.join("/") || "root"}`;
    if (node.const !== undefined) add(`${label} const`, path, node.const === 1 ? 2 : "__invalid_const__");
    if (node.enum) add(`${label} enum`, path, "__invalid_enum__");
    if (node.format) add(`${label} format`, path, "not-a-valid-format");
    if (node.pattern) add(`${label} pattern`, path, "INVALID");
    if (node.minimum !== undefined) add(`${label} minimum`, path, node.minimum - 1);
    if (node.maximum !== undefined) add(`${label} maximum`, path, node.maximum + 1);
    if (node.minLength !== undefined) add(`${label} minLength`, path, "".padEnd(Math.max(0, node.minLength - 1), "x"));
    if (node.maxLength !== undefined) add(`${label} maxLength`, path, "x".repeat(node.maxLength + 1));
    if (node.minItems !== undefined) add(`${label} minItems`, path, value.slice(0, Math.max(0, node.minItems - 1)));
    if (node.maxItems !== undefined) add(`${label} maxItems`, path, Array.from({ length: node.maxItems + 1 }, (_, index) => `item-${index}`));
    if (node.uniqueItems && value.length) add(`${label} uniqueItems`, path, [value[0], value[0]]);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of node.required ?? []) if (Object.hasOwn(value, key)) add(`${label} required ${key}`, [...path, key], undefined, true);
      if (node.additionalProperties === false) add(`${label} extra property`, [...path, "AWS_SECRET_ACCESS_KEY"], "must-not-pass");
      for (const [key, child] of Object.entries(node.properties ?? {})) if (Object.hasOwn(value, key)) visit(child as JsonSchema, value[key], [...path, key], document);
    }
    if (Array.isArray(value) && node.items) value.forEach((item, index) => visit(node.items, item, [...path, index], document));
  };
  visit(schema, exemplar, [], schema);
  return mutations;
}

describe("canonical and generated model-associated validator parity", () => {
  test.each(cases)("accepts positive fixture for %s", (schemaPath, validName) => {
    const id = `https://podcaster.local/schema/${schemaPath}`;
    const title = CONTRACT_SCHEMAS[schemaPath].title;
    const positive = readJson(`fixtures/valid/${validName}.json`);
    expect(canonical.validate(id, positive), JSON.stringify(canonical.errors)).toBe(true);
    expect(CONTRACT_VALIDATORS[title](positive), JSON.stringify(CONTRACT_VALIDATORS[title].errors)).toBe(true);
  });
  for (const [schemaPath, validName] of cases.map(([path, valid]) => [path, valid] as const)) {
    const schema = CONTRACT_SCHEMAS[schemaPath] as JsonSchema;
    const mutations = systematicMutations(schema, readJson(`fixtures/valid/${validName}.json`));
    test.each(mutations)(`${schemaPath}: $name`, ({ value }) => {
      expect(canonical.validate(schema.$id, value), JSON.stringify(canonical.errors)).toBe(false);
      const generated = CONTRACT_VALIDATORS[schema.title as keyof typeof CONTRACT_VALIDATORS];
      expect(generated(value), JSON.stringify(generated.errors)).toBe(false);
    });
  }
  test("benchmark run requires UTC completion timestamps and rejects secret-like environment keys", () => {
    const valid = readJson("fixtures/valid/benchmark-run.json");
    const validate = CONTRACT_VALIDATORS.BenchmarkRun;
    expect(validate({ ...valid, startedAt: "2026-08-06T12:00:00+01:00" })).toBe(false);
    expect(validate({ ...valid, endedAt: null, status: "passed" })).toBe(false);
    expect(validate({ ...valid, environment: { AWS_SECRET_ACCESS_KEY: "secret" } })).toBe(false);
    expect(validate({ ...valid, endedAt: null, status: "running" })).toBe(true);
  });
  test("enforces the persona body UTF-8 byte and well-formed string limits across canonical validators", () => {
    const valid = readJson("fixtures/valid/persona.json");
    const exact = { ...valid, body: "😀".repeat(4096) };
    const oversized = { ...valid, body: "😀".repeat(4097) };
    expect(canonical.validate("https://podcaster.local/schema/persona.json", exact), JSON.stringify(canonical.errors)).toBe(true);
    expect(CONTRACT_VALIDATORS.Persona(exact), JSON.stringify(CONTRACT_VALIDATORS.Persona.errors)).toBe(true);
    for (const invalid of [oversized, { ...valid, body: "\ud800" }, { ...valid, body: "\udc00" }]) {
      expect(canonical.validate("https://podcaster.local/schema/persona.json", invalid)).toBe(false);
      expect(CONTRACT_VALIDATORS.Persona(invalid)).toBe(false);
    }
  });
  test("generates exactly one runtime schema for every canonical schema", () => {
    expect(Object.keys(CONTRACT_SCHEMAS).sort()).toEqual(cases.map(([path]) => path).sort());
    expect(Object.keys(CONTRACT_VALIDATORS).sort()).toEqual(Object.values(CONTRACT_SCHEMAS).map(schema => schema.title).sort());
  });
});

describe("multi-part response part constraints", () => {
  const partStarted = (payload: Record<string, unknown>) => CONTRACT_VALIDATORS.ResponsePartStartedEvent({ protocolVersion: 1, sessionId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f1", epoch: 2, eventId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f3", monotonicMs: 1000, type: "response.part_started", payload });
  const base = { turnId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f5", responseId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f6" };
  test("accepts stall at index 0 and body at indices 1-7", () => {
    expect(partStarted({ ...base, kind: "stall", partIndex: 0 })).toBe(true);
    for (const index of [1, 3, 7]) expect(partStarted({ ...base, kind: "body", partIndex: index })).toBe(true);
  });
  test("rejects stall at nonzero index, body at index 0, and out-of-range indices", () => {
    expect(partStarted({ ...base, kind: "stall", partIndex: 1 })).toBe(false);
    expect(partStarted({ ...base, kind: "body", partIndex: 0 })).toBe(false);
    expect(partStarted({ ...base, kind: "body", partIndex: 8 })).toBe(false);
    expect(partStarted({ ...base, kind: "body", partIndex: -1 })).toBe(false);
    expect(partStarted({ ...base, kind: "stall", partIndex: 0.5 })).toBe(false);
  });
  test("rejects a partId without a partIndex, and unknown kinds", () => {
    expect(partStarted({ ...base, kind: "body", partIndex: 1, partId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f7" })).toBe(true);
    expect(partStarted({ ...base, kind: "body", partId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f7" })).toBe(false);
    expect(partStarted({ ...base, kind: "intro", partIndex: 0 })).toBe(false);
  });
  test("multipart TTS started requires outputStreamId; legacy may omit it", () => {
    const env = { protocolVersion: 1, sessionId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f1", epoch: 2, eventId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f3", monotonicMs: 1000, type: "tts.started" };
    const base = { responseId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f6", playbackId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f7", sampleRate: 24000 };
    expect(CONTRACT_VALIDATORS.TtsStartedEvent({ ...env, payload: base })).toBe(true);
    expect(CONTRACT_VALIDATORS.TtsStartedEvent({ ...env, payload: { ...base, partIndex: 1 } })).toBe(false);
    expect(CONTRACT_VALIDATORS.TtsStartedEvent({ ...env, payload: { ...base, partIndex: 1, outputStreamId: 42 } })).toBe(true);
  });
  test("reasoning events reject partId without partIndex", () => {
    const env = { protocolVersion: 1, sessionId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f1", epoch: 2, eventId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f3", monotonicMs: 1000, type: "reasoning.delta" };
    const base = { turnId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f5", responseId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f6", text: "hi" };
    expect(CONTRACT_VALIDATORS.ReasoningDeltaEvent({ ...env, payload: base })).toBe(true);
    expect(CONTRACT_VALIDATORS.ReasoningDeltaEvent({ ...env, payload: { ...base, partIndex: 2 } })).toBe(true);
    expect(CONTRACT_VALIDATORS.ReasoningDeltaEvent({ ...env, payload: { ...base, partId: "018f06b5-3c8d-7b2a-9f35-8b3388a857f8" } })).toBe(false);
  });
});

describe("binary PCM framing", () => {
  const fixture = readJson("fixtures/valid/binary-frame.json");
  test("encodes the shared little-endian fixture", () => {
    const encoded = encodeBinaryAudioFrame({ channel: fixture.channel, streamId: fixture.streamId, sequence: fixture.sequence, monotonicUs: BigInt(fixture.monotonicUs), pcm16: Int16Array.from(fixture.samples) }, 100);
    expect(Buffer.from(encoded).toString("hex")).toBe(fixture.hex);
  });
  test("round trips and rejects malformed or oversized frames", () => {
    const bytes = Uint8Array.from(Buffer.from(fixture.hex, "hex"));
    expect([...decodeBinaryAudioFrame(bytes, 100).pcm16]).toEqual(fixture.samples);
    expect(() => decodeBinaryAudioFrame(bytes, 4)).toThrow(/negotiated/);
    expect(() => decodeBinaryAudioFrame(bytes.subarray(0, 19), 100)).toThrow(/truncated/);
    const badVersion = bytes.slice(); badVersion[0] = 2;
    expect(() => decodeBinaryAudioFrame(badVersion, 100)).toThrow(/version/);
  });
});
