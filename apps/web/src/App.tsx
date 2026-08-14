import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserCapture, type CaptureHandle } from './audio/capture';
import { BrowserPlayback } from './audio/playback';
import type { PlaybackStopReason } from './audio/playback-ledger';
import { Readiness } from './readiness/Readiness';
import { RecordingControls } from './recording/RecordingControls';
import { createEncoderClient } from './recording/encoder-client';
import { RecordingRecorder } from './recording/recorder';
import { offlineResample } from './recording/resample';
import { buildRecording, createBrowserDecoder } from './recording/splice';
import { SessionScreen } from './session/SessionScreen';
import { activityLog } from './session/activity-log';
import { SessionController, type ControlledPlayback } from './session/controller';
import { conversationFromStoredTurns } from './session/conversation';
import { createEnvelope, uuidV7 } from './session/envelope';
import { FakeSessionTransport } from './session/fake-transport';
import type { SessionTransport } from './session/transport';
import { WebSocketSessionTransport } from './session/websocket-transport';
import { initialSessionState, type SessionViewState } from './session/state';
import { RecordingStore, type RecordingItemSummary } from './storage/recording-store';
import { StableTurnWriter } from './storage/stable-turn-writer';
import { deleteSessionRecording } from './recording/export';
import { emptyRecordingSessionView, projectRecordingTrim, type RecordingSessionViewState, type RecordingTrimTargetId } from './recording/trim-state';
import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_PERSONA, DEFAULT_VOICE_SPEED_MODIFIER, type VoiceCatalog, type VoicePreference } from '@app/contracts/settings';
import { SettingsStore } from './settings/settings-store';
import { startVoicePreview } from './settings/voice-preview';
import { applyReconciled, defaultSettingsModel, reconcileVoice, settingsDigest, type SettingsModel } from './settings/settings-model';
import { SettingsDialog } from './settings/SettingsDialog';

