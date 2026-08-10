import type { PlaybackProgress, PlaybackStopReason, PlaybackTerminal } from '../audio/playback-ledger';
import type { StableTurnWriter, StableEvent } from '../storage/stable-turn-writer';
import { activityLog } from './activity-log';
import { createEnvelope } from './envelope';
import { canSafelyResume, initialSessionState, reduceSessionState, type SessionViewState } from './state';
import type { OutputAudioChunk, SessionTransport } from './transport';

export interface ControlledPlayback {
  setGeneratedSamples(samples: number): void;
  append(offset: number, pcm16: Int16Array): void;
  pause(): Promise<PlaybackProgress>;
  resume(): Promise<void>;
  stop(reason: PlaybackStopReason): Promise<PlaybackTerminal>;
}
export interface SessionControllerOptions {
  sessionId: string;
  transport: SessionTransport;
  writer: StableTurnWriter;
  initialState?: SessionViewState;
  playbackFactory?: (input: { playbackId: string; outputEpoch: number; sampleRate: number }) => ControlledPlayback;
  schedule?: (delay: number, callback: () => void) => () => void;
}
interface ActivePlayback { playbackId: string; responseId: string; outputEpoch: number; player: ControlledPlayback; terminal: boolean; partIndex?: number }
interface ResponsePlaybackGroup { responseId: string; parts: ActivePlayback[]; activeIndex: number; terminal: boolean }
interface Provisional {
  responseId: string;
  outputEpoch: number;
  playbackId: string;
  pausedSampleOffset?: number;
  confirmed: boolean;
  checkpointReady: Promise<boolean>;
}

export class SessionController {
  private state: SessionViewState;
  private readonly listeners = new Set<(state: SessionViewState) => void>();
  private readonly seenEvents = new Set<string>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly terminalReports = new Map<string, Promise<void>>();
  private readonly groups = new Map<string, ResponsePlaybackGroup>();
  private readonly playbackByPart = new Map<string, ActivePlayback>();
  private active: ActivePlayback | undefined;
  private provisional: Provisional | undefined;
  private stopped = false;
  private cancelSilence: (() => void) | undefined;
  private readonly schedule: (delay: number, callback: () => void) => () => void;

  constructor(private readonly options: SessionControllerOptions) {
    this.state = options.initialState ?? initialSessionState;
    this.schedule = options.schedule ?? ((delay, callback) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
    this.unsubscribe.push(options.transport.onEvent(event => this.handleEvent(event)));
    this.unsubscribe.push(options.transport.onAudio(chunk => this.handleAudio(chunk)));
    this.unsubscribe.push(options.transport.onFailure(message => { void this.handleTransportFailure(message); }));
  }

  snapshot(): SessionViewState { return this.state; }
  subscribe(listener: (state: SessionViewState) => void): () => void { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); }

