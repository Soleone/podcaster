import type { HostEvent } from '@app/contracts';
import type { PlaybackProgress, PlaybackStopReason, PlaybackTerminal } from '../audio/playback-ledger';
import type { PlaybackPauseCheckpoint, StableTurnWriter } from '../storage/stable-turn-writer';
import { activityLog } from './activity-log';
import { createEnvelope } from './envelope';
import { canSafelyResume, initialSessionState, reduceSessionState, type SessionViewState } from './state';
import type { OutputAudioChunk, SessionTransport } from './transport';

export interface ControlledPlayback {
  setGeneratedSamples(samples: number): void;
  append(offset: number, pcm16: Int16Array): void;
  pause(): Promise<PlaybackProgress>;
  resume(rewindMs?: number): Promise<void>;
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
interface ActivePlayback { playbackId: string; responseId: string; outputEpoch: number; player: ControlledPlayback; terminal: boolean; partIndex?: number; pendingAudio?: Array<{ sampleOffset: number; pcm16: Int16Array }>; speechPauseGeneration?: number; speechPause?: Promise<PlaybackProgress> | undefined }
interface ResponsePlaybackGroup { responseId: string; parts: ActivePlayback[]; activeIndex: number; terminal: boolean }
function resumeRewindMs(payload: { rewindMs?: number }): number {
  const rewindMs = payload.rewindMs;
  return typeof rewindMs === 'number' && Number.isSafeInteger(rewindMs) && rewindMs > 0 ? rewindMs : 0;
}

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
  private userSpeaking = false;
  private speechGeneration = 0;
  private deferredResume: HostEvent | undefined;
  private eventQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  private pausing = false;
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

  handleEvent(event: HostEvent): Promise<void> {
    // VAD and playback events arrive on separate asynchronous paths. Observe a
    // speech start before queueing any older host resolution so local playback
    // is silenced immediately and a stale resume cannot win the race.
    if (!this.pausing && !this.stopped && event.sessionId === this.options.sessionId && event.epoch >= this.state.epoch) {
      if (event.type === 'vad.speech_start') {
        this.userSpeaking = true;
        this.speechGeneration++;
        this.pauseActiveForSpeech();
      } else if (event.type === 'vad.speech_end') {
        this.userSpeaking = false;
      }
    }
    const run = this.eventQueue.then(() => this.processEvent(event), () => this.processEvent(event));
    this.eventQueue = run.catch(() => undefined);
    return run;
  }

  private async processEvent(event: HostEvent): Promise<void> {
    if (this.pausing || this.stopped || event.sessionId !== this.options.sessionId || this.seenEvents.has(event.eventId)) return;
    if (event.epoch < this.state.epoch) return;
    const isInterruptionResolution = event.type === 'barge_in.confirmed' || event.type === 'barge_in.rejected' || event.type === 'barge_in.timed_out' || event.type === 'interruption.decision';
    const resumesPlayback = (event.type === 'interruption.decision' && event.payload.action === 'resume')
      || ((event.type === 'barge_in.rejected' || event.type === 'barge_in.timed_out') && event.payload.resumable === true);
    if (isInterruptionResolution && !this.matchesProvisionalResolution(event)) return;
    if (resumesPlayback && this.userSpeaking) {
      // A resolution for an older utterance must not make the agent audible
      // during a newer utterance. Keep it pending until VAD reports speech end.
      this.deferredResume = event;
      return;
    }
    if (isInterruptionResolution) {
      const provisional = this.provisional!;
      if (!await provisional.checkpointReady || this.provisional !== provisional) return;
      if (resumesPlayback && this.userSpeaking) {
        // Speech may seize the mic while the pause checkpoint is being
        // persisted. Re-check after the await, not only at event arrival.
        this.deferredResume = event;
        return;
      }
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
    if (event.type === 'vad.speech_end') {
      const deferred = this.deferredResume;
      this.deferredResume = undefined;
      if (deferred) await this.processEvent(deferred);
    }
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
        if (this.userSpeaking && firstPart) this.pauseForSpeech(part);
        // Non-first parts are queued and become audible when their predecessor
        // reports a terminal receipt (see advanceGroup). Their PCM is held in
        // handleAudio until then so it can never overlap the still-speaking
        // predecessor (the sidecar prefetches the successor while part 0 plays).
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
      activityLog.append({ level: 'warn', source: 'controller', message: 'response failed', detail: `${String(event.payload.responseId)}${typeof event.payload.reasonCode === 'string' ? ` reason=${event.payload.reasonCode}` : ''}` });
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
        const speechPause = active.speechPause;
        active.speechPause = undefined;
        const progress = await (speechPause ?? active.player.pause());
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
        const rewindMs = resumeRewindMs(event.payload);
        this.clearProvisional();
        await active.player.resume(rewindMs);
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
      const rewindMs = resumeRewindMs(event.payload);
      this.clearProvisional();
      if (safe && !this.userSpeaking) await active.player.resume(rewindMs);
      else if (safe) this.deferredResume = event;
      else await this.terminalize('cancelled');
    }
  }

