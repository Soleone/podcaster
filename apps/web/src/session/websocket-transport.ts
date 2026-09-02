import { decodeBinaryAudioFrame } from '@app/contracts/binary';
import type {
  BrowserCommand,
  HostEvent,
  PlaybackPausedEvent,
  PlaybackStoppedEvent,
  TranscriptFinalEvent,
} from '@app/contracts';
import { isJsonArray, isJsonBoolean, isJsonNumber, isJsonObject, isJsonString } from '../lib/json-values';
import type { JsonObject, JsonValue } from '../lib/json-values';
import type { PlaybackProgress, PlaybackTerminal } from '../audio/playback-ledger';
import { activityLog } from './activity-log';
import type { ActivityEntry } from './activity-log';
import { createEnvelope, type BrowserCommandPayload } from './envelope';
import type { OutputAudioChunk, SessionStartRequest, SessionTransport } from './transport';

const MAX_BINARY_PAYLOAD = 64 * 1024 - 20;
// Close codes in 3000-4999 are application-defined and valid for a browser
// WebSocket *client* to send. 1008/1011 are server-only and a browser client
// that tries to send them throws InvalidAccessError inside onmessage.
const CLOSE_PROTOCOL_VIOLATION = 4000;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;
// Must comfortably exceed the host's SESSION_DISCONNECT_GRACE_MS (30s): if the
// client gives up before the host tears the conversation down, a recoverable
// outage becomes permanent. The margin also absorbs background-tab timer
// throttling, which stretches the backoff schedule exactly while the user is
// paused and the tab is hidden.
const DEFAULT_RECONNECT_WINDOW_MS = 45_000;
// Bounds one connection attempt: a half-open TCP connect or a server that
// accepts but never authenticates must not burn the whole reconnect window on
// a single hung attempt.
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_QUEUED_COMMANDS = 128;
export interface WebSocketTransportOptions {
  reconnectWindowMs?: number;
  reconnectDelaysMs?: readonly number[];
  /** Invoked when connectivity likely returned (tab visible again, network online). */
  subscribeConnectivityHints?: (hint: () => void) => () => void;
}

function subscribeBrowserConnectivityHints(hint: () => void): () => void {
  // The global exists only in a browser UI context; workers and SSR bundles
  // have no window/document binding, so probe globalThis instead of referencing
  // the bare globals (which would throw where they are absent).
  if (globalThis.window === undefined || globalThis.document === undefined) return () => {};
  window.addEventListener('online', hint);
  document.addEventListener('visibilitychange', hint);
  return () => {
    window.removeEventListener('online', hint);
    document.removeEventListener('visibilitychange', hint);
  };
}
interface OutputBinding {
  playbackId: string;
  responseId: string;
  outputEpoch: number;
  streamId?: number;
  partIndex?: number;
  expectedSequence: number;
  sampleOffset: number;
  terminal: boolean;
  receivedAt: number;
}
interface QueuedCommand {
  message: string;
  type: string;
  key?: string;
}

interface OutputCollection {
  // Multi-part responses key bindings by the sidecar outputStreamId; the legacy
  // single-output path uses the single slot below.
  byStream: Map<number, OutputBinding>;
  single: OutputBinding | undefined;
}

