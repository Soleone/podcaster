import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  CUSTOM_VOICE_PREFIX,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_PERSONA,
  DEFAULT_PI_SETTINGS,
  DEFAULT_TTS_MODEL,
  customVoiceId,
  customVoicesMissingFromCatalog,
  ttsModelKey,
  withCustomVoices,
  type PiSettings,
  type QwenVoiceLanguage,
  type SessionSettingsSnapshot,
  type TtsModelDescriptor,
  type TtsModelSelection,
  type VoiceCatalog,
  type VoicePreference,
} from '@app/contracts/settings';
import { enrollCustomVoice as enrollCustomVoiceApi, enrollStoredCustomVoice, deleteCustomVoice as deleteCustomVoiceApi } from '../voice-enrollment/api';
import type { ReferenceTake } from '../voice-enrollment/recorder';
import type { CustomVoiceRecord } from '../storage/custom-voice-store';
import { startVoicePreview, type VoicePreviewHandle } from '../settings/voice-preview';
import { applyReconciled, defaultSettingsModel, reconcileSettings, settingsDigest, type SettingsModel } from '../settings/settings-model';
import type { AppStorage } from './useAppStorage';
import type { ReadinessSnapshot } from '../services/service-status';

const fakeServices = import.meta.env.MODE === 'fake-services';

/** Frozen snapshot handed to a session at start; digest pins the persona. */
export interface SessionStartSettings {
  settings: SessionSettingsSnapshot;
  digest: string;
}

export interface UseSettingsOptions {
  storage: AppStorage;
  /** Shared handle owned by App; the service-status hook reads it. */
  settingsModelRef: RefObject<SettingsModel>;
  /** Shared handle owned by the service-status hook. */
  capabilityRef: RefObject<string | undefined>;
  readinessSnapshot: ReadinessSnapshot | undefined;
}

export interface UseSettingsResult {
  settingsModel: SettingsModel;
  settingsModelRef: RefObject<SettingsModel>;
  setSettingsModel: (model: SettingsModel) => void;
  /** Resolves once the stored settings row has been applied (or defaulted). */
  settingsReady: Promise<void>;
  currentStartSettings: () => SessionStartSettings;
  ttsModels: TtsModelDescriptor[];
  ttsModelsRef: RefObject<TtsModelDescriptor[]>;
  voiceCatalogRef: RefObject<VoiceCatalog | undefined>;
  rawTtsModelsRef: RefObject<TtsModelDescriptor[]>;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsSaving: boolean;
  settingsSaveError: string | undefined;
  saveSettings: (agentName: string, persona: string, voice: VoicePreference, selectedModel?: TtsModelSelection, voiceProfiles?: Record<string, VoicePreference>, pi?: PiSettings) => Promise<void>;
  previewVoice: (voiceId: string, speedModifier: number, selectedModel?: TtsModelSelection, catalogId?: string, tonePrompt?: string, language?: QwenVoiceLanguage, signal?: AbortSignal) => Promise<VoicePreviewHandle>;
  enrollVoice: (name: string, take: ReferenceTake) => Promise<void>;
  deleteVoice: (voiceId: string) => Promise<void>;
  renameVoice: (voiceId: string, name: string) => Promise<void>;
}

/**
 * Owns the settings model, the sidecar-reported TTS model/catalog state, and
 * all browser-merged custom-voice reconciliation. Reads the shared
 * capability handle for anything that talks to the host.
 */
