import type { StableEvent } from '../storage/stable-turn-writer';
import type { RecordingSampleRate, RecordingStore, StoredRecordingItem, TerminalReason } from '../storage/recording-store';
import { uuidV7 } from '../session/envelope';
import type { EncodeMp3 } from './encode';

export type { EncodeMp3 } from './encode';
export const PER_TURN_KBPS = 64;

interface FrameChunk { sequence: number; pcm16: Int16Array }
interface OpenUserSlice {
  utteranceId: string;
  streamId: string;
  startSeq: number;
  frames: FrameChunk[];
  itemId: string;
}
interface PendingUserItem { itemId: string; turnId: string | null }
interface AgentBuffer {
  playbackId: string;
  responseId: string;
  turnId: string | null;
  partIndex: number | null;
  sampleRate: RecordingSampleRate;
  outputEpoch: number;
  frames: Int16Array[];
  itemId: string;
}

const TERMINAL_REASONS: readonly TerminalReason[] = ['completed', 'cancelled', 'stopped', 'failed'];
/** Lookback window for capture frames tapped before the speech_start relay arrives. */
const RECENT_FRAME_LIMIT = 64;

function concatFrames(frames: Array<{ pcm16: Int16Array }>): Int16Array {
  const total = frames.reduce((sum, frame) => sum + frame.pcm16.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) { pcm.set(frame.pcm16, offset); offset += frame.pcm16.length; }
  return pcm;
}

export interface RecordingRecorderDependencies {
  sessionId: string;
  store: RecordingStore;
  encode: EncodeMp3;
  now?: () => number;
}