export class WebSocketSessionTransport implements SessionTransport {
  private socket: WebSocket | undefined;
  private capability: string | undefined;
  private connectPromise: Promise<void> | undefined;
  private initialConnectionSettled = false;
  private connected = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private connectivityListeners: (() => void) | undefined;
  private reconnectStartedAt = 0;
  private reconnectAttempt = 0;
  private permanentFailure = false;
  private readonly queuedCommands: QueuedCommand[] = [];
  private readonly eventListeners = new Set<(event: HostEvent) => void | Promise<void>>();
  private readonly audioListeners = new Set<(chunk: OutputAudioChunk) => void>();
  private readonly failureListeners = new Set<(message: string) => void>();
  private readonly reconnectListeners = new Set<() => void | Promise<void>>();
  private readonly terminalEnvelopes = new Map<string, PlaybackStoppedEvent>();
  private readonly usedOutputStreams = new Set<number>();
  private readonly outputs: OutputCollection = { byStream: new Map(), single: undefined };
  private intentionalDisconnect = false;
  private failureNotified = false;
  private pendingAudioStart: { streamId: number; resolve(): void; reject(error: Error): void } | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly epoch: () => number,
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
    private readonly options: WebSocketTransportOptions = {},
  ) {}

  connect(capability: string): Promise<void> {
    this.capability = capability;
    this.intentionalDisconnect = false;
    this.permanentFailure = false;
    this.failureNotified = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectStartedAt = 0;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      this.initialConnectionSettled = false;
      this.initialResolve = resolve;
      this.initialReject = reject;
      this.openSocket();
    });
    return this.connectPromise;
  }

  private initialResolve: (() => void) | undefined;
  private initialReject: ((error: Error) => void) | undefined;

  private openSocket(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = this.createSocket(`${protocol}//${location.host}/ws`);
    } catch (error) {
      this.handleSocketFailure(undefined, error instanceof Error ? error.message : 'socket creation failed');
      return;
    }
    this.socket = socket;
    let authenticated = false;
    const fail = (detail?: string) => {
      this.clearHandshakeWatchdog();
      this.handleSocketFailure(socket, detail);
    };
    socket.binaryType = 'arraybuffer';
    this.armHandshakeWatchdog(socket, () => authenticated);
    socket.onopen = () => {
      if (this.socket !== socket || this.intentionalDisconnect) return;
      activityLog.append({
        level: 'info',
        source: 'transport',
        message: this.reconnecting ? 'session socket reconnecting' : 'session socket opened',
      });
      try {
        socket.send(JSON.stringify({ capability: this.capability }));
      } catch {
        fail('authentication send failed');
      }
    };
    socket.onerror = () => fail();
    socket.onclose = (event) => {
      const detail =
        event.code || event.reason ? `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}` : undefined;
      fail(detail);
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket || this.intentionalDisconnect) return;
      if (!isJsonString(message.data)) {
        if (!(message.data instanceof ArrayBuffer)) {
          this.protocolFailure('a binary message was not an ArrayBuffer.');
          return;
        }
        this.handleBinary(message.data);
        return;
      }
      let value: JsonValue;
      try {
        value = JSON.parse(message.data);
      } catch {
        this.protocolFailure('the message was not valid JSON.');
        return;
      }
      if (isJsonObject(value) && value.type === 'authenticated') {
        authenticated = true;
        this.clearHandshakeWatchdog();
        this.connected = true;
        if (!this.initialConnectionSettled) {
          this.initialConnectionSettled = true;
          this.initialResolve?.();
          this.initialResolve = undefined;
          this.initialReject = undefined;
        } else if (this.reconnecting) {
          this.reconnecting = false;
          this.unwatchConnectivityRestored();
          this.reconnectStartedAt = 0;
          this.reconnectAttempt = 0;
          activityLog.append({ level: 'info', source: 'transport', message: 'session socket reconnected' });
          this.flushQueuedCommands();
          if (!this.connected) return;
          for (const listener of this.reconnectListeners) void listener();
        }
        return;
      }
      if (!authenticated) {
        this.protocolFailure('the session socket sent data before authentication.');
        return;
      }
      if (!isStrictHostEvent(value)) {
        const type = isJsonObject(value) ? String(value.type ?? 'unknown') : 'unknown';
        this.protocolFailure(`the "${type}" event failed validation.`);
        return;
      }
      const hostEvent = value;
      if (hostEvent.sessionId !== this.sessionId) {
        this.protocolFailure('the event sessionId did not match this session.');
        return;
      }
      if (hostEvent.type === 'reasoning.started') {
        const responseId = String(hostEvent.payload.responseId);
        if (this.latestResponseId !== undefined) {
          // A duplicate reasoning.started for the SAME response is a protocol anomaly
          // unless it starts a new part of a multi-part response.
          if (responseId === this.latestResponseId) {
            this.protocolFailure('a duplicate reasoning.started was received for the current response.');
            return;
          }
          // A different response superseded the previous one before it terminalized
          // (e.g. rapid re-engagement while the old response was still generating).
          // The previous output bindings are dead and their late PCM must be rejected.
          if (responseId !== this.latestResponseId) {
            for (const binding of this.outputs.byStream.values()) binding.terminal = true;
            if (this.outputs.single) this.outputs.single.terminal = true;
          }
        }
        if (responseId !== this.latestResponseId) this.latestResponseId = responseId;
      } else if (hostEvent.type === 'reasoning.delta') {
        if (hostEvent.payload.responseId !== this.latestResponseId) {
          this.protocolFailure('reasoning.delta did not match the established response.');
          return;
        }
      } else if (hostEvent.type === 'reasoning.final') {
        if (hostEvent.payload.responseId !== this.latestResponseId) {
          this.protocolFailure('reasoning.final did not match the established response.');
          return;
        }
      } else if (hostEvent.type === 'tts.started') {
        if (hostEvent.epoch !== this.epoch() || hostEvent.payload.responseId !== this.latestResponseId) {
          this.protocolFailure('tts.started did not match the established response identity.');
          return;
        }
        const outputStreamId = hostEvent.payload.outputStreamId;
        const binding: OutputBinding = {
          playbackId: String(hostEvent.payload.playbackId),
          responseId: String(hostEvent.payload.responseId),
          outputEpoch: hostEvent.epoch,
          expectedSequence: 0,
          sampleOffset: 0,
          terminal: false,
          receivedAt: Date.now(),
        };
        if (outputStreamId !== undefined) binding.streamId = outputStreamId;
        if (outputStreamId !== undefined) {
          if (this.outputs.byStream.has(outputStreamId) || this.usedOutputStreams.has(outputStreamId)) {
            this.protocolFailure('tts.started reused an output stream id.');
            return;
          }
          this.outputs.byStream.set(outputStreamId, binding);
          this.usedOutputStreams.add(outputStreamId);
        } else {
          if (this.outputs.single && !this.outputs.single.terminal) {
            this.protocolFailure('tts.started collided with the active output stream.');
            return;
          }
          this.outputs.single = binding;
        }
      } else if (hostEvent.type === 'response.failed') {
        if (hostEvent.payload.responseId !== this.latestResponseId) {
          this.protocolFailure('response.failed did not match the established response.');
          return;
        }
        this.markResponseOutputsTerminal(hostEvent.payload.responseId);
        this.latestResponseId = undefined;
      } else if (hostEvent.type === 'response.cancelled') {
        const responseId = hostEvent.payload.responseId;
        const matchedOutput = this.markResponseOutputsTerminal(responseId);
        if (responseId !== this.latestResponseId && !matchedOutput) {
          this.protocolFailure('response.cancelled did not match an established response.');
          return;
        }
        if (responseId === this.latestResponseId) this.latestResponseId = undefined;
      } else if (hostEvent.type === 'tts.ended') {
        const binding = this.findOutput(String(hostEvent.payload.playbackId));
        if (!binding || binding.outputEpoch !== hostEvent.epoch) {
          this.protocolFailure('tts.ended did not match the active output stream.');
          return;
        }
        binding.terminal = true;
        const generated = Number(hostEvent.payload.generatedSamples);
        if (generated !== binding.sampleOffset) {
          this.protocolFailure('tts.ended reported a sample count that does not match the streamed audio.');
          return;
        }
        this.latestResponseId = undefined;
      }
      if (hostEvent.type === 'session.state') {
        const audio = hostEvent.payload.audio;
        const pending = this.pendingAudioStart;
        if (pending && audio) {
          if (audio.status === 'ready') {
            this.pendingAudioStart = undefined;
            pending.resolve();
          } else if (audio.status === 'failed') {
            this.pendingAudioStart = undefined;
            pending.reject(new Error(audio.detail ?? 'The audio engine failed to warm up.'));
          }
        }
      }
      for (const listener of this.eventListeners) void listener(hostEvent);
    };
  }

  private handleSocketFailure(socket: WebSocket | undefined, detail?: string): void {
    if (socket && this.socket !== socket) return;
    if (socket && this.socket === socket) this.socket = undefined;
    this.connected = false;
    if (this.intentionalDisconnect) return;
    if (!this.initialConnectionSettled) {
      this.initialConnectionSettled = true;
      this.initialReject?.(new Error('The secure session connection could not be authenticated.'));
      this.initialResolve = undefined;
      this.initialReject = undefined;
      const failure: Omit<ActivityEntry, 'ts'> = {
        level: 'error',
        source: 'transport',
        message: 'session connection could not be established',
      };
      if (detail) failure.detail = detail;
      activityLog.append(failure);
      return;
    }
    if (this.permanentFailure) {
      this.notifyFailure(
        `The secure session connection was lost. Local playback was stopped.${detail ? ` (${detail})` : ''}`,
      );
      return;
    }
    if (!this.reconnecting) {
      this.reconnecting = true;
      this.reconnectStartedAt = Date.now();
      this.reconnectAttempt = 0;
      const losing: Omit<ActivityEntry, 'ts'> = {
        level: 'warn',
        source: 'transport',
        message: 'session connection lost; reconnecting',
      };
      if (detail) losing.detail = detail;
      activityLog.append(losing);
      // Browsers throttle timers in hidden tabs, which delays exactly these
      // backoff attempts; retry eagerly when the tab becomes visible or the
      // network comes back.
      this.watchConnectivityRestored();
    }
    this.scheduleReconnect();
  }

  private armHandshakeWatchdog(socket: WebSocket, isAuthenticated: () => boolean): void {
    this.clearHandshakeWatchdog();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined;
      if (isAuthenticated() || this.socket !== socket || this.intentionalDisconnect) return;
      this.handleSocketFailure(socket, 'authentication timed out');
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private clearHandshakeWatchdog(): void {
    if (!this.handshakeTimer) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private watchConnectivityRestored(): void {
    if (this.connectivityListeners) return;
    const subscribe = this.options.subscribeConnectivityHints ?? subscribeBrowserConnectivityHints;
    this.connectivityListeners = subscribe(() => this.retryReconnectImmediately());
  }

  private unwatchConnectivityRestored(): void {
    this.connectivityListeners?.();
    this.connectivityListeners = undefined;
  }

  private retryReconnectImmediately(): void {
    // Only short-circuit a pending backoff delay; if an attempt is already in
    // flight (reconnectTimer undefined) the handshake watchdog bounds it.
    if (!this.reconnecting || !this.reconnectTimer || this.intentionalDisconnect) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    activityLog.append({ level: 'info', source: 'transport', message: 'connectivity restored; retrying immediately' });
    this.openSocket();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalDisconnect || this.failureNotified) return;
    const windowMs = this.options.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS;
    const elapsed = Date.now() - this.reconnectStartedAt;
    if (elapsed >= windowMs) {
      this.reconnecting = false;
      this.unwatchConnectivityRestored();
      this.notifyFailure('The secure session connection could not be restored. Local playback was stopped.');
      return;
    }
    const delays = this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    const delay = Math.min(delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 1_000, windowMs - elapsed);
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        this.reconnectAttempt++;
        this.openSocket();
      },
      Math.max(0, delay),
    );
  }

  private flushQueuedCommands(): void {
    while (this.queuedCommands.length > 0 && this.connected) {
      const command = this.queuedCommands[0]!;
      try {
        this.readySocket().send(command.message);
      } catch {
        this.handleSocketFailure(this.socket, 'command send failed');
        return;
      }
      this.queuedCommands.shift();
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.connected = false;
    this.reconnecting = false;
    this.unwatchConnectivityRestored();
    this.clearHandshakeWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.queuedCommands.length = 0;
    activityLog.append({ level: 'info', source: 'transport', message: 'session socket closed intentionally' });
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, 'session ended');
  }
  /** Pre-live open; planning state arrives as session.state events and the host
   * never opens microphone capture until session.begin. */
  openSession(input: SessionStartRequest): void {
    const payload: BrowserCommandPayload<'session.open'> = {
      sessionSeed: input.sessionSeed,
      reasoningMode: input.reasoningMode,
      settings: input.settings,
    };
    if (input.planning) payload.planning = input.planning;
    this.sendCommand('session.open', payload);
  }
  /** Explicit live transition: sends session.begin and resolves once the host
   * acknowledges the audio engine (or rejects on failure). Retryable while pre-live. */
  beginLive(streamId: number): Promise<void> {
    if (this.pendingAudioStart) return Promise.reject(new Error('another live transition is already in progress'));
    return new Promise<void>((resolve, reject) => {
      this.pendingAudioStart = { streamId, resolve, reject };
      try {
        this.sendCommand('session.begin', { streamId, sampleRate: 16_000, channels: 1, frameSamples: 320 });
      } catch (error) {
        this.pendingAudioStart = undefined;
        reject(error instanceof Error ? error : new Error('the live transition could not start'));
      }
    });
  }
  cancelPlanning(): void {
    this.sendCommand('planning.cancel', { reason: 'user' });
  }
  retryPlanning(): void {
    this.sendCommand('planning.retry', {});
  }
  startAudio(streamId: number): Promise<void> {
    if (this.pendingAudioStart) return Promise.reject(new Error('another microphone warmup is already in progress'));
    return new Promise<void>((resolve, reject) => {
      this.pendingAudioStart = { streamId, resolve, reject };
      try {
        this.sendCommand('audio.start', { streamId, sampleRate: 16_000, channels: 1, frameSamples: 320 });
      } catch (error) {
        this.pendingAudioStart = undefined;
        reject(error instanceof Error ? error : new Error('microphone warmup could not start'));
      }
    });
  }
  stopAudio(streamId: number): void {
    this.sendCommand('audio.stop', { streamId });
  }
  rollbackLive(): void {
    this.sendCommand('session.rollback_begin', {});
  }
  acknowledgePersisted(event: TranscriptFinalEvent): void {
    this.sendCommand(
      'turn.persisted',
      { turnId: event.payload.turnId, finalEventId: event.eventId, persistedEpoch: event.epoch },
      event.epoch,
    );
  }
  acknowledgePersistenceFailed(event: TranscriptFinalEvent, reasonCode: 'quota' | 'unavailable' | 'aborted'): void {
    this.sendCommand(
      'turn.persistence_failed',
      { turnId: event.payload.turnId, finalEventId: event.eventId, persistedEpoch: event.epoch, reasonCode },
      event.epoch,
    );
  }
  stopSession(reason: 'user' | 'expired' | 'disconnect'): void {
    this.sendCommand('session.stop', { reason });
  }
  sendCapture(frame: Uint8Array): void {
    // Capture is intentionally dropped while the transport is reconnecting. The
    // app restarts the capture stream after onReconnect so sequence numbers never
    // resume in the middle of a sidecar stream.
    const socket = this.socket;
    if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(frame);
    } catch {
      this.handleSocketFailure(socket, 'capture send failed');
    }
  }
  sendProgress(progress: PlaybackProgress): void {
    this.sendCommand('playback.progress', { ...progress });
  }
  sendPaused(checkpoint: PlaybackPausedEvent['payload']): void {
    this.sendCommand('playback.paused', checkpoint, checkpoint.outputEpoch);
  }
  sendTerminal(receipt: PlaybackTerminal, persistedEvent?: PlaybackStoppedEvent): void {
    const binding = this.findOutput(receipt.playbackId);
    if (binding && binding.outputEpoch === receipt.cancelledEpoch) binding.terminal = true;
    const terminalKey = `${receipt.cancelledEpoch}:${receipt.playbackId}`;
    let envelope = this.terminalEnvelopes.get(terminalKey);
    if (!envelope) {
      envelope = persistedEvent
        ? { ...persistedEvent, payload: { ...receipt } }
        : createEnvelope({
            sessionId: this.sessionId,
            epoch: this.epoch(),
            type: 'playback.stopped',
            payload: { ...receipt },
          });
      this.terminalEnvelopes.set(terminalKey, envelope);
    }
    this.sendWire(JSON.stringify(envelope), 'playback.stopped', `playback.stopped:${terminalKey}`);
  }
  cancelAssistant(): void {
    this.sendCommand('turn.cancel', { reason: 'user' });
  }
  private latestResponseId: string | undefined;
  onEvent(listener: (event: HostEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onAudio(listener: (chunk: OutputAudioChunk) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }
  onFailure(listener: (message: string) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }
  onReconnect(listener: () => void | Promise<void>): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  private handleBinary(data: ArrayBuffer): void {
    let frame;
    try {
      frame = decodeBinaryAudioFrame(new Uint8Array(data), MAX_BINARY_PAYLOAD);
    } catch {
      this.protocolFailure('a binary audio frame could not be decoded.');
      return;
    }
    const output =
      this.outputs.byStream.get(frame.streamId) ??
      (this.outputs.single &&
      (this.outputs.single.streamId === undefined || this.outputs.single.streamId === frame.streamId)
        ? this.outputs.single
        : undefined);
    if (!output || output.terminal || frame.channel !== 2) {
      this.protocolFailure('a binary audio frame did not match the active output stream.');
      return;
    }
    if (output.streamId === undefined) {
      if (this.usedOutputStreams.has(frame.streamId)) {
        this.protocolFailure('the host reused an output stream id.');
        return;
      }
      output.streamId = frame.streamId;
      this.usedOutputStreams.add(frame.streamId);
    }
    if (frame.streamId !== output.streamId || frame.sequence !== output.expectedSequence) {
      this.protocolFailure('a binary audio frame had an unexpected stream id or sequence.');
      return;
    }
    if (frame.sequence === 0 && output.partIndex !== undefined) {
      activityLog.append({
        level: 'info',
        source: 'transport',
        message: `part ${output.partIndex} first audio`,
        detail: `${Date.now() - output.receivedAt}ms`,
      });
    }
    const chunk: OutputAudioChunk = {
      playbackId: output.playbackId,
      sequence: frame.sequence,
      sampleOffset: output.sampleOffset,
      pcm16: frame.pcm16,
    };
    output.expectedSequence++;
    output.sampleOffset += frame.pcm16.length;
    for (const listener of this.audioListeners) listener(chunk);
  }
  private findOutput(playbackId: string): OutputBinding | undefined {
    for (const binding of this.outputs.byStream.values()) if (binding.playbackId === playbackId) return binding;
    return this.outputs.single?.playbackId === playbackId ? this.outputs.single : undefined;
  }
  private markResponseOutputsTerminal(responseId: string): boolean {
    let matched = false;
    for (const binding of this.outputs.byStream.values()) {
      if (binding.responseId !== responseId) continue;
      binding.terminal = true;
      matched = true;
    }
    if (this.outputs.single?.responseId === responseId) {
      this.outputs.single.terminal = true;
      matched = true;
    }
    return matched;
  }
  private sendCommand<T extends BrowserCommand['type']>(
    type: T,
    payload: BrowserCommandPayload<T>,
    epoch = this.epoch(),
  ): void {
    // SAFETY: the ternary guard narrows `type` to 'playback.progress' before
    // the payload is read through the playback.progress contract, so the
    // assertion only ever applies to a payload of that exact event type.
    const progress = type === 'playback.progress' ? (payload as BrowserCommandPayload<'playback.progress'>) : undefined;
    const key = progress
      ? `playback.progress:${String(progress.playbackId)}:${String(progress.outputEpoch)}`
      : undefined;
    this.sendWire(JSON.stringify(createEnvelope({ sessionId: this.sessionId, epoch, type, payload })), type, key);
  }
  private sendWire(message: string, type = 'control', key?: string): void {
    const queued: QueuedCommand = { message, type };
    if (key) queued.key = key;
    if (!this.connected) {
      if (!this.reconnecting) throw new Error('Session transport is not connected.');
      this.queueCommand(queued);
      return;
    }
    try {
      this.readySocket().send(message);
    } catch {
      this.queueCommand(queued);
      this.handleSocketFailure(this.socket, 'command send failed');
    }
  }
  private queueCommand(command: QueuedCommand): void {
    if (command.key) {
      const existing = this.queuedCommands.findIndex((item) => item.key === command.key);
      if (existing >= 0) {
        this.queuedCommands[existing] = command;
        return;
      }
    }
    if (this.queuedCommands.length >= MAX_QUEUED_COMMANDS) {
      const progress = this.queuedCommands.findIndex((item) => item.type === 'playback.progress');
      if (progress >= 0) this.queuedCommands.splice(progress, 1);
      else {
        this.notifyFailure('The secure session connection backlog could not be recovered safely.');
        return;
      }
    }
    this.queuedCommands.push(command);
  }
  private protocolFailure(reason: string): void {
    this.permanentFailure = true;
    this.pendingAudioStart?.reject(new Error(`The host sent invalid conversation data: ${reason}`));
    this.pendingAudioStart = undefined;
    activityLog.append({ level: 'error', source: 'transport', message: 'protocol failure', detail: reason });
    this.notifyFailure(`The host sent invalid conversation data: ${reason}`);
    // close() with a server-only code would throw InvalidAccessError inside
    // onmessage; guard on OPEN and swallow anything close() itself throws so
    // a protocol violation can never escape as an uncaught browser error.
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.close(CLOSE_PROTOCOL_VIOLATION, 'invalid host conversation protocol');
      } catch {
        /* never escape onmessage */
      }
    }
  }
  private notifyFailure(message: string): void {
    this.pendingAudioStart?.reject(new Error(message));
    this.pendingAudioStart = undefined;
    if (this.failureNotified || this.intentionalDisconnect) return;
    this.failureNotified = true;
    for (const listener of this.failureListeners) listener(message);
  }
  private readySocket(): WebSocket {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Session transport is not connected.');
    return this.socket;
  }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The sidecar stream id is generated host-side with node:crypto randomUUID() (UUIDv4),
