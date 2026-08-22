import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERSONA_MARKDOWN, parsePersona } from '../src/persona/index.js';

const GOLDEN_DIGEST = 'd46604d3c926d965fdc70314af836fcb98f749a230e445ea0e33343b11f26393';

describe('persona v1 parser', () => {
  it('parses the tracked supported default into a stable canonical interpretation', () => {
    const fixtureRoot = resolve(import.meta.dirname, '../fixtures/persona');
    const trackedSource = readFileSync(resolve(fixtureRoot, 'default.md'), 'utf8');
    const golden = JSON.parse(readFileSync(resolve(fixtureRoot, 'default.golden.json'), 'utf8'));
    expect(trackedSource).toBe(DEFAULT_PERSONA_MARKDOWN);
    const result = parsePersona(trackedSource);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.interpretation).toMatchObject({
      version: 1,
      name: 'Oliver',
      invitation_only: false,
      posture_weights: { riff: 50, question: 35, challenge: 15 },
      challenge_enabled: true,
    });
    expect(result.interpretation.experiences?.length).toBeGreaterThan(0);
    expect(result.digest).toBe(GOLDEN_DIGEST);
    expect({ digest: result.digest, interpretation: result.interpretation }).toEqual(golden);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('applies defaults without front matter and hashes semantic content', () => {
    const first = parsePersona('Hello 😀\r\nworld');
    const second = parsePersona('Hello 😀\nworld');
    expect(first).toEqual(second);
    expect(first.ok && first.interpretation.name).toBe('Oliver');
  });

  it.each([
    ['unknown key', '---\nversion: 1\nunknown: true\n---\nbody', 'unsupported_key'],
    ['bad sum', '---\nposture_weights: { riff: 40, question: 35, challenge: 15 }\n---\nbody', 'weights_sum'],
    ['duplicate', '---\nname: one\nname: two\n---\nbody', 'yaml_syntax'],
    ['alias', '---\nname: &name companion\ninterests: [*name]\n---\nbody', 'unsupported_alias'],
    ['custom tag', '---\nname: !thing companion\n---\nbody', 'unsupported_tag'],
    ['standard explicit tag', '---\nname: !!str companion\n---\nbody', 'unsupported_tag'],
    ['html', '<script>alert(1)</script>', 'html_or_script'],
  ])('rejects %s with structured diagnostics', (_name, source, code) => {
    const result = parsePersona(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.code === code)).toBe(true);
    expect(result.errors.every((error) => error.line >= 1 && error.range.end >= error.range.start)).toBe(true);
    expect('interpretation' in result).toBe(false);
    expect('digest' in result).toBe(false);
  });

  it('allows Markdown horizontal rules after the single front matter block', () => {
    const result = parsePersona('---\nname: companion\n---\nFirst section\n\n---\n\nSecond section');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.interpretation.body).toBe('First section\n\n---\n\nSecond section');
  });

  it('counts name, interest, and experience limits by Unicode code point', () => {
    const valid = parsePersona(
      `---\nname: ${'😀'.repeat(80)}\ninterests: [${'😀'.repeat(80)}]\nexperiences: [${'😀'.repeat(200)}]\n---\nbody`,
    );
    expect(valid.ok).toBe(true);
    for (const source of [
      `---\nname: ${'😀'.repeat(81)}\n---\nbody`,
      `---\ninterests: [${'😀'.repeat(81)}]\n---\nbody`,
      `---\nexperiences: [${'😀'.repeat(201)}]\n---\nbody`,
      `---\nexperiences: [${Array.from({ length: 21 }, () => 'a').join(', ')}]\n---\nbody`,
    ])
      expect(parsePersona(source)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expect.objectContaining({ code: 'invalid_value' })]),
      });
  });

  it('short-circuits oversized input before YAML parsing', () => {
    const result = parsePersona(`---\nname: [\n${' '.repeat(24 * 1024)}`);
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'document_too_large' }] });
    if (!result.ok) expect(result.errors).toHaveLength(1);
  });

  it('rejects invalid UTF-8 and body byte overflow', () => {
    expect(parsePersona(Uint8Array.from([0xc3, 0x28]))).toMatchObject({
      ok: false,
      errors: [{ code: 'invalid_utf8' }],
    });
    expect(parsePersona('x'.repeat(16 * 1024 + 1))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'body_too_large' })]),
    });
  });

  it('never throws or returns interpretation alongside errors for fuzzed input', () => {
    let seed = 0x5a17;
    for (let attempt = 0; attempt < 300; attempt++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const length = seed % 256;
      const bytes = Uint8Array.from({ length }, (_, index) => (seed >>> index % 24) & 0xff);
      const result = parsePersona(bytes);
      if (result.ok) expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
      else {
        expect(result.errors.length).toBeGreaterThan(0);
        expect('interpretation' in result).toBe(false);
      }
    }
  });
});
