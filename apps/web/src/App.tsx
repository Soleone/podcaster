import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { BrowserCapture, type CaptureHandle } from './audio/capture';
import { BrowserPlayback } from './audio/playback';
import type { PlaybackStopReason } from './audio/playback-ledger';
import { createEncoderClient } from './recording/encoder-client';
import { RecordingRecorder } from './recording/recorder';
import { offlineResample } from './recording/resample';
import { buildRecording, createBrowserDecoder, type ExportOnProgress } from './recording/splice';
import { activityLog } from './session/activity-log';
import { SessionController, type ControlledPlayback } from './session/controller';
import { sessionViewStateFromTurns } from './sessions/session-archive';
import { createEnvelope, uuidV7 } from './session/envelope';
import { FakeSessionTransport } from './session/fake-transport';
import type { SessionTransport } from './session/transport';
import { WebSocketSessionTransport } from './session/websocket-transport';
import { initialSessionState, type SessionViewState } from './session/state';
import { RecordingStore, type RecordingItemSummary } from './storage/recording-store';
import { CustomVoiceStore, type CustomVoiceRecord } from './storage/custom-voice-store';
import { enrollCustomVoice as enrollCustomVoiceApi, enrollStoredCustomVoice, deleteCustomVoice as deleteCustomVoiceApi } from './voice-enrollment/api';
import type { ReferenceTake } from './voice-enrollment/recorder';
import { sessionActiveDurationMs, StableTurnWriter } from './storage/stable-turn-writer';
import type { StoredSession } from './storage/schema';
import { deleteSessionRecording } from './recording/export';
import { emptyRecordingSessionView, projectRecordingTrim, type RecordingSessionViewState, type RecordingTrimTargetId } from './recording/trim-state';
import { CUSTOM_VOICE_PREFIX, DEFAULT_AGENT_NAME, DEFAULT_AGENT_PERSONA, DEFAULT_PI_SETTINGS, DEFAULT_TTS_MODEL, customVoiceId, customVoicesMissingFromCatalog, isValidSessionSettingsSnapshot, ttsModelKey, withCustomVoices, type PiSettings, type QwenVoiceLanguage, type SessionSettingsSnapshot, type TtsModelDescriptor, type TtsModelSelection, type VoiceCatalog, type VoicePreference } from '@app/contracts/settings';
import { SettingsStore } from './settings/settings-store';
import { startVoicePreview } from './settings/voice-preview';
import { applyReconciled, defaultSettingsModel, reconcileSettings, settingsDigest, type SettingsModel } from './settings/settings-model';
import { AppHeader } from './components/AppHeader';
import { bootstrapCapability } from './sessions/session-archive';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { Spinner } from './components/ui/spinner';
import { persistTheme, readTheme } from './theme';
import { initialServiceStatuses, serviceStatusesFromSnapshot, type ReadinessSnapshot, type ServiceStatuses } from './services/service-status';

const fakeServices = import.meta.env.MODE === 'fake-services';

const SessionIndex = lazy(() => import('./sessions/SessionIndex').then(({ SessionIndex: component }) => ({ default: component })));
const SessionScreen = lazy(() => import('./session/SessionScreen').then(({ SessionScreen: component }) => ({ default: component })));
const StoppedSession = lazy(() => import('./sessions/StoppedSession').then(({ StoppedSession: component }) => ({ default: component })));
const SettingsDialog = lazy(() => import('./settings/SettingsDialog').then(({ SettingsDialog: component }) => ({ default: component })));
type SessionStartSettings = SessionSettingsSnapshot;
type LifecycleAction = 'idle' | 'pausing' | 'resuming' | 'ending';

interface FakeRuntimeStats {
  captureStarts: number;
  captureStops: number;
  captureRunning: boolean;
  playbackPauses: number;
  playbackResumes: number;
  playbackStops: PlaybackStopReason[];
}
class InstrumentedPlayback implements ControlledPlayback {
  constructor(private readonly playback: BrowserPlayback, private readonly stats: FakeRuntimeStats) {}
  setGeneratedSamples(samples: number): void { this.playback.setGeneratedSamples(samples); }
  append(offset: number, pcm16: Int16Array): void { this.playback.append(offset, pcm16); }
  async pause() { this.stats.playbackPauses++; return this.playback.pause(); }
  async resume(rewindMs?: number): Promise<void> { this.stats.playbackResumes++; await this.playback.resume(rewindMs); }
  stop(reason: PlaybackStopReason) { return this.playback.stop(reason); }
}

interface TestApi {
  emit(type: string, payload: Record<string, unknown>, epoch?: number): Promise<void>;
  partial(text: string): Promise<void>;
  audio(playbackId: string, sampleOffset: number, samples: number): Promise<void>;
  capture(): void;
  degrade(message: string): void;
  stats(): FakeRuntimeStats & { captureFrames: number; progressReports: number; terminalReceipts: number; commands: string[] };
}

declare global { interface Window { __podcasterTest?: TestApi } }

