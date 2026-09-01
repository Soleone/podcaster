import { createHash } from 'node:crypto';
import { isAlias, parseDocument } from 'yaml';
import { CONTRACT_VALIDATORS } from '../validators.js';
import { DEFAULT_PERSONA_FIELDS } from './defaults.js';
import type { PersonaDiagnostic, PersonaInterpretation, PersonaParseResult } from './types.js';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SOURCE_BYTES = 24 * 1024;
const LONG_BODY_BYTES = 8 * 1024;
const ALLOWED_KEYS = new Set([
  'version',
  'name',
  'invitation_only',
  'posture_weights',
  'challenge_enabled',
  'interests',
  'experiences',
]);

/** A value the YAML core schema can produce at the front-matter boundary. */
type RawValue = string | number | boolean | null | RawValue[] | { [key: string]: RawValue };

/** The seven front-matter keys the persona contract accepts, before validation. */
type FrontMatter = {
  version?: RawValue;
  name?: RawValue;
  invitation_only?: RawValue;
  posture_weights?: RawValue;
  challenge_enabled?: RawValue;
  interests?: RawValue;
  experiences?: RawValue;
};

/** Validated posture weights after front-matter decoding. */
type PostureWeights = { riff: number; question: number; challenge: number };

/**
 * The subset of the yaml AST inspected for aliases and custom tags: parsed
 * nodes have optional anchor/tag; pairs carry key/value; collections carry
 * items. `value` is left as `unknown` because a scalar's raw value is not a
 * walkable member (the walker re-checks before descending).
 */
interface YamlAstMember {
  anchor?: string;
  tag?: string;
  key?: YamlAstMember | null;
  value?: unknown;
  items?: readonly YamlAstMember[] | null;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split('\n').length;
}

function diagnostic(
  source: string,
  severity: 'warning' | 'error',
  code: string,
  message: string,
  start = 0,
  end = start + 1,
): PersonaDiagnostic {
  return { severity, code, message, line: lineAt(source, start), range: { start, end: Math.max(start, end) } };
}

function canonicalize(value: RawValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isMapping(value)) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
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
  if (ArrayBuffer.isView(input)) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      return undefined;
    }
  }
  return hasUnpairedSurrogate(input) ? undefined : input;
}

function offsetOfKey(source: string, key: string): number {
  const match = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'mu').exec(source);
  return match?.index ?? 0;
}

function inspectYamlNode(
  node: YamlAstMember | null,
  seen: Set<unknown>,
): 'unsupported_alias' | 'unsupported_tag' | undefined {
  if (!node || seen.has(node)) return;
  seen.add(node);
  if (isAlias(node)) return 'unsupported_alias';
  if (node.anchor !== undefined) return 'unsupported_alias';
  if (node.tag !== undefined) return 'unsupported_tag';
  const keyChild = node.key;
  if (keyChild !== null && keyChild !== undefined) {
    const found = inspectYamlNode(keyChild, seen);
    if (found) return found;
  }
  const valueChild = node.value;
  if (valueChild !== null && valueChild !== undefined && Object(valueChild) === valueChild) {
    // SAFETY: only a pair's `value` slot holds a walkable AST member; a scalar
    // raw value is plain data and fails the object check above.
    const found = inspectYamlNode(valueChild as YamlAstMember, seen);
    if (found) return found;
  }
  if (node.items !== null && node.items !== undefined) {
    for (const item of node.items) {
      const found = inspectYamlNode(item, seen);
      if (found) return found;
    }
  }
  return;
}

function isStringValue(value: RawValue | undefined): value is string {
  return value !== undefined && value !== null && String(value) === value;
}

function isBooleanValue(value: RawValue | undefined): value is boolean {
  return value === true || value === false;
}

function isIntegerValue(value: RawValue | undefined): value is number {
  return Number.isInteger(value);
}

function integerInRange(value: RawValue | undefined): value is number {
  return isIntegerValue(value) && value >= 0 && value <= 100;
}

