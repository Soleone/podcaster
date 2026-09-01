import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { activityLog } from './session/activity-log';
import { createLiveSessionRuntime, type LiveRuntimeTestApi, type LiveSessionRuntime } from './session/live-runtime';
import { uuidV7 } from './session/envelope';
import { sessionViewStateFromTurns } from './sessions/session-archive';
import { initialSessionState, type SessionViewState } from './session/state';
import type { ReferenceTake } from './voice-enrollment/recorder';
import { sessionActiveDurationMs, StableTurnWriter } from './storage/stable-turn-writer';
import type { StoredSession } from './storage/schema';
import {
  emptyRecordingSessionView,
  projectRecordingTrim,
  type RecordingSessionViewState,
  type RecordingTrimTargetId,
} from './recording/trim-state';
import {
  isValidSessionSettingsSnapshot,
  type SessionPlanningRequest,
  type SessionPlanningSnapshot,
  type SessionSettingsSnapshot,
} from '@app/contracts/settings';
import type { ExportOnProgress } from './recording/splice';
import type { RecordingItemSummary } from './storage/recording-store';
import { useAppStorage } from './hooks/useAppStorage';
import { useSettings } from './hooks/useSettings';
import {
  applyReconciled,
  defaultSettingsModel,
  reconcileSettings,
  settingsDigest,
  type SettingsModel,
} from './settings/settings-model';
import { AppHeader } from './components/AppHeader';
import { PrivacyDialog } from './components/PrivacyDialog';
import { bootstrapCapability } from './sessions/session-archive';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { Spinner } from './components/ui/spinner';
import { persistTheme, readTheme } from './theme';
import type { ReadinessSnapshot, ServiceStatuses } from './services/service-status';
import { useServiceStatuses } from './hooks/useServiceStatuses';

const fakeServices = import.meta.env.MODE === 'fake-services';

const SessionIndex = lazy(() =>
  import('./sessions/SessionIndex').then(({ SessionIndex: component }) => ({ default: component })),
);
const SessionScreen = lazy(() =>
  import('./session/SessionScreen').then(({ SessionScreen: component }) => ({ default: component })),
);
const DraftSession = lazy(() =>
  import('./sessions/DraftSession').then(({ DraftSession: component }) => ({ default: component })),
);
const StoppedSession = lazy(() =>
  import('./sessions/StoppedSession').then(({ StoppedSession: component }) => ({ default: component })),
);
const SettingsDialog = lazy(() =>
  import('./settings/SettingsDialog').then(({ SettingsDialog: component }) => ({ default: component })),
);
type SessionStartSettings = SessionSettingsSnapshot;
type LifecycleAction = 'idle' | 'pausing' | 'resuming' | 'ending';

function planningSnapshotForStart(planning: SessionPlanningRequest | undefined): SessionPlanningSnapshot {
  if (!planning) return { status: 'skipped', attempt: 0 };
  const snapshot: SessionPlanningSnapshot = {
    status: planning.reuse ? 'ready' : 'planning',
    attempt: 1,
    topic: planning.topic,
    depth: planning.depth,
  };
  if (planning.notes) snapshot.notes = planning.notes;
  return snapshot;
}
function planningForResume(planning: SessionPlanningSnapshot | undefined): SessionPlanningRequest | undefined {
  if (!planning || planning.status !== 'ready' || !planning.topic || !planning.depth) return undefined;
  const request: SessionPlanningRequest = { topic: planning.topic, depth: planning.depth, reuse: true };
  if (planning.notes) request.notes = planning.notes;
  return request;
}
function planningViewForStart(planning: SessionPlanningRequest | undefined): SessionViewState['planning'] {
  if (!planning) return { status: 'skipped', attempt: 0 };
  const view: NonNullable<SessionViewState['planning']> = {
    status: planning.reuse ? 'ready' : 'planning',
    attempt: 1,
    topic: planning.topic,
    depth: planning.depth,
  };
  if (planning.notes) view.notes = planning.notes;
  return view;
}

