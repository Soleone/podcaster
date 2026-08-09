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
import { RecordingStore } from './storage/recording-store';
import { StableTurnWriter } from './storage/stable-turn-writer';

const fakeServices = import.meta.env.MODE === 'fake-services';
const PERSONA_DIGEST = 'a'.repeat(64);

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
  async resume(): Promise<void> { this.stats.playbackResumes++; await this.playback.resume(); }
  stop(reason: PlaybackStopReason) { return this.playback.stop(reason); }
}

interface TestApi {
  emit(type: string, payload: Record<string, unknown>, epoch?: number): Promise<void>;
  partial(text: string): Promise<void>;
  audio(playbackId: string, sampleOffset: number, samples: number): Promise<void>;
  capture(): void;
  echoRecovered(recovered: boolean): void;
  degrade(message: string): void;
  stats(): FakeRuntimeStats & { captureFrames: number; progressReports: number; terminalReceipts: number; commands: string[] };
}

declare global { interface Window { __podcasterTest?: TestApi } }

export function App() {
  const [view, setView] = useState<SessionViewState>();
  const [sessionId, setSessionId] = useState<string>();
  const [capability, setCapability] = useState<string>();
  const [elapsed, setElapsed] = useState(0);
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

  const composeFakeSession = useCallback(async (opened: StableTurnWriter, id: string, initial: SessionViewState, cap: string) => {
    const transport = new FakeSessionTransport();
    await transport.connect(cap);
    recordingStoreRef.current?.close();
    const recordingStore = await RecordingStore.open();
    recordingStoreRef.current = recordingStore;
    const recorder = new RecordingRecorder({ sessionId: id, store: recordingStore, encode: createEncoderClient() });
    await recorder.start();
    recordingRecorderRef.current = recorder;
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

  const composeRealSession = useCallback(async (opened: StableTurnWriter, id: string, initial: SessionViewState, cap: string, seed: string, reasoningMode: 'full' | 'transcript_only') => {
    recordingStoreRef.current?.close();
    const recordingStore = await RecordingStore.open();
    recordingStoreRef.current = recordingStore;
    const recorder = new RecordingRecorder({ sessionId: id, store: recordingStore, encode: createEncoderClient() });
    await recorder.start();
    recordingRecorderRef.current = recorder;
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
    await transport.startSession(seed, reasoningMode);
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
      await composeFakeSession(opened, active.sessionId, restored, 'fake-recovered');
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
      echoRecovered: recovered => controller.setEchoRecovered(recovered),
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
    const persisted = await opened.beginSession({ sessionId: id, sessionSeed: seed, personaDigest: PERSONA_DIGEST });
    if (!persisted.ok) throw new Error(persisted.degradedReason);
    startedAt.current = Date.now();
    activityLog.append({ level: 'info', source: 'app', message: `session started (${cap})` });
    const initial = { ...initialSessionState, dominant: 'listening' as const, announcement: 'Listening' };
    if (fakeServices) await composeFakeSession(opened, id, initial, cap);
    else await composeRealSession(opened, id, initial, cap, seed, reasoningMode);
  }

  async function stop() {
    activityLog.append({ level: 'info', source: 'app', message: 'session stopped by user' });
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
    const current = sessionId;
    if (!store || !writer || !current) return null;
    return buildRecording(current, {
      store,
      turns: writer,
      decode: createBrowserDecoder(),
      resample: offlineResample,
      encode: createEncoderClient(),
    });
  }, [sessionId]);

  const toggleRecording = useCallback(async (enabled: boolean) => {
    await recordingRecorderRef.current?.setEnabled(enabled);
  }, []);

  if (!view) return <Readiness sessionAvailable={fakeServices} onStart={start} />;
  return <div className="session-layout">
    <SessionScreen
      state={view}
      elapsedSeconds={elapsed}
      onStop={() => void stop()}
      onCancelAssistant={() => void controllerRef.current?.cancelAssistant()}
      onConfirmEcho={() => void controllerRef.current?.confirmBargeIn()}
      onRejectEcho={() => void controllerRef.current?.rejectBargeIn()}
    />
    {sessionId && recordingStoreRef.current ? <RecordingControls sessionId={sessionId} store={recordingStoreRef.current} buildExport={buildExport} onToggleRecording={toggleRecording} /> : null}
  </div>;
}