export class RecordingRecorder {
  private enabled = false;
  private recordSeq = 0;
  private readonly userSlices = new Map<string, OpenUserSlice>();
  private readonly pendingUserItems = new Map<string, PendingUserItem>();
  private readonly pendingTranscriptTurns = new Map<string, string>();
  private readonly committedUserItems = new Map<string, string>();
  private readonly agentBuffers = new Map<string, AgentBuffer>();
  private readonly responseTurns = new Map<string, string>();
  private readonly recentFrames: FrameChunk[] = [];
  private readonly pendingCommits = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly deps: RecordingRecorderDependencies) {
    // Recording is always on; there is no per-session toggle.
    this.enabled = true;
    this.now = deps.now ?? (() => Math.max(0, Math.floor(performance.now())));
  }

  /** Resumes the per-session record sequence from persisted items. */
  async start(): Promise<void> {
    const existing = await this.deps.store.getSessionItems(this.deps.sessionId);
    this.recordSeq = existing.reduce((max, item) => Math.max(max, item.recordSeq), -1) + 1;
  }

  onCaptureAudio(capture: { streamId: number; sequence: number; sampleOffset: number; pcm16: Int16Array }): void {
    if (!this.enabled) return;
    void capture.sampleOffset;
    // Keep a lookback window so a slice can backfill frames tapped before the
    // speech_start relay arrived (VAD needs a few frames before declaring start).
    this.recentFrames.push({ sequence: capture.sequence, pcm16: capture.pcm16.slice() });
    if (this.recentFrames.length > RECENT_FRAME_LIMIT) this.recentFrames.splice(0, this.recentFrames.length - RECENT_FRAME_LIMIT);
    for (const slice of this.userSlices.values()) {
      if (capture.sequence >= slice.startSeq) slice.frames.push({ sequence: capture.sequence, pcm16: capture.pcm16.slice() });
    }
  }

  onPlaybackAudio(audio: { playbackId: string; sampleOffset: number; pcm16: Int16Array }): void {
    if (!this.enabled) return;
    void audio.sampleOffset;
    const buffer = this.agentBuffers.get(audio.playbackId);
    if (!buffer) return;
    buffer.frames.push(audio.pcm16.slice());
  }

  onSessionEvent(event: StableEvent): void {
    const payload = event.payload;
    switch (event.type) {
      case 'vad.speech_start': {
        if (!this.enabled) return;
        const streamId = String(payload.streamId ?? '');
        const utteranceId = String(payload.utteranceId ?? '');
        const startSeq = Number(payload.captureStartSequence);
        if (!streamId || !utteranceId || !Number.isSafeInteger(startSeq) || startSeq < 0 || this.userSlices.has(utteranceId)) return;
        const slice: OpenUserSlice = { utteranceId, streamId, startSeq, frames: [], itemId: uuidV7() };
        for (const frame of this.recentFrames) {
          if (frame.sequence >= startSeq) slice.frames.push({ sequence: frame.sequence, pcm16: frame.pcm16.slice() });
        }
        this.userSlices.set(utteranceId, slice);
        break;
      }
      case 'vad.speech_end': {
        if (!this.enabled) return;
        const utteranceId = String(payload.utteranceId ?? '');
        const slice = this.userSlices.get(utteranceId);
        if (!slice) return;
        const captureEndSequence = Number(payload.captureEndSequence);
        this.commitUserSlice(slice, Number.isSafeInteger(captureEndSequence) && captureEndSequence >= 0 ? captureEndSequence : null, false);
        break;
      }
      case 'transcript.final': {
        const turnId = String(payload.turnId ?? '');
        if (!turnId) return;
        const entry = this.pendingUserItems.get(turnId);
        if (entry) {
          entry.turnId = turnId;
          return;
        }
        const itemId = this.committedUserItems.get(turnId);
        if (itemId) {
          this.trackPending(this.deps.store.updateTurnId(itemId, turnId));
        } else {
          // VAD and STT normally arrive in this order, but the transcript can
          // win the race when a short utterance is finalized quickly. Keep the
          // identity until speech_end creates the recording row.
          this.pendingTranscriptTurns.set(turnId, turnId);
        }
        break;
      }
      case 'reasoning.started': {
        const turnId = String(payload.turnId ?? '');
        const responseId = String(payload.responseId ?? '');
        if (turnId && responseId) this.responseTurns.set(responseId, turnId);
        break;
      }
      case 'tts.started': {
        if (!this.enabled) return;
        const playbackId = String(payload.playbackId ?? '');
        const responseId = String(payload.responseId ?? '');
        const sampleRate = Number(payload.sampleRate);
        if (!playbackId || !responseId || (sampleRate !== 16000 && sampleRate !== 24000) || this.agentBuffers.has(playbackId)) return;
        this.agentBuffers.set(playbackId, {
          playbackId,
          responseId,
          turnId: this.responseTurns.get(responseId) ?? null,
          partIndex: typeof payload.partIndex === 'number' ? payload.partIndex : null,
          sampleRate,
          outputEpoch: event.epoch,
          frames: [],
          itemId: uuidV7(),
        });
        break;
      }
      case 'response.failed': {
        const responseId = String(payload.responseId ?? '');
        if (!responseId) return;
        for (const [playbackId, buffer] of [...this.agentBuffers]) {
          if (buffer.responseId === responseId) this.agentBuffers.delete(playbackId);
        }
        break;
      }
      case 'playback.stopped': {
        if (!this.enabled) return;
        const playbackId = String(payload.playbackId ?? '');
        const buffer = this.agentBuffers.get(playbackId);
        if (!buffer) return;
        const cancelledEpoch = Number(payload.cancelledEpoch);
        const finalPlayedSampleOffset = Number(payload.finalPlayedSampleOffset);
        const reason = String(payload.reason ?? '');
        if (!Number.isSafeInteger(cancelledEpoch) || !Number.isSafeInteger(finalPlayedSampleOffset) || finalPlayedSampleOffset < 0) return;
        this.commitAgentBuffer(buffer, { cancelledEpoch, finalPlayedSampleOffset, reason });
        break;
      }
      default:
        break;
    }
  }

  /** Finalizes open slices. finalize=true persists truncated user slices; agent buffers are always dropped. */
  async stop(finalize: boolean): Promise<void> {
    const slices = [...this.userSlices.values()];
    if (finalize) {
      for (const slice of slices) this.commitUserSlice(slice, null, true);
    } else {
      for (const slice of slices) this.userSlices.delete(slice.utteranceId);
    }
    this.agentBuffers.clear();
    this.recentFrames.length = 0;
    await Promise.allSettled([...this.pendingCommits]);
  }

  private commitUserSlice(slice: OpenUserSlice, captureEndSequence: number | null, truncated: boolean): void {
    this.userSlices.delete(slice.utteranceId);
    const entry: PendingUserItem = { itemId: slice.itemId, turnId: this.pendingTranscriptTurns.get(slice.utteranceId) ?? null };
    this.pendingTranscriptTurns.delete(slice.utteranceId);
    this.pendingUserItems.set(slice.utteranceId, entry);
    const commit = (async () => {
      const endSeq = captureEndSequence ?? Math.max(slice.startSeq, slice.frames.length ? slice.frames[slice.frames.length - 1]!.sequence : slice.startSeq);
      const frames = slice.frames.filter(frame => frame.sequence >= slice.startSeq && frame.sequence <= endSeq);
      const pcm = concatFrames(frames);
      if (pcm.length === 0) return;
      const mp3 = await this.deps.encode(pcm, 16000, PER_TURN_KBPS);
      const monotonicMs = this.now();
      const item: StoredRecordingItem = {
        itemId: slice.itemId,
        sessionId: this.deps.sessionId,
        recordSeq: this.recordSeq++,
        role: 'user',
        turnId: entry.turnId,
        responseId: null,
        partIndex: null,
        playbackId: null,
        outputEpoch: null,
        sampleRate: 16000,
        sampleCount: pcm.length,
        interrupted: false,
        deliveredSamples: null,
        terminalReason: null,
        captureStartSequence: slice.startSeq,
        captureEndSequence: endSeq,
        truncated,
        durationMs: Math.round((pcm.length / 16000) * 1000),
        createdAt: new Date().toISOString(),
        monotonicMs,
        trimmed: false,
        data: new Blob([mp3], { type: 'audio/mpeg' }),
      };
      await this.deps.store.put(item);
      this.committedUserItems.set(slice.utteranceId, slice.itemId);
    })().catch(() => undefined)
      .finally(() => this.pendingUserItems.delete(slice.utteranceId));
    this.trackPending(commit);
  }

  private commitAgentBuffer(buffer: AgentBuffer, terminal: { cancelledEpoch: number; finalPlayedSampleOffset: number; reason: string }): void {
    this.agentBuffers.delete(buffer.playbackId);
    const commit = (async () => {
      const pcm = concatFrames(buffer.frames.map(pcm16 => ({ pcm16 })));
      if (pcm.length === 0) return;
      const mp3 = await this.deps.encode(pcm, buffer.sampleRate, PER_TURN_KBPS);
      const reason = TERMINAL_REASONS.includes(terminal.reason as TerminalReason) ? terminal.reason as NonNullable<TerminalReason> : 'cancelled';
      const monotonicMs = this.now();
      const item: StoredRecordingItem = {
        itemId: buffer.itemId,
        sessionId: this.deps.sessionId,
        recordSeq: this.recordSeq++,
        role: 'agent',
        turnId: buffer.turnId,
        responseId: buffer.responseId,
        partIndex: buffer.partIndex,
        playbackId: buffer.playbackId,
        outputEpoch: terminal.cancelledEpoch,
        sampleRate: buffer.sampleRate,
        sampleCount: pcm.length,
        interrupted: reason !== 'completed',
        deliveredSamples: terminal.finalPlayedSampleOffset,
        terminalReason: reason,
        captureStartSequence: null,
        captureEndSequence: null,
        truncated: false,
        durationMs: Math.round((pcm.length / buffer.sampleRate) * 1000),
        createdAt: new Date().toISOString(),
        monotonicMs,
        trimmed: false,
        data: new Blob([mp3], { type: 'audio/mpeg' }),
      };
      await this.deps.store.put(item);
    })().catch(() => undefined);
    this.trackPending(commit);
  }

  private trackPending(operation: Promise<void>): void {
    this.pendingCommits.add(operation);
    void operation.then(
      () => this.pendingCommits.delete(operation),
      () => this.pendingCommits.delete(operation),
    );
  }
}