const fakeServices = import.meta.env.MODE === 'fake-services';
type SessionStartSettings = { version: 1; persona: string; voice: VoicePreference };

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
  const [view, setView] = useState<SessionViewState>();
  const [sessionId, setSessionId] = useState<string>();
  const [capability, setCapability] = useState<string>();
  const [elapsed, setElapsed] = useState(0);
  const [sessionPaused, setSessionPaused] = useState(false);
  const writerRef = useRef<StableTurnWriter | undefined>(undefined);
  const controllerRef = useRef<SessionController | undefined>(undefined);
  const transportRef = useRef<SessionTransport | undefined>(undefined);
  const fakeTransportRef = useRef<FakeSessionTransport | undefined>(undefined);
  const captureRef = useRef<CaptureHandle | undefined>(undefined);
  const captureStreamIdRef = useRef<number | undefined>(undefined);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const recordingStoreRef = useRef<RecordingStore | undefined>(undefined);
  const recordingRecorderRef = useRef<RecordingRecorder | undefined>(undefined);
  const recordingUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const statsRef = useRef<FakeRuntimeStats>({ captureStarts: 0, captureStops: 0, captureRunning: false, playbackPauses: 0, playbackResumes: 0, playbackStops: [] });
  const startedAt = useRef(Date.now());
  const [recordingView, setRecordingView] = useState<RecordingSessionViewState>(emptyRecordingSessionView);
  const recordingViewRef = useRef(recordingView);
  recordingViewRef.current = recordingView;
  const recordingSessionRef = useRef<string | undefined>(undefined);
  recordingSessionRef.current = sessionId;
  const recordingGenRef = useRef(0);
  const lastCheapRef = useRef<{ enabled: boolean; count: number } | null>(null);
  const settingsStoreRef = useRef<SettingsStore | undefined>(undefined);
  const voiceCatalogRef = useRef<VoiceCatalog | undefined>(undefined);
  const settingsFrozenRef = useRef<SettingsModel | undefined>(undefined);
  const [settingsModel, setSettingsModel] = useState<SettingsModel>(() => defaultSettingsModel(undefined));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | undefined>(undefined);

  const composeFakeSession = useCallback(async (opened: StableTurnWriter, id: string, initial: SessionViewState, cap: string, settings: SessionStartSettings) => {
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
  }, []);

  const composeRealSession = useCallback(async (opened: StableTurnWriter, id: string, initial: SessionViewState, cap: string, seed: string, reasoningMode: 'full' | 'transcript_only', settings: SessionStartSettings) => {
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
      await transport.stopAudio(streamId);
      captureStreamIdRef.current = undefined;
      await controller.stop();
      throw error;
    }
    setCapability(cap);
    setSessionId(id);
  }, []);

  useEffect(() => {
    if (!fakeServices) return;
    let cancelled = false;
    void StableTurnWriter.open().then(async opened => {
      if (cancelled) { opened.close(); return; }
      writerRef.current = opened;
      const active = await opened.recoverActiveSession();
      if (!active || cancelled) return;
      const turns = await opened.getTurns(active.sessionId);
      const restored: SessionViewState = {
        ...initialSessionState,
        dominant: 'listening',
        announcement: 'Listening',
        stableTurns: turns.filter(turn => turn.stableText !== null).map(turn => ({ turnId: turn.turnId, text: turn.stableText!, ...(turn.posture ? { posture: turn.posture } : {}), ...(turn.policyReason ? { policyReason: turn.policyReason } : {}) })),
        conversationItems: conversationFromStoredTurns(turns),
      };
      startedAt.current = new Date(active.startedAt).getTime();
      await composeFakeSession(opened, active.sessionId, restored, 'fake-recovered', { version: 1, persona: DEFAULT_AGENT_PERSONA, voice: { catalogId: '', voiceId: '', speedModifier: DEFAULT_VOICE_SPEED_MODIFIER } });
    });
    return () => { cancelled = true; };
  }, [composeFakeSession]);

  useEffect(() => {
    if (!view) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [view]);

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

  async function start(cap: string, reasoningMode: 'full' | 'transcript_only' = 'full') {
    const opened = writerRef.current ?? await StableTurnWriter.open();
    writerRef.current = opened;
    const id = uuidV7();
    const seed = uuidV7();
    const frozen: SettingsModel = { agentName: settingsModel.agentName, persona: settingsModel.persona, voice: { ...settingsModel.voice } };
    settingsFrozenRef.current = frozen;
    const settings: SessionStartSettings = { version: 1, persona: frozen.persona, voice: { ...frozen.voice } };
    const personaDigest = settingsDigest(frozen);
    const persisted = await opened.beginSession({ sessionId: id, sessionSeed: seed, personaDigest });
    if (!persisted.ok) throw new Error(persisted.degradedReason);
    startedAt.current = Date.now();
    setSessionPaused(false);
    activityLog.append({ level: 'info', source: 'app', message: `session started (${cap})` });
    const initial = { ...initialSessionState, dominant: 'listening' as const, announcement: 'Listening' };
    if (fakeServices) await composeFakeSession(opened, id, initial, cap, settings);
    else await composeRealSession(opened, id, initial, cap, seed, reasoningMode, settings);
  }

  const togglePause = useCallback(async () => {
    const transport = transportRef.current;
    const controller = controllerRef.current;
    const recorder = recordingRecorderRef.current;
    if (!transport || !controller || !recorder) return;
    if (!sessionPaused) {
      await captureRef.current?.stop();
      captureRef.current = undefined;
      const streamId = captureStreamIdRef.current;
      if (streamId !== undefined) {
        await transport.stopAudio(streamId);
        captureStreamIdRef.current = undefined;
      }
      activityLog.append({ level: 'info', source: 'app', message: 'session paused by user' });
      setSessionPaused(true);
      return;
    }
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const streamId = random[0] ?? 0;
    try {
      await transport.startAudio(streamId);
      captureStreamIdRef.current = streamId;
      const capture = await new BrowserCapture({ streamId: () => streamId, onAudio: audio => recorder.onCaptureAudio(audio) }).start({
        send: frame => transport.sendCapture(frame),
        degraded: message => controller.degrade(message),
      });
      if (fakeServices) {
        statsRef.current.captureStarts++;
        statsRef.current.captureRunning = true;
        captureRef.current = {
          stop: async () => {
            if (!statsRef.current.captureRunning) return;
            await capture.stop();
            statsRef.current.captureStops++;
            statsRef.current.captureRunning = false;
          },
        };
      } else captureRef.current = capture;
      activityLog.append({ level: 'info', source: 'app', message: 'session resumed by user' });
      setSessionPaused(false);
    } catch (error) {
      await Promise.resolve(transport.stopAudio(streamId)).catch(() => undefined);
      captureStreamIdRef.current = undefined;
      controller.degrade(error instanceof Error ? error.message : 'The microphone could not be resumed.');
    }
  }, [sessionPaused]);

  async function stop() {
    activityLog.append({ level: 'info', source: 'app', message: 'session stopped by user' });
    setSessionPaused(false);
    await captureRef.current?.stop();
    const streamId = captureStreamIdRef.current;
    if (streamId !== undefined) {
      await transportRef.current?.stopAudio(streamId);
      captureStreamIdRef.current = undefined;
    }
    await controllerRef.current?.stop();
    recordingUnsubscribeRef.current?.();
    recordingUnsubscribeRef.current = undefined;
    await recordingRecorderRef.current?.stop(true);
    if (capability && capability !== 'fake-recovered') await fetch('/api/stop', { method: 'POST', credentials: 'same-origin', headers: { 'x-podcaster-capability': capability } }).catch(() => undefined);
  }

  const buildExport = useCallback(async () => {
    const store = recordingStoreRef.current;
    const writer = writerRef.current;
    const current = recordingSessionRef.current;
    if (!store || !writer || !current) return null;
    return buildRecording(current, {
      store,
      turns: writer,
      decode: createBrowserDecoder(),
      resample: offlineResample,
      encode: createEncoderClient(),
    });
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
    lastCheapRef.current = { enabled, count: summaries.length };
    setRecordingView(prev => ({ ...projectRecordingTrim(summaries, enabled), pendingTargetId: prev.pendingTargetId, notice: prev.notice, error: '' }));
  }, []);

  const pollRecording = useCallback(async (targetSession: string): Promise<void> => {
    const store = recordingStoreRef.current;
    if (!store) return;
    let enabled: boolean;
    let count: number;
    try {
      [enabled, count] = await Promise.all([store.getRecordingEnabled(), store.countSessionItems(targetSession)]);
    } catch { return; }
    if (recordingSessionRef.current !== targetSession) return;
    const last = lastCheapRef.current;
    if (!last || last.enabled !== enabled || last.count !== count) {
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

  const toggleRecording = useCallback(async (enabled: boolean) => {
    await recordingRecorderRef.current?.setEnabled(enabled);
    const current = recordingSessionRef.current;
    if (current) await fetchRecordingSummaries(current);
  }, [fetchRecordingSummaries]);

  const onCatalog = useCallback((catalog: VoiceCatalog) => {
    voiceCatalogRef.current = catalog;
    setSettingsModel(prev => applyReconciled(prev, reconcileVoice(prev.voice, catalog)));
  }, []);

  const previewVoice = useCallback(async (voiceId: string, speedModifier: number) => {
    if (!capability) throw new Error('The session capability is not ready yet.');
    return startVoicePreview({ voiceId, speedModifier, capability });
  }, [capability]);

  const saveSettings = useCallback(async (agentName: string, persona: string, voice: VoicePreference) => {
    setSettingsSaving(true);
    setSettingsSaveError(undefined);
    try {
      const store = settingsStoreRef.current ?? await SettingsStore.open();
      settingsStoreRef.current = store;
      const ok = await store.save({ version: 1, agentName, persona, voice });
      if (!ok) throw new Error('Settings could not be saved on this device.');
      setSettingsModel(applyReconciled({ agentName, persona }, { voice }));
      setSettingsOpen(false);
    } catch (error) {
      setSettingsSaveError(error instanceof Error ? error.message : 'Settings could not be saved.');
    } finally {
      setSettingsSaving(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void SettingsStore.open().then(async store => {
      settingsStoreRef.current = store;
      const stored = await store.load();
      if (cancelled) return;
      const catalog = voiceCatalogRef.current;
      const reconciled = reconcileVoice(stored?.voice, catalog);
      setSettingsModel(applyReconciled({ agentName: stored?.agentName ?? DEFAULT_AGENT_NAME, persona: stored?.persona ?? DEFAULT_AGENT_PERSONA }, reconciled));
    });
    return () => { cancelled = true; };
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
    const target = recordingViewRef.current.targets.get(targetId);
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

  if (!view) return <>
    <Readiness sessionAvailable={fakeServices} onStart={start} onCatalog={onCatalog} onOpenSettings={() => setSettingsOpen(true)} onCapability={setCapability} />
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} model={settingsModel} catalog={voiceCatalogRef.current} saving={settingsSaving} saveError={settingsSaveError} onSave={saveSettings} onPreviewVoice={previewVoice} />
  </>;
  return <div className="session-layout">
    <SessionScreen
      state={view}
      agentName={settingsModel.agentName}
      elapsedSeconds={elapsed}
      sessionPaused={sessionPaused}
      onTogglePause={() => void togglePause()}
      onStop={() => void stop()}
      onCancelAssistant={() => void controllerRef.current?.cancelAssistant()}
      onOpenSettings={() => setSettingsOpen(true)}
      settingsOpen={settingsOpen}
      recording={recordingView}
      onToggleBubbleTrim={toggleBubbleTrim}
    />
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} model={settingsModel} catalog={voiceCatalogRef.current} saving={settingsSaving} saveError={settingsSaveError} onSave={saveSettings} onPreviewVoice={previewVoice} />
    {sessionId ? <RecordingControls sessionId={sessionId} buildExport={buildExport} recording={recordingView} onToggleRecording={toggleRecording} onDelete={deleteRecording} /> : null}
  </div>;
}
