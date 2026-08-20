import type { HostEvent, PiSettings, PlaybackPausedEvent, PlaybackStoppedEvent, TranscriptFinalEvent, VoicePreference } from '@app/contracts';
import type { PlaybackProgress, PlaybackTerminal } from '../audio/playback-ledger';

export interface OutputAudioChunk { playbackId: string; sequence: number; sampleOffset: number; pcm16: Int16Array }
export interface SessionStartRequest {
  sessionSeed: string;
  reasoningMode: 'full' | 'transcript_only';
  settings: { version: 1; persona: string; voice: VoicePreference; pi?: PiSettings };
}
export interface SessionTransport {
  connect(capability: string): Promise<void>;
  disconnect(): void;
  startSession(input: SessionStartRequest): void | Promise<void>;
  startAudio(streamId: number): void | Promise<void>;
  stopAudio(streamId: number): void | Promise<void>;
  acknowledgePersisted(event: TranscriptFinalEvent): void | Promise<void>;
  acknowledgePersistenceFailed(event: TranscriptFinalEvent, reasonCode: 'quota' | 'unavailable' | 'aborted'): void | Promise<void>;
  stopSession(reason: 'user' | 'expired' | 'disconnect'): void | Promise<void>;
  sendCapture(frame: Uint8Array): void | Promise<void>;
  sendProgress(progress: PlaybackProgress): void | Promise<void>;
  sendPaused(checkpoint: PlaybackPausedEvent['payload']): void | Promise<void>;
  sendTerminal(receipt: PlaybackTerminal, event?: PlaybackStoppedEvent): void | Promise<void>;
  cancelAssistant(): void | Promise<void>;
  onEvent(listener: (event: HostEvent) => void | Promise<void>): () => void;
  onAudio(listener: (chunk: OutputAudioChunk) => void): () => void;
  onFailure(listener: (message: string) => void): () => void;
  onReconnect(listener: () => void | Promise<void>): () => void;
}