function appendActivityIssue(level: 'error' | 'warn', message: string, detail?: string): void {
  const entry: Parameters<typeof activityLog.append>[0] = { level, source: 'app', message };
  if (detail) entry.detail = detail;
  activityLog.append(entry);
}

declare global {
  interface Window {
    __podcasterTest?: LiveRuntimeTestApi;
  }
}

export function App() {
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const navigate = useNavigate();
  const [view, setView] = useState<SessionViewState>();
  const [sessionId, setSessionId] = useState<string>();
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
  const runtimeRef = useRef<LiveSessionRuntime | undefined>(undefined);
  const sessionClockRef = useRef<{ activeDurationMs: number; runningSinceMs: number | undefined }>({
    activeDurationMs: 0,
    runningSinceMs: undefined,
  });
  const [recordingView, setRecordingView] = useState<RecordingSessionViewState>(emptyRecordingSessionView);
  const recordingViewRef = useRef(recordingView);
  recordingViewRef.current = recordingView;
  const recordingSessionRef = useRef<string | undefined>(undefined);
  recordingSessionRef.current = sessionId;
  const recordingGenRef = useRef(0);
  const lastCheapRef = useRef<{ enabled: boolean; signature: string } | null>(null);
  const settingsModelRef = useRef<SettingsModel>(defaultSettingsModel(undefined));
  const appStorage = useAppStorage();
  const { customVoices } = appStorage;
  const services = useServiceStatuses({ settingsModelRef });
  const {
    capability,
    setCapability,
    capabilityRef,
    serviceStatuses,
    applyAudioEngine,
    latestReadinessSnapshot,
    refreshServiceStatus,
    refreshingServiceStatus,
    servicesConnecting,
    connectServices,
    privacyAcknowledged,
    privacyDialogOpen,
    setPrivacyDialogOpen,
    openServicesConnection,
    microphoneGranted,
    enableMicrophone,
  } = services;
  const settings = useSettings({
    storage: appStorage,
    settingsModelRef,
    capabilityRef,
    readinessSnapshot: latestReadinessSnapshot,
  });
  const {
    settingsModel,
    setSettingsModel,
    settingsReady,
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
  } = settings;
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [darkMode, setDarkMode] = useState(() => readTheme() === 'dark');
  const toggleDarkMode = useCallback(() => setDarkMode((value) => !value), []);

  const refreshElapsed = useCallback(() => {
    const clock = sessionClockRef.current;
    const running = clock.runningSinceMs === undefined ? 0 : Math.max(0, Date.now() - clock.runningSinceMs);
    setElapsed(Math.floor((clock.activeDurationMs + running) / 1000));
  }, []);

  const configureSessionClock = useCallback(
    (session: StoredSession | undefined) => {
      if (!session) {
        sessionClockRef.current = { activeDurationMs: 0, runningSinceMs: undefined };
        setElapsed(0);
        return;
      }
      const now = Date.now();
      const runningSince =
        session.state === 'active'
          ? Date.parse(session.runningSince ?? '') || Date.parse(session.startedAt) || now
          : undefined;
      const currentRun = runningSince === undefined ? 0 : Math.max(0, now - runningSince);
      sessionClockRef.current = {
        activeDurationMs: Math.max(0, sessionActiveDurationMs(session, now) - currentRun),
        runningSinceMs: session.state === 'active' ? now : undefined,
      };
      refreshElapsed();
    },
    [refreshElapsed],
  );

  useEffect(() => {
    persistTheme(darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const fetchRecordingSummaries = useCallback(async (targetSession: string): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.sessionId !== targetSession) return;
    const gen = ++recordingGenRef.current;
    let enabled: boolean;
    let summaries: Awaited<ReturnType<LiveSessionRuntime['recordingSummaries']>>['summaries'];
    try {
      ({ enabled, summaries } = await runtime.recordingSummaries());
    } catch (error) {
      if (gen !== recordingGenRef.current || recordingSessionRef.current !== targetSession) return;
      setRecordingView((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Recording state could not be read.',
      }));
      return;
    }
    if (gen !== recordingGenRef.current || recordingSessionRef.current !== targetSession) return;
    lastCheapRef.current = { enabled, signature: recordingSummarySignature(summaries) };
    setRecordingView((prev) => ({
      ...projectRecordingTrim(summaries, enabled),
      pendingTargetId: prev.pendingTargetId,
      notice: prev.notice,
      error: '',
    }));
  }, []);

  const composeSession = useCallback(
    async (
      opened: StableTurnWriter,
      id: string,
      initial: SessionViewState,
      cap: string,
      seed: string,
      reasoningMode: 'full' | 'transcript_only',
      settings: SessionStartSettings,
      planning: SessionPlanningRequest | undefined,
      activate: () => Promise<void>,
    ): Promise<void> => {
      const runtimeOptions: Parameters<typeof createLiveSessionRuntime>[0] = {
        sessionId: id,
        capability: cap,
        writer: opened,
        initialState: initial,
        seed,
        reasoningMode,
        settings,
        activate,
        fake: fakeServices,
        callbacks: {
          onView: (next) => {
            setView(next);
            applyAudioEngine(next.audioEngine);
          },
          onTransportFailure: () => undefined,
          onRecordingChanged: () => {
            void fetchRecordingSummaries(id);
          },
        },
      };
      if (planning) runtimeOptions.planning = planning;
      const runtime = await createLiveSessionRuntime(runtimeOptions);
      runtimeRef.current = runtime;
      capabilityRef.current = cap;
      setCapability(cap);
      setSessionId(id);
      stoppedRef.current = false;
      await fetchRecordingSummaries(id);
    },
    [fetchRecordingSummaries],
  );

  // Open the shared session store once. If the initial URL targets a session
  // that was still active, resume it right away (like the readiness flow, but
  // without a fresh session): the transcript is rebuilt from stable storage and
  // the host is reconnected under the same session identity.
  useEffect(() => {
    let cancelled = false;
    let opened: StableTurnWriter | undefined;
    let closed = false;
    const closeOpened = (): void => {
      if (closed || !opened) return;
      closed = true;
      opened.close();
    };
    void (async () => {
      const candidate = await StableTurnWriter.open();
      opened = candidate;
      if (cancelled) {
        closeOpened();
        return;
      }
      writerRef.current = candidate;
      const target = sessionIdFromPath(locationRef.current.pathname);
      if (target) {
        // SettingsStore and CustomVoiceStore share one bootstrap effect. Do
        // not let active-session recovery race that load and silently reopen a
        // Qwen session with the Kokoro defaults.
        await settingsReady;
        if (cancelled) {
          closeOpened();
          return;
        }
        const stored = await candidate.getSession(target);
        if (!cancelled && stored?.state === 'active') {
          setResuming(true);
          setWriter(candidate);
          sessionPausedRef.current = false;
          try {
            const restored = await sessionViewStateFromTurns(candidate, target, 'active');
            const current = currentStartSettings();
            const storedSettings =
              stored.settings && isValidSessionSettingsSnapshot(stored.settings) ? stored.settings : undefined;
            const settings = storedSettings ?? current.settings;
            const digest = storedSettings ? stored.personaDigest || current.digest : current.digest;
            const activate = async (): Promise<void> => {
              const reopened = await candidate.beginSession({
                sessionId: target,
                sessionSeed: stored.sessionSeed,
                personaDigest: digest,
                settings,
              });
              if (!reopened.ok) throw new Error(reopened.degradedReason);
              configureSessionClock(await candidate.getSession(target));
            };
            await composeSession(
              candidate,
              target,
              restored,
              fakeServices ? 'fake-recovered' : await bootstrapCapability(),
              stored.sessionSeed,
              'full',
              settings,
              planningForResume(stored.planning),
              activate,
            );
            if (!cancelled) navigate(`/session/${target}`);
          } catch (error) {
            try {
              await runtimeRef.current?.dispose();
            } catch {
              /* best-effort rollback */
            }
            runtimeRef.current = undefined;
            await candidate.pauseSession(target);
            configureSessionClock(await candidate.getSession(target));
            appendActivityIssue(
              'error',
              'active session could not be resumed; it is paused locally',
              error instanceof Error ? error.message : undefined,
            );
          } finally {
            if (!cancelled) setResuming(false);
          }
          return;
        }
      }
      if (!cancelled) setWriter(candidate);
    })();
    return () => {
      cancelled = true;
      if (writerRef.current === opened) writerRef.current = undefined;
      closeOpened();
    };
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
    if (!fakeServices || !view || !sessionId) {
      delete window.__podcasterTest;
      return;
    }
    const api = runtimeRef.current?.testApi();
    if (!api) {
      delete window.__podcasterTest;
      return;
    }
    window.__podcasterTest = api;
    return () => {
      delete window.__podcasterTest;
    };
  }, [sessionId, view]);

  async function start(
    cap: string,
    reasoningMode: 'full' | 'transcript_only' = 'full',
    existingId?: string,
    requestedPlanning?: SessionPlanningRequest,
  ) {
    const opened = writerRef.current;
    if (!opened) throw new Error('Local session storage is not ready yet.');
    await settingsReady;
    const reconciled = reconcileSettings(
      {
        selectedModel: settingsModelRef.current.selectedModel,
        voice: settingsModelRef.current.voice,
        voiceProfiles: settingsModelRef.current.voiceProfiles,
      },
      ttsModelsRef.current,
      voiceCatalogRef.current,
    );
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
    const storedSettings =
      existing?.settings && isValidSessionSettingsSnapshot(existing.settings) ? existing.settings : undefined;
    const planning =
      existing?.state === 'draft'
        ? requestedPlanning
        : preserveIdentity
          ? planningForResume(existing?.planning)
          : requestedPlanning;
    const settings: SessionStartSettings =
      preserveIdentity && storedSettings
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
    const personaDigest =
      preserveIdentity && storedSettings ? existing!.personaDigest || settingsDigest(frozen) : settingsDigest(frozen);
    stoppedRef.current = false;
    sessionPausedRef.current = false;
    setSessionPaused(false);
    activityLog.append({ level: 'info', source: 'app', message: `session started (${cap})` });
    try {
      // Rehydrating the transcript is part of the resume transaction. If it
      // fails after beginSession has reactivated the row, the rollback below
      // must return it to paused rather than leaving an orphaned active row.
      const initial: SessionViewState = existingId
        ? await sessionViewStateFromTurns(opened, id, 'active')
        : {
            ...initialSessionState,
            dominant: planning ? 'planning' : 'ready',
            planning: planningViewForStart(planning),
            announcement: planning ? 'Preparing your session' : 'Ready to go live',
          };
      const activate = async (): Promise<void> => {
        const persisted = await opened.beginSession({
          sessionId: id,
          sessionSeed: seed,
          personaDigest,
          settings,
          planning: planningSnapshotForStart(planning),
        });
        if (!persisted.ok) throw new Error(persisted.degradedReason);
        configureSessionClock(await opened.getSession(id));
      };
      await composeSession(opened, id, initial, cap, seed, reasoningMode, settings, planning, activate);
      // A no-preparation start is one explicit click: open and begin in the same
      // gesture. Preparation leaves the session pre-live with an explicit Begin
      // live action on the session screen.
      if (!planning) await runtimeRef.current?.beginLive();
    } catch (error) {
      // A failed composition must release the partially-created runtime before
      // returning to the durable paused state.
      stoppedRef.current = true;
      try {
        await runtimeRef.current?.dispose();
      } catch {
        /* best effort */
      }
      runtimeRef.current = undefined;
      const afterFailure = await opened.getSession(id);
      const rolledBack = afterFailure?.state === 'active' ? await opened.pauseSession(id) : { ok: true };
      if (!rolledBack.ok) {
        appendActivityIssue(
          'error',
          'session start failed and could not checkpoint the session',
          rolledBack.degradedReason ? rolledBack.degradedReason : undefined,
        );
        setView((previous) =>
          previous
            ? {
                ...previous,
                dominant: 'degraded',
                degradedMessage:
                  'The session could not be safely returned to its previous state. Retry or return to your sessions.',
                announcement: 'Session needs attention',
              }
            : previous,
        );
      }
      if (cap !== 'fake-recovered' && cap !== 'fake')
        await fetch('/api/stop', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'x-podcaster-capability': cap },
        }).catch(() => undefined);
      capabilityRef.current = undefined;
      setCapability(undefined);
      const rolledBackSession = await opened.getSession(id);
      const pausedAfterFailure = rolledBackSession?.state === 'paused';
      sessionPausedRef.current = pausedAfterFailure;
      setSessionPaused(pausedAfterFailure);
      try {
        configureSessionClock(rolledBackSession);
      } catch {
        /* retain the last known timer if storage is still unavailable */
      }
      throw error;
    }
    const sessionPath = `/session/${id}`;
    navigate(sessionPath, { replace: locationRef.current.pathname === sessionPath });
  }

  const createDraft = useCallback(async () => {
    if (creatingDraft) return;
    const opened = writerRef.current;
    if (!opened) throw new Error('Local session storage is not ready yet.');
    setCreatingDraft(true);
    try {
      const id = uuidV7();
      const created = await opened.createDraftSession({ sessionId: id, sessionSeed: uuidV7() });
      if (!created.ok) throw new Error(created.degradedReason ?? 'The new session could not be saved.');
      navigate(`/session/${id}`);
    } finally {
      setCreatingDraft(false);
    }
  }, [creatingDraft, navigate]);

  const stop = useCallback(async () => {
    if (lifecycleActionRef.current !== 'idle') return;
    const targetSession = recordingSessionRef.current ?? sessionId;
    if (!targetSession) return;
    lifecycleActionRef.current = 'ending';
    setLifecycleAction('ending');
    stoppedRef.current = true;
    sessionPausedRef.current = false;
    setSessionPaused(false);
    activityLog.append({ level: 'info', source: 'app', message: 'session stopped for navigation' });
    let ended = true;
    try {
      await runtimeRef.current?.stop();
    } catch (error) {
      ended = false;
      appendActivityIssue('warn', 'live session cleanup failed', error instanceof Error ? error.message : undefined);
    }
    const opened = writerRef.current;
    if (opened) {
      const persisted = await opened.endSession(targetSession);
      ended = ended && persisted.ok;
      if (!persisted.ok)
        appendActivityIssue(
          'error',
          'session end could not be saved',
          persisted.degradedReason ? persisted.degradedReason : undefined,
        );
    }
    if (ended && capability && capability !== 'fake-recovered' && capability !== 'fake')
      await fetch('/api/stop', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-podcaster-capability': capability },
      }).catch(() => undefined);
    runtimeRef.current = undefined;
    if (ended) {
      configureSessionClock(await opened?.getSession(targetSession));
      capabilityRef.current = undefined;
      setCapability(undefined);
      setSessionId(undefined);
      setView(undefined);
    } else {
      if (opened) await opened.pauseSession(targetSession);
      stoppedRef.current = true;
      sessionPausedRef.current = true;
      setSessionPaused(true);
      setView((previous) =>
        previous
          ? {
              ...previous,
              dominant: 'degraded',
              degradedMessage:
                'The session stopped locally, but its final state could not be saved. Resume it and try again.',
              announcement: 'Session needs attention',
            }
          : previous,
      );
    }
    lifecycleActionRef.current = 'idle';
    setLifecycleAction('idle');
  }, [capability, configureSessionClock, sessionId]);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const continueSession = useCallback(
    async (targetId: string) => {
      if (lifecycleActionRef.current !== 'idle') return;
      const current = sessionId;
      if (current && current !== targetId && !stoppedRef.current) await stopRef.current();
      lifecycleActionRef.current = 'resuming';
      setLifecycleAction('resuming');
      try {
        const cap = fakeServices ? 'fake-recovered' : await bootstrapCapability();
        await start(cap, 'full', targetId);
      } catch (error) {
        appendActivityIssue(
          'error',
          'session could not be resumed',
          error instanceof Error ? error.message : undefined,
        );
        sessionPausedRef.current = true;
        setSessionPaused(true);
      } finally {
        lifecycleActionRef.current = 'idle';
        setLifecycleAction('idle');
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [sessionId],
  );

  // Leaving the stopped-live view (index or another session's page) releases
  // its state so the page renders the session read-only from storage again.
  // Opening a different session's page while another session is still running
  // ends the live session first so the read-only view can take over.
  useEffect(() => {
    if (!sessionId) return;
    if (location.pathname === '/') {
      if (stoppedRef.current) {
        setSessionId(undefined);
        setView(undefined);
      }
      return;
    }
    const target = sessionIdFromPath(location.pathname);
    if (target && target !== sessionId) {
      if (stoppedRef.current) {
        setSessionId(undefined);
        setView(undefined);
      } else void stopRef.current();
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
    const runtime = runtimeRef.current;
    if (!runtime) return;
    lifecycleActionRef.current = 'pausing';
    setLifecycleAction('pausing');
    try {
      const paused = await runtime.pause();
      if (!paused) return;
      stoppedRef.current = true;
      sessionPausedRef.current = true;
      setSessionPaused(true);
      if (capability && capability !== 'fake-recovered' && capability !== 'fake') {
        const released = await fetch('/api/stop', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'x-podcaster-capability': capability },
        })
          .then((response) => response.ok)
          .catch(() => false);
        if (!released)
          activityLog.append({
            level: 'warn',
            source: 'app',
            message: 'session paused locally; host cleanup is pending',
          });
      }
      capabilityRef.current = undefined;
      setCapability(undefined);
      configureSessionClock(await writerRef.current?.getSession(targetSession));
      setView((previous) => (previous ? pausedSessionView(previous) : runtime.snapshot()));
      activityLog.append({ level: 'info', source: 'app', message: 'session paused by user' });
    } catch (error) {
      appendActivityIssue('error', 'session pause cleanup failed', error instanceof Error ? error.message : undefined);
      sessionPausedRef.current = true;
      setSessionPaused(true);
      stoppedRef.current = true;
      setView((previous) =>
        previous
          ? {
              ...pausedSessionView(previous),
              dominant: 'degraded',
              degradedMessage: 'The session was paused, but some live resources need attention. Resume to reconnect.',
              announcement: 'Session needs attention',
            }
          : previous,
      );
    } finally {
      lifecycleActionRef.current = 'idle';
      setLifecycleAction('idle');
    }
  }, [capability, configureSessionClock, continueSession, sessionId]);

  const buildExport = useCallback(async (onProgress?: ExportOnProgress) => {
    return runtimeRef.current?.buildRecording(onProgress) ?? null;
  }, []);

  const pollRecording = useCallback(
    async (targetSession: string): Promise<void> => {
      const runtime = runtimeRef.current;
      if (!runtime || runtime.sessionId !== targetSession) return;
      let enabled: boolean;
      let summaries: Awaited<ReturnType<LiveSessionRuntime['recordingSummaries']>>['summaries'];
      try {
        ({ enabled, summaries } = await runtime.recordingSummaries());
      } catch {
        return;
      }
      if (recordingSessionRef.current !== targetSession) return;
      const last = lastCheapRef.current;
      if (!last || last.enabled !== enabled || last.signature !== recordingSummarySignature(summaries)) {
        // The number of rows is not enough to detect a late transcript.final:
        // the recorder may persist a user clip first and attach its turnId just
        // afterward. Compare the metadata as well so the matching X appears
        // without waiting for another recording item to be created.
        await fetchRecordingSummaries(targetSession);
      } else {
        setRecordingView((prev) => (prev.enabled === enabled && prev.hydrated ? prev : { ...prev, enabled }));
      }
    },
    [fetchRecordingSummaries],
  );

  useEffect(() => {
    if (!sessionId) return;
    const targetSession = sessionId;
    let cancelled = false;
    void fetchRecordingSummaries(targetSession);
    const timer = setInterval(() => {
      if (!cancelled) void pollRecording(targetSession);
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, fetchRecordingSummaries, pollRecording]);

  const deleteRecording = useCallback(async () => {
    const current = recordingSessionRef.current;
    if (!current) return;
    await runtimeRef.current?.deleteRecording();
    await fetchRecordingSummaries(current);
  }, [fetchRecordingSummaries]);

  const toggleBubbleTrim = useCallback(
    async (targetId: RecordingTrimTargetId, trimmed: boolean): Promise<boolean> => {
      const current = recordingSessionRef.current;
      if (!current) return false;
      const target =
        recordingViewRef.current.targets.get(targetId) ?? recordingViewRef.current.partTargets.get(targetId);
      if (!target) return false;
      setRecordingView((prev) => ({ ...prev, pendingTargetId: targetId, error: '' }));
      try {
        await runtimeRef.current?.setItemsTrimmed(target.itemIds, trimmed);
      } catch (error) {
        setRecordingView((prev) => ({
          ...prev,
          pendingTargetId: null,
          error: error instanceof Error ? error.message : 'The message could not be updated. Try again.',
        }));
        return false;
      }
      setRecordingView((prev) => ({ ...prev, pendingTargetId: null }));
      await fetchRecordingSummaries(current);
      return true;
    },
    [fetchRecordingSummaries],
  );

  const settingsDialog = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        model={settingsModel}
        catalog={voiceCatalogRef.current}
        models={ttsModels}
        saving={settingsSaving}
        saveError={settingsSaveError}
        onSave={saveSettings}
        onPreviewVoice={previewVoice}
        customVoices={customVoices}
        onEnrollCustomVoice={enrollVoice}
        onDeleteCustomVoice={deleteVoice}
        onRenameCustomVoice={renameVoice}
      />
    </Suspense>
  ) : null;
  const privacyDialog = (
    <PrivacyDialog open={privacyDialogOpen} onOpenChange={setPrivacyDialogOpen} onConfirm={connectServices} />
  );
  const appHeader = (
    <AppHeader
      darkMode={darkMode}
      onToggleDarkMode={toggleDarkMode}
      onOpenSettings={() => setSettingsOpen(true)}
      serviceStatuses={serviceStatuses}
      piSettings={settingsModel.pi}
      onRefreshServiceStatus={() => void refreshServiceStatus()}
      refreshingServiceStatus={refreshingServiceStatus || servicesConnecting}
      privacyAcknowledged={privacyAcknowledged}
      capability={capability}
      onConnectServices={openServicesConnection}
      microphoneGranted={microphoneGranted}
      onEnableMicrophone={enableMicrophone}
    />
  );

  if (!writer)
    return (
      <main className="mx-auto my-8 flex w-[min(56rem,calc(100%_-_2rem))] items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading…
      </main>
    );

  return (
    <>
      {appHeader}
      <Routes>
        <Route
          path="/"
          element={
            <Suspense fallback={<RouteLoading />}>
              <SessionIndex
                writer={writer}
                liveSessionId={sessionId}
                liveSessionPaused={sessionPaused}
                elapsedSeconds={elapsed}
                creatingDraft={creatingDraft}
                onCreateDraft={() => void createDraft()}
                onContinueSession={(id) => void continueSession(id)}
              />
            </Suspense>
          }
        />
        <Route
          path="/session/:sessionId"
          element={
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
              onCancelAssistant={() => void runtimeRef.current?.cancelAssistant()}
              onCancelPlanning={() => void runtimeRef.current?.cancelPlanning()}
              onRetryPlanning={() => void runtimeRef.current?.retryPlanning()}
              onBeginLive={() => runtimeRef.current?.beginLive()}
              onToggleBubbleTrim={toggleBubbleTrim}
              onDeleteRecording={deleteRecording}
              buildExport={buildExport}
              onContinueSession={(id: string) => void continueSession(id)}
              onBack={() => navigate('/')}
              serviceStatuses={serviceStatuses}
              capability={capability}
              microphoneGranted={microphoneGranted}
              privacyAcknowledged={privacyAcknowledged}
              onConnectServices={openServicesConnection}
              onEnableMicrophone={enableMicrophone}
              onStartDraft={(id, planning) => {
                const activeCapability = capabilityRef.current;
                if (!activeCapability)
                  return Promise.reject(new Error('Connect services before starting this session.'));
                return start(activeCapability, 'full', id, planning);
              }}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {settingsDialog}
      {privacyDialog}
    </>
  );
}

function recordingSummarySignature(summaries: readonly RecordingItemSummary[]): string {
  return JSON.stringify(
    [...summaries]
      .map((summary) => [
        summary.itemId,
        summary.role,
        summary.turnId,
        summary.responseId,
        summary.partIndex,
        summary.trimmed,
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
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
    conversationItems: state.conversationItems.map((item) =>
      item.kind === 'assistant' && item.playback !== 'completed' && item.playback !== 'interrupted'
        ? // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
          { ...item, playback: 'interrupted' as const }
        : item,
    ),
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
  onCancelPlanning: () => void;
  onRetryPlanning: () => void;
  onBeginLive: () => Promise<void> | undefined;
  onToggleBubbleTrim: (targetId: RecordingTrimTargetId, trimmed: boolean) => Promise<boolean>;
  onDeleteRecording: () => Promise<void>;
  buildExport: (onProgress?: ExportOnProgress) => Promise<Blob | null>;
  onContinueSession: (sessionId: string) => void;
  onBack: () => void;
  serviceStatuses: ServiceStatuses;
  capability: string | undefined;
  microphoneGranted: boolean;
  privacyAcknowledged: boolean;
  onConnectServices: () => void;
  onEnableMicrophone: () => void | Promise<void>;
  onStartDraft: (sessionId: string, planning?: SessionPlanningRequest) => Promise<void>;
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
    return (
      <Suspense fallback={<RouteLoading label="Loading session…" />}>
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
          onCancelPlanning={props.onCancelPlanning}
          onRetryPlanning={props.onRetryPlanning}
          onBeginLive={props.onBeginLive}
          settingsOpen={props.settingsOpen}
          recording={props.recordingView}
          onToggleBubbleTrim={props.onToggleBubbleTrim}
          buildExport={props.buildExport}
          onExportingChange={setExporting}
          onDeleteRecording={deleteRecording}
          exporting={exporting}
          deleting={deleting}
        />
      </Suspense>
    );
  }
  if (props.resuming)
    return (
      <main className="mx-auto mt-5 mb-8 flex w-[min(56rem,calc(100%_-_2rem))] items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Resuming session…
      </main>
    );
  if (!routeSessionId) return null;
  return (
    <Suspense fallback={<RouteLoading label="Loading session…" />}>
      <DraftSession
        writer={props.writer}
        sessionId={routeSessionId}
        agentName={props.agentName}
        serviceStatuses={props.serviceStatuses}
        capability={props.capability}
        microphoneGranted={props.microphoneGranted}
        privacyAcknowledged={props.privacyAcknowledged}
        onConnectServices={props.onConnectServices}
        onEnableMicrophone={props.onEnableMicrophone}
        onStart={(planning) => props.onStartDraft(routeSessionId, planning)}
        onBack={props.onBack}
        onContinue={() => props.onContinueSession(routeSessionId)}
      />
    </Suspense>
  );
}

function RouteLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <main className="mx-auto my-8 flex w-[min(56rem,calc(100%_-_2rem))] items-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </main>
  );
}
