// Browser-safe settings reconciliation. Model selection owns the catalog and its
// profile, so a voice or speed from one backend is never silently reused by
// another backend.

import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_PERSONA,
  DEFAULT_PI_SETTINGS,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_SPEED_MODIFIER,
  isVoiceInCatalog,
  isValidVoicePreference,
  ttsModelKey,
  voiceSpeedCapability,
  type PiSettings,
  type TtsModelDescriptor,
  type TtsModelSelection,
  type VoiceCatalog,
  type VoicePreference,
} from '@app/contracts/settings';

export type VoiceNoticeReason = 'rebase' | 'defaulted' | 'missing_catalog' | 'model_unavailable' | 'speed_defaulted';

export interface SettingsModel {
  agentName: string;
  persona: string;
  pi: PiSettings;
  selectedModel: TtsModelSelection;
  voice: VoicePreference;
  voiceProfiles: Record<string, VoicePreference>;
  notice?: VoiceNoticeReason;
}

export interface ReconcileSettingsInput {
  selectedModel?: TtsModelSelection;
  voice?: VoicePreference;
  voiceProfiles?: Record<string, VoicePreference>;
}

export function defaultVoice(catalog: VoiceCatalog | undefined): VoicePreference {
  return { catalogId: catalog?.catalogId ?? '', voiceId: catalog?.defaultVoiceId ?? '', speedModifier: DEFAULT_VOICE_SPEED_MODIFIER };
}

export function defaultSettingsModel(catalog: VoiceCatalog | undefined, selectedModel: TtsModelSelection = DEFAULT_TTS_MODEL, pi: PiSettings = DEFAULT_PI_SETTINGS): SettingsModel {
  const voice = defaultVoice(catalog);
  const key = ttsModelKey(selectedModel);
  return {
    agentName: DEFAULT_AGENT_NAME,
    persona: DEFAULT_AGENT_PERSONA,
    pi: { ...pi },
    selectedModel: { ...selectedModel },
    voice,
    voiceProfiles: catalog ? { [key]: { ...voice, ...selectedModel } } : {},
  };
}

/** Stable audit digest over the frozen agent settings snapshot. */
export function settingsDigest(settings: { agentName: string; persona: string; voice: VoicePreference; selectedModel?: TtsModelSelection; pi?: PiSettings }): string {
  const model = settings.selectedModel ?? {
    backendId: settings.voice.backendId ?? DEFAULT_TTS_MODEL.backendId,
    modelId: settings.voice.modelId ?? DEFAULT_TTS_MODEL.modelId,
  };
  const pi = settings.pi ?? DEFAULT_PI_SETTINGS;
  const source = `${settings.agentName}\u0000${settings.persona}\u0000${pi.model}\u0000${pi.thinkingLevel}\u0000${model.backendId}\u0000${model.modelId}\u0000${settings.voice.catalogId}\u0000${settings.voice.voiceId}\u0000${settings.voice.speedModifier}\u0000${settings.voice.tonePrompt ?? ''}\u0000${settings.voice.language ?? ''}`;
  let hash1 = 0x811c9dc5;
  let hash2 = 0x01000193 ^ 0x3f08;
  for (const byte of new TextEncoder().encode(source)) {
    hash1 ^= byte; hash1 = Math.imul(hash1, 0x01000193);
    hash2 ^= byte; hash2 = Math.imul(hash2, 0x85ebca6b);
  }
  return `${(hash1 >>> 0).toString(16).padStart(8, '0')}${(hash2 >>> 0).toString(16).padStart(8, '0')}`;
}

function validSpeed(speed: number, catalog: VoiceCatalog | undefined): boolean {
  const capability = voiceSpeedCapability(catalog);
  return capability.supported
    && Number.isFinite(speed)
    && speed >= capability.min
    && speed <= capability.max;
}

/**
 * Reconcile one persisted preference against one verified catalog:
 * stale voice IDs use the backend default, changed catalog IDs rebase, and an
 * unsupported speed uses that backend's declared default.
 */
export function reconcileVoice(preference: VoicePreference | undefined, catalog: VoiceCatalog | undefined): { voice: VoicePreference; notice?: VoiceNoticeReason } {
  if (!catalog) {
    if (preference && Number.isFinite(preference.speedModifier)) return { voice: preference, notice: 'missing_catalog' };
    return { voice: { catalogId: '', voiceId: '', speedModifier: DEFAULT_VOICE_SPEED_MODIFIER }, notice: 'missing_catalog' };
  }
  const capability = voiceSpeedCapability(catalog);
  const speed = preference && validSpeed(preference.speedModifier, catalog)
    ? preference.speedModifier
    : capability.default;
  const speedNotice = preference && speed !== preference.speedModifier ? 'speed_defaulted' : undefined;
  if (preference && isValidVoicePreference(preference) && preference.catalogId === catalog.catalogId && isVoiceInCatalog(catalog, preference.voiceId)) {
    return speedNotice
      ? { voice: { ...preference, speedModifier: speed }, notice: speedNotice }
      : { voice: preference };
  }
  if (preference && isValidVoicePreference(preference) && isVoiceInCatalog(catalog, preference.voiceId)) {
    return { voice: { catalogId: catalog.catalogId, voiceId: preference.voiceId, speedModifier: speed, ...(preference.tonePrompt ? { tonePrompt: preference.tonePrompt } : {}), ...(preference.language ? { language: preference.language } : {}) }, notice: speedNotice ?? 'rebase' };
  }
  return { voice: { catalogId: catalog.catalogId, voiceId: catalog.defaultVoiceId, speedModifier: speed, ...(preference?.tonePrompt ? { tonePrompt: preference.tonePrompt } : {}), ...(preference?.language ? { language: preference.language } : {}) }, notice: speedNotice ?? 'defaulted' };
}

