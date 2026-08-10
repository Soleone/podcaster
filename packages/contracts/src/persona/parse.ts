import { createHash } from "node:crypto";
import { isAlias, parseDocument } from "yaml";
import { CONTRACT_VALIDATORS } from "../validators.js";
import { DEFAULT_PERSONA_FIELDS } from "./defaults.js";
import type { PersonaDiagnostic, PersonaInterpretation, PersonaParseResult } from "./types.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SOURCE_BYTES = 24 * 1024;
const LONG_BODY_BYTES = 8 * 1024;
const ALLOWED_KEYS = new Set(["version", "name", "invitation_only", "posture_weights", "challenge_enabled", "interests", "experiences"]);

function lineAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split("\n").length;
}

function diagnostic(source: string, severity: "warning" | "error", code: string, message: string, start = 0, end = start + 1): PersonaDiagnostic {
  return { severity, code, message, line: lineAt(source, start), range: { start, end: Math.max(start, end) } };
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

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

function decode(input: string | Uint8Array): string | undefined {
  if (typeof input === "string") {
    return hasUnpairedSurrogate(input) ? undefined : input;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(input); }
  catch { return undefined; }
}

function offsetOfKey(source: string, key: string): number {
  const match = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "mu").exec(source);
  return match?.index ?? 0;
}

function inspectYamlNode(node: unknown, seen: Set<unknown>): "unsupported_alias" | "unsupported_tag" | undefined {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (isAlias(node)) return "unsupported_alias";
  const record = node as Record<string, unknown>;
  if (typeof record.anchor === "string") return "unsupported_alias";
  if (typeof record.tag === "string") return "unsupported_tag";
  for (const key of ["contents", "key", "value"] as const) {
    const found = inspectYamlNode(record[key], seen); if (found) return found;
  }
  if (Array.isArray(record.items)) for (const item of record.items) { const found = inspectYamlNode(item, seen); if (found) return found; }
  return;
}

function integerInRange(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100; }
function plainObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function codePointLength(value: string): number { return Array.from(value).length; }

