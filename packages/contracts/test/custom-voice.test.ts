import { describe, expect, it } from 'vitest';
import {
  CUSTOM_VOICE_PREFIX,
  customVoiceId,
  isReferenceSizeValid,
  isValidCustomVoiceId,
  MAX_CUSTOM_VOICE_BYTES,
  MAX_CUSTOM_VOICE_MS,
  MAX_REFERENCE_SIGNAL_PEAK,
  MIN_CUSTOM_VOICE_BYTES,
  MIN_CUSTOM_VOICE_MS,
  MIN_REFERENCE_SIGNAL_PEAK,
  MIN_REFERENCE_SIGNAL_RMS,
  normalizeCustomVoiceName,
  validateReferenceSignal,
  withCustomVoices,
  analyzeReferenceSignal,
  type CustomVoiceMetadata,
  type VoiceCatalog,
} from '../src/settings/index.js';

const FULL_SHA = 'a'.repeat(64);

describe('custom voice ids', () => {
  it('derives ids deterministically from the reference hash prefix', () => {
    expect(customVoiceId(FULL_SHA)).toBe('custom:aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(customVoiceId(`b${'b'.repeat(63)}`)).toBe(`custom:${'b'.repeat(24)}`);
  });

  it('accepts only well-formed custom ids', () => {
    expect(isValidCustomVoiceId('custom:aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(isValidCustomVoiceId('Ryan')).toBe(false);
    expect(isValidCustomVoiceId('custom:xyz')).toBe(false);
    expect(isValidCustomVoiceId('custom:aaaaaaaaaaaaaaaaaaaaaaab')).toBe(true);
    expect(isValidCustomVoiceId('custom:' + 'a'.repeat(23))).toBe(false);
    expect(isValidCustomVoiceId('custom:aaaaaaaaaaaaaaaaaaaaaaaa' + 'a')).toBe(false);
  });
});

describe('recorded reference quality gates', () => {
  function tone(durationMs: number, sampleRate = 16_000, amplitude = 0.4): Float32Array {
    const samples = Math.round((durationMs / 1000) * sampleRate);
    const channel = new Float32Array(samples);
    for (let index = 0; index < samples; index++) {
      channel[index] = Math.sin((index / sampleRate) * 2 * Math.PI * 440) * amplitude;
    }
    return channel;
  }

  it('accepts a healthy 5-second sample', () => {
    const channel = tone(5_000);
    const signal = analyzeReferenceSignal(channel, 16_000);
    expect(signal.durationMs).toBe(5_000);
    expect(signal.rms).toBeGreaterThan(MIN_REFERENCE_SIGNAL_RMS);
    expect(signal.peak).toBeGreaterThan(MIN_REFERENCE_SIGNAL_PEAK);
    expect(validateReferenceSignal(signal)).toBeUndefined();
  });

  it('rejects too-short and too-long samples', () => {
    expect(validateReferenceSignal(analyzeReferenceSignal(tone(MIN_CUSTOM_VOICE_MS - 1), 16_000))).toBe('too_short');
    expect(validateReferenceSignal(analyzeReferenceSignal(tone(MAX_CUSTOM_VOICE_MS + 1), 16_000))).toBe('too_long');
  });

  it('rejects silence as too quiet', () => {
    expect(validateReferenceSignal(analyzeReferenceSignal(new Float32Array(16_000 * 5), 16_000))).toBe('too_quiet');
  });

  it('rejects near-clipping peaks as clipped', () => {
    const channel = tone(5_000, 16_000, 0.99);
    expect(validateReferenceSignal(analyzeReferenceSignal(channel, 16_000))).toBe('clipped');
  });

  it('rejects wrong sample rates', () => {
    expect(validateReferenceSignal(analyzeReferenceSignal(tone(5_000, 24_000), 24_000))).toBe('decode_failed');
  });

  it('bounds the encoded size', () => {
    expect(isReferenceSizeValid(MIN_CUSTOM_VOICE_BYTES)).toBe(true);
    expect(isReferenceSizeValid(MAX_CUSTOM_VOICE_BYTES)).toBe(true);
    expect(isReferenceSizeValid(MIN_CUSTOM_VOICE_BYTES - 1)).toBe(false);
    expect(isReferenceSizeValid(MAX_CUSTOM_VOICE_BYTES + 1)).toBe(false);
  });
});

describe('voice names', () => {
  it('normalizes and bounds names', () => {
    expect(normalizeCustomVoiceName('  My   Voice  ')).toBe('My Voice');
    expect(normalizeCustomVoiceName('x'.repeat(200)).length).toBeLessThanOrEqual(64);
    const accented = 'ä'.repeat(50);
    expect(new TextEncoder().encode(normalizeCustomVoiceName(accented)).byteLength).toBeLessThanOrEqual(64);
    expect(normalizeCustomVoiceName('')).toBe('');
  });
});

describe('custom voice catalog merge', () => {
  const catalog: VoiceCatalog = {
    catalogId: 'stock-catalog',
    backendId: 'qwen3',
    modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    runtimeConfigId: 'cfg',
    revision: 'rev',
    defaultVoiceId: 'Ryan',
    voices: [{ id: 'Ryan', label: 'Ryan' }, { id: 'Serena', label: 'Serena' }],
  };
  const custom: CustomVoiceMetadata = {
    voiceId: 'custom:aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Me',
    refSha256: FULL_SHA,
    sampleRate: 16_000,
    durationMs: 5_000,
    byteLength: 160_044,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };

  it('appends customs after stock voices and preserves catalog identity', () => {
    const merged = withCustomVoices(catalog, [custom])!;
    expect(merged.catalogId).toBe(catalog.catalogId);
    expect(merged.defaultVoiceId).toBe('Ryan');
    expect(merged.voices.map(voice => voice.id)).toEqual(['Ryan', 'Serena', 'custom:aaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(merged.voices[2]!.label).toBe('Me');
  });

  it('is idempotent and ignores duplicates or stock ids', () => {
    const merged = withCustomVoices(catalog, [custom, custom, { ...custom, voiceId: 'Ryan' as never }])!;
    expect(merged.voices).toHaveLength(3);
  });

  it('returns the catalog untouched with no customs and undefined for no catalog', () => {
    expect(withCustomVoices(catalog, [])).toBe(catalog);
    expect(withCustomVoices(undefined, [custom])).toBeUndefined();
  });
});