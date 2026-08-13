import { decodeBinaryAudioFrame } from '@app/contracts/binary';
import type { PlaybackProgress, PlaybackTerminal } from '../audio/playback-ledger';
import type { StableEvent } from '../storage/stable-turn-writer';
import { activityLog } from './activity-log';
import { createEnvelope, type Envelope } from './envelope';
import type { OutputAudioChunk, SessionTransport } from './transport';

const MAX_BINARY_PAYLOAD = 64 * 1024 - 20;
// Close codes in 3000-4999 are application-defined and valid for a browser
// WebSocket *client* to send. 1008/1011 are server-only and a browser client
// that tries to send them throws InvalidAccessError inside onmessage.
const CLOSE_PROTOCOL_VIOLATION = 4000;
interface OutputBinding { playbackId: string; responseId: string; outputEpoch: number; streamId?: number; partIndex?: number; expectedSequence: number; sampleOffset: number; terminal: boolean; receivedAt: number }

interface OutputCollection {
  // Multi-part responses key bindings by the sidecar outputStreamId; the legacy
  // single-output path uses the single slot below.
  byStream: Map<number, OutputBinding>;
  single: OutputBinding | undefined;
}

export class WebSocketSessionTransport implements SessionTransport {
  private socket: WebSocket | undefined;
  private readonly eventListeners = new Set<(event: StableEvent) => void | Promise<void>>();
  private readonly audioListeners = new Set<(chunk: OutputAudioChunk) => void>();
  private readonly failureListeners = new Set<(message: string) => void>();
  private readonly terminalEnvelopes = new Map<string, Envelope>();
  private readonly usedOutputStreams = new Set<number>();
  private readonly outputs: OutputCollection = { byStream: new Map(), single: undefined };
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
        if (!settled) {
          settled = true;
          activityLog.append({ level: 'error', source: 'transport', message: 'session connection could not be established' });
          reject(new Error('The secure session connection could not be authenticated.'));
        } else if (!this.failureNotified && !this.intentionalDisconnect) {
          activityLog.append({ level: 'error', source: 'transport', message: 'session connection lost' });
          this.notifyFailure('The secure session connection was lost. Local playback was stopped.');
        }
      };
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => { activityLog.append({ level: 'info', source: 'transport', message: 'session socket opened' }); socket.send(JSON.stringify({ capability })); };
      socket.onerror = fail;
      socket.onclose = () => { if (!this.intentionalDisconnect) fail(); };
      socket.onmessage = message => {
        if (typeof message.data !== 'string') { this.handleBinary(message.data); return; }
        let value: unknown;
        try { value = JSON.parse(message.data); } catch { this.protocolFailure('the message was not valid JSON.'); return; }
        if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'authenticated') { if (!settled) { settled = true; resolve(); } return; }
        if (!isStrictHostEvent(value)) {
          const type = typeof value === 'object' && value !== null ? String((value as { type?: unknown }).type ?? 'unknown') : 'unknown';
          this.protocolFailure(`the "${type}" event failed validation.`);
          return;
        }
        const hostEvent = value as StableEvent;
        if (hostEvent.sessionId !== this.sessionId) { this.protocolFailure('the event sessionId did not match this session.'); return; }
        if (hostEvent.type === 'reasoning.started') {
          const responseId = String(hostEvent.payload.responseId);
          const partIndex = typeof hostEvent.payload.partIndex === 'number' ? hostEvent.payload.partIndex : undefined;
          if (this.latestResponseId !== undefined) {
            // A duplicate reasoning.started for the SAME response is a protocol anomaly
            // unless it starts a new part of a multi-part response.
            if (responseId === this.latestResponseId && partIndex === undefined) { this.protocolFailure('a duplicate reasoning.started was received for the current response.'); return; }
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
          if (hostEvent.payload.responseId !== this.latestResponseId) { this.protocolFailure('reasoning.delta did not match the established response.'); return; }
        } else if (hostEvent.type === 'reasoning.final') {
          if (hostEvent.payload.responseId !== this.latestResponseId) { this.protocolFailure('reasoning.final did not match the established response.'); return; }
        } else if (hostEvent.type === 'response.part_started') {
          const responseId = String(hostEvent.payload.responseId);
          activityLog.append({ level: 'info', source: 'transport', message: `part ${String(hostEvent.payload.kind)} ${String(hostEvent.payload.partIndex)} started` });
          // A part_started may be the FIRST event of a new response (the host emits
          // it before reasoning.started). If it belongs to a different response
          // than the one currently established, the previous response was
          // superseded before it terminalized and its output bindings are dead.
          if (this.latestResponseId !== undefined && responseId !== this.latestResponseId) {
            for (const binding of this.outputs.byStream.values()) binding.terminal = true;
            if (this.outputs.single) this.outputs.single.terminal = true;
          }
          this.latestResponseId = responseId;
        } else if (hostEvent.type === 'response.part_final') {
          // A part_final must follow that part's reasoning.started/final, so keep strict matching.
          if (hostEvent.payload.responseId !== this.latestResponseId) { this.protocolFailure('response.part_final did not match the established response.'); return; }
          activityLog.append({ level: 'info', source: 'transport', message: `part ${String(hostEvent.payload.kind)} ${String(hostEvent.payload.partIndex)} final` });
        } else if (hostEvent.type === 'tts.started') {
          if (hostEvent.epoch !== this.epoch() || hostEvent.payload.responseId !== this.latestResponseId) { this.protocolFailure('tts.started did not match the established response identity.'); return; }
          const outputStreamId = typeof hostEvent.payload.outputStreamId === 'number' ? hostEvent.payload.outputStreamId : undefined;
          const partIndex = typeof hostEvent.payload.partIndex === 'number' ? hostEvent.payload.partIndex : undefined;
          const binding: OutputBinding = { playbackId: String(hostEvent.payload.playbackId), responseId: String(hostEvent.payload.responseId), outputEpoch: hostEvent.epoch, expectedSequence: 0, sampleOffset: 0, terminal: false, receivedAt: Date.now(), ...(outputStreamId !== undefined ? { streamId: outputStreamId } : {}), ...(partIndex !== undefined ? { partIndex } : {}) };
          if (outputStreamId !== undefined) {
            if (this.outputs.byStream.has(outputStreamId) || this.usedOutputStreams.has(outputStreamId)) { this.protocolFailure('tts.started reused an output stream id.'); return; }
            this.outputs.byStream.set(outputStreamId, binding);
            this.usedOutputStreams.add(outputStreamId);
          } else {
            if (this.outputs.single && !this.outputs.single.terminal) { this.protocolFailure('tts.started collided with the active output stream.'); return; }
            this.outputs.single = binding;
          }
        } else if (hostEvent.type === 'response.failed') {
          if (hostEvent.payload.responseId !== this.latestResponseId) { this.protocolFailure('response.failed did not match the established response.'); return; }
          for (const binding of this.outputs.byStream.values()) if (binding.responseId === hostEvent.payload.responseId && !binding.terminal) binding.terminal = true;
          if (this.outputs.single && this.outputs.single.responseId === hostEvent.payload.responseId && !this.outputs.single.terminal) this.outputs.single.terminal = true;
          this.latestResponseId = undefined;
        } else if (hostEvent.type === 'tts.ended') {
          const binding = this.findOutput(String(hostEvent.payload.playbackId));
          if (!binding || binding.outputEpoch !== hostEvent.epoch) { this.protocolFailure('tts.ended did not match the active output stream.'); return; }
          binding.terminal = true;
          const generated = Number(hostEvent.payload.generatedSamples);
          if (generated !== binding.sampleOffset) { this.protocolFailure('tts.ended reported a sample count that does not match the streamed audio.'); return; }
          // For a single-part response the response is fully delivered. For a
          // multi-part response the parent identity persists until the last part.
          const partIndex = typeof hostEvent.payload.partIndex === 'number' ? hostEvent.payload.partIndex : undefined;
          if (partIndex === undefined) this.latestResponseId = undefined;
        }
        for (const listener of this.eventListeners) void listener(hostEvent);
      };
    });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    activityLog.append({ level: 'info', source: 'transport', message: 'session socket closed intentionally' });
    this.socket?.close(1000, 'session ended');
    this.socket = undefined;
  }
  startSession(input: { sessionSeed: string; reasoningMode: 'full' | 'transcript_only'; settings: { version: 1; persona: string; voice: { catalogId: string; voiceId: string } } }): void { this.sendCommand('session.start', { sessionSeed: input.sessionSeed, reasoningMode: input.reasoningMode, settings: input.settings }); }
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
    const binding = this.findOutput(receipt.playbackId);
    if (binding && binding.outputEpoch === receipt.cancelledEpoch) binding.terminal = true;
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
  private latestResponseId: string | undefined;
  onEvent(listener: (event: StableEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onAudio(listener: (chunk: OutputAudioChunk) => void): () => void { this.audioListeners.add(listener); return () => this.audioListeners.delete(listener); }
  onFailure(listener: (message: string) => void): () => void { this.failureListeners.add(listener); return () => this.failureListeners.delete(listener); }

  private handleBinary(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) { this.protocolFailure('a binary message was not an ArrayBuffer.'); return; }
    let frame;
    try { frame = decodeBinaryAudioFrame(new Uint8Array(data), MAX_BINARY_PAYLOAD); } catch { this.protocolFailure('a binary audio frame could not be decoded.'); return; }
    const output = this.outputs.byStream.get(frame.streamId)
      ?? (this.outputs.single && (this.outputs.single.streamId === undefined || this.outputs.single.streamId === frame.streamId) ? this.outputs.single : undefined);
    if (!output || output.terminal || frame.channel !== 2) { this.protocolFailure('a binary audio frame did not match the active output stream.'); return; }
    if (output.streamId === undefined) {
      if (this.usedOutputStreams.has(frame.streamId)) { this.protocolFailure('the host reused an output stream id.'); return; }
      output.streamId = frame.streamId;
      this.usedOutputStreams.add(frame.streamId);
    }
    if (frame.streamId !== output.streamId || frame.sequence !== output.expectedSequence) { this.protocolFailure('a binary audio frame had an unexpected stream id or sequence.'); return; }
    if (frame.sequence === 0 && output.partIndex !== undefined) {
      activityLog.append({ level: 'info', source: 'transport', message: `part ${output.partIndex} first audio`, detail: `${Date.now() - output.receivedAt}ms` });
    }
    const chunk: OutputAudioChunk = { playbackId: output.playbackId, sequence: frame.sequence, sampleOffset: output.sampleOffset, pcm16: frame.pcm16 };
    output.expectedSequence++;
    output.sampleOffset += frame.pcm16.length;
    for (const listener of this.audioListeners) listener(chunk);
  }
  private findOutput(playbackId: string): OutputBinding | undefined {
    for (const binding of this.outputs.byStream.values()) if (binding.playbackId === playbackId) return binding;
    return this.outputs.single?.playbackId === playbackId ? this.outputs.single : undefined;
  }
  private currentBinding(): OutputBinding | undefined {
    const first = this.outputs.byStream.values().next().value as OutputBinding | undefined;
    return first ?? this.outputs.single;
  }
  private sendCommand(type: string, payload: Record<string, unknown>, epoch = this.epoch()): void {
    this.readySocket().send(JSON.stringify(createEnvelope({ sessionId: this.sessionId, epoch, type, payload })));
  }
  private protocolFailure(reason: string): void {
    activityLog.append({ level: 'error', source: 'transport', message: 'protocol failure', detail: reason });
    this.notifyFailure(`The host sent invalid conversation data: ${reason}`);
    // close() with a server-only code would throw InvalidAccessError inside
    // onmessage; guard on OPEN and swallow anything close() itself throws so
    // a protocol violation can never escape as an uncaught browser error.
    if (this.socket?.readyState === WebSocket.OPEN) {
      try { this.socket.close(CLOSE_PROTOCOL_VIOLATION, 'invalid host conversation protocol'); } catch { /* never escape onmessage */ }
    }
  }
  private notifyFailure(message: string): void {
    if (this.failureNotified || this.intentionalDisconnect) return;
    this.failureNotified = true;
    for (const listener of this.failureListeners) listener(message);
  }
  private readySocket(): WebSocket { if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Session transport is not connected.'); return this.socket; }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The sidecar stream id is generated host-side with node:crypto randomUUID() (UUIDv4),
// so VAD streamIds accept any RFC 4122 UUID version (v1-v8), not just v7.
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function hasOnly(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key));
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function partOk(value: Record<string, unknown>): boolean {
  const index = value.partIndex;
  const partId = value.partId;
  if (index === undefined && partId === undefined) return true;
  if (index === undefined || !integer(index) || Number(index) > 7) return false;
  if (partId !== undefined && (typeof partId !== 'string' || !UUID_V7.test(partId))) return false;
  return true;
}
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
  const anyUuid = (key: string) => typeof payload[key] === 'string' && UUID_ANY.test(String(payload[key]));
  switch (event.type) {
    case 'session.state': return exact(payload, ['phase', 'personaDigest']) && typeof payload.phase === 'string' && typeof payload.personaDigest === 'string' && /^[a-f0-9]{64}$/.test(payload.personaDigest);
    case 'transcript.partial': return exact(payload, ['utteranceId', 'sequence', 'text', 'replacedCharacters']) && uuid('utteranceId') && integer(payload.sequence) && typeof payload.text === 'string' && payload.text.length <= 16_384 && integer(payload.replacedCharacters);
    case 'transcript.final': return exact(payload, ['turnId', 'text', 'endpointComplete']) && uuid('turnId') && typeof payload.text === 'string' && payload.text.length <= 16_384 && payload.endpointComplete === true;
    case 'vad.speech_start': return exact(payload, ['streamId', 'utteranceId', 'captureStartSequence']) && anyUuid('streamId') && uuid('utteranceId') && integer(payload.captureStartSequence);
    case 'vad.speech_end': return exact(payload, ['streamId', 'utteranceId', 'captureStartSequence', 'captureEndSequence']) && anyUuid('streamId') && uuid('utteranceId') && integer(payload.captureStartSequence) && integer(payload.captureEndSequence);
    case 'policy.decision': return exact(payload, ['turnId', 'policyVersion', 'eligible', 'posture', 'reasonCodes', 'inputDigest']) && uuid('turnId') && payload.policyVersion === 'v1.experimental' && typeof payload.eligible === 'boolean' && ['riff', 'question', 'challenge', 'silence'].includes(String(payload.posture)) && Array.isArray(payload.reasonCodes) && payload.reasonCodes.length > 0 && payload.reasonCodes.every(code => typeof code === 'string' && code.length > 0) && typeof payload.inputDigest === 'string' && /^[a-f0-9]{64}$/.test(payload.inputDigest);
    case 'reasoning.started': return hasOnly(payload, ['turnId', 'responseId', 'posture'], ['partIndex', 'partId']) && uuid('turnId') && uuid('responseId') && ['riff', 'question', 'challenge'].includes(String(payload.posture)) && partOk(payload);
    case 'reasoning.delta': return hasOnly(payload, ['turnId', 'responseId', 'text'], ['partIndex', 'partId']) && uuid('turnId') && uuid('responseId') && typeof payload.text === 'string' && payload.text.length > 0 && payload.text.length <= 4_096 && partOk(payload);
    case 'response.failed': return hasOnly(payload, ['turnId', 'responseId', 'reasonCode'], ['partIndex', 'partId']) && uuid('turnId') && uuid('responseId') && ['reasoning_unavailable', 'reasoning_invalid', 'tts_failed'].includes(String(payload.reasonCode)) && partOk(payload);
    case 'reasoning.final': return hasOnly(payload, ['turnId', 'responseId', 'posture', 'text'], ['partIndex', 'partId']) && uuid('turnId') && uuid('responseId') && ['riff', 'question', 'challenge'].includes(String(payload.posture)) && typeof payload.text === 'string' && payload.text.length > 0 && payload.text.length <= 4_096 && partOk(payload);
    case 'tts.started': return hasOnly(payload, ['responseId', 'playbackId', 'sampleRate'], ['outputStreamId', 'partIndex', 'partId']) && uuid('responseId') && uuid('playbackId') && integer(payload.sampleRate) && Number(payload.sampleRate) > 0 && (payload.outputStreamId === undefined || (integer(payload.outputStreamId) && Number(payload.outputStreamId) <= 4_294_967_295)) && partOk(payload);
    case 'tts.ended': return hasOnly(payload, ['responseId', 'playbackId', 'generatedSamples'], ['partIndex', 'partId']) && uuid('responseId') && uuid('playbackId') && integer(payload.generatedSamples) && partOk(payload);
    case 'response.part_started': case 'response.part_final': return hasOnly(payload, ['turnId', 'responseId', 'partIndex', 'kind'], ['partId']) && uuid('turnId') && uuid('responseId') && integer(payload.partIndex) && Number(payload.partIndex) <= 7 && ['stall', 'body'].includes(String(payload.kind)) && (payload.partId === undefined || (typeof payload.partId === 'string' && UUID_V7.test(payload.partId))) && ((payload.kind === 'stall' && payload.partIndex === 0) || (payload.kind === 'body' && Number(payload.partIndex) >= 1));
    case 'barge_in.provisional': case 'barge_in.confirmed': case 'barge_in.rejected': case 'barge_in.timed_out': return hasOnly(payload, ['responseId', 'outputEpoch', 'resumable'], ['partIndex', 'partId', 'playbackId']) && uuid('responseId') && integer(payload.outputEpoch) && typeof payload.resumable === 'boolean' && partOk(payload) && (payload.playbackId === undefined || uuid('playbackId'));
    case 'interruption.decision': return hasOnly(payload, ['turnId', 'responseId', 'playbackId', 'outputEpoch', 'action', 'intent', 'confidence', 'disposition', 'pausedSampleOffset'], ['partIndex', 'partId']) && uuid('turnId') && uuid('responseId') && uuid('playbackId') && integer(payload.outputEpoch) && ['resume', 'accept'].includes(String(payload.action)) && ['non_substantive', 'continue_previous', 'new_request', 'correction', 'topic_change', 'stop_previous'].includes(String(payload.intent)) && ['low', 'medium', 'high'].includes(String(payload.confidence)) && ['resume_noise', 'resume_fragment', 'resume_requested', 'accept_takeover'].includes(String(payload.disposition)) && integer(payload.pausedSampleOffset) && partOk(payload);
    case 'failure': return exact(payload, ['code', 'detail', 'correctiveAction', 'recoverable']) && typeof payload.code === 'string' && payload.code.length > 0 && typeof payload.detail === 'string' && payload.detail.length > 0 && typeof payload.correctiveAction === 'string' && payload.correctiveAction.length > 0 && typeof payload.recoverable === 'boolean';
    default: return false;
  }
}