export function parsePersona(input: string | Uint8Array): PersonaParseResult {
  const decoded = decode(input);
  if (decoded === undefined) return { ok: false, errors: [diagnostic("", "error", "invalid_utf8", "Persona must be valid UTF-8.")], warnings: [] };
  const source = decoded.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const errors: PersonaDiagnostic[] = [];
  const warnings: PersonaDiagnostic[] = [];
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return { ok: false, errors: [diagnostic(source, "error", "document_too_large", `Persona source exceeds ${MAX_SOURCE_BYTES} bytes.`)], warnings };
  }
  if (/(?:<!--|<!doctype\b|<\/?(?:script|style|iframe|object|embed|link|meta|[a-z][\w-]*)\b[^>]*>)/iu.test(source)) {
    const start = source.search(/(?:<!--|<!doctype\b|<\/?(?:script|style|iframe|object|embed|link|meta|[a-z][\w-]*)\b)/iu);
    errors.push(diagnostic(source, "error", "html_or_script", "HTML and script markup are not allowed.", start, start + 1));
  }

  const lines = source.split("\n");
  let frontMatter: Record<string, unknown> = {};
  let body = source;
  if (lines[0]?.trim() === "---") {
    const closing = lines.slice(1).findIndex(line => line.trim() === "---");
    if (closing < 0) errors.push(diagnostic(source, "error", "front_matter_unclosed", "YAML front matter is not closed.", 0, 3));
    else {
      const closingIndex = closing + 1;
      const yamlSource = lines.slice(1, closingIndex).join("\n");
      body = lines.slice(closingIndex + 1).join("\n");
      const document = parseDocument(yamlSource, { schema: "core", uniqueKeys: true, prettyErrors: false });
      for (const issue of document.errors) {
        const position = issue.pos?.[0] ?? 0;
        errors.push(diagnostic(source, "error", "yaml_syntax", issue.message, position + 4, (issue.pos?.[1] ?? position + 1) + 4));
      }
      const unsupported = inspectYamlNode(document.contents, new Set());
      if (unsupported) errors.push(diagnostic(source, "error", unsupported, unsupported === "unsupported_alias" ? "YAML aliases and anchors are not allowed." : "Custom YAML tags are not allowed."));
      if (!document.errors.length && !unsupported) {
        const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
        if (!plainObject(parsed)) errors.push(diagnostic(source, "error", "invalid_value", "Front matter must be a mapping."));
        else frontMatter = parsed;
      }
    }
  }

  for (const key of Object.keys(frontMatter)) if (!ALLOWED_KEYS.has(key)) {
    const start = offsetOfKey(source, key);
    errors.push(diagnostic(source, "error", "unsupported_key", `Unknown front matter key: ${key}.`, start, start + key.length));
  }

  const version = frontMatter.version ?? DEFAULT_PERSONA_FIELDS.version;
  const name = frontMatter.name ?? DEFAULT_PERSONA_FIELDS.name;
  const invitationOnly = frontMatter.invitation_only ?? DEFAULT_PERSONA_FIELDS.invitation_only;
  const weights = frontMatter.posture_weights ?? DEFAULT_PERSONA_FIELDS.posture_weights;
  const challengeEnabled = frontMatter.challenge_enabled ?? DEFAULT_PERSONA_FIELDS.challenge_enabled;
  const interests = frontMatter.interests ?? DEFAULT_PERSONA_FIELDS.interests;
  const experiences = frontMatter.experiences ?? DEFAULT_PERSONA_FIELDS.experiences;

  if (version !== 1) errors.push(diagnostic(source, "error", "invalid_value", "version must be 1.", offsetOfKey(source, "version")));
  if (typeof name !== "string" || codePointLength(name) > 80) errors.push(diagnostic(source, "error", "invalid_value", "name must be a string of at most 80 characters.", offsetOfKey(source, "name")));
  if (typeof invitationOnly !== "boolean") errors.push(diagnostic(source, "error", "invalid_value", "invitation_only must be boolean.", offsetOfKey(source, "invitation_only")));
  if (typeof challengeEnabled !== "boolean") errors.push(diagnostic(source, "error", "invalid_value", "challenge_enabled must be boolean.", offsetOfKey(source, "challenge_enabled")));
  if (!plainObject(weights) || Object.keys(weights).some(key => !["riff", "question", "challenge"].includes(key)) || !integerInRange(weights.riff) || !integerInRange(weights.question) || !integerInRange(weights.challenge)) {
    errors.push(diagnostic(source, "error", "invalid_value", "posture_weights must contain integer riff, question, and challenge values from 0 to 100.", offsetOfKey(source, "posture_weights")));
  } else if (weights.riff + weights.question + weights.challenge !== 100) {
    errors.push(diagnostic(source, "error", "weights_sum", "posture_weights must sum to 100.", offsetOfKey(source, "posture_weights")));
  }
  if (!Array.isArray(interests) || interests.length > 20 || interests.some(item => typeof item !== "string" || codePointLength(item) > 80)) errors.push(diagnostic(source, "error", "invalid_value", "interests must contain at most 20 strings of at most 80 characters.", offsetOfKey(source, "interests")));
  if (!Array.isArray(experiences) || experiences.length > 20 || experiences.some(item => typeof item !== "string" || codePointLength(item) > 200)) errors.push(diagnostic(source, "error", "invalid_value", "experiences must contain at most 20 strings of at most 200 characters.", offsetOfKey(source, "experiences")));
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_BODY_BYTES) errors.push(diagnostic(source, "error", "body_too_large", `Persona body exceeds ${MAX_BODY_BYTES} bytes.`));
  else if (bodyBytes > LONG_BODY_BYTES) warnings.push(diagnostic(source, "warning", "body_long", "Persona body is long and may be truncated in bounded reasoning context."));
  if (plainObject(weights) && integerInRange(weights.challenge) && weights.challenge === 0) warnings.push(diagnostic(source, "warning", "challenge_weight_zero", "Challenge posture has zero weight."));
  if (challengeEnabled === false && plainObject(weights) && integerInRange(weights.challenge) && weights.challenge > 0) warnings.push(diagnostic(source, "warning", "challenge_disabled_weight", "Challenge weight is ignored while challenge is disabled."));

  if (errors.length) return { ok: false, errors, warnings };
  const interpretation: PersonaInterpretation = {
    version: 1,
    name: name as string,
    invitation_only: invitationOnly as boolean,
    posture_weights: { riff: (weights as Record<string, number>).riff!, question: (weights as Record<string, number>).question!, challenge: (weights as Record<string, number>).challenge! },
    challenge_enabled: challengeEnabled as boolean,
    interests: [...(interests as string[])],
    experiences: [...(experiences as string[])],
    body,
  };
  if (!CONTRACT_VALIDATORS.Persona(interpretation)) return { ok: false, errors: [diagnostic(source, "error", "invalid_value", "Persona interpretation failed canonical validation.")], warnings };
  const canonicalJson = canonicalize(interpretation);
  return { ok: true, interpretation, canonicalJson, digest: createHash("sha256").update(canonicalJson, "utf8").digest("hex"), warnings };
}