  async handleEvent(event: StableEvent): Promise<void> {
    if (event.sessionId !== this.options.sessionId || this.seenEvents.has(event.eventId)) return;
    const accountingOnly = event.type === 'playback.progress' || event.type === 'playback.stopped';
    if (event.epoch < this.state.epoch && !accountingOnly) return;
    const isInterruptionResolution = event.type === 'barge_in.confirmed' || event.type === 'barge_in.rejected' || event.type === 'barge_in.timed_out' || event.type === 'interruption.decision';
    if (isInterruptionResolution && !this.matchesProvisionalResolution(event)) return;
    if (isInterruptionResolution) {
      const provisional = this.provisional!;
      if (!await provisional.checkpointReady || this.provisional !== provisional) return;
      if (event.type === 'interruption.decision' && event.payload.pausedSampleOffset !== provisional.pausedSampleOffset) return;
    }
    this.seenEvents.add(event.eventId);
    const storage = await this.options.writer.apply(event);
    if (!storage.ok) {
      if (event.type === 'transcript.final' && !this.stopped) await this.options.transport.acknowledgePersistenceFailed(event, 'unavailable');
      this.degrade(storage.degradedReason ?? 'Stable storage failed.');
      return;
    }
    if (event.type === 'transcript.final') {
      if (this.stopped) return;
      await this.options.transport.acknowledgePersisted(event);
    }
    if (event.epoch < this.state.epoch) return;
    this.setState(reduceSessionState(this.state, event));
    if (event.type === 'policy.decision' && event.payload.posture === 'silence') {
      this.cancelSilence?.();
      const silenceEpoch = event.epoch;
      this.cancelSilence = this.schedule(900, () => {
        this.cancelSilence = undefined;
        if (!this.stopped && this.state.epoch === silenceEpoch && this.state.dominant === 'intentional_silence') {
          this.setState({ ...this.state, dominant: 'listening', announcement: 'Listening' });
        }
      });
    }
    if (event.type === 'tts.started') {
      const playbackId = typeof event.payload.playbackId === 'string' ? event.payload.playbackId : undefined;
      const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : undefined;
      const sampleRate = Number(event.payload.sampleRate);
      const partIndex = typeof event.payload.partIndex === 'number' ? event.payload.partIndex : undefined;
      if (playbackId && responseId && Number.isSafeInteger(sampleRate) && sampleRate > 0 && this.options.playbackFactory) {
        // A different response superseded the current one before it terminalized.
        const active = this.active;
        if (active && active.responseId !== responseId && !active.terminal) await this.terminalize('cancelled');
        const player = this.options.playbackFactory({ playbackId, outputEpoch: event.epoch, sampleRate });
        const part: ActivePlayback = { playbackId, responseId, outputEpoch: event.epoch, player, terminal: false, ...(partIndex !== undefined ? { partIndex } : {}) };
        this.playbackByPart.set(playbackId, part);
        let group = this.groups.get(responseId);
        if (group && group.parts.length > 0 && group.parts[0]!.outputEpoch !== event.epoch) {
          // Same responseId but a fresh epoch: the old group is stale and must
          // not be advanced by late receipts. Replace the active playback with
          // legacy supersede semantics (the old player is not stopped).
          group.terminal = true;
          this.groups.delete(responseId);
          group = undefined;
          if (this.active && !this.active.terminal) this.active.terminal = true;
          this.active = undefined;
        }
        if (!group) { group = { responseId, parts: [], activeIndex: -1, terminal: false }; this.groups.set(responseId, group); }
        const firstPart = group.parts.length === 0;
        group.parts.push(part);
        if (firstPart) { group.activeIndex = 0; this.active = part; }
        // Non-first parts are queued and become audible when their predecessor
        // reports a terminal receipt (see advanceGroup).
      }
    } else if (event.type === 'tts.ended') {
      const part = typeof event.payload.playbackId === 'string' ? this.playbackByPart.get(event.payload.playbackId) : undefined;
      if (part && !part.terminal) part.player.setGeneratedSamples(Number(event.payload.generatedSamples));
    } else if (event.type === 'reasoning.started') {
      // A new response superseded the current one before it terminalized (rapid
      // re-engagement). Stop the superseded playback so its audio cannot keep
      // playing or leak. A completed playback is already terminal, so no-op.
      const responseId = typeof event.payload.responseId === 'string' ? event.payload.responseId : '';
      const active = this.active;
      if (active && active.responseId !== responseId && !active.terminal) {
        await this.terminalize('cancelled');
      }
    } else if (event.type === 'response.failed') {
      // Identity-matched failure: stop only the matching playback with reason
      // 'failed' and send its exact terminal receipt. Clear any provisional
      // interruption state first so an in-flight pause checkpoint cannot be
      // persisted after the cutoff. If playback never started, no-op.
      activityLog.append({ level: 'warn', source: 'controller', message: 'response failed', detail: String(event.payload.responseId) });
      this.clearProvisional();
      this.setState({ ...this.state, playbackNotice: '' });
      const active = this.active;
      if (active && active.responseId === event.payload.responseId) {
        await this.terminalize('failed');
      }
    } else if (event.type === 'barge_in.provisional' && this.active && event.payload.responseId === this.active.responseId && event.payload.outputEpoch === this.active.outputEpoch) {
      const active = this.active;
      let completeCheckpoint!: (ready: boolean) => void;
      const provisional: Provisional = {
        responseId: active.responseId,
        outputEpoch: active.outputEpoch,
        playbackId: active.playbackId,
        confirmed: false,
        checkpointReady: new Promise(resolve => { completeCheckpoint = resolve; }),
      };
      this.provisional = provisional;
      try {
        const progress = await active.player.pause();
        if (this.provisional !== provisional || this.active !== active || active.terminal) { completeCheckpoint(false); return; }
        provisional.pausedSampleOffset = progress.playedSampleOffset;
        const checkpoint = { responseId: active.responseId, playbackId: active.playbackId, outputEpoch: active.outputEpoch, pausedSampleOffset: progress.playedSampleOffset, generatedSamples: progress.generatedSamples };
        const pausedEvent = createEnvelope({ sessionId: this.options.sessionId, epoch: this.state.epoch, type: 'playback.paused', payload: checkpoint });
        const persisted = await this.options.writer.apply(pausedEvent);
        if (!persisted.ok) { completeCheckpoint(false); this.degrade(persisted.degradedReason ?? 'The pause checkpoint could not be saved.'); await this.terminalize('failed'); this.clearProvisional(); return; }
        await this.options.transport.sendPaused(checkpoint);
        completeCheckpoint(true);
      } catch {
        completeCheckpoint(false);
        if (this.provisional === provisional) { await this.terminalize('failed'); this.clearProvisional(); this.degrade('Playback could not be paused safely.'); }
      }
    } else if (event.type === 'interruption.decision') {
      const provisional = this.provisional;
      const active = this.active;
      if (!provisional || !active || provisional.pausedSampleOffset === undefined || event.payload.pausedSampleOffset !== provisional.pausedSampleOffset) return;
      if (event.payload.action === 'resume') {
        this.clearProvisional();
        await active.player.resume();
      } else if (event.payload.action === 'accept') {
        provisional.confirmed = true;
        await this.terminalize('cancelled');
        this.clearProvisional();
      }
    } else if (event.type === 'barge_in.confirmed') {
      const provisional = this.provisional;
      const active = this.active;
      if (!provisional || !active || event.payload.responseId !== provisional.responseId || event.payload.outputEpoch !== provisional.outputEpoch || active.responseId !== provisional.responseId || active.playbackId !== provisional.playbackId || active.outputEpoch !== provisional.outputEpoch) return;
      provisional.confirmed = true;
      await this.terminalize('cancelled');
      this.clearProvisional();
    } else if (event.type === 'barge_in.rejected' || event.type === 'barge_in.timed_out') {
      const provisional = this.provisional;
      const active = this.active;
      if (!provisional || !active || event.payload.responseId !== provisional.responseId || event.payload.outputEpoch !== provisional.outputEpoch || active.responseId !== provisional.responseId || active.playbackId !== provisional.playbackId || active.outputEpoch !== provisional.outputEpoch) return;
      const safe = canSafelyResume({
        hostResumable: event.payload.resumable === true,
        responseMatches: true,
        playbackMatches: true,
        epochMatches: active.outputEpoch === event.epoch,
        wasSpeaking: true,
        playbackTerminal: active.terminal,
        echoRecovered: true,
        newerStableTurn: false,
        stopped: this.stopped,
        confirmed: provisional.confirmed,
      });
      this.clearProvisional();
      if (safe) await active.player.resume();
      else await this.terminalize('cancelled');
    }
  }