export function App() {
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const navigate = useNavigate();
  const [view, setView] = useState<SessionViewState>();
  const [sessionId, setSessionId] = useState<string>();
  const [capability, setCapability] = useState<string>();
  const [elapsed, setElapsed] = useState(0);
  const [sessionPaused, setSessionPaused] = useState(false);
  const sessionPausedRef = useRef(false);
  sessionPausedRef.current = sessionPaused;
  const [lifecycleAction, setLifecycleAction] = useState<LifecycleAction>('idle');
  const lifecycleActionRef = useRef<LifecycleAction>('idle');
  lifecycleActionRef.current = lifecycleAction;
  const [writer, setWriter] = useState<StableTurnWriter | undefined>(undefined);
  const [resuming, setResuming] = useState(false);
  const stoppedRef = useRef(false);
  const writerRef = useRef<StableTurnWriter | undefined>(undefined);
  const controllerRef = useRef<SessionController | undefined>(undefined);
  const transportRef = useRef<SessionTransport | undefined>(undefined);
  const fakeTransportRef = useRef<FakeSessionTransport | undefined>(undefined);
  const captureRef = useRef<CaptureHandle | undefined>(undefined);
  const captureStreamIdRef = useRef<number | undefined>(undefined);
  const captureRecoveryRef = useRef<Promise<void> | undefined>(undefined);
  const captureGenerationRef = useRef(0);
  const reconnectUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const transportFailureUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const recordingStoreRef = useRef<RecordingStore | undefined>(undefined);
  const recordingRecorderRef = useRef<RecordingRecorder | undefined>(undefined);
  const recordingUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const statsRef = useRef<FakeRuntimeStats>({ captureStarts: 0, captureStops: 0, captureRunning: false, playbackPauses: 0, playbackResumes: 0, playbackStops: [] });
  const sessionClockRef = useRef<{ activeDurationMs: number; runningSinceMs: number | undefined }>({ activeDurationMs: 0, runningSinceMs: undefined });
  const [recordingView, setRecordingView] = useState<RecordingSessionViewState>(emptyRecordingSessionView);
  const recordingViewRef = useRef(recordingView);
  recordingViewRef.current = recordingView;
  const recordingSessionRef = useRef<string | undefined>(undefined);
  recordingSessionRef.current = sessionId;
  const recordingGenRef = useRef(0);
  const lastCheapRef = useRef<{ enabled: boolean; signature: string } | null>(null);
  const settingsStoreRef = useRef<SettingsStore | undefined>(undefined);
  const customVoiceStoreRef = useRef<CustomVoiceStore | undefined>(undefined);
  const [customVoices, setCustomVoices] = useState<CustomVoiceRecord[]>([]);
  const customVoicesRef = useRef(customVoices);
  customVoicesRef.current = customVoices;
  const settingsReadyPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const resolveSettingsReadyRef = useRef<(() => void) | undefined>(undefined);
  if (!settingsReadyPromiseRef.current) {
    settingsReadyPromiseRef.current = new Promise<void>(resolve => { resolveSettingsReadyRef.current = resolve; });
  }
  const voiceCatalogRef = useRef<VoiceCatalog | undefined>(undefined);
  const ttsModelsRef = useRef<TtsModelDescriptor[]>([]);
  const [ttsModels, setTtsModels] = useState<TtsModelDescriptor[]>([]);
  const settingsFrozenRef = useRef<SettingsModel | undefined>(undefined);
  const [settingsModel, setSettingsModel] = useState<SettingsModel>(() => defaultSettingsModel(undefined));
  const settingsModelRef = useRef(settingsModel);
  settingsModelRef.current = settingsModel;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serviceStatuses, setServiceStatuses] = useState<ServiceStatuses>(initialServiceStatuses);
  const [refreshingServiceStatus, setRefreshingServiceStatus] = useState(false);
  const [darkMode, setDarkMode] = useState(() => readTheme() === 'dark');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | undefined>(undefined);
  const toggleDarkMode = useCallback(() => setDarkMode(value => !value), []);

  const applyReadinessSnapshot = useCallback((snapshot: ReadinessSnapshot) => {
    setServiceStatuses(serviceStatusesFromSnapshot(snapshot));
  }, []);

  const refreshServiceStatus = useCallback(async () => {
    if (!capability) return;
    setRefreshingServiceStatus(true);
    try {
      const microphoneGranted = await navigator.permissions?.query({ name: 'microphone' as PermissionName }).then(permission => permission.state === 'granted').catch(() => false) ?? false;
      const response = await fetch('/api/readiness', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-podcaster-capability': capability },
        body: JSON.stringify({ microphoneGranted, ttsModel: settingsModelRef.current.selectedModel }),
      });
      if (!response.ok) throw new Error('service status request failed');
      const snapshot = await response.json() as ReadinessSnapshot;
      applyReadinessSnapshot(snapshot);
    } catch {
      // Keep the last known state visible. A single dropped poll should not
      // make healthy services flash unavailable.
    } finally {
      setRefreshingServiceStatus(false);
    }
  }, [applyReadinessSnapshot, capability]);

  useEffect(() => {
    if (!capability) return;
    let cancelled = false;
    void refreshServiceStatus();
    const timer = setInterval(() => { if (!cancelled) void refreshServiceStatus(); }, 4_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [capability, refreshServiceStatus]);

  const refreshElapsed = useCallback(() => {
    const clock = sessionClockRef.current;
    const running = clock.runningSinceMs === undefined ? 0 : Math.max(0, Date.now() - clock.runningSinceMs);
    setElapsed(Math.floor((clock.activeDurationMs + running) / 1000));
  }, []);

  const configureSessionClock = useCallback((session: StoredSession | undefined) => {
    if (!session) {
      sessionClockRef.current = { activeDurationMs: 0, runningSinceMs: undefined };
      setElapsed(0);
      return;
    }
    const now = Date.now();
    const runningSince = session.state === 'active'
      ? (Date.parse(session.runningSince ?? '') || Date.parse(session.startedAt) || now)
      : undefined;
    const currentRun = runningSince === undefined ? 0 : Math.max(0, now - runningSince);
    sessionClockRef.current = { activeDurationMs: Math.max(0, sessionActiveDurationMs(session, now) - currentRun), runningSinceMs: session.state === 'active' ? now : undefined };
    refreshElapsed();
  }, [refreshElapsed]);

  useEffect(() => {
    persistTheme(darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const currentStartSettings = useCallback((): { settings: SessionStartSettings; digest: string } => {
    const model = settingsModelRef.current;
    return {
      settings: { version: 1, persona: model.persona, voice: { ...model.voice }, pi: { ...model.pi } },
      digest: settingsDigest(model),
    };
  }, []);

  const composeFakeSession = useCallback(async (opened: StableTurnWriter, id: string, initial: SessionViewState, cap: string, settings: SessionStartSettings) => {
    reconnectUnsubscribeRef.current?.();
    reconnectUnsubscribeRef.current = undefined;
    transportFailureUnsubscribeRef.current?.();
    transportFailureUnsubscribeRef.current = undefined;
    captureGenerationRef.current++;
    captureRecoveryRef.current = undefined;
    const transport = new FakeSessionTransport();
    await transport.connect(cap);
    recordingStoreRef.current?.close();
    const recordingStore = await RecordingStore.open();
    recordingStoreRef.current = recordingStore;
    const recorder = new RecordingRecorder({ sessionId: id, store: recordingStore, encode: createEncoderClient() });
    await recorder.start();
    recordingRecorderRef.current = recorder;
    recordingSessionRef.current = id;
    await fetchRecordingSummaries(id);
    recordingUnsubscribeRef.current = transport.onEvent(event => recorder.onSessionEvent(event));
    let controller!: SessionController;
    controller = new SessionController({
      sessionId: id,
      transport,
      writer: opened,
      initialState: initial,
      playbackFactory: input => new InstrumentedPlayback(new BrowserPlayback(
        input.playbackId,
        input.outputEpoch,
        input.sampleRate,
        {
          progress: progress => controller.reportPlaybackProgress(progress),
          terminal: receipt => {
            recorder.onSessionEvent(createEnvelope({ sessionId: id, epoch: controller.snapshot().epoch, type: 'playback.stopped', payload: { ...receipt } }));
            statsRef.current.playbackStops.push(receipt.reason);
            return controller.reportPlaybackTerminal(receipt);
          },
          degraded: message => controller.degrade(message),
        },
        undefined,
        audio => recorder.onPlaybackAudio(audio),
      ), statsRef.current),
    });
    unsubscribeRef.current?.();
    unsubscribeRef.current = controller.subscribe(setView);
    controllerRef.current = controller;
    transportRef.current = transport;
    fakeTransportRef.current = transport;
    statsRef.current.captureStarts++;
    const capture = await new BrowserCapture({ onAudio: capture => recorder.onCaptureAudio(capture) }).start({
      send: frame => transport.sendCapture(frame),
      degraded: message => controller.degrade(message),
    });
    statsRef.current.captureRunning = true;
    captureRef.current = {
      stop: async () => {
        if (!statsRef.current.captureRunning) return;
        await capture.stop();
        statsRef.current.captureStops++;
        statsRef.current.captureRunning = false;
      },
    };
    setCapability(cap);
    setSessionId(id);
    stoppedRef.current = false;
  }, []);

  const composeRealSession = useCallback(async (opened: StableTurnWriter, id: string, initial: SessionViewState, cap: string, seed: string, reasoningMode: 'full' | 'transcript_only', settings: SessionStartSettings) => {
    reconnectUnsubscribeRef.current?.();
    reconnectUnsubscribeRef.current = undefined;
    transportFailureUnsubscribeRef.current?.();
    transportFailureUnsubscribeRef.current = undefined;
    captureGenerationRef.current++;
    captureRecoveryRef.current = undefined;
    recordingStoreRef.current?.close();
    const recordingStore = await RecordingStore.open();
    recordingStoreRef.current = recordingStore;
    const recorder = new RecordingRecorder({ sessionId: id, store: recordingStore, encode: createEncoderClient() });
    await recorder.start();
    recordingRecorderRef.current = recorder;
    recordingSessionRef.current = id;
    await fetchRecordingSummaries(id);
    let controller!: SessionController;
    const transport = new WebSocketSessionTransport(id, () => controller?.snapshot().epoch ?? 0);
    await transport.connect(cap);
    recordingUnsubscribeRef.current = transport.onEvent(event => recorder.onSessionEvent(event));
    controller = new SessionController({
      sessionId: id,
      transport,
      writer: opened,
      initialState: initial,
      playbackFactory: input => new BrowserPlayback(input.playbackId, input.outputEpoch, input.sampleRate, {
        progress: progress => controller.reportPlaybackProgress(progress),
        terminal: receipt => {
          recorder.onSessionEvent(createEnvelope({ sessionId: id, epoch: controller.snapshot().epoch, type: 'playback.stopped', payload: { ...receipt } }));
          return controller.reportPlaybackTerminal(receipt);
        },
        degraded: message => controller.degrade(message),
      }, undefined, audio => recorder.onPlaybackAudio(audio)),
    });
    unsubscribeRef.current?.();
    unsubscribeRef.current = controller.subscribe(setView);
    controllerRef.current = controller;
    transportRef.current = transport;
    transportFailureUnsubscribeRef.current = transport.onFailure(() => {
      captureGenerationRef.current++;
      const capture = captureRef.current;
      captureRef.current = undefined;
      captureStreamIdRef.current = undefined;
      void capture?.stop().catch(() => undefined);
    });
    reconnectUnsubscribeRef.current = transport.onReconnect(() => {
      if (captureRecoveryRef.current) return captureRecoveryRef.current;
      let recovery!: Promise<void>;
      recovery = (async () => {
        if (stoppedRef.current || sessionPausedRef.current || lifecycleActionRef.current !== 'idle') return;
        const generation = ++captureGenerationRef.current;
        const capture = captureRef.current;
        const oldStreamId = captureStreamIdRef.current;
        captureRef.current = undefined;
        captureStreamIdRef.current = undefined;
        await capture?.stop().catch(() => undefined);
        if (oldStreamId !== undefined) {
          try { await transport.stopAudio(oldStreamId); } catch { /* reconnect may have failed again */ }
        }
        if (stoppedRef.current || sessionPausedRef.current || lifecycleActionRef.current !== 'idle') return;
        const random = new Uint32Array(1);
        crypto.getRandomValues(random);
        const streamId = random[0] ?? 0;
        try {
          await transport.startAudio(streamId);
          captureStreamIdRef.current = streamId;
          const recovered = await new BrowserCapture({ streamId: () => streamId, onAudio: audio => recorder.onCaptureAudio(audio) }).start({
            send: frame => transport.sendCapture(frame),
            degraded: message => controller.degrade(message),
          });
          if (generation !== captureGenerationRef.current || stoppedRef.current || sessionPausedRef.current || lifecycleActionRef.current !== 'idle') {
            await recovered.stop();
            try { await transport.stopAudio(streamId); } catch { /* session teardown may have won the race */ }
            if (generation === captureGenerationRef.current) captureStreamIdRef.current = undefined;
            return;
          }
          captureRef.current = recovered;
          activityLog.append({ level: 'info', source: 'app', message: 'microphone capture recovered after transport reconnect' });
        } catch (error) {
          try { await transport.stopAudio(streamId); } catch { /* session teardown may have won the race */ }
          if (generation !== captureGenerationRef.current || stoppedRef.current) return;
          captureStreamIdRef.current = undefined;
          controller.degrade(error instanceof Error ? error.message : 'The microphone could not be recovered after reconnecting.');
        }
      })().finally(() => { if (captureRecoveryRef.current === recovery) captureRecoveryRef.current = undefined; });
      captureRecoveryRef.current = recovery;
      return recovery;
    });
    await transport.startSession({ sessionSeed: seed, reasoningMode, settings });
    const random = new Uint32Array(1); crypto.getRandomValues(random);
    const streamId = random[0] ?? 0;
    captureStreamIdRef.current = streamId;
    await transport.startAudio(streamId);
    try {
      captureRef.current = await new BrowserCapture({ streamId: () => streamId, onAudio: capture => recorder.onCaptureAudio(capture) }).start({
        send: frame => transport.sendCapture(frame),
        degraded: message => controller.degrade(message),
      });
    } catch (error) {
      try { await transport.stopAudio(streamId); } catch { /* teardown is best effort */ }
      captureStreamIdRef.current = undefined;
      await controller.pause();
      throw error;
    }
    setCapability(cap);
    setSessionId(id);
    stoppedRef.current = false;
  }, []);

  const fetchRecordingSummaries = useCallback(async (targetSession: string): Promise<void> => {
    const store = recordingStoreRef.current;
    if (!store) return;
    const gen = ++recordingGenRef.current;
    let enabled: boolean;
    let summaries: RecordingItemSummary[];
    try {
      [enabled, summaries] = await Promise.all([store.getRecordingEnabled(), store.getSessionItemSummaries(targetSession)]);
    } catch (error) {
      if (gen !== recordingGenRef.current || recordingSessionRef.current !== targetSession) return;
      setRecordingView(prev => ({ ...prev, error: error instanceof Error ? error.message : 'Recording state could not be read.' }));
      return;
    }
    if (gen !== recordingGenRef.current || recordingSessionRef.current !== targetSession) return;
    lastCheapRef.current = { enabled, signature: recordingSummarySignature(summaries) };
    setRecordingView(prev => ({ ...projectRecordingTrim(summaries, enabled), pendingTargetId: prev.pendingTargetId, notice: prev.notice, error: '' }));
  }, []);

  // Open the shared session store once. If the initial URL targets a session
  // that was still active, resume it right away (like the readiness flow, but
  // without a fresh session): the transcript is rebuilt from stable storage and
  // the host is reconnected under the same session identity.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const opened = await StableTurnWriter.open();
      if (cancelled) { opened.close(); return; }
      writerRef.current = opened;
      const target = sessionIdFromPath(locationRef.current.pathname);
      if (target) {
        // SettingsStore opens independently from the session store. Do not let
        // an active-session recovery race that load and silently reopen a Qwen
        // session with the Kokoro defaults.
        await settingsReadyPromiseRef.current!;
        if (cancelled) return;
        const stored = await opened.getSession(target);
        if (!cancelled && stored?.state === 'active') {
          setResuming(true);
          setWriter(opened);
          sessionPausedRef.current = false;
          try {
            const restored = await sessionViewStateFromTurns(opened, target, 'active');
            const current = currentStartSettings();
            const storedSettings = stored.settings && isValidSessionSettingsSnapshot(stored.settings) ? stored.settings : undefined;
            const settings = storedSettings ?? current.settings;
            const digest = storedSettings
              ? (stored.personaDigest || current.digest)
              : current.digest;
            const reopened = await opened.beginSession({ sessionId: target, sessionSeed: stored.sessionSeed, personaDigest: digest, settings });
            if (!reopened.ok) throw new Error(reopened.degradedReason);
            const reopenedSession = await opened.getSession(target);
            configureSessionClock(reopenedSession);
            if (fakeServices) await composeFakeSession(opened, target, restored, 'fake-recovered', settings);
            else await composeRealSession(opened, target, restored, await bootstrapCapability(), stored.sessionSeed, 'full', settings);
            if (!cancelled) navigate(`/session/${target}`);
          } catch (error) {
            try { await controllerRef.current?.pause(); } catch { /* best-effort rollback */ }
            try { await releaseRecorder(target); } catch { /* best-effort rollback */ }
            transportRef.current?.disconnect();
            controllerRef.current = undefined;
            transportRef.current = undefined;
            fakeTransportRef.current = undefined;
            await opened.pauseSession(target);
            configureSessionClock(await opened.getSession(target));
            activityLog.append({ level: 'error', source: 'app', message: 'active session could not be resumed; it is paused locally', ...(error instanceof Error ? { detail: error.message } : {}) });
          } finally {
            if (!cancelled) setResuming(false);
          }
          return;
        }
      }
      if (!cancelled) setWriter(opened);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setElapsed(0);
      return;
    }
    refreshElapsed();
    if (sessionClockRef.current.runningSinceMs === undefined) return;
    const timer = setInterval(refreshElapsed, 1000);
    return () => clearInterval(timer);
  }, [sessionId, sessionPaused, refreshElapsed]);

  useEffect(() => {
    if (!fakeServices || !view || !sessionId || !fakeTransportRef.current || !controllerRef.current) { delete window.__podcasterTest; return; }
    const transport = fakeTransportRef.current;
    const controller = controllerRef.current;
    window.__podcasterTest = {
      emit: (type, payload, epoch = controller.snapshot().epoch) => transport.emit(createEnvelope({ sessionId, epoch, type, payload })),
      partial: text => transport.emit(createEnvelope({ sessionId, epoch: controller.snapshot().epoch, type: 'transcript.partial', payload: { text } })),
      audio: async (playbackId, sampleOffset, samples) => {
        transport.emitAudio({ playbackId, sequence: 0, sampleOffset, pcm16: new Int16Array(samples) });
        await new Promise(resolve => setTimeout(resolve, 0));
      },
      capture: () => { (window as unknown as { __podcasterFakeWorkletNode?: { port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } } }).__podcasterFakeWorkletNode?.port.onmessage?.({ data: new Float32Array(961) } as MessageEvent<Float32Array>); },
      degrade: message => controller.degrade(message),
      stats: () => ({ ...statsRef.current, playbackStops: [...statsRef.current.playbackStops], captureFrames: transport.captureFrames.length, progressReports: transport.progressReports.length, terminalReceipts: transport.terminalReceipts.size, commands: [...transport.commands] }),
    };
    return () => { delete window.__podcasterTest; };
  }, [sessionId, view]);

  async function start(cap: string, reasoningMode: 'full' | 'transcript_only' = 'full', existingId?: string) {
    const opened = writerRef.current;
    if (!opened) throw new Error('Local session storage is not ready yet.');
    await settingsReadyPromiseRef.current!;
    const reconciled = reconcileSettings({ selectedModel: settingsModelRef.current.selectedModel, voice: settingsModelRef.current.voice, voiceProfiles: settingsModelRef.current.voiceProfiles }, ttsModelsRef.current, voiceCatalogRef.current);
    const activeSettings = applyReconciled(settingsModelRef.current, reconciled);
    settingsModelRef.current = activeSettings;
    setSettingsModel(activeSettings);
    const id = existingId ?? uuidV7();
    const existing = existingId ? await opened.getSession(id) : undefined;
    const preserveIdentity = Boolean(existing && existing.state !== 'stopped');
    const seed = preserveIdentity ? existing!.sessionSeed : uuidV7();
    const current: SettingsModel = {
      agentName: activeSettings.agentName,
      persona: activeSettings.persona,
      pi: { ...activeSettings.pi },
      selectedModel: { ...activeSettings.selectedModel },
      voice: { ...activeSettings.voice },
      voiceProfiles: { ...activeSettings.voiceProfiles },
    };
    const storedSettings = existing?.settings && isValidSessionSettingsSnapshot(existing.settings) ? existing.settings : undefined;
    const settings: SessionStartSettings = preserveIdentity && storedSettings
      ? storedSettings
      : { version: 1, persona: current.persona, voice: { ...current.voice }, pi: { ...current.pi } };
    const frozen: SettingsModel = preserveIdentity
      ? {
          ...current,
          persona: settings.persona,
          voice: { ...settings.voice },
          pi: { ...(settings.pi ?? current.pi) },
          selectedModel: {
            backendId: settings.voice.backendId ?? current.selectedModel.backendId,
            modelId: settings.voice.modelId ?? current.selectedModel.modelId,
          },
        }
      : current;
    settingsFrozenRef.current = frozen;
    const personaDigest = preserveIdentity && storedSettings
      ? (existing!.personaDigest || settingsDigest(frozen))
      : settingsDigest(frozen);
    const persisted = await opened.beginSession({ sessionId: id, sessionSeed: seed, personaDigest, settings });
    if (!persisted.ok) throw new Error(persisted.degradedReason);
    stoppedRef.current = false;
    sessionPausedRef.current = false;
    setSessionPaused(false);
    configureSessionClock(await opened.getSession(id));
    activityLog.append({ level: 'info', source: 'app', message: `session started (${cap})` });
    const initial: SessionViewState = existingId
      ? await sessionViewStateFromTurns(opened, id, 'active')
      : { ...initialSessionState, dominant: 'listening', announcement: 'Listening' };
    try {
      if (fakeServices) await composeFakeSession(opened, id, initial, cap, settings);
      else await composeRealSession(opened, id, initial, cap, seed, reasoningMode, settings);
    } catch (error) {
      // A failed composition must release the partially-created runtime before
      // returning to the durable paused state. This is also the stale-event
      // barrier for a failed resume.
      captureGenerationRef.current++;
      captureRecoveryRef.current = undefined;
      stoppedRef.current = true;
      const failedTransport = transportRef.current;
      reconnectUnsubscribeRef.current?.();
      reconnectUnsubscribeRef.current = undefined;
      transportFailureUnsubscribeRef.current?.();
      transportFailureUnsubscribeRef.current = undefined;
      try { await captureRef.current?.stop(); } catch { /* best effort */ }
      captureRef.current = undefined;
      const streamId = captureStreamIdRef.current;
      captureStreamIdRef.current = undefined;
      if (streamId !== undefined) try { await failedTransport?.stopAudio(streamId); } catch { /* best effort */ }
      try { await controllerRef.current?.pause(); } catch { /* best effort */ }
      await releaseRecorder(id);
      failedTransport?.disconnect();
      controllerRef.current = undefined;
      transportRef.current = undefined;
      fakeTransportRef.current = undefined;
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      await opened.pauseSession(id);
      if (cap !== 'fake-recovered') await fetch('/api/stop', { method: 'POST', credentials: 'same-origin', headers: { 'x-podcaster-capability': cap } }).catch(() => undefined);
      setCapability(undefined);
      sessionPausedRef.current = true;
      setSessionPaused(true);
      configureSessionClock(await opened.getSession(id));
      throw error;
    }
    navigate(`/session/${id}`);
  }

  const releaseRecorder = useCallback(async (targetSession?: string) => {
    recordingUnsubscribeRef.current?.();
    recordingUnsubscribeRef.current = undefined;
    const recorder = recordingRecorderRef.current;
    const store = recordingStoreRef.current;
    if (recorder) {
      try { await recorder.stop(true); }
      catch (error) { activityLog.append({ level: 'warn', source: 'app', message: 'recording cleanup failed', ...(error instanceof Error ? { detail: error.message } : {}) }); }
    }
    if (targetSession && store) await fetchRecordingSummaries(targetSession);
    recordingRecorderRef.current = undefined;
    recordingStoreRef.current?.close();
    recordingStoreRef.current = undefined;
  }, [fetchRecordingSummaries]);

  const stop = useCallback(async () => {
    if (lifecycleActionRef.current !== 'idle') return;
    const targetSession = recordingSessionRef.current ?? sessionId;
    if (!targetSession) return;
    lifecycleActionRef.current = 'ending';
    setLifecycleAction('ending');
    const controller = controllerRef.current;
    captureGenerationRef.current++;
    captureRecoveryRef.current = undefined;
    stoppedRef.current = true;
    sessionPausedRef.current = false;
    activityLog.append({ level: 'info', source: 'app', message: 'session ended by user' });
    reconnectUnsubscribeRef.current?.();
    reconnectUnsubscribeRef.current = undefined;
    transportFailureUnsubscribeRef.current?.();
    transportFailureUnsubscribeRef.current = undefined;
    setSessionPaused(false);
    try { await captureRef.current?.stop(); } catch { /* teardown is best effort */ }
    captureRef.current = undefined;
    const streamId = captureStreamIdRef.current;
    captureStreamIdRef.current = undefined;
    if (streamId !== undefined) {
      try { await transportRef.current?.stopAudio(streamId); } catch { /* the transport may already be gone */ }
    }
    let ended = true;
    try { await controller?.stop(); }
    catch (error) { ended = false; activityLog.append({ level: 'warn', source: 'app', message: 'live session cleanup failed', ...(error instanceof Error ? { detail: error.message } : {}) }); }
    await releaseRecorder(targetSession);
    const opened = writerRef.current;
    if (opened) {
      const persisted = await opened.endSession(targetSession);
      ended = ended && persisted.ok;
      if (!persisted.ok) activityLog.append({ level: 'error', source: 'app', message: 'session end could not be saved', ...(persisted.degradedReason ? { detail: persisted.degradedReason } : {}) });
    }
    if (ended && capability && capability !== 'fake-recovered') await fetch('/api/stop', { method: 'POST', credentials: 'same-origin', headers: { 'x-podcaster-capability': capability } }).catch(() => undefined);
    controllerRef.current = undefined;
    transportRef.current = undefined;
    fakeTransportRef.current = undefined;
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    if (ended) {
      configureSessionClock(await opened?.getSession(targetSession));
      setCapability(undefined);
      setSessionId(undefined);
      setView(undefined);
    } else {
      // Resources are gone, but the local row remains resumable so a failed
      // end write cannot silently discard the conversation.
      if (opened) await opened.pauseSession(targetSession);
      stoppedRef.current = true;
      sessionPausedRef.current = true;
      setSessionPaused(true);
      setView(previous => previous ? { ...previous, dominant: 'degraded', degradedMessage: 'The session ended locally, but its final state could not be saved. Resume it and try again.', announcement: 'Session needs attention' } : previous);
    }
    lifecycleActionRef.current = 'idle';
    setLifecycleAction('idle');
  }, [capability, configureSessionClock, fetchRecordingSummaries, releaseRecorder, sessionId]);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const continueSession = useCallback(async (targetId: string) => {
    if (lifecycleActionRef.current !== 'idle') return;
    const current = sessionId;
    if (current && current !== targetId && !stoppedRef.current) await stopRef.current();
    lifecycleActionRef.current = 'resuming';
    setLifecycleAction('resuming');
    try {
      const cap = fakeServices ? 'fake-recovered' : await bootstrapCapability();
      await start(cap, 'full', targetId);
    } catch (error) {
      activityLog.append({ level: 'error', source: 'app', message: 'session could not be resumed', ...(error instanceof Error ? { detail: error.message } : {}) });
      sessionPausedRef.current = true;
      setSessionPaused(true);
    } finally {
      lifecycleActionRef.current = 'idle';
      setLifecycleAction('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Leaving the stopped-live view (index or another session's page) releases
  // its state so the page renders the session read-only from storage again.
  // Opening a different session's page while another session is still running
  // ends the live session first so the read-only view can take over.
  useEffect(() => {
    if (!sessionId) return;
    if (location.pathname === '/') {
      if (stoppedRef.current) { setSessionId(undefined); setView(undefined); }
      return;
    }
    const target = sessionIdFromPath(location.pathname);
    if (target && target !== sessionId) {
      if (stoppedRef.current) { setSessionId(undefined); setView(undefined); }
      else void stopRef.current();
    }
  }, [location, sessionId]);

  const togglePause = useCallback(async () => {
    if (lifecycleActionRef.current !== 'idle') return;
    const targetSession = recordingSessionRef.current ?? sessionId;
    if (!targetSession) return;
    if (sessionPausedRef.current) {
      await continueSession(targetSession);
      return;
    }
    const controller = controllerRef.current;
    if (!controller || !recordingRecorderRef.current) return;
    lifecycleActionRef.current = 'pausing';
    setLifecycleAction('pausing');
    captureGenerationRef.current++;
    try {
      // The controller persists the pause barrier before disconnecting the
      // host. If that write fails, all live resources remain available.
      const paused = await controller.pause();
      if (!paused) return;
      stoppedRef.current = true;
      sessionPausedRef.current = true;
      setSessionPaused(true);
      reconnectUnsubscribeRef.current?.();
      reconnectUnsubscribeRef.current = undefined;
      transportFailureUnsubscribeRef.current?.();
      transportFailureUnsubscribeRef.current = undefined;
      try { await captureRef.current?.stop(); } catch { /* teardown is best effort */ }
      captureRef.current = undefined;
      const streamId = captureStreamIdRef.current;
      captureStreamIdRef.current = undefined;
      if (streamId !== undefined) {
        try { await transportRef.current?.stopAudio(streamId); } catch { /* controller already disconnected the transport */ }
      }
      await releaseRecorder(targetSession);
      if (capability && capability !== 'fake-recovered') {
        const released = await fetch('/api/stop', { method: 'POST', credentials: 'same-origin', headers: { 'x-podcaster-capability': capability } }).then(response => response.ok).catch(() => false);
        if (!released) activityLog.append({ level: 'warn', source: 'app', message: 'session paused locally; host cleanup is pending' });
      }
      setCapability(undefined);
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      // Keep the inert controller/fake transport references until the next
      // runtime is composed so test diagnostics can verify the released
      // resources. They have already unsubscribed and cannot process events.
      transportRef.current = undefined;
      configureSessionClock(await writerRef.current?.getSession(targetSession));
      setView(previous => pausedSessionView(previous ?? controller.snapshot()));
      activityLog.append({ level: 'info', source: 'app', message: 'session paused by user' });
    } catch (error) {
      activityLog.append({ level: 'error', source: 'app', message: 'session pause cleanup failed', ...(error instanceof Error ? { detail: error.message } : {}) });
      // The durable pause barrier succeeded, so expose the paused state even if
      // an individual browser resource refused to close.
      sessionPausedRef.current = true;
      setSessionPaused(true);
      stoppedRef.current = true;
      setView(previous => previous ? { ...pausedSessionView(previous), dominant: 'degraded', degradedMessage: 'The session was paused, but some live resources need attention. Resume to reconnect.', announcement: 'Session needs attention' } : previous);
    } finally {
      lifecycleActionRef.current = 'idle';
      setLifecycleAction('idle');
    }
  }, [capability, configureSessionClock, continueSession, releaseRecorder, sessionId]);

  const buildExport = useCallback(async (onProgress?: ExportOnProgress) => {
    const store = recordingStoreRef.current;
    const writer = writerRef.current;
    const current = recordingSessionRef.current;
    if (!store || !writer || !current) return null;
    const deps: Parameters<typeof buildRecording>[1] = {
      store,
      turns: writer,
      decode: createBrowserDecoder(),
      resample: offlineResample,
      encode: createEncoderClient(),
    };
    if (onProgress) deps.onProgress = onProgress;
    return buildRecording(current, deps);
  }, []);

  const pollRecording = useCallback(async (targetSession: string): Promise<void> => {
    const store = recordingStoreRef.current;
    if (!store) return;
    let enabled: boolean;
    let summaries: RecordingItemSummary[];
    try {
      [enabled, summaries] = await Promise.all([store.getRecordingEnabled(), store.getSessionItemSummaries(targetSession)]);
    } catch { return; }
    if (recordingSessionRef.current !== targetSession) return;
    const last = lastCheapRef.current;
    if (!last || last.enabled !== enabled || last.signature !== recordingSummarySignature(summaries)) {
      // The number of rows is not enough to detect a late transcript.final:
      // the recorder may persist a user clip first and attach its turnId just
      // afterward. Compare the metadata as well so the matching X appears
      // without waiting for another recording item to be created.
      await fetchRecordingSummaries(targetSession);
    } else {
      setRecordingView(prev => (prev.enabled === enabled && prev.hydrated) ? prev : { ...prev, enabled });
    }
  }, [fetchRecordingSummaries]);

  useEffect(() => {
    if (!sessionId) return;
    const targetSession = sessionId;
    let cancelled = false;
    void fetchRecordingSummaries(targetSession);
    const timer = setInterval(() => { if (!cancelled) void pollRecording(targetSession); }, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sessionId, fetchRecordingSummaries, pollRecording]);

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
  }, [capability]);
  const reconcileCurrentSettings = useCallback((models: TtsModelDescriptor[], fallbackCatalog = voiceCatalogRef.current) => {
    const merged = mergeCustomModels(models);
    const fallback = withCustomVoices(fallbackCatalog, customVoicesRef.current);
    setSettingsModel(previous => applyReconciled(previous, reconcileSettings({ selectedModel: previous.selectedModel, voice: previous.voice, voiceProfiles: previous.voiceProfiles }, merged, fallback)));
  }, [mergeCustomModels]);

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
  }, [reconcileCurrentSettings, syncStoredCustomVoices]);

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

  const ensureCustomVoiceEnrolled = useCallback(async (voiceId: string) => {
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
  }, [capability]);

  const previewVoice = useCallback(async (voiceId: string, speedModifier: number, selectedModel: TtsModelSelection = DEFAULT_TTS_MODEL, catalogId?: string, tonePrompt?: string, language?: QwenVoiceLanguage, signal?: AbortSignal) => {
    if (!capability) throw new Error('The session capability is not ready yet.');
    await ensureCustomVoiceEnrolled(voiceId);
    return startVoicePreview({ voiceId, speedModifier, backendId: selectedModel.backendId, modelId: selectedModel.modelId, ...(catalogId ? { catalogId } : {}), ...(tonePrompt ? { tonePrompt } : {}), ...(language ? { language } : {}), ...(signal ? { signal } : {}), capability });
  }, [capability, ensureCustomVoiceEnrolled]);

  const enrollVoice = useCallback(async (name: string, take: ReferenceTake) => {
    const store = customVoiceStoreRef.current ?? await CustomVoiceStore.open();
    customVoiceStoreRef.current = store;
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
    if (!fakeServices && capability) await enrollCustomVoiceApi({ capability, voiceId: record.voiceId, name, take });
  }, [capability]);

  const deleteVoice = useCallback(async (voiceId: string) => {
    if (!fakeServices && capability) await deleteCustomVoiceApi(capability, voiceId);
    const store = customVoiceStoreRef.current;
    if (store) {
      await store.delete(voiceId);
      setCustomVoices(await store.list());
    }
  }, [capability]);

  const renameVoice = useCallback(async (voiceId: string, name: string) => {
    const store = customVoiceStoreRef.current;
    if (!store || !(await store.rename(voiceId, name))) throw new Error('The custom voice name could not be saved.');
    setCustomVoices(await store.list());
  }, []);

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
      const store = settingsStoreRef.current ?? await SettingsStore.open();
      settingsStoreRef.current = store;
      const activeVoice = { ...voice, backendId: selectedModel.backendId, modelId: selectedModel.modelId };
      const profiles = { ...voiceProfiles, [ttsModelKey(selectedModel)]: activeVoice };
      const ok = await store.save({ version: 1, agentName, persona, pi, selectedModel, voice: activeVoice, voiceProfiles: profiles });
      if (!ok) throw new Error('Settings could not be saved on this device.');
      const next = applyReconciled({ agentName, persona, pi, selectedModel, voiceProfiles: profiles }, { voice: activeVoice, selectedModel, voiceProfiles: profiles });
      settingsModelRef.current = next;
      setSettingsModel(next);
      setSettingsOpen(false);
    } catch (error) {
      setSettingsSaveError(error instanceof Error ? error.message : 'Settings could not be saved.');
    } finally {
      setSettingsSaving(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const store = await SettingsStore.open();
        settingsStoreRef.current = store;
        const stored = await store.load();
        if (cancelled) return;
        const customStore = customVoiceStoreRef.current ?? await CustomVoiceStore.open();
        customVoiceStoreRef.current = customStore;
        const storedCustomVoices = await customStore.list();
        customVoicesRef.current = storedCustomVoices;
        setCustomVoices(storedCustomVoices);
        const pi = stored?.pi ?? DEFAULT_PI_SETTINGS;
        const selectedModel = stored?.selectedModel ?? {
          backendId: stored?.voice.backendId ?? DEFAULT_TTS_MODEL.backendId,
          modelId: stored?.voice.modelId ?? DEFAULT_TTS_MODEL.modelId,
        };
        const availableModels = mergeCustomModels(ttsModelsRef.current);
        const fallbackCatalog = withCustomVoices(voiceCatalogRef.current, storedCustomVoices);
        const reconciled = reconcileSettings({ selectedModel, ...(stored?.voice ? { voice: stored.voice } : {}), ...(stored?.voiceProfiles ? { voiceProfiles: stored.voiceProfiles } : {}) }, availableModels, fallbackCatalog);
        const next = applyReconciled({ agentName: stored?.agentName ?? DEFAULT_AGENT_NAME, persona: stored?.persona ?? DEFAULT_AGENT_PERSONA, pi, selectedModel, ...(stored?.voiceProfiles ? { voiceProfiles: stored.voiceProfiles } : {}) }, reconciled);
        settingsModelRef.current = next;
        setSettingsModel(next);
      } catch {
        // Keep the in-memory defaults when local settings storage is unavailable.
      } finally {
        resolveSettingsReadyRef.current?.();
        resolveSettingsReadyRef.current = undefined;
      }
    })();
    return () => { cancelled = true; };
  }, [mergeCustomModels]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const store = customVoiceStoreRef.current ?? await CustomVoiceStore.open();
        if (cancelled) { store.close(); return; }
        customVoiceStoreRef.current = store;
        setCustomVoices(await store.list());
      } catch {
        // Keep the settings UI usable if IndexedDB is unavailable.
      }
    })();
    return () => {
      cancelled = true;
      customVoiceStoreRef.current?.close();
      customVoiceStoreRef.current = undefined;
    };
  }, []);

  const deleteRecording = useCallback(async () => {
    const store = recordingStoreRef.current;
    const current = recordingSessionRef.current;
    if (!store || !current) return;
    await deleteSessionRecording(current, store);
    await fetchRecordingSummaries(current);
  }, [fetchRecordingSummaries]);

  const toggleBubbleTrim = useCallback(async (targetId: RecordingTrimTargetId, trimmed: boolean): Promise<boolean> => {
    const store = recordingStoreRef.current;
    const current = recordingSessionRef.current;
    if (!store || !current) return false;
    const target = recordingViewRef.current.targets.get(targetId) ?? recordingViewRef.current.partTargets.get(targetId);
    if (!target) return false;
    setRecordingView(prev => ({ ...prev, pendingTargetId: targetId, error: '' }));
    try {
      await store.setItemsTrimmed(current, target.itemIds, trimmed);
    } catch (error) {
      setRecordingView(prev => ({ ...prev, pendingTargetId: null, error: error instanceof Error ? error.message : 'The message could not be updated. Try again.' }));
      return false;
    }
    setRecordingView(prev => ({ ...prev, pendingTargetId: null }));
    await fetchRecordingSummaries(current);
    return true;
  }, [fetchRecordingSummaries]);

  const settingsDialog = settingsOpen ? <Suspense fallback={null}>
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} model={settingsModel} catalog={voiceCatalogRef.current} models={ttsModels} saving={settingsSaving} saveError={settingsSaveError} onSave={saveSettings} onPreviewVoice={previewVoice} customVoices={customVoices} onEnrollCustomVoice={enrollVoice} onDeleteCustomVoice={deleteVoice} onRenameCustomVoice={renameVoice} />
  </Suspense> : null;
  const appHeader = <AppHeader darkMode={darkMode} onToggleDarkMode={toggleDarkMode} onOpenSettings={() => setSettingsOpen(true)} serviceStatuses={serviceStatuses} piSettings={settingsModel.pi} onRefreshServiceStatus={() => void refreshServiceStatus()} refreshingServiceStatus={refreshingServiceStatus} />;

  if (!writer) return <main className="mx-auto my-8 flex w-[min(56rem,calc(100%_-_2rem))] items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading…</main>;

  return <>
    {appHeader}
    <Routes>
      <Route path="/" element={
        <Suspense fallback={<RouteLoading />}>
          <SessionIndex
            writer={writer}
            sessionAvailable={fakeServices}
            selectedModel={settingsModel.selectedModel}
            liveSessionId={sessionId}
            liveSessionPaused={sessionPaused}
            elapsedSeconds={elapsed}
            onStart={start}
            onCatalog={onCatalog}
            onModels={onModels}
            onCapability={setCapability}
            onSnapshot={applyReadinessSnapshot}
            onContinueSession={id => void continueSession(id)}
          />
        </Suspense>
      } />
      <Route path="/session/:sessionId" element={
        <SessionRoute
          writer={writer}
          liveSessionId={sessionId}
          resuming={resuming}
          view={view}
          agentName={settingsModel.agentName}
          elapsed={elapsed}
          sessionPaused={sessionPaused}
          lifecycleAction={lifecycleAction}
          recordingView={recordingView}
          settingsOpen={settingsOpen}
          onTogglePause={() => void togglePause()}
          onStop={() => void stop()}
          onCancelAssistant={() => void controllerRef.current?.cancelAssistant()}
          onToggleBubbleTrim={toggleBubbleTrim}
          onDeleteRecording={deleteRecording}
          buildExport={buildExport}
          onContinueSession={(id: string) => void continueSession(id)}
          onBack={() => navigate('/')}
        />
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    {settingsDialog}
  </>;
}

