// Settings reconciliation against the verified voice catalog. Browser-safe.

import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_PERSONA, isVoiceInCatalog, isValidVoicePreference, type VoiceCatalog, type VoicePreference } from '@app/contracts/settings';

export type VoiceNoticeReason = 'rebase' | 'defaulted' | 'missing_catalog';

export interface SettingsModel {
  agentName: string;
  persona: string;
  voice: VoicePreference;
  notice?: VoiceNoticeReason;
}

export function defaultVoice(catalog: VoiceCatalog | undefined): VoicePreference {
  return { catalogId: catalog?.catalogId ?? '', voiceId: catalog?.defaultVoiceId ?? '' };
}

export function defaultSettingsModel(catalog: VoiceCatalog | undefined): SettingsModel {
  return { agentName: DEFAULT_AGENT_NAME, persona: DEFAULT_AGENT_PERSONA, voice: defaultVoice(catalog) };
}

/** Stable audit digest over the frozen agent settings snapshot (name + persona + voice). */
export function settingsDigest(settings: { agentName: string; persona: string; voice: VoicePreference }): string {
  const source = `${settings.agentName}\u0000${settings.persona}\u0000${settings.voice.catalogId}\u0000${settings.voice.voiceId}`;
  let hash1 = 0x811c9dc5;
  let hash2 = 0x01000193 ^ 0x3f08;
  for (const byte of new TextEncoder().encode(source)) {
    hash1 ^= byte; hash1 = Math.imul(hash1, 0x01000193);
    hash2 ^= byte; hash2 = Math.imul(hash2, 0x85ebca6b);
  }
  return `${(hash1 >>> 0).toString(16).padStart(8, '0')}${(hash2 >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Reconcile a persisted voice preference against the current verified catalog:
 * 1. Same catalog and known voice -> keep it.
 * 2. Changed catalog but the same voice id is available -> rebase + notice.
 * 3. Removed/unknown voice -> verified default + notice.
 * 4. No verified catalog -> no options; voice-session start is disabled.
 */
export function reconcileVoice(preference: VoicePreference | undefined, catalog: VoiceCatalog | undefined): { voice: VoicePreference; notice?: VoiceNoticeReason } {
  // Keep a valid persisted preference while the verified catalog is still
  // loading. Readiness and settings initialize independently, so clearing it
  // here would make a saved voice impossible to reconcile when the catalog
  // arrives later.
  if (!catalog) {
    if (preference && isValidVoicePreference(preference)) return { voice: preference, notice: 'missing_catalog' };
    return { voice: { catalogId: '', voiceId: '' }, notice: 'missing_catalog' };
  }
  if (preference && isValidVoicePreference(preference) && preference.catalogId === catalog.catalogId && isVoiceInCatalog(catalog, preference.voiceId)) {
    return { voice: preference };
  }
  if (preference && isValidVoicePreference(preference) && isVoiceInCatalog(catalog, preference.voiceId)) {
    return { voice: { catalogId: catalog.catalogId, voiceId: preference.voiceId }, notice: 'rebase' };
  }
  return { voice: { catalogId: catalog.catalogId, voiceId: catalog.defaultVoiceId }, notice: 'defaulted' };
}

/** Build a SettingsModel honoring exactOptionalPropertyTypes (never sets undefined). */
export function applyReconciled(base: { agentName: string; persona: string }, reconciled: { voice: VoicePreference; notice?: VoiceNoticeReason }): SettingsModel {
  return reconciled.notice
    ? { agentName: base.agentName, persona: base.persona, voice: reconciled.voice, notice: reconciled.notice }
    : { agentName: base.agentName, persona: base.persona, voice: reconciled.voice };
}