  async reportPlaybackProgress(progress: PlaybackProgress): Promise<void> {
    if (this.pausing || this.stopped || !this.active || this.active.playbackId !== progress.playbackId || this.active.outputEpoch !== progress.outputEpoch || this.active.terminal) return;
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
    const event = createEnvelope({ sessionId: this.options.sessionId, epoch: this.state.epoch, type: 'playback.stopped', payload: { ...receipt } });
    // Playback is authoritative locally. Clear the marker before waiting for
    // storage or the host's follow-up session.state event, while retaining it
    // when this is a queued/stale part and another output is still active.
    this.applyLocalPlaybackTerminal(receipt, this.playbackContinuesAfter(receipt));
    const report = (async () => {
      const stored = await this.options.writer.apply(event);
      if (!stored.ok) { this.degrade(stored.degradedReason ?? 'The terminal playback receipt could not be saved.'); return; }
      try { await this.options.transport.sendTerminal(receipt, event); }
      catch (error) { activityLog.append({ level: 'warn', source: 'controller', message: 'playback terminal receipt could not be sent', ...(error instanceof Error ? { detail: error.message } : {}) }); }
      this.advanceGroup(receipt.playbackId);
    })();
    this.terminalReports.set(reportKey, report);
    return report;
  }

  async cancelAssistant(): Promise<void> {
    this.userSpeaking = false;
    this.deferredResume = undefined;
    await this.options.transport.cancelAssistant();
    await this.terminalize('cancelled');
    this.clearProvisional();
    this.setState({ ...this.state, dominant: 'listening', announcement: 'Listening', playbackNotice: '' });
  }

