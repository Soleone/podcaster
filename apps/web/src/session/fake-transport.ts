import type { PlaybackProgress, PlaybackTerminal } from '../audio/playback-ledger';
import type { StableEvent } from '../storage/stable-turn-writer';
import type { OutputAudioChunk, SessionTransport } from './transport';

export class FakeSessionTransport implements SessionTransport {
  readonly captureFrames: Uint8Array[] = [];
  readonly progressReports: PlaybackProgress[] = [];
  readonly terminalReceipts = new Map<string, PlaybackTerminal>();
  readonly terminalHistory: PlaybackTerminal[] = [];
  readonly commands: string[] = [];
  private readonly eventListeners = new Set<(event: StableEvent) => void | Promise<void>>();
  private readonly audioListeners = new Set<(chunk: OutputAudioChunk) => void>();
  private readonly failureListeners = new Set<(message: string) => void>();
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
  sendTerminal(receipt: PlaybackTerminal, _event?: StableEvent): void {
    const key = `${receipt.cancelledEpoch}:${receipt.playbackId}`;
    if (!this.terminalReceipts.has(key)) {
      const stored = { ...receipt };
      this.terminalReceipts.set(key, stored);
      this.terminalHistory.push(stored);
    }
  }
  cancelAssistant(): void { this.commands.push('cancel'); }
  confirmBargeIn(): void { this.commands.push('confirm'); }
  rejectBargeIn(): void { this.commands.push('reject'); }
  onEvent(listener: (event: StableEvent) => void | Promise<void>): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onAudio(listener: (chunk: OutputAudioChunk) => void): () => void { this.audioListeners.add(listener); return () => this.audioListeners.delete(listener); }
  onFailure(listener: (message: string) => void): () => void { this.failureListeners.add(listener); return () => this.failureListeners.delete(listener); }
  async emit(event: StableEvent): Promise<void> { await Promise.all([...this.eventListeners].map(listener => listener(event))); }
  emitFailure(message: string): void { for (const listener of this.failureListeners) listener(message); }
  emitAudio(chunk: OutputAudioChunk): void { for (const listener of this.audioListeners) listener(chunk); }
}
