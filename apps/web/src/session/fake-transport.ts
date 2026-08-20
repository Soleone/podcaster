import type { HostEvent, PlaybackPausedEvent, PlaybackStoppedEvent } from '@app/contracts';
import type { PlaybackProgress, PlaybackTerminal } from '../audio/playback-ledger';
import type { OutputAudioChunk, SessionTransport } from './transport';

export class FakeSessionTransport implements SessionTransport {
  readonly captureFrames: Uint8Array[] = [];
  readonly progressReports: PlaybackProgress[] = [];
  readonly pauseCheckpoints: PlaybackPausedEvent['payload'][] = [];
  readonly terminalReceipts = new Map<string, PlaybackTerminal>();
  readonly terminalHistory: PlaybackTerminal[] = [];
  readonly commands: string[] = [];
  private readonly eventListeners = new Set<(event: HostEvent) => void | Promise<void>>();
  private readonly audioListeners = new Set<(chunk: OutputAudioChunk) => void>();
  private readonly failureListeners = new Set<(message: string) => void>();
  private readonly reconnectListeners = new Set<() => void | Promise<void>>();
  connected = false;

  async connect(_capability: string): Promise<void> { this.connected = true; }
  disconnect(): void { this.connected = false; }
  startSession(): void { this.commands.push('session.start'); }
  startAudio(): void { this.commands.push('audio.start'); }
  stopAudio(): void { this.commands.push('audio.stop'); }
  acknowledgePersisted(): void { this.commands.push('turn.persisted'); }
  acknowledgePersistenceFailed(): void { this.commands.push('turn.persistence_failed'); }
  stopSession(): void { this.commands.push('session.stop'); }
  sendCapture(frame: Uint8Array): void { this.captureFrames.push(frame.slice()); }
  sendProgress(progress: PlaybackProgress): void { this.progressReports.push({ ...progress }); }
  sendPaused(checkpoint: PlaybackPausedEvent['payload']): void { this.pauseCheckpoints.push({ ...checkpoint }); this.commands.push('playback.paused'); }
  sendTerminal(receipt: PlaybackTerminal, _event?: PlaybackStoppedEvent): void {
    const key = `${receipt.cancelledEpoch}:${receipt.playbackId}`;
    if (!this.terminalReceipts.has(key)) {
      const stored = { ...receipt };
      this.terminalReceipts.set(key, stored);
      this.terminalHistory.push(stored);
    }
  }
  cancelAssistant(): void { this.commands.push('cancel'); }
  onEvent(listener: (event: HostEvent) => void | Promise<void>): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onAudio(listener: (chunk: OutputAudioChunk) => void): () => void { this.audioListeners.add(listener); return () => this.audioListeners.delete(listener); }
  onFailure(listener: (message: string) => void): () => void { this.failureListeners.add(listener); return () => this.failureListeners.delete(listener); }
  onReconnect(listener: () => void | Promise<void>): () => void { this.reconnectListeners.add(listener); return () => this.reconnectListeners.delete(listener); }
  async emit(event: HostEvent): Promise<void> { await Promise.all([...this.eventListeners].map(listener => listener(event))); }
  emitFailure(message: string): void { for (const listener of this.failureListeners) listener(message); }
  emitAudio(chunk: OutputAudioChunk): void { for (const listener of this.audioListeners) listener(chunk); }
}