function recordingSummarySignature(summaries: readonly RecordingItemSummary[]): string {
  return JSON.stringify([...summaries]
    .map(summary => [summary.itemId, summary.role, summary.turnId, summary.responseId, summary.partIndex, summary.trimmed])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

function sessionIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/session\/([^/]+)/);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

function pausedSessionView(state: SessionViewState): SessionViewState {
  return {
    ...state,
    dominant: 'paused',
    announcement: 'Session paused',
    playbackNotice: 'Any assistant response in progress was stopped and will not resume automatically.',
    conversationItems: state.conversationItems.map(item => item.kind === 'assistant' && item.playback !== 'completed' && item.playback !== 'interrupted' ? { ...item, playback: 'interrupted' as const } : item),
  };
}

interface SessionRouteProps {
  writer: StableTurnWriter;
  liveSessionId: string | undefined;
  resuming: boolean;
  view: SessionViewState | undefined;
  agentName: string;
  elapsed: number;
  sessionPaused: boolean;
  lifecycleAction: LifecycleAction;
  recordingView: RecordingSessionViewState;
  settingsOpen: boolean;
  onTogglePause: () => void;
  onStop: () => void;
  onCancelAssistant: () => void;
  onToggleBubbleTrim: (targetId: RecordingTrimTargetId, trimmed: boolean) => Promise<boolean>;
  onDeleteRecording: () => Promise<void>;
  buildExport: (onProgress?: ExportOnProgress) => Promise<Blob | null>;
  onContinueSession: (sessionId: string) => void;
  onBack: () => void;
}

function SessionRoute(props: SessionRouteProps) {
  const params = useParams();
  const routeSessionId = params.sessionId;
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deleteRecording = useCallback(async () => {
    setDeleting(true);
    try {
      await props.onDeleteRecording();
    } finally {
      setDeleting(false);
    }
  }, [props.onDeleteRecording]);

  if (props.liveSessionId && props.liveSessionId === routeSessionId) {
    return <Suspense fallback={<RouteLoading label="Loading session…" />}>
      <SessionScreen
        state={props.view ?? initialSessionState}
        sessionId={props.liveSessionId}
        agentName={props.agentName}
        elapsedSeconds={props.elapsed}
        sessionPaused={props.sessionPaused}
        lifecycleAction={props.lifecycleAction}
        onTogglePause={props.onTogglePause}
        onStop={props.onStop}
        onCancelAssistant={props.onCancelAssistant}
        settingsOpen={props.settingsOpen}
        recording={props.recordingView}
        onToggleBubbleTrim={props.onToggleBubbleTrim}
        buildExport={props.buildExport}
        onExportingChange={setExporting}
        onDeleteRecording={deleteRecording}
        exporting={exporting}
        deleting={deleting}
      />
    </Suspense>;
  }
  if (props.resuming) return <main className="mx-auto mt-5 mb-8 flex w-[min(56rem,calc(100%_-_2rem))] items-center gap-2 text-sm text-muted-foreground"><Spinner />Resuming session…</main>;
  if (!routeSessionId) return null;
  return <Suspense fallback={<RouteLoading label="Loading session…" />}>
    <StoppedSession
      writer={props.writer}
      sessionId={routeSessionId}
      agentName={props.agentName}
      onContinue={() => props.onContinueSession(routeSessionId)}
      onBack={props.onBack}
    />
  </Suspense>;
}

function RouteLoading({ label = 'Loading…' }: { label?: string }) {
  return <main className="mx-auto my-8 flex w-[min(56rem,calc(100%_-_2rem))] items-center gap-2 text-sm text-muted-foreground"><Spinner />{label}</main>;
}

