// Shared user voice-enrollment semantics for the Podcaster web app, host, and
// audio sidecar. This module is imported from the browser as well as Node, so
// it must stay free of Node built-ins (Buffer, node:crypto, etc.). Use
// TextEncoder for byte lengths and a plain digest for ids.
//
// The wire format, hard bounds, and (where expressible) the validation limits
// are mirrored by packages/contracts/schema/voice-enrollment.json, which the
// audio sidecar validates strictly. See docs/decisions/009.
//
// Determinism: a voice id is derived from the exact reference bytes the user
// saved, so the same reference always yields the same voice and the same
// synthesized identity. No reference bytes ever leave the local host.

import type { VoiceCatalog, VoiceInfo } from './types.js';

/** Every user-enrolled voice id starts with this prefix. Stock voices never do. */
export const CUSTOM_VOICE_PREFIX = 'custom:' as const;

/** Enrollment references are WAV/PCM16LE mono at a fixed sample rate. */
export const CUSTOM_VOICE_SAMPLE_RATE = 16_000 as const;
export const CUSTOM_VOICE_SAMPLE_WIDTH_BYTES = 2 as const;
export const CUSTOM_VOICE_CHANNELS = 1 as const;
/** PCM16LE mono byte rate, used for byte budgets. */
export const CUSTOM_VOICE_BYTES_PER_SECOND = CUSTOM_VOICE_SAMPLE_RATE * CUSTOM_VOICE_SAMPLE_WIDTH_BYTES;

/** A minimal RIFF/WAVE header for the fixed format. */
export const WAV_HEADER_BYTES = 44 as const;

export const MIN_CUSTOM_VOICE_MS = 3_000 as const;
export const MAX_CUSTOM_VOICE_MS = 20_000 as const;
export const MIN_CUSTOM_VOICE_BYTES = WAV_HEADER_BYTES + (MIN_CUSTOM_VOICE_MS / 1000) * CUSTOM_VOICE_BYTES_PER_SECOND;
export const MAX_CUSTOM_VOICE_BYTES = WAV_HEADER_BYTES + (MAX_CUSTOM_VOICE_MS / 1000) * CUSTOM_VOICE_BYTES_PER_SECOND;
/** Fraction (0..1) of full scale for PCM16 samples. */
export const MIN_REFERENCE_SIGNAL_RMS = 0.01 as const;
export const MIN_REFERENCE_SIGNAL_PEAK = 0.02 as const;
export const MIN_REFERENCE_PEAK_FOR_RMS = MIN_REFERENCE_SIGNAL_PEAK;
export const MAX_REFERENCE_SIGNAL_PEAK = 0.98 as const;

export const MAX_CUSTOM_VOICES = 8 as const;
export const MAX_CUSTOM_VOICE_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_VOICE_NAME_BYTES = 64 as const;

/** Derived tile limit for a name enforced on save; matches MAX_VOICE_NAME_BYTES. */
export const MAX_VOICE_NAME_CHARACTERS = MAX_VOICE_NAME_BYTES;

/** Explicit consent copy shown before any enrollment microphone access. */
export const VOICE_ENROLLMENT_CONSENT_COPY =
  'This recording will be stored on this device only and used to clone your voice for local speech. It is never uploaded. You can delete it at any time.';
/** One-line consent acknowledgement the user must check before recording. */
export const VOICE_ENROLLMENT_CONSENT_ACK =
  'I consent to storing this recording locally on this device and using it only for local voice cloning.';
/** Retention note shown next to saved voices. */
export const VOICE_ENROLLMENT_RETENTION_COPY =
  'Reference recordings stay in this browser\u2019s local storage on this device and are used by the local audio engine only. Deleting a voice deletes its reference.';

/** Actionable rejection codes surfaced by the enrollment UI. */
export type CustomVoiceErrorCode =
  | 'too_short'
  | 'too_long'
  | 'too_quiet'
  | 'clipped'
  | 'decode_failed'
  | 'mic_denied'
  | 'mic_unavailable'
  | 'mic_busy'
  | 'limit_reached';

/** Human-readable corrective guidance for each rejection code. */
export const CUSTOM_VOICE_ERROR_COPY: Readonly<Record<CustomVoiceErrorCode, string>> = Object.freeze({
  too_short: `Recording is shorter than ${MIN_CUSTOM_VOICE_MS / 1000} seconds. Speak a little longer and try again.`,
  too_long: `Recording is longer than ${MAX_CUSTOM_VOICE_MS / 1000} seconds. Use a shorter sample and try again.`,
  too_quiet: 'The recording is too quiet to clone reliably. Speak closer to the microphone and try again.',
  clipped: 'The recording is too loud or clipped. Move away from the microphone and try again.',
  decode_failed: 'The recording could not be decoded. Please try again.',
  mic_denied: 'Microphone access is blocked. Allow the microphone in your browser and try again.',
  mic_unavailable: 'No usable microphone was found on this device.',
  mic_busy: 'The microphone is busy with another app. Close it and try again.',
  limit_reached: `You can save at most ${MAX_CUSTOM_VOICES} custom voices. Delete one to make room.`,
});

type CustomVoiceIdCandidate = string | number | boolean | bigint | symbol | null | undefined;

export function isValidCustomVoiceId(value: CustomVoiceIdCandidate): value is string {
  return String(value) === value && value.startsWith(CUSTOM_VOICE_PREFIX) && /^custom:[0-9a-f]{24}$/.test(value);
}