/** True when `value` is a plain mapping (YAML `!!map`, JSON object). */
function isMapping(value: RawValue | undefined): value is { [key: string]: RawValue } {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function decodePostureWeights(value: RawValue | undefined): PostureWeights | undefined {
  if (!isMapping(value)) return undefined;
  if (Object.keys(value).some((key) => !['riff', 'question', 'challenge'].includes(key))) return undefined;
  const riff = value.riff;
  const question = value.question;
  const challenge = value.challenge;
  if (!integerInRange(riff) || !integerInRange(question) || !integerInRange(challenge)) return undefined;
  return { riff, question, challenge };
}

function decodeStringArray(value: RawValue | undefined): string[] | undefined {
  if (value === undefined || !Array.isArray(value)) return undefined;
  if (!value.every(isStringValue)) return undefined;
  return value.slice();
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function parsePersona(input: string | Uint8Array): PersonaParseResult {
  const decoded = decode(input);
  if (decoded === undefined)
    return {
      ok: false,
      errors: [diagnostic('', 'error', 'invalid_utf8', 'Persona must be valid UTF-8.')],
      warnings: [],
    };
  const source = decoded.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const errors: PersonaDiagnostic[] = [];
  const warnings: PersonaDiagnostic[] = [];
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      errors: [diagnostic(source, 'error', 'document_too_large', `Persona source exceeds ${MAX_SOURCE_BYTES} bytes.`)],
      warnings,
    };
  }
  if (/(?:<!--|<!doctype\b|<\/?(?:script|style|iframe|object|embed|link|meta|[a-z][\w-]*)\b[^>]*>)/iu.test(source)) {
    const start = source.search(
      /(?:<!--|<!doctype\b|<\/?(?:script|style|iframe|object|embed|link|meta|[a-z][\w-]*)\b)/iu,
    );
    errors.push(
      diagnostic(source, 'error', 'html_or_script', 'HTML and script markup are not allowed.', start, start + 1),
    );
  }

  const lines = source.split('\n');
  let frontMatter: FrontMatter = {};
  let body = source;
  if (lines[0]?.trim() === '---') {
    const closing = lines.slice(1).findIndex((line) => line.trim() === '---');
    if (closing < 0)
      errors.push(diagnostic(source, 'error', 'front_matter_unclosed', 'YAML front matter is not closed.', 0, 3));
    else {
      const closingIndex = closing + 1;
      const yamlSource = lines.slice(1, closingIndex).join('\n');
      body = lines.slice(closingIndex + 1).join('\n');
      const document = parseDocument(yamlSource, { schema: 'core', uniqueKeys: true, prettyErrors: false });
      for (const issue of document.errors) {
        const position = issue.pos?.[0] ?? 0;
        errors.push(
          diagnostic(source, 'error', 'yaml_syntax', issue.message, position + 4, (issue.pos?.[1] ?? position + 1) + 4),
        );
      }
      // SAFETY: YAML document contents are the AST members described by the
      // local adapter; their public types use `unknown` for scalar values.
      const unsupported = inspectYamlNode(document.contents as YamlAstMember | null, new Set());
      if (unsupported)
        errors.push(
          diagnostic(
            source,
            'error',
            unsupported,
            unsupported === 'unsupported_alias'
              ? 'YAML aliases and anchors are not allowed.'
              : 'Custom YAML tags are not allowed.',
          ),
        );
      if (!document.errors.length && !unsupported) {
        // SAFETY: the yaml runtime types `toJS` as `any`; the guard below
        // re-checks that the value is a non-null, non-array plain mapping,
        // which is exactly what FrontMatter models.
        const parsed = document.toJS({ maxAliasCount: 0 }) as FrontMatter | null;
        if (parsed === null || Array.isArray(parsed) || !isMapping(parsed)) {
          errors.push(diagnostic(source, 'error', 'invalid_value', 'Front matter must be a mapping.'));
        } else {
          frontMatter = parsed;
        }
      }
    }
  }

  for (const key of Object.keys(frontMatter))
    if (!ALLOWED_KEYS.has(key)) {
      const start = offsetOfKey(source, key);
      errors.push(
        diagnostic(source, 'error', 'unsupported_key', `Unknown front matter key: ${key}.`, start, start + key.length),
      );
    }

  const version = frontMatter.version ?? DEFAULT_PERSONA_FIELDS.version;
  const name = frontMatter.name ?? DEFAULT_PERSONA_FIELDS.name;
  const invitationOnly = frontMatter.invitation_only ?? DEFAULT_PERSONA_FIELDS.invitation_only;
  const challengeEnabled = frontMatter.challenge_enabled ?? DEFAULT_PERSONA_FIELDS.challenge_enabled;
  const weights = decodePostureWeights(frontMatter.posture_weights ?? DEFAULT_PERSONA_FIELDS.posture_weights);
  const interests = decodeStringArray(frontMatter.interests ?? DEFAULT_PERSONA_FIELDS.interests);
  const experiences = decodeStringArray(frontMatter.experiences ?? DEFAULT_PERSONA_FIELDS.experiences);

  if (version !== 1)
    errors.push(diagnostic(source, 'error', 'invalid_value', 'version must be 1.', offsetOfKey(source, 'version')));
  if (!isStringValue(name) || codePointLength(name) > 80)
    errors.push(
      diagnostic(
        source,
        'error',
        'invalid_value',
        'name must be a string of at most 80 characters.',
        offsetOfKey(source, 'name'),
      ),
    );
  if (!isBooleanValue(invitationOnly))
    errors.push(
      diagnostic(
        source,
        'error',
        'invalid_value',
        'invitation_only must be boolean.',
        offsetOfKey(source, 'invitation_only'),
      ),
    );
  if (!isBooleanValue(challengeEnabled))
    errors.push(
      diagnostic(
        source,
        'error',
        'invalid_value',
        'challenge_enabled must be boolean.',
        offsetOfKey(source, 'challenge_enabled'),
      ),
    );
  if (weights === undefined) {
    errors.push(
      diagnostic(
        source,
        'error',
        'invalid_value',
        'posture_weights must contain integer riff, question, and challenge values from 0 to 100.',
        offsetOfKey(source, 'posture_weights'),
      ),
    );
  } else if (weights.riff + weights.question + weights.challenge !== 100) {
    errors.push(
      diagnostic(
        source,
        'error',
        'weights_sum',
        'posture_weights must sum to 100.',
        offsetOfKey(source, 'posture_weights'),
      ),
    );
  }
  if (interests === undefined || interests.length > 20 || interests.some((item) => codePointLength(item) > 80))
    errors.push(
      diagnostic(
        source,
        'error',
        'invalid_value',
        'interests must contain at most 20 strings of at most 80 characters.',
        offsetOfKey(source, 'interests'),
      ),
    );
  if (experiences === undefined || experiences.length > 20 || experiences.some((item) => codePointLength(item) > 200))
    errors.push(
      diagnostic(
        source,
        'error',
        'invalid_value',
        'experiences must contain at most 20 strings of at most 200 characters.',
        offsetOfKey(source, 'experiences'),
      ),
    );
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > MAX_BODY_BYTES)
    errors.push(diagnostic(source, 'error', 'body_too_large', `Persona body exceeds ${MAX_BODY_BYTES} bytes.`));
  else if (bodyBytes > LONG_BODY_BYTES)
    warnings.push(
      diagnostic(
        source,
        'warning',
        'body_long',
        'Persona body is long and may be truncated in bounded reasoning context.',
      ),
    );
  if (weights !== undefined && weights.challenge === 0)
    warnings.push(diagnostic(source, 'warning', 'challenge_weight_zero', 'Challenge posture has zero weight.'));
  if (challengeEnabled === false && weights !== undefined && weights.challenge > 0)
    warnings.push(
      diagnostic(
        source,
        'warning',
        'challenge_disabled_weight',
        'Challenge weight is ignored while challenge is disabled.',
      ),
    );

  if (errors.length) return { ok: false, errors, warnings };
  const interpretation: PersonaInterpretation = {
    version: 1,
    name: isStringValue(name) ? name : DEFAULT_PERSONA_FIELDS.name,
    invitation_only: isBooleanValue(invitationOnly) ? invitationOnly : DEFAULT_PERSONA_FIELDS.invitation_only,
    posture_weights: weights ?? DEFAULT_PERSONA_FIELDS.posture_weights,
    challenge_enabled: isBooleanValue(challengeEnabled) ? challengeEnabled : DEFAULT_PERSONA_FIELDS.challenge_enabled,
    interests: interests ?? [...DEFAULT_PERSONA_FIELDS.interests],
    experiences: experiences ?? [...(DEFAULT_PERSONA_FIELDS.experiences ?? [])],
    body,
  };
  if (!CONTRACT_VALIDATORS.Persona(interpretation))
    return {
      ok: false,
      errors: [diagnostic(source, 'error', 'invalid_value', 'Persona interpretation failed canonical validation.')],
      warnings,
    };
  const canonicalJson = canonicalize(interpretation);
  return {
    ok: true,
    interpretation,
    canonicalJson,
    digest: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
    warnings,
  };
}