  /**
   * Checkpoints the local session, then tears down the live controller and
   * transport. A pause deliberately stops an in-flight assistant response;
   * the next resume starts listening from durable transcript/recording state
   * instead of trying to resurrect browser audio or a host stream.
   */
  async pause(): Promise<boolean> {
    if (this.stopped) return this.state.dominant === 'paused';
    if (this.pausing) return false;
    this.pausing = true;
    const activeAtPause = this.active && !this.active.terminal ? this.active : undefined;
    let audioSilenced = false;
    let playbackCheckpoint: PlaybackPauseCheckpoint | undefined;
    let checkpoint: { ok: boolean; degradedReason?: string };
    try {
      // Silence browser output before waiting on storage or host teardown. New
      // audio is blocked by the pausing barrier, and a failed checkpoint can
      // still resume this player below.
      if (activeAtPause) {
        const progress = await activeAtPause.player.pause();
        playbackCheckpoint = { responseId: activeAtPause.responseId, playbackId: activeAtPause.playbackId, outputEpoch: activeAtPause.outputEpoch, pausedSampleOffset: progress.playedSampleOffset, generatedSamples: progress.generatedSamples };
        audioSilenced = true;
      }
      // Finish the event already being reduced before taking the durable pause
      // snapshot. New events see pausing=true and are ignored, so nothing can
      // be written after the checkpoint while resources are being released.
      await this.eventQueue;
      const pausedAt = new Date().toISOString();
      checkpoint = await this.options.writer.pauseSession(this.options.sessionId, pausedAt, playbackCheckpoint ? [playbackCheckpoint] : []);
    } catch (error) {
      checkpoint = { ok: false, degradedReason: error instanceof Error ? error.message : 'The session pause could not be saved.' };
    }
    if (!checkpoint.ok) {
      this.pausing = false;
      if (audioSilenced && activeAtPause && !activeAtPause.terminal) {
        try { await activeAtPause.player.resume(); } catch { /* keep the degraded state visible */ }
      }
      this.degrade(checkpoint.degradedReason ?? 'The session pause could not be saved.');
      return false;
    }

    this.stopped = true;
    this.pausing = false;
    this.userSpeaking = false;
    this.deferredResume = undefined;
    activityLog.append({ level: 'info', source: 'controller', message: 'session pause requested' });
    this.cancelSilence?.();
    try { await this.terminalize('stopped'); }
    catch (error) { activityLog.append({ level: 'warn', source: 'controller', message: 'in-flight playback did not finish its pause cleanup', ...(error instanceof Error ? { detail: error.message } : {}) }); }
    this.clearProvisional();
    try { await this.options.transport.stopSession('disconnect'); }
    catch (error) { activityLog.append({ level: 'warn', source: 'controller', message: 'session transport could not be stopped cleanly', ...(error instanceof Error ? { detail: error.message } : {}) }); }
    this.options.transport.disconnect();
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.setState({ ...this.state, dominant: 'paused', announcement: 'Session paused', playbackNotice: 'Any assistant response in progress was stopped and will not resume automatically.', conversationItems: this.state.conversationItems.map(item => item.kind === 'assistant' && item.playback !== 'completed' && item.playback !== 'interrupted' ? { ...item, playback: 'interrupted' as const } : item) });
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopped || this.pausing) return;
    this.stopped = true;
    this.userSpeaking = false;
    this.deferredResume = undefined;
    activityLog.append({ level: 'info', source: 'controller', message: 'session stop requested' });
    this.cancelSilence?.();
    this.setState({ ...this.state, dominant: 'stopping', announcement: 'Stopping session', playbackNotice: '' });
    await this.terminalize('stopped');
    this.clearProvisional();
    try { await this.options.transport.stopSession('user'); }
    catch (error) { activityLog.append({ level: 'warn', source: 'controller', message: 'session transport could not be stopped cleanly', ...(error instanceof Error ? { detail: error.message } : {}) }); }
    finally {
      this.options.transport.disconnect();
      for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    }
    const ended = await this.options.writer.endSession(this.options.sessionId);
    if (!ended.ok) {
      this.degrade(ended.degradedReason ?? 'The session stopped, but its final local state could not be saved.');
      return;
    }
    this.setState({ ...this.state, dominant: 'idle', announcement: 'Session stopped', playbackNotice: '' });
  }

  degrade(message: string): void {
    activityLog.append({ level: 'error', source: 'controller', message: 'session degraded', detail: message });
    const event = createEnvelope({
      sessionId: this.options.sessionId,
      epoch: this.state.epoch,
      type: 'failure',
      payload: {
        code: 'client_degraded',
        detail: message,
        correctiveAction: 'Continue listening, retry, or stop the session.',
        recoverable: true,
      },
    });
    void this.options.writer.apply(event);
    this.setState(reduceSessionState(this.state, event));
  }

  private matchesProvisionalResolution(event: HostEvent): boolean {
    const provisional = this.provisional;
    const active = this.active;
    if (!provisional || !active || !('responseId' in event.payload) || !('outputEpoch' in event.payload)) return false;
    return event.payload.responseId === provisional.responseId
      && event.payload.outputEpoch === provisional.outputEpoch
      && (event.type !== 'interruption.decision' || event.payload.playbackId === provisional.playbackId)
      && active.responseId === provisional.responseId
      && active.playbackId === provisional.playbackId
      && active.outputEpoch === provisional.outputEpoch;
  }

  private handleAudio(chunk: OutputAudioChunk): void {
    if (this.pausing || this.stopped) return;
    const part = this.playbackByPart.get(chunk.playbackId);
    if (!part || part.terminal) return;
    if (part !== this.active) {
      // Queued part: hold its PCM until advanceGroup promotes it, so its audio
      // cannot start while the previous part is still speaking. The chunks are
      // flushed in arrival order when the part becomes active.
      (part.pendingAudio ??= []).push({ sampleOffset: chunk.sampleOffset, pcm16: chunk.pcm16 });
      return;
    }
    part.player.append(chunk.sampleOffset, chunk.pcm16);
  }
  private async handleTransportFailure(message: string): Promise<void> {
    if (this.pausing || this.stopped) return;
    const active = this.active;
    if (active && !active.terminal) {
      active.terminal = true;
      try { await active.player.stop('failed'); } catch { /* local cutoff was still attempted */ }
    }
    this.clearProvisional();
    this.degrade(message);
  }
  private playbackContinuesAfter(receipt: PlaybackTerminal): boolean {
    const active = this.active;
    // No active player means a terminal receipt can only be cleaning up stale
    // presentation state. If another player is active, this receipt is for an
    // older or queued part and must not hide its speaking marker.
    if (!active) return false;
    if (active.playbackId !== receipt.playbackId || active.outputEpoch !== receipt.cancelledEpoch) return true;
    const group = this.groups.get(active.responseId);
    if (!group || group.terminal) return false;
    const index = group.parts.findIndex(part => part.playbackId === receipt.playbackId);
    const successor = index >= 0 ? group.parts[index + 1] : undefined;
    return successor !== undefined && !successor.terminal;
  }

  private applyLocalPlaybackTerminal(receipt: PlaybackTerminal, continues: boolean): void {
    const completed = receipt.reason === 'completed';
    let changed = false;
    const conversationItems = this.state.conversationItems.map(item => {
      if (item.kind !== 'assistant' || item.playbackId !== receipt.playbackId) return item;
      changed = true;
      return { ...item, playback: completed ? 'completed' as const : 'interrupted' as const };
    });
    const speakingEnded = !continues && this.state.dominant === 'speaking';
    if (!changed && !speakingEnded) return;
    this.setState({
      ...this.state,
      ...(speakingEnded ? { dominant: 'listening' as const, announcement: 'Listening' } : {}),
      conversationItems,
    });
  }

  private async terminalize(reason: PlaybackStopReason): Promise<void> {
    const active = this.active;
    if (!active || active.terminal) return;
    const group = this.groups.get(active.responseId);
    const queued = group && !group.terminal ? group.parts.filter(part => part.playbackId !== active.playbackId && !part.terminal) : [];
    for (const part of queued) {
      part.terminal = true;
      try {
        const receipt = await part.player.stop(reason);
        await this.reportPlaybackTerminal(receipt);
      } catch { /* local cutoff was still attempted */ }
    }
    activityLog.append({ level: 'info', source: 'controller', message: 'playback stopped', detail: reason });
    try {
      const receipt = await active.player.stop(reason);
      await this.reportPlaybackTerminal(receipt);
    } catch (error) {
      activityLog.append({ level: 'warn', source: 'controller', message: 'playback cleanup failed', ...(error instanceof Error ? { detail: error.message } : {}) });
    }
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
    if (!next || next.terminal) {
      // No live successor: the response is done, or the successor was cancelled
      // while queued (whole-group teardown) and must not be promoted.
      group.terminal = true;
      this.groups.delete(part.responseId);
      if (this.active?.playbackId === completedPlaybackId) this.active = undefined;
      return;
    }
    group.activeIndex = nextIndex;
    this.active = next;
    if (this.userSpeaking) this.pauseForSpeech(next);
    const pendingAudio = next.pendingAudio;
    if (pendingAudio) {
      delete next.pendingAudio;
      for (const chunk of pendingAudio) next.player.append(chunk.sampleOffset, chunk.pcm16);
    }
    if (!this.userSpeaking && !this.provisional) void next.player.resume().catch(() => undefined);
  }
  private playbackKey(outputEpoch: number, playbackId: string): string { return `${outputEpoch}:${playbackId}`; }
  private pauseActiveForSpeech(): void { if (this.active && !this.active.terminal) this.pauseForSpeech(this.active); }
  private pauseForSpeech(part: ActivePlayback): void {
    if (part.speechPauseGeneration === this.speechGeneration) return;
    part.speechPauseGeneration = this.speechGeneration;
    part.speechPause = part.player.pause();
    void part.speechPause.catch(() => undefined);
  }
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