export function useSettings({ storage, settingsModelRef, capabilityRef, readinessSnapshot }: UseSettingsOptions): UseSettingsResult {
  const { settingsStoreRef, customVoiceStoreRef, customVoices, customVoicesRef, setCustomVoices } = storage;

  const voiceCatalogRef = useRef<VoiceCatalog | undefined>(undefined);
  const ttsModelsRef = useRef<TtsModelDescriptor[]>([]);
  const [ttsModels, setTtsModels] = useState<TtsModelDescriptor[]>([]);
  const [settingsModel, setSettingsModelState] = useState<SettingsModel>(() => defaultSettingsModel(undefined));
  settingsModelRef.current = settingsModel;
  const setSettingsModel = useCallback((model: SettingsModel) => {
    settingsModelRef.current = model;
    setSettingsModelState(model);
  }, [settingsModelRef]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | undefined>(undefined);
  const settingsReadyRef = useRef<Promise<void> | undefined>(undefined);
  const resolveSettingsReadyRef = useRef<(() => void) | undefined>(undefined);
  if (!settingsReadyRef.current) {
    settingsReadyRef.current = new Promise<void>(resolve => { resolveSettingsReadyRef.current = resolve; });
  }

  const currentStartSettings = useCallback((): SessionStartSettings => {
    const model = settingsModelRef.current;
    return {
      settings: { version: 1, persona: model.persona, voice: { ...model.voice }, pi: { ...model.pi } },
      digest: settingsDigest(model),
    };
  }, []);

  const mergeCustomModels = useCallback((models: TtsModelDescriptor[]): TtsModelDescriptor[] => models.map(item => {
    if (item.backendId !== 'qwen3' || !item.voiceCatalog) return item;
    const voiceCatalog = withCustomVoices(item.voiceCatalog, customVoicesRef.current);
    return voiceCatalog ? { ...item, voiceCatalog } : item;
  }), []);
  const customSyncInFlightRef = useRef(false);
  // The raw sidecar-reported model descriptors, without the browser-merged
  // custom voices. Restore detection must compare stored references against the
  // sidecar's authoritative catalog only; if we compare against the merged
  // catalog (which always includes browser-stored voices), a voice that the
  // sidecar dropped on restart is never seen as missing and never re-enrolled.
  const rawTtsModelsRef = useRef<TtsModelDescriptor[]>([]);
  const syncStoredCustomVoices = useCallback(async (models?: TtsModelDescriptor[]) => {
    const capability = capabilityRef.current;
    if (fakeServices || !capability || customSyncInFlightRef.current) return;
    const qwen = (models ?? rawTtsModelsRef.current).find(item => item.backendId === 'qwen3' && item.status === 'ready' && item.voiceCatalog);
    const store = customVoiceStoreRef.current;
    if (!qwen?.voiceCatalog || !store || customVoicesRef.current.length === 0) return;
    const missing = customVoicesMissingFromCatalog(qwen?.voiceCatalog, customVoicesRef.current);
    if (missing.length === 0) return;
    customSyncInFlightRef.current = true;
    try {
      for (const voice of missing) {
        try { await enrollStoredCustomVoice({ capability, voice }); } catch { break; }
      }
    } finally { customSyncInFlightRef.current = false; }
  }, [capabilityRef, customVoiceStoreRef, customVoicesRef]);
  const reconcileCurrentSettings = useCallback((models: TtsModelDescriptor[], fallbackCatalog = voiceCatalogRef.current) => {
    const merged = mergeCustomModels(models);
    const fallback = withCustomVoices(fallbackCatalog, customVoicesRef.current);
    setSettingsModelState(previous => applyReconciled(previous, reconcileSettings({ selectedModel: previous.selectedModel, voice: previous.voice, voiceProfiles: previous.voiceProfiles }, merged, fallback)));
  }, [customVoicesRef, mergeCustomModels]);

  const onCatalog = useCallback((catalog: VoiceCatalog) => {
    const mergedCatalog = withCustomVoices(catalog, customVoicesRef.current) ?? catalog;
    voiceCatalogRef.current = mergedCatalog;
    if (ttsModelsRef.current.length === 0) {
      // Keep the raw (un-merged) sidecar catalog for restore detection; only the
      // UI-facing fallback merges in the browser-stored custom voices.
      const rawFallback: TtsModelDescriptor = { backendId: catalog.backendId, modelId: catalog.modelId, label: catalog.backendId === 'kokoro' ? 'Kokoro CUDA' : `${catalog.backendId} · ${catalog.modelId}`, status: 'ready', voiceCatalog: catalog, ...(catalog.speed ? { speed: catalog.speed } : {}) };
      rawTtsModelsRef.current = [rawFallback];
      const fallbackModel: TtsModelDescriptor = { ...rawFallback, voiceCatalog: mergedCatalog };
      ttsModelsRef.current = [fallbackModel];
      setTtsModels([fallbackModel]);
    }
    reconcileCurrentSettings(ttsModelsRef.current, mergedCatalog);
    void syncStoredCustomVoices(rawTtsModelsRef.current);
  }, [customVoicesRef, reconcileCurrentSettings, syncStoredCustomVoices]);

  const onModels = useCallback((models: TtsModelDescriptor[]) => {
    if (models.length > 0) rawTtsModelsRef.current = models;
    const merged = mergeCustomModels(models);
    ttsModelsRef.current = merged;
    setTtsModels(merged);
    const active = merged.find(item => item.status === 'ready' && item.voiceCatalog);
    if (active?.voiceCatalog) voiceCatalogRef.current = active.voiceCatalog;
    reconcileCurrentSettings(merged, voiceCatalogRef.current);
    void syncStoredCustomVoices(rawTtsModelsRef.current);
  }, [mergeCustomModels, reconcileCurrentSettings, syncStoredCustomVoices]);

  useEffect(() => {
    const snapshot = readinessSnapshot;
    if (!snapshot) return;
    if (snapshot.ttsModels) onModels(snapshot.ttsModels);
    if (snapshot.voiceCatalog) onCatalog(snapshot.voiceCatalog);
  }, [readinessSnapshot, onCatalog, onModels]);

  const ensureCustomVoiceEnrolled = useCallback(async (voiceId: string) => {
    const capability = capabilityRef.current;
    if (fakeServices || !capability || !voiceId.startsWith(CUSTOM_VOICE_PREFIX)) return;
    // Compare against the raw sidecar catalog (not the merged one) so a voice
    // the sidecar dropped on restart is re-enrolled before it is previewed.
    const qwen = rawTtsModelsRef.current.find(item => item.backendId === 'qwen3' && item.status === 'ready' && item.voiceCatalog);
    const catalog = qwen?.voiceCatalog;
    if (catalog && catalog.voices.some(voice => voice.id === voiceId)) return;
    const store = customVoiceStoreRef.current;
    const record = store ? await store.get(voiceId) : undefined;
    if (!record) return;
    await enrollStoredCustomVoice({ capability, voice: record });
  }, [capabilityRef, customVoiceStoreRef]);

  const previewVoice = useCallback(async (voiceId: string, speedModifier: number, selectedModel: TtsModelSelection = DEFAULT_TTS_MODEL, catalogId?: string, tonePrompt?: string, language?: QwenVoiceLanguage, signal?: AbortSignal) => {
    const capability = capabilityRef.current;
    if (!capability) throw new Error('The session capability is not ready yet.');
    await ensureCustomVoiceEnrolled(voiceId);
    return startVoicePreview({ voiceId, speedModifier, backendId: selectedModel.backendId, modelId: selectedModel.modelId, ...(catalogId ? { catalogId } : {}), ...(tonePrompt ? { tonePrompt } : {}), ...(language ? { language } : {}), ...(signal ? { signal } : {}), capability });
  }, [capabilityRef, ensureCustomVoiceEnrolled]);

  const enrollVoice = useCallback(async (name: string, take: ReferenceTake) => {
    await settingsReadyRef.current!;
    const store = customVoiceStoreRef.current;
    if (!store) throw new Error('Custom voice storage is unavailable.');
    const now = new Date().toISOString();
    const record: CustomVoiceRecord = {
      voiceId: customVoiceId(take.refSha256),
      name,
      refSha256: take.refSha256,
      sampleRate: take.signal.sampleRate,
      durationMs: take.durationMs,
      byteLength: take.wavBytes.byteLength,
      createdAt: now,
      updatedAt: now,
      wav: take.wav,
    };
    if (!(await store.save(record))) throw new Error('The local custom voice storage limit was reached. Delete a voice and try again.');
    setCustomVoices(await store.list());
    const capability = capabilityRef.current;
    if (!fakeServices && capability) await enrollCustomVoiceApi({ capability, voiceId: record.voiceId, name, take });
  }, [capabilityRef, customVoiceStoreRef, setCustomVoices]);

  const deleteVoice = useCallback(async (voiceId: string) => {
    const capability = capabilityRef.current;
    if (!fakeServices && capability) await deleteCustomVoiceApi(capability, voiceId);
    const store = customVoiceStoreRef.current;
    if (store) {
      await store.delete(voiceId);
      setCustomVoices(await store.list());
    }
  }, [capabilityRef, customVoiceStoreRef, setCustomVoices]);

  const renameVoice = useCallback(async (voiceId: string, name: string) => {
    const store = customVoiceStoreRef.current;
    if (!store || !(await store.rename(voiceId, name))) throw new Error('The custom voice name could not be saved.');
    setCustomVoices(await store.list());
  }, [customVoiceStoreRef, setCustomVoices]);

  useEffect(() => {
    const merged = mergeCustomModels(ttsModelsRef.current);
    if (merged.length === 0) return;
    ttsModelsRef.current = merged;
    setTtsModels(merged);
    reconcileCurrentSettings(merged, voiceCatalogRef.current);
    // Use the raw sidecar descriptors so a sidecar restart is detected and each
    // dropped stored voice is re-enrolled rather than hidden by the merge.
    void syncStoredCustomVoices(rawTtsModelsRef.current);
  }, [customVoices, mergeCustomModels, reconcileCurrentSettings, syncStoredCustomVoices]);

  const saveSettings = useCallback(async (agentName: string, persona: string, voice: VoicePreference, selectedModel: TtsModelSelection = DEFAULT_TTS_MODEL, voiceProfiles: Record<string, VoicePreference> = {}, pi: PiSettings = DEFAULT_PI_SETTINGS) => {
    setSettingsSaving(true);
    setSettingsSaveError(undefined);
    try {
      await settingsReadyRef.current!;
      const store = settingsStoreRef.current;
      if (!store) throw new Error('Settings storage is unavailable.');
      const activeVoice = { ...voice, backendId: selectedModel.backendId, modelId: selectedModel.modelId };
      const profiles = { ...voiceProfiles, [ttsModelKey(selectedModel)]: activeVoice };
      const ok = await store.save({ version: 1, agentName, persona, pi, selectedModel, voice: activeVoice, voiceProfiles: profiles });
      if (!ok) throw new Error('Settings could not be saved on this device.');
      const next = applyReconciled({ agentName, persona, pi, selectedModel, voiceProfiles: profiles }, { voice: activeVoice, selectedModel, voiceProfiles: profiles });
      settingsModelRef.current = next;
      setSettingsModelState(next);
      setSettingsOpen(false);
    } catch (error) {
      setSettingsSaveError(error instanceof Error ? error.message : 'Settings could not be saved.');
    } finally {
      setSettingsSaving(false);
    }
  }, [settingsStoreRef]);

  // Load the stored settings row once the stores are ready. Storage failures
  // keep the in-memory defaults but still release the ready gate.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await storage.ready;
        if (cancelled) return;
        const store = settingsStoreRef.current;
        const stored = store ? await store.load() : undefined;
        if (cancelled) return;
        const pi = stored?.pi ?? DEFAULT_PI_SETTINGS;
        const selectedModel = stored?.selectedModel ?? {
          backendId: stored?.voice.backendId ?? DEFAULT_TTS_MODEL.backendId,
          modelId: stored?.voice.modelId ?? DEFAULT_TTS_MODEL.modelId,
        };
        const availableModels = mergeCustomModels(ttsModelsRef.current);
        const fallbackCatalog = withCustomVoices(voiceCatalogRef.current, customVoicesRef.current);
        const reconciled = reconcileSettings({ selectedModel, ...(stored?.voice ? { voice: stored.voice } : {}), ...(stored?.voiceProfiles ? { voiceProfiles: stored.voiceProfiles } : {}) }, availableModels, fallbackCatalog);
        const next = applyReconciled({ agentName: stored?.agentName ?? DEFAULT_AGENT_NAME, persona: stored?.persona ?? DEFAULT_AGENT_PERSONA, pi, selectedModel, ...(stored?.voiceProfiles ? { voiceProfiles: stored.voiceProfiles } : {}) }, reconciled);
        settingsModelRef.current = next;
        setSettingsModelState(next);
      } catch {
        // Keep the in-memory defaults when local settings storage is unavailable.
      } finally {
        if (!cancelled) {
          resolveSettingsReadyRef.current?.();
          resolveSettingsReadyRef.current = undefined;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [storage, settingsStoreRef, customVoicesRef, mergeCustomModels]);

  return {
    settingsModel,
    settingsModelRef,
    setSettingsModel,
    settingsReady: settingsReadyRef.current!,
    currentStartSettings,
    ttsModels,
    ttsModelsRef,
    voiceCatalogRef,
    rawTtsModelsRef,
    settingsOpen,
    setSettingsOpen,
    settingsSaving,
    settingsSaveError,
    saveSettings,
    previewVoice,
    enrollVoice,
    deleteVoice,
    renameVoice,
  };
}