// so VAD streamIds accept any RFC 4122 UUID version (v1-v8), not just v7.
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exact(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function hasOnly(value: JsonObject, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}
function integer(value: JsonValue | undefined): value is number {
  return isJsonNumber(value) && Number.isSafeInteger(value) && Number(value) >= 0;
}
function partOk(value: JsonObject): boolean {
  const index = value.partIndex;
  const partId = value.partId;
  if (index === undefined && partId === undefined) return true;
  if (index === undefined || !integer(index) || Number(index) > 7) return false;
  if (partId !== undefined && (!isJsonString(partId) || !UUID_ANY.test(partId))) return false;
  return true;
}
function modelIdentityOk(value: JsonObject): boolean {
  const backendId = value.backendId;
  const modelId = value.modelId;
  if (backendId === undefined && modelId === undefined) return true;
  return isJsonString(backendId) && backendId.length > 0 && isJsonString(modelId) && modelId.length > 0;
}

/** Validates only the canonical HostEvent contract. */
function isCanonicalHostEvent(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false;
  const event = value;
  if (
    !exact(event, ['protocolVersion', 'sessionId', 'epoch', 'eventId', 'type', 'monotonicMs', 'payload']) ||
    event.protocolVersion !== 1 ||
    !isJsonString(event.sessionId) ||
    !UUID_V7.test(event.sessionId) ||
    !integer(event.epoch) ||
    !isJsonString(event.eventId) ||
    !UUID_V7.test(event.eventId) ||
    !isJsonString(event.type) ||
    event.type.length === 0 ||
    !isJsonNumber(event.monotonicMs) ||
    event.monotonicMs < 0 ||
    !isJsonObject(event.payload)
  )
    return false;
  const payload = event.payload;
  const uuid = (key: string): boolean => {
    const candidate = payload[key];
    return isJsonString(candidate) && UUID_ANY.test(candidate);
  };
  const anyUuid = uuid;
  switch (event.type) {
    case 'session.state': {
      if (
        !hasOnly(payload, ['phase', 'personaDigest'], ['audio', 'planning']) ||
        ![
          'idle',
          'preparing',
          'prelive',
          'starting_live',
          'planning',
          'ready',
          'listening',
          'deciding',
          'reasoning',
          'synthesizing',
          'playing',
          'echo_provisional',
          'interruption_deciding',
          'stopped',
        ].includes(String(payload.phase)) ||
        !isJsonString(payload.personaDigest) ||
        !/^[a-f0-9]{64}$/.test(payload.personaDigest)
      )
        return false;
      if (payload.audio !== undefined) {
        if (!isJsonObject(payload.audio)) return false;
        const audio = payload.audio;
        if (
          !hasOnly(audio, ['status', 'capture', 'vad', 'tts'], ['detail']) ||
          !['starting', 'warming', 'ready', 'failed', 'retrying'].includes(String(audio.status)) ||
          !['starting', 'ready', 'failed'].includes(String(audio.capture)) ||
          !['starting', 'warming', 'ready', 'failed'].includes(String(audio.vad)) ||
          !['starting', 'warming', 'ready', 'failed'].includes(String(audio.tts)) ||
          (audio.detail !== undefined && (!isJsonString(audio.detail) || audio.detail.length > 512))
        )
          return false;
      }
      if (payload.planning === undefined) return true;
      if (!isJsonObject(payload.planning)) return false;
      const planning = payload.planning;
      return (
        hasOnly(
          planning,
          ['status', 'attempt'],
          ['topic', 'depth', 'stage', 'deadlineMs', 'reasonCode', 'detail', 'notes'],
        ) &&
        ['skipped', 'planning', 'ready', 'failed', 'cancelled', 'continued'].includes(String(planning.status)) &&
        integer(planning.attempt) &&
        (planning.stage === undefined || ['starting', 'researching', 'finalizing'].includes(String(planning.stage))) &&
        (planning.deadlineMs === undefined || integer(planning.deadlineMs)) &&
        (planning.reasonCode === undefined ||
          ['timeout', 'provider_unavailable', 'invalid_result', 'interrupted'].includes(String(planning.reasonCode))) &&
        (planning.topic === undefined ||
          (isJsonString(planning.topic) &&
            planning.topic.length > 0 &&
            new TextEncoder().encode(planning.topic).length <= 2048)) &&
        (planning.depth === undefined || ['light', 'standard', 'deep'].includes(String(planning.depth))) &&
        (planning.detail === undefined || (isJsonString(planning.detail) && planning.detail.length <= 512)) &&
        (planning.notes === undefined ||
          (isJsonString(planning.notes) && new TextEncoder().encode(planning.notes).length <= 12_288))
      );
    }
    case 'transcript.partial':
      return (
        exact(payload, ['utteranceId', 'sequence', 'text', 'replacedCharacters']) &&
        uuid('utteranceId') &&
        integer(payload.sequence) &&
        isJsonString(payload.text) &&
        payload.text.length <= 16_384 &&
        integer(payload.replacedCharacters)
      );
    case 'transcript.final':
      return (
        exact(payload, ['turnId', 'text', 'endpointComplete']) &&
        uuid('turnId') &&
        isJsonString(payload.text) &&
        payload.text.length <= 16_384 &&
        payload.endpointComplete === true
      );
    case 'vad.speech_start':
      return (
        exact(payload, ['streamId', 'utteranceId', 'captureStartSequence']) &&
        anyUuid('streamId') &&
        uuid('utteranceId') &&
        integer(payload.captureStartSequence)
      );
    case 'vad.speech_end':
      return (
        exact(payload, ['streamId', 'utteranceId', 'captureStartSequence', 'captureEndSequence']) &&
        anyUuid('streamId') &&
        uuid('utteranceId') &&
        integer(payload.captureStartSequence) &&
        integer(payload.captureEndSequence)
      );
    case 'policy.decision':
      return (
        exact(payload, ['turnId', 'policyVersion', 'eligible', 'posture', 'reasonCodes', 'inputDigest']) &&
        uuid('turnId') &&
        payload.policyVersion === 'v1.experimental' &&
        isJsonBoolean(payload.eligible) &&
        ['riff', 'question', 'challenge', 'silence'].includes(String(payload.posture)) &&
        isJsonArray(payload.reasonCodes) &&
        payload.reasonCodes.length > 0 &&
        payload.reasonCodes.every((code) => isJsonString(code) && code.length > 0) &&
        isJsonString(payload.inputDigest) &&
        /^[a-f0-9]{64}$/.test(payload.inputDigest)
      );
    case 'reasoning.started':
      return (
        hasOnly(payload, ['turnId', 'responseId', 'posture'], ['partIndex', 'partId']) &&
        uuid('turnId') &&
        uuid('responseId') &&
        ['riff', 'question', 'challenge'].includes(String(payload.posture)) &&
        partOk(payload)
      );
    case 'reasoning.delta':
      return (
        hasOnly(payload, ['turnId', 'responseId', 'text'], ['partIndex', 'partId']) &&
        uuid('turnId') &&
        uuid('responseId') &&
        isJsonString(payload.text) &&
        payload.text.length > 0 &&
        payload.text.length <= 4_096 &&
        partOk(payload)
      );
    case 'response.cancelled':
      return (
        exact(payload, ['turnId', 'responseId', 'reason']) &&
        uuid('turnId') &&
        uuid('responseId') &&
        ['superseded', 'user', 'stopped'].includes(String(payload.reason))
      );
    case 'response.failed':
      return (
        hasOnly(payload, ['turnId', 'responseId', 'reasonCode'], ['partIndex', 'partId']) &&
        uuid('turnId') &&
        uuid('responseId') &&
        ['reasoning_unavailable', 'reasoning_invalid', 'tts_failed'].includes(String(payload.reasonCode)) &&
        partOk(payload)
      );
    case 'reasoning.final':
      return (
        hasOnly(payload, ['turnId', 'responseId', 'posture', 'text'], ['partIndex', 'partId']) &&
        uuid('turnId') &&
        uuid('responseId') &&
        ['riff', 'question', 'challenge'].includes(String(payload.posture)) &&
        isJsonString(payload.text) &&
        payload.text.length > 0 &&
        payload.text.length <= 4_096 &&
        partOk(payload)
      );
    case 'tts.started':
      return (
        hasOnly(
          payload,
          ['responseId', 'playbackId', 'sampleRate'],
          ['backendId', 'modelId', 'outputStreamId', 'partIndex', 'partId'],
        ) &&
        uuid('responseId') &&
        uuid('playbackId') &&
        integer(payload.sampleRate) &&
        Number(payload.sampleRate) > 0 &&
        (payload.outputStreamId === undefined ||
          (integer(payload.outputStreamId) && Number(payload.outputStreamId) <= 4_294_967_295)) &&
        (payload.partIndex === undefined || payload.outputStreamId !== undefined) &&
        modelIdentityOk(payload) &&
        partOk(payload)
      );
    case 'tts.ended':
      return (
        hasOnly(payload, ['responseId', 'playbackId', 'generatedSamples'], ['partIndex', 'partId']) &&
        uuid('responseId') &&
        uuid('playbackId') &&
        integer(payload.generatedSamples) &&
        partOk(payload)
      );
    case 'response.part_started':
    case 'response.part_final':
      return (
        hasOnly(payload, ['turnId', 'responseId', 'partIndex', 'kind'], ['partId']) &&
        uuid('turnId') &&
        uuid('responseId') &&
        integer(payload.partIndex) &&
        Number(payload.partIndex) <= 7 &&
        ['stall', 'body'].includes(String(payload.kind)) &&
        (payload.partId === undefined || (isJsonString(payload.partId) && UUID_ANY.test(payload.partId))) &&
        ((payload.kind === 'stall' && payload.partIndex === 0) ||
          (payload.kind === 'body' && Number(payload.partIndex) >= 1))
      );
    case 'barge_in.provisional':
    case 'barge_in.confirmed':
    case 'barge_in.rejected':
    case 'barge_in.timed_out':
      return (
        hasOnly(
          payload,
          ['responseId', 'outputEpoch', 'resumable'],
          ['rewindMs', 'partIndex', 'partId', 'playbackId'],
        ) &&
        uuid('responseId') &&
        integer(payload.outputEpoch) &&
        isJsonBoolean(payload.resumable) &&
        (payload.rewindMs === undefined || (integer(payload.rewindMs) && Number(payload.rewindMs) <= 1_000)) &&
        partOk(payload) &&
        (payload.playbackId === undefined || uuid('playbackId'))
      );
    case 'interruption.decision':
      return (
        hasOnly(
          payload,
          [
            'turnId',
            'responseId',
            'playbackId',
            'outputEpoch',
            'action',
            'intent',
            'confidence',
            'disposition',
            'pausedSampleOffset',
          ],
          ['rewindMs', 'partIndex', 'partId'],
        ) &&
        uuid('turnId') &&
        uuid('responseId') &&
        uuid('playbackId') &&
        integer(payload.outputEpoch) &&
        ['resume', 'accept'].includes(String(payload.action)) &&
        ['non_substantive', 'continue_previous', 'new_request', 'correction', 'topic_change', 'stop_previous'].includes(
          String(payload.intent),
        ) &&
        ['low', 'medium', 'high'].includes(String(payload.confidence)) &&
        ['resume_noise', 'resume_fragment', 'resume_requested', 'accept_takeover'].includes(
          String(payload.disposition),
        ) &&
        integer(payload.pausedSampleOffset) &&
        (payload.rewindMs === undefined || (integer(payload.rewindMs) && Number(payload.rewindMs) <= 1_000)) &&
        partOk(payload)
      );
    case 'failure':
      return (
        exact(payload, ['code', 'detail', 'correctiveAction', 'recoverable']) &&
        isJsonString(payload.code) &&
        payload.code.length > 0 &&
        isJsonString(payload.detail) &&
        payload.detail.length > 0 &&
        isJsonString(payload.correctiveAction) &&
        payload.correctiveAction.length > 0 &&
        isJsonBoolean(payload.recoverable)
      );
    case 'tool.activity': {
      if (
        !hasOnly(
          payload,
          ['scope', 'toolCallId', 'toolName', 'status'],
          ['turnId', 'responseId', 'summary', 'durationMs'],
        ) ||
        !['planning', 'turn'].includes(String(payload.scope)) ||
        !isJsonString(payload.toolCallId) ||
        payload.toolCallId.length === 0 ||
        new TextEncoder().encode(payload.toolCallId).length > 128 ||
        !isJsonString(payload.toolName) ||
        payload.toolName.length === 0 ||
        new TextEncoder().encode(payload.toolName).length > 64 ||
        !['started', 'ended', 'failed'].includes(String(payload.status))
      )
        return false;
      if (
        payload.summary !== undefined &&
        (!isJsonString(payload.summary) || new TextEncoder().encode(payload.summary).length > 160)
      )
        return false;
      if (payload.durationMs !== undefined && !integer(payload.durationMs)) return false;
      if (payload.turnId !== undefined && !uuid('turnId')) return false;
      if (payload.responseId !== undefined && !uuid('responseId')) return false;
      if (payload.scope === 'turn' && (payload.turnId === undefined || payload.responseId === undefined)) return false;
      return true;
    }
    default:
      return false;
  }
}

/**
 * The schema check is deliberately separate from the stateful identity and
 * sequence checks performed by the transport message handler above.
 */
export function isStrictHostEvent(value: JsonValue): value is HostEvent {
  return isCanonicalHostEvent(value);
}