  async reportPlaybackProgress(progress: PlaybackProgress): Promise<void> {
    if (this.stopped || !this.active || this.active.playbackId !== progress.playbackId || this.active.outputEpoch !== progress.outputEpoch || this.active.terminal) return;
    const event = createEnvelope({ sessionId: this.options.sessionId, epoch: this.state.epoch, type: 'playback.progress', payload: { ...progress } });
    const stored = await this.options.writer.apply(event);
    if (!stored.ok) { this.degrade(stored.degradedReason ?? 'Playback progress could not be saved.'); return; }
    await this.options.transport.sendProgress(progress);
  }

  reportPlaybackTerminal(receipt: PlaybackTerminal): Promise<void> {
    const reportKey = this.playbackKey(receipt.cancelledEpoch, receipt.playbackId);
    const existing = this.terminalReports.get(reportKey);
    if (existing) return existing;
    const part = this.playbackByPart.get(receipt.playbackId);
    if (part) part.terminal = true;
    if (this.active?.playbackId === receipt.playbackId && this.active.outputEpoch === receipt.cancelledEpoch) this.active.terminal = true;
    const report = (async () => {
      const event = createEnvelope({ sessionId: this.options.sessionId, epoch: this.state.epoch, type: 'playback.stopped', payload: { ...receipt } });
      const stored = await this.options.writer.apply(event);
      if (!stored.ok) { this.degrade(stored.degradedReason ?? 'The terminal playback receipt could not be saved.'); return; }
      await this.options.transport.sendTerminal(receipt, event);
      this.advanceGroup(receipt.playbackId);
    })();
    this.terminalReports.set(reportKey, report);
    return report;
  }