/** Derive the deterministic voice id for a reference's full WAV SHA-256. */
export function customVoiceId(refSha256: string): string {
  return `${CUSTOM_VOICE_PREFIX}${refSha256.slice(0, 24)}`;
}

/** Normalized, truncated display name that always fits the byte budget. */
export function normalizeCustomVoiceName(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim();
  const encoder = new TextEncoder();
  const units = Array.from(name);
  for (const unit of units) {
    if (encoder.encode(name).byteLength <= MAX_VOICE_NAME_BYTES) break;
    name = name.slice(0, name.length - unit.length);
  }
  return name;
}

export function customVoiceNameBytes(name: string): number {
  return new TextEncoder().encode(name).length;
}

/** Byte-size check for a WAV reference. */
export function isReferenceSizeValid(byteLength: number): boolean {
  return Number.isInteger(byteLength) && byteLength >= MIN_CUSTOM_VOICE_BYTES && byteLength <= MAX_CUSTOM_VOICE_BYTES;
}

export interface ReferenceSignal {
  /** Samples after decode at the enrollment sample rate. */
  samples: number;
  sampleRate: number;
  durationMs: number;
  /** Root-mean-square of the normalized float samples. */
  rms: number;
  /** Absolute peak of the normalized float samples. */
  peak: number;
}

/**
 * Analyzes normalized float samples in the -1..1 range. Callers must have
 * already resampled to the enrollment sample rate.
 */
export function analyzeReferenceSignal(channel: Float32Array, sampleRate: number): ReferenceSignal {
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < channel.length; index++) {
    const value = channel[index]!;
    sum += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  const rms = channel.length > 0 ? Math.sqrt(sum / channel.length) : 0;
  return {
    samples: channel.length,
    sampleRate,
    durationMs: Math.round((channel.length / sampleRate) * 1000),
    rms,
    peak,
  };
}

/**
 * Pure quality gate over an analyzed reference. Returns a single actionable
 * code, or undefined when the sample passes.
 */
export function validateReferenceSignal(signal: ReferenceSignal): CustomVoiceErrorCode | undefined {
  if (signal.sampleRate !== CUSTOM_VOICE_SAMPLE_RATE) return 'decode_failed';
  if (signal.samples <= 0) return 'too_short';
  if (signal.durationMs < MIN_CUSTOM_VOICE_MS) return 'too_short';
  if (signal.durationMs > MAX_CUSTOM_VOICE_MS) return 'too_long';
  if (signal.peak > MAX_REFERENCE_SIGNAL_PEAK || Number.isNaN(signal.peak)) return 'clipped';
  if (signal.rms < MIN_REFERENCE_SIGNAL_RMS || signal.peak < MIN_REFERENCE_SIGNAL_PEAK) return 'too_quiet';
  return undefined;
}

/** The browser-persisted metadata for one enrolled voice (audio lives in IndexedDB). */
export interface CustomVoiceMetadata {
  voiceId: string;
  name: string;
  refSha256: string;
  sampleRate: number;
  durationMs: number;
  byteLength: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Appends user voices after a catalog's stock voices, preserving the stock
 * identity (catalogId, defaults, ordering). The catalogId deliberately does
 * not change: admission is stable, and renames or re-enrollments never
 * invalidate an open stream.
 */
export function withCustomVoices(
  catalog: VoiceCatalog | undefined,
  customs: readonly CustomVoiceMetadata[],
): VoiceCatalog | undefined {
  if (!catalog) return undefined;
  const owned = new Set(catalog.voices.map((voice) => voice.id));
  const customVoices: VoiceInfo[] = [];
  for (const custom of customs) {
    if (!isValidCustomVoiceId(custom.voiceId) || owned.has(custom.voiceId)) continue;
    owned.add(custom.voiceId);
    customVoices.push({ id: custom.voiceId, label: custom.name });
  }
  if (customVoices.length === 0) return catalog;
  return { ...catalog, voices: [...catalog.voices, ...customVoices] };
}

/**
 * Stored references whose voice id is absent from `catalog`'s voices.
 *
 * This comparison must always run against the sidecar's authoritative catalog
 * (which already includes any voice the sidecar re-enrolled), never the
 * browser-merged catalog, so a voice the sidecar dropped on restart is seen as
 * missing and can be re-enrolled instead of being hidden by the merge.
 */
export function customVoicesMissingFromCatalog<C extends CustomVoiceMetadata>(
  catalog: VoiceCatalog | undefined,
  customs: readonly C[],
): C[] {
  if (!catalog) return customs.slice();
  const known = new Set(catalog.voices.map((voice) => voice.id));
  return customs.filter((custom) => !known.has(custom.voiceId));
}

/** All stock voice ids from a catalog, excluding any user-enrolled entries. */
export function stockVoiceIds(catalog: VoiceCatalog | undefined): Set<string> {
  return new Set((catalog?.voices ?? []).filter((voice) => !isValidCustomVoiceId(voice.id)).map((voice) => voice.id));
}

/** The wire/metadata shape sent to the host for enrollment or rename re-announce. */
export interface CustomVoiceEnrollment {
  voiceId: string;
  name: string;
  refSha256: string;
  sampleRate: number;
  durationMs: number;
  byteLength: number;
  /** WAV bytes, base64-encoded for the localhost JSON relay. */
  wavBase64: string;
}

/** Upper bound for the enrollment HTTP body (base64 inflation plus JSON). */
export const MAX_CUSTOM_VOICE_ENROLLMENT_BODY = 1_024 * 1024;
