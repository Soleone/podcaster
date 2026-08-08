import type { PlaybackProgress, PlaybackTerminal } from '../audio/playback-ledger';
import type { StableEvent } from '../storage/stable-turn-writer';
import { createEnvelope, type Envelope } from './envelope';
import type { OutputAudioChunk, SessionTransport } from './transport';

export class WebSocketSessionTransport implements SessionTransport {
  private socket: WebSocket | undefined;
  private readonly eventListeners = new Set<(event: StableEvent) => void | Promise<void>>();
  private readonly audioListeners = new Set<(chunk: OutputAudioChunk) => void>();
  private readonly terminalEnvelopes = new Map<string, Envelope>();

  constructor(private readonly sessionId: string, private readonly epoch: () => number, private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url)) {}

  connect(capability: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = this.createSocket(`${protocol}//${location.host}/ws`);
      this.socket = socket;
      const fail = () => reject(new Error('The secure session connection could not be authenticated.'));
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(JSON.stringify({ capability }));
      socket.onerror = fail;
      socket.onclose = event => { if (event.code !== 1000) fail(); };
      socket.onmessage = message => {
        if (typeof message.data !== 'string') return;
        let value: unknown;
        try { value = JSON.parse(message.data); } catch { return; }
        if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'authenticated') { resolve(); return; }
        if (isStableEvent(value)) for (const listener of this.eventListeners) void listener(value);
      };
    });
  }

  disconnect(): void { this.socket?.close(1000, 'session ended'); this.socket = undefined; }
  sendCapture(frame: Uint8Array): void { this.readySocket().send(frame); }
  sendProgress(progress: PlaybackProgress): void {
    this.readySocket().send(JSON.stringify(createEnvelope({ sessionId: this.sessionId, epoch: this.epoch(), type: 'playback.progress', payload: { ...progress } })));
  }
  sendTerminal(receipt: PlaybackTerminal, persistedEvent?: StableEvent): void {
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
  cancelAssistant(): never { throw new Error('Assistant cancellation transport contract is not frozen for real integration.'); }
  confirmBargeIn(): never { throw new Error('Barge-in confirmation transport contract is not frozen for real integration.'); }
  rejectBargeIn(): never { throw new Error('Barge-in rejection transport contract is not frozen for real integration.'); }
  onEvent(listener: (event: StableEvent) => void | Promise<void>): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onAudio(listener: (chunk: OutputAudioChunk) => void): () => void { this.audioListeners.add(listener); return () => this.audioListeners.delete(listener); }

  private readySocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Session transport is not connected.');
    return this.socket;
  }
}
function isStableEvent(value: unknown): value is StableEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<StableEvent>;
  return typeof event.eventId === 'string' && typeof event.sessionId === 'string' && typeof event.type === 'string' && typeof event.epoch === 'number' && typeof event.monotonicMs === 'number' && typeof event.payload === 'object' && event.payload !== null;
}
