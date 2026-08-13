// Shared settings semantics for the Podcaster web app and host. This module is
// imported from the browser as well as Node, so it must stay free of Node
// built-ins (Buffer, node:crypto, etc.). Use TextEncoder for byte lengths.

export const SETTINGS_VERSION = 1 as const;

export const MAX_PERSONA_BYTES = 8 * 1024;

/** Upper bound on the editable agent display name, in UTF-8 bytes. */
export const MAX_AGENT_NAME_BYTES = 64;

/** The first-run editable default agent name shown above the assistant's bubbles. */
export const DEFAULT_AGENT_NAME = "Oliver";

/** A single advertised voice from a verified TTS backend/model catalog. */
export interface VoiceInfo {
  /** Stable, authoritative voice identifier used on every tts.open. */
  id: string;
  /** Human-friendly label for display; the id remains authoritative. */
  label: string;
}

/**
 * A strict, attested catalog of the voices actually available from the active
 * TTS backend/model/runtime. The host and sidecar revalidate this identity
 * before any stream opens.
 */
export interface VoiceCatalog {
  /** Stable identity derived from backend/model/runtime plus the verified voices SHA-256. */
  catalogId: string;
  backendId: string;
  modelId: string;
  runtimeConfigId: string;
  revision: string;
  /** The verified default voice, always present in `voices`. */
  defaultVoiceId: string;
  voices: VoiceInfo[];
}

/** The browser's persisted voice selection, bound to one catalog. */
export interface VoicePreference {
  catalogId: string;
  voiceId: string;
}

/**
 * The frozen settings snapshot sent in `session.start`. Immutable for the
 * lifetime of a session; later edits only affect the next session.
 */
export interface SessionSettingsSnapshot {
  version: typeof SETTINGS_VERSION;
  /** Free-form AGENTS.md-like persona text; empty is valid. */
  persona: string;
  voice: VoicePreference;
}
