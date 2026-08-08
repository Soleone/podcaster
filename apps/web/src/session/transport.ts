import type { PlaybackProgress, PlaybackTerminal } from '../audio/playback-ledger';
import type { StableEvent } from '../storage/stable-turn-writer';

export interface OutputAudioChunk { playbackId: string; sequence: number; sampleOffset: number; pcm16: Int16Array }
export interface SessionTransport {
  connect(capability: string): Promise<void>;
  disconnect(): void;
  startSession(sessionSeed: string, reasoningMode: 'full' | 'transcript_only'): void | Promise<void>;
  startAudio(streamId: number): void | Promise<void>;
  stopAudio(streamId: number): void | Promise<void>;
  acknowledgePersisted(event: StableEvent): void | Promise<void>;
  acknowledgePersistenceFailed(event: StableEvent, reasonCode: 'quota' | 'unavailable' | 'aborted'): void | Promise<void>;
  stopSession(reason: 'user' | 'expired' | 'disconnect'): void | Promise<void>;
  sendCapture(frame: Uint8Array): void | Promise<void>;
  sendProgress(progress: PlaybackProgress): void | Promise<void>;
  sendTerminal(receipt: PlaybackTerminal, event?: StableEvent): void | Promise<void>;
  cancelAssistant(): void | Promise<void>;
  confirmBargeIn(): void | Promise<void>;
  rejectBargeIn(): void | Promise<void>;
  onEvent(listener: (event: StableEvent) => void | Promise<void>): () => void;
  onAudio(listener: (chunk: OutputAudioChunk) => void): () => void;
  onFailure(listener: (message: string) => void): () => void;
}