function descriptorCatalog(descriptor: TtsModelDescriptor | undefined): VoiceCatalog | undefined {
  if (descriptor?.status !== 'ready' || !descriptor.voiceCatalog) return undefined;
  // The model descriptor is the current capability snapshot. Prefer its speed
  // contract even when an older catalog omitted or retained a stale speed field.
  return descriptor.speed ? { ...descriptor.voiceCatalog, speed: descriptor.speed } : descriptor.voiceCatalog;
}

function modelDescriptor(models: readonly TtsModelDescriptor[], selection: TtsModelSelection): TtsModelDescriptor | undefined {
  return models.find(model => model.backendId === selection.backendId && model.modelId === selection.modelId);
}

function sameModel(preference: VoicePreference | undefined, model: TtsModelSelection): boolean {
  if (!preference?.backendId && !preference?.modelId) return model.backendId === DEFAULT_TTS_MODEL.backendId && model.modelId === DEFAULT_TTS_MODEL.modelId;
  if (!preference?.backendId || !preference.modelId) return false;
  return preference.backendId === model.backendId && preference.modelId === model.modelId;
}

function scopedProfiles(value: Record<string, VoicePreference> | undefined): Record<string, VoicePreference> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, preference]) =>
    Boolean(preference.backendId && preference.modelId)
    && key === ttsModelKey({ backendId: preference.backendId!, modelId: preference.modelId! }),
  ));
}

/**
 * Reconcile the full model/profile set used by the settings dialog. The active
 * model is selected first, then only that model's profile is reconciled.
 */
export function reconcileSettings(input: ReconcileSettingsInput, models: readonly TtsModelDescriptor[], fallbackCatalog?: VoiceCatalog): { selectedModel: TtsModelSelection; voice: VoicePreference; voiceProfiles: Record<string, VoicePreference>; notice?: VoiceNoticeReason } {
  const requested = input.selectedModel ?? {
    backendId: input.voice?.backendId ?? DEFAULT_TTS_MODEL.backendId,
    modelId: input.voice?.modelId ?? DEFAULT_TTS_MODEL.modelId,
  };
  const requestedDescriptor = modelDescriptor(models, requested);
  let selectedModel = { ...requested };
  let catalog = descriptorCatalog(requestedDescriptor);
  let notice: VoiceNoticeReason | undefined;
  if (!catalog && (requestedDescriptor?.status === 'unavailable' || (models.length > 0 && !requestedDescriptor))) {
    const fallback = requestedDescriptor?.fallback
      ?? (modelDescriptor(models, DEFAULT_TTS_MODEL)?.status === 'ready' ? DEFAULT_TTS_MODEL : models.find(item => item.status === 'ready' && item.voiceCatalog) ?? DEFAULT_TTS_MODEL);
    const fallbackSelection: TtsModelSelection = 'backendId' in fallback && 'modelId' in fallback
      ? { backendId: fallback.backendId, modelId: fallback.modelId }
      : { ...DEFAULT_TTS_MODEL };
    const fallbackDescriptor = modelDescriptor(models, fallbackSelection);
    selectedModel = fallbackSelection;
    catalog = descriptorCatalog(fallbackDescriptor) ?? (selectedModel.backendId === DEFAULT_TTS_MODEL.backendId && selectedModel.modelId === DEFAULT_TTS_MODEL.modelId ? fallbackCatalog : undefined);
    notice = 'model_unavailable';
  }
  if (!catalog && selectedModel.backendId === DEFAULT_TTS_MODEL.backendId && selectedModel.modelId === DEFAULT_TTS_MODEL.modelId) catalog = fallbackCatalog;

  const profiles: Record<string, VoicePreference> = scopedProfiles(input.voiceProfiles);
  const key = ttsModelKey(selectedModel);
  const stored = profiles[key] ?? (sameModel(input.voice, selectedModel) ? input.voice : undefined);
  const reconciled = reconcileVoice(stored, catalog);
  const activeVoice = {
    ...reconciled.voice,
    backendId: selectedModel.backendId,
    modelId: selectedModel.modelId,
  };
  profiles[key] = activeVoice;
  if (!notice) notice = reconciled.notice;
  return notice
    ? { selectedModel, voice: activeVoice, voiceProfiles: profiles, notice }
    : { selectedModel, voice: activeVoice, voiceProfiles: profiles };
}

/** Build a SettingsModel honoring exactOptionalPropertyTypes. */
export function applyReconciled(
  base: { agentName: string; persona: string; pi?: PiSettings; selectedModel?: TtsModelSelection; voiceProfiles?: Record<string, VoicePreference> },
  reconciled: { voice: VoicePreference; notice?: VoiceNoticeReason; selectedModel?: TtsModelSelection; voiceProfiles?: Record<string, VoicePreference> },
): SettingsModel {
  const selectedModel = reconciled.selectedModel ?? base.selectedModel ?? {
    backendId: reconciled.voice.backendId ?? DEFAULT_TTS_MODEL.backendId,
    modelId: reconciled.voice.modelId ?? DEFAULT_TTS_MODEL.modelId,
  };
  const voice = { ...reconciled.voice, backendId: selectedModel.backendId, modelId: selectedModel.modelId };
  const voiceProfiles = reconciled.voiceProfiles ?? base.voiceProfiles ?? { [ttsModelKey(selectedModel)]: voice };
  const model: SettingsModel = { agentName: base.agentName, persona: base.persona, pi: { ...(base.pi ?? DEFAULT_PI_SETTINGS) }, selectedModel: { ...selectedModel }, voice, voiceProfiles };
  if (reconciled.notice) model.notice = reconciled.notice;
  return model;
}
