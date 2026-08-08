import { decodeBinaryAudioFrame } from '@app/contracts/binary';
import type { PlaybackProgress, PlaybackTerminal } from '../audio/playback-ledger';
import type { StableEvent } from '../storage/stable-turn-writer';
import { createEnvelope, type Envelope } from './envelope';
import type { OutputAudioChunk, SessionTransport } from './transport';

const MAX_BINARY_PAYLOAD = 64 * 1024 - 20;
interface OutputBinding { playbackId: string; outputEpoch: number; streamId?: number; expectedSequence: number; sampleOffset: number; terminal: boolean }

export class WebSocketSessionTransport implements SessionTransport {
  private socket: WebSocket | undefined;
  private readonly eventListeners = new Set<(event: StableEvent) => void | Promise<void>>();
  private readonly audioListeners = new Set<(chunk: OutputAudioChunk) => void>();
  private readonly failureListeners = new Set<(message: string) => void>();
  private readonly terminalEnvelopes = new Map<string, Envelope>();
  private readonly usedOutputStreams = new Set<number>();
  private output: OutputBinding | undefined;
  private intentionalDisconnect = false;
  private failureNotified = false;

  constructor(private readonly sessionId: string, private readonly epoch: () => number, private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url)) {}

  connect(capability: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = this.createSocket(`${protocol}//${location.host}/ws`);
      this.socket = socket;
      let settled = false;
      const fail = () => {
        if (!settled) { settled = true; reject(new Error('The secure session connection could not be authenticated.')); }
        else this.notifyFailure('The secure session connection was lost. Local playback was stopped.');
      };
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(JSON.stringify({ capability }));
      socket.onerror = fail;
      socket.onclose = () => { if (!this.intentionalDisconnect) fail(); };
      socket.onmessage = message => {
        if (typeof message.data !== 'string') { this.handleBinary(message.data); return; }
        let value: unknown;
        try { value = JSON.parse(message.data); } catch { this.protocolFailure(); return; }
        if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'authenticated') { if (!settled) { settled = true; resolve(); } return; }
        if (!isStrictHostEvent(value)) { this.protocolFailure(); return; }
        const hostEvent = value as StableEvent;
        if (hostEvent.sessionId !== this.sessionId) { this.protocolFailure(); return; }
        if (hostEvent.type === 'tts.started') {
          if (hostEvent.epoch !== this.epoch() || hostEvent.payload.responseId !== this.latestResponseId || (this.output && !this.output.terminal)) { this.protocolFailure(); return; }
          this.output = { playbackId: String(hostEvent.payload.playbackId), outputEpoch: hostEvent.epoch, expectedSequence: 0, sampleOffset: 0, terminal: false };
        } else if (hostEvent.type === 'tts.ended') {
          if (!this.output || this.output.playbackId !== hostEvent.payload.playbackId || this.output.outputEpoch !== hostEvent.epoch) { this.protocolFailure(); return; }
          this.output.terminal = true;
          const generated = Number(hostEvent.payload.generatedSamples);
          if (generated !== this.output.sampleOffset) { this.protocolFailure(); return; }
        }
        for (const listener of this.eventListeners) void listener(hostEvent);
      };
    });
  }

  disconnect(): void { this.intentionalDisconnect = true; this.socket?.close(1000, 'session ended'); this.socket = undefined; }
  startSession(sessionSeed: string, reasoningMode: 'full' | 'transcript_only'): void { this.sendCommand('session.start', { sessionSeed, reasoningMode }); }
  startAudio(streamId: number): void { this.sendCommand('audio.start', { streamId, sampleRate: 16_000, channels: 1, frameSamples: 320 }); }
  stopAudio(streamId: number): void { this.sendCommand('audio.stop', { streamId }); }
  acknowledgePersisted(event: StableEvent): void {
    this.sendCommand('turn.persisted', { turnId: event.payload.turnId, finalEventId: event.eventId, persistedEpoch: event.epoch }, event.epoch);
  }
  acknowledgePersistenceFailed(event: StableEvent, reasonCode: 'quota' | 'unavailable' | 'aborted'): void {
    this.sendCommand('turn.persistence_failed', { turnId: event.payload.turnId, finalEventId: event.eventId, persistedEpoch: event.epoch, reasonCode }, event.epoch);
  }
  stopSession(reason: 'user' | 'expired' | 'disconnect'): void { this.sendCommand('session.stop', { reason }); }
  sendCapture(frame: Uint8Array): void { this.readySocket().send(frame); }
  sendProgress(progress: PlaybackProgress): void { this.sendCommand('playback.progress', { ...progress }); }
  sendPaused(checkpoint: { responseId: string; playbackId: string; outputEpoch: number; pausedSampleOffset: number; generatedSamples: number }): void { this.sendCommand('playback.paused', checkpoint, checkpoint.outputEpoch); }
  sendTerminal(receipt: PlaybackTerminal, persistedEvent?: StableEvent): void {
    const output = this.output;
    if (output && output.playbackId === receipt.playbackId && output.outputEpoch === receipt.cancelledEpoch) output.terminal = true;
    const terminalKey = `${receipt.cancelledEpoch}:${receipt.playbackId}`;
    let envelope = this.terminalEnvelopes.get(terminalKey);
    if (!envelope) {
      envelope = persistedEvent?.type === 'playback.stopped'
        ? { protocolVersion: 1, sessionId: persistedEvent.sessionId, epoch: persistedEvent.epoch, eventId: persistedEvent.eventId, type: 'playback.stopped', monotonicMs: persistedEvent.monotonicMs, payload: { ...receipt } }
        : createEnvelope({ sessionId: this.sessionId, epoch: this.epoch(), type: 'playback.stopped', payload: { ...receipt } });
      this.terminalEnvelopes.set(terminalKey, envelope);
    }
    this.readySocket().send(JSON.stringify(envelope));
  }
  cancelAssistant(): void { this.sendCommand('turn.cancel', { reason: 'user' }); }
  confirmBargeIn(): void {
    const output = this.output;
    const responseId = this.latestResponseId;
    if (!output || !responseId) return;
    this.sendCommand('barge_in.confirm', { responseId, outputEpoch: output.outputEpoch });
  }
  rejectBargeIn(): void {
    const output = this.output;
    const responseId = this.latestResponseId;
    if (!output || !responseId) return;
    this.sendCommand('barge_in.reject', { responseId, outputEpoch: output.outputEpoch });
  }
  private latestResponseId: string | undefined;
  onEvent(listener: (event: StableEvent) => void | Promise<void>): () => void {
    const wrapped = (event: StableEvent) => { if (event.type === 'reasoning.final' && typeof event.payload.responseId === 'string') this.latestResponseId = event.payload.responseId; return listener(event); };
    this.eventListeners.add(wrapped);
    return () => this.eventListeners.delete(wrapped);
  }
  onAudio(listener: (chunk: OutputAudioChunk) => void): () => void { this.audioListeners.add(listener); return () => this.audioListeners.delete(listener); }
  onFailure(listener: (message: string) => void): () => void { this.failureListeners.add(listener); return () => this.failureListeners.delete(listener); }

  private handleBinary(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) { this.protocolFailure(); return; }
    let frame;
    try { frame = decodeBinaryAudioFrame(new Uint8Array(data), MAX_BINARY_PAYLOAD); } catch { this.protocolFailure(); return; }
    const output = this.output;
    if (!output || output.terminal || frame.channel !== 2) { this.protocolFailure(); return; }
    if (output.streamId === undefined) {
      if (this.usedOutputStreams.has(frame.streamId)) { this.protocolFailure(); return; }
      output.streamId = frame.streamId;
      this.usedOutputStreams.add(frame.streamId);
    }
    if (frame.streamId !== output.streamId || frame.sequence !== output.expectedSequence) { this.protocolFailure(); return; }
    const chunk: OutputAudioChunk = { playbackId: output.playbackId, sequence: frame.sequence, sampleOffset: output.sampleOffset, pcm16: frame.pcm16 };
    output.expectedSequence++;
    output.sampleOffset += frame.pcm16.length;
    for (const listener of this.audioListeners) listener(chunk);
  }
  private sendCommand(type: string, payload: Record<string, unknown>, epoch = this.epoch()): void {
    this.readySocket().send(JSON.stringify(createEnvelope({ sessionId: this.sessionId, epoch, type, payload })));
  }
  private protocolFailure(): void {
    this.notifyFailure('The host sent invalid conversation data. Local playback was stopped.');
    this.socket?.close(1008, 'invalid host conversation protocol');
  }
  private notifyFailure(message: string): void {
    if (this.failureNotified || this.intentionalDisconnect) return;
    this.failureNotified = true;
    for (const listener of this.failureListeners) listener(message);
  }
  private readySocket(): WebSocket { if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Session transport is not connected.'); return this.socket; }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function isStrictHostEvent(value: unknown): value is StableEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (!exact(event, ['protocolVersion', 'sessionId', 'epoch', 'eventId', 'type', 'monotonicMs', 'payload'])
    || event.protocolVersion !== 1 || typeof event.sessionId !== 'string' || !UUID_V7.test(event.sessionId)
    || !integer(event.epoch) || typeof event.eventId !== 'string' || !UUID_V7.test(event.eventId)
    || typeof event.type !== 'string' || typeof event.monotonicMs !== 'number' || event.monotonicMs < 0
    || typeof event.payload !== 'object' || event.payload === null) return false;
  const payload = event.payload as Record<string, unknown>;
  const uuid = (key: string) => typeof payload[key] === 'string' && UUID_V7.test(String(payload[key]));
  switch (event.type) {
    case 'session.state': return exact(payload, ['phase', 'personaDigest']) && typeof payload.phase === 'string' && typeof payload.personaDigest === 'string' && /^[a-f0-9]{64}$/.test(payload.personaDigest);
    case 'transcript.partial': return exact(payload, ['utteranceId', 'sequence', 'text', 'replacedCharacters']) && uuid('utteranceId') && integer(payload.sequence) && typeof payload.text === 'string' && payload.text.length <= 16_384 && integer(payload.replacedCharacters);
    case 'transcript.final': return exact(payload, ['turnId', 'text', 'endpointComplete']) && uuid('turnId') && typeof payload.text === 'string' && payload.text.length <= 16_384 && payload.endpointComplete === true;
    case 'policy.decision': return exact(payload, ['turnId', 'policyVersion', 'eligible', 'posture', 'reasonCodes', 'inputDigest']) && uuid('turnId') && payload.policyVersion === 'v1.experimental' && typeof payload.eligible === 'boolean' && ['riff', 'question', 'challenge', 'silence'].includes(String(payload.posture)) && Array.isArray(payload.reasonCodes) && payload.reasonCodes.length > 0 && payload.reasonCodes.every(code => typeof code === 'string' && code.length > 0) && typeof payload.inputDigest === 'string' && /^[a-f0-9]{64}$/.test(payload.inputDigest);
    case 'reasoning.final': return exact(payload, ['turnId', 'responseId', 'posture', 'text']) && uuid('turnId') && uuid('responseId') && ['riff', 'question', 'challenge'].includes(String(payload.posture)) && typeof payload.text === 'string' && payload.text.length > 0 && payload.text.length <= 4_096;
    case 'tts.started': return exact(payload, ['responseId', 'playbackId', 'sampleRate']) && uuid('responseId') && uuid('playbackId') && integer(payload.sampleRate) && Number(payload.sampleRate) > 0;
    case 'tts.ended': return exact(payload, ['responseId', 'playbackId', 'generatedSamples']) && uuid('responseId') && uuid('playbackId') && integer(payload.generatedSamples);
    case 'barge_in.provisional': case 'barge_in.confirmed': case 'barge_in.rejected': case 'barge_in.timed_out': return exact(payload, ['responseId', 'outputEpoch', 'resumable']) && uuid('responseId') && integer(payload.outputEpoch) && typeof payload.resumable === 'boolean';
    case 'interruption.decision': return exact(payload, ['turnId', 'responseId', 'playbackId', 'outputEpoch', 'action', 'intent', 'confidence', 'disposition', 'pausedSampleOffset']) && uuid('turnId') && uuid('responseId') && uuid('playbackId') && integer(payload.outputEpoch) && ['resume', 'accept'].includes(String(payload.action)) && ['non_substantive', 'continue_previous', 'new_request', 'correction', 'topic_change', 'stop_previous'].includes(String(payload.intent)) && ['low', 'medium', 'high'].includes(String(payload.confidence)) && ['resume_noise', 'resume_fragment', 'resume_requested', 'accept_takeover'].includes(String(payload.disposition)) && integer(payload.pausedSampleOffset);
    case 'failure': return exact(payload, ['code', 'detail', 'correctiveAction', 'recoverable']) && typeof payload.code === 'string' && payload.code.length > 0 && typeof payload.detail === 'string' && payload.detail.length > 0 && typeof payload.correctiveAction === 'string' && payload.correctiveAction.length > 0 && typeof payload.recoverable === 'boolean';
    default: return false;
  }
}