  async cancelAssistant(): Promise<void> {
    await this.options.transport.cancelAssistant();
    await this.terminalize('cancelled');
    this.clearProvisional();
    this.setState({ ...this.state, dominant: 'listening', announcement: 'Listening', playbackNotice: '' });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    activityLog.append({ level: 'info', source: 'controller', message: 'session stop requested' });
    this.cancelSilence?.();
    this.setState({ ...this.state, dominant: 'stopping', announcement: 'Stopping session', playbackNotice: '' });
    await this.terminalize('stopped');
    this.clearProvisional();
    await this.options.transport.stopSession('user');
    this.options.transport.disconnect();
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    const ended = await this.options.writer.endSession(this.options.sessionId);
    if (!ended.ok) {
      this.degrade(ended.degradedReason ?? 'The session stopped, but its final local state could not be saved.');
      return;
    }
    this.setState({ ...this.state, dominant: 'idle', announcement: 'Session stopped', playbackNotice: '' });
  }

  degrade(message: string): void {
    activityLog.append({ level: 'error', source: 'controller', message: 'session degraded', detail: message });
    this.setState(reduceSessionState(this.state, createEnvelope({ sessionId: this.options.sessionId, epoch: this.state.epoch, type: 'failure', payload: { detail: message } })));
  }

  private matchesProvisionalResolution(event: StableEvent): boolean {
    const provisional = this.provisional;
    const active = this.active;
    return Boolean(provisional && active
      && event.payload.responseId === provisional.responseId
      && event.payload.outputEpoch === provisional.outputEpoch
      && (event.type !== 'interruption.decision' || event.payload.playbackId === provisional.playbackId)
      && active.responseId === provisional.responseId
      && active.playbackId === provisional.playbackId
      && active.outputEpoch === provisional.outputEpoch);
  }

  private handleAudio(chunk: OutputAudioChunk): void {
    const part = this.playbackByPart.get(chunk.playbackId);
    if (part && !part.terminal) part.player.append(chunk.sampleOffset, chunk.pcm16);
  }
  private async handleTransportFailure(message: string): Promise<void> {
    const active = this.active;
    if (active && !active.terminal) {
      active.terminal = true;
      try { await active.player.stop('failed'); } catch { /* local cutoff was still attempted */ }
    }
    this.clearProvisional();
    this.degrade(message);
  }
  private async terminalize(reason: PlaybackStopReason): Promise<void> {
    const active = this.active;
    if (!active || active.terminal) return;
    const group = this.groups.get(active.responseId);
    const queued = group && !group.terminal ? group.parts.filter(part => part.playbackId !== active.playbackId && !part.terminal) : [];
    for (const part of queued) {
      part.terminal = true;
      try {
        const receipt = await part.player.stop('cancelled');
        await this.reportPlaybackTerminal(receipt);
      } catch { /* local cutoff was still attempted */ }
    }
    activityLog.append({ level: 'info', source: 'controller', message: 'playback stopped', detail: reason });
    const receipt = await active.player.stop(reason);
    await this.reportPlaybackTerminal(receipt);
  }
  private advanceGroup(completedPlaybackId: string): void {
    const part = this.playbackByPart.get(completedPlaybackId);
    if (!part) return;
    const group = this.groups.get(part.responseId);
    if (!group || group.terminal) return;
    const index = group.parts.findIndex(candidate => candidate.playbackId === completedPlaybackId);
    if (index < 0 || index !== group.activeIndex) return;
    this.playbackByPart.delete(completedPlaybackId);
    const nextIndex = index + 1;
    const next = group.parts[nextIndex];
    if (!next) {
      group.terminal = true;
      this.groups.delete(part.responseId);
      if (this.active?.playbackId === completedPlaybackId) this.active = undefined;
      return;
    }
    group.activeIndex = nextIndex;
    this.active = next;
    void next.player.resume().catch(() => undefined);
  }
  private playbackKey(outputEpoch: number, playbackId: string): string { return `${outputEpoch}:${playbackId}`; }
  private clearProvisional(): void { this.provisional = undefined; }
  private setState(state: SessionViewState): void {
    const previous = this.state;
    this.state = state;
    if (state.dominant !== previous.dominant) {
      activityLog.append({ level: state.dominant === 'degraded' ? 'error' : 'info', source: 'controller', message: `session state: ${state.dominant}` });
    }
    for (const listener of this.listeners) listener(state);
  }
}
