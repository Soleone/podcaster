import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent } from '@app/contracts';
import type { PlaybackProgress, PlaybackStopReason, PlaybackTerminal } from '../audio/playback-ledger';
import { StableTurnWriter } from '../storage/stable-turn-writer';
import { SessionController, type ControlledPlayback } from './controller';
import { FakeSessionTransport } from './fake-transport';
import { initialSessionState } from './state';

let sequence = 0;
const databases: string[] = [];
const event = <T extends HostEvent['type']>(
  sessionId: string,
  epoch: number,
  type: T,
  payload: Record<string, unknown>,
): HostEvent =>
  ({
    protocolVersion: 1,
    eventId: `event-${++sequence}`,
    sessionId,
    epoch,
    monotonicMs: sequence,
    type,
    payload,
  }) as HostEvent;
afterEach(async () => {
  for (const name of databases.splice(0))
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
});

class FakePlayback implements ControlledPlayback {
  generated = 0;
  pause = vi.fn(async () => ({
    playbackId: this.playbackId,
    outputEpoch: this.epoch,
    playedSampleOffset: 0,
    generatedSamples: this.generated,
  }));
  resume = vi.fn(async () => undefined);
  append = vi.fn();
  stops: PlaybackStopReason[] = [];
  private receipt?: PlaybackTerminal;
  constructor(
    private readonly playbackId: string,
    private readonly epoch: number,
  ) {}
  setGeneratedSamples(samples: number): void {
    this.generated = samples;
  }
  async stop(reason: PlaybackStopReason): Promise<PlaybackTerminal> {
    this.stops.push(reason);
    return (this.receipt ??= {
      playbackId: this.playbackId,
      cancelledEpoch: this.epoch,
      finalPlayedSampleOffset: 0,
      reason,
    });
  }
}

async function setup(epoch = 0, schedule?: (delay: number, callback: () => void) => () => void) {
  const name = `controller-${++sequence}`;
  databases.push(name);
  const writer = await StableTurnWriter.open(indexedDB, name);
  await writer.beginSession({ sessionId: 'session', sessionSeed: 'seed', personaDigest: 'digest' });
  const transport = new FakeSessionTransport();
  await transport.connect('capability');
  const players: FakePlayback[] = [];
  const controller = new SessionController({
    sessionId: 'session',
    transport,
    writer,
    initialState: { ...initialSessionState, dominant: 'listening', announcement: 'Listening', epoch },
    playbackFactory: (input) => {
      const player = new FakePlayback(input.playbackId, input.outputEpoch);
      players.push(player);
      return player;
    },
    ...(schedule ? { schedule } : {}),
  });
  return { controller, players, transport, writer };
}

describe('SessionController', () => {
  it('plays multi-part responses sequentially: queues the body until the stall terminalizes, then advances', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'reasoning.started', {
        turnId: 'turn',
        responseId: 'response',
        posture: 'riff',
        partIndex: 0,
      }),
    );
    await transport.emit(
      event('session', 0, 'tts.started', {
        responseId: 'response',
        playbackId: 'stall',
        sampleRate: 24000,
        partIndex: 0,
      }),
    );
    await transport.emit(
      event('session', 0, 'reasoning.started', {
        turnId: 'turn',
        responseId: 'response',
        posture: 'riff',
        partIndex: 1,
      }),
    );
    await transport.emit(
      event('session', 0, 'tts.started', {
        responseId: 'response',
        playbackId: 'body',
        sampleRate: 24000,
        partIndex: 1,
      }),
    );
    // Both parts exist; only the stall is active.
    expect(players).toHaveLength(2);
    expect(players[1]!.resume).not.toHaveBeenCalled();
    // Stall terminalizes -> body becomes active and resumes.
    await controller.reportPlaybackTerminal({
      playbackId: 'stall',
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 3200,
      reason: 'completed',
    });
    expect(players[1]!.resume).toHaveBeenCalledOnce();
    // Body terminalizes -> response completes.
    await controller.reportPlaybackTerminal({
      playbackId: 'body',
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 6400,
      reason: 'completed',
    });
    writer.close();
  });

  it('holds a queued part\u2019s PCM until its predecessor terminalizes, then flushes it in order', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', {
        responseId: 'response',
        playbackId: 'part-0',
        sampleRate: 24000,
        partIndex: 0,
      }),
    );
    await transport.emit(
      event('session', 0, 'tts.started', {
        responseId: 'response',
        playbackId: 'part-1',
        sampleRate: 24000,
        partIndex: 1,
      }),
    );
    transport.emitAudio({ playbackId: 'part-0', sequence: 0, sampleOffset: 0, pcm16: new Int16Array(480) });
    transport.emitAudio({ playbackId: 'part-1', sequence: 0, sampleOffset: 0, pcm16: new Int16Array(480) });
    transport.emitAudio({ playbackId: 'part-1', sequence: 1, sampleOffset: 480, pcm16: new Int16Array(480) });
    // The active part plays immediately; the queued part stays silent while its
    // predecessor is still speaking.
    expect(players[0]!.append).toHaveBeenCalledOnce();
    expect(players[1]!.append).not.toHaveBeenCalled();
    // Predecessor terminalizes -> queued part is promoted and its held PCM
    // flushes in arrival order (offsets 0 then 480).
    await controller.reportPlaybackTerminal({
      playbackId: 'part-0',
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 480,
      reason: 'completed',
    });
    expect(players[1]!.append).toHaveBeenCalledTimes(2);
    expect(players[1]!.append.mock.calls.map((call) => call[0])).toEqual([0, 480]);
    expect(players[1]!.resume).toHaveBeenCalledOnce();
    expect(controller.snapshot().dominant).toBe('speaking');
    await controller.reportPlaybackTerminal({ playbackId: 'part-1', cancelledEpoch: 0, finalPlayedSampleOffset: 960, reason: 'completed' });
    expect(controller.snapshot().dominant).toBe('listening');
    writer.close();
  });

  it('clears speaking immediately on the local playback terminal, without waiting for host state', async () => {
    const { controller, transport, writer } = await setup();
    await transport.emit(event('session', 0, 'reasoning.started', { turnId: 'turn', responseId: 'response', posture: 'riff' }));
    await transport.emit(event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }));
    expect(controller.snapshot().dominant).toBe('speaking');
    const report = controller.reportPlaybackTerminal({ playbackId: 'playback', cancelledEpoch: 0, finalPlayedSampleOffset: 480, reason: 'completed' });
    expect(controller.snapshot()).toMatchObject({ dominant: 'listening', announcement: 'Listening' });
    await report;
    writer.close();
  });

  it('drops held PCM when a queued part is cancelled before it becomes active', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', {
        responseId: 'response',
        playbackId: 'part-0',
        sampleRate: 24000,
        partIndex: 0,
      }),
    );
    await transport.emit(
      event('session', 0, 'tts.started', {
        responseId: 'response',
        playbackId: 'part-1',
        sampleRate: 24000,
        partIndex: 1,
      }),
    );
    transport.emitAudio({ playbackId: 'part-1', sequence: 0, sampleOffset: 0, pcm16: new Int16Array(480) });
    expect(players[1]!.append).not.toHaveBeenCalled();
    // Barge-in accept cancels the whole response: active and queued parts stop
    // and the queued part's held audio never reaches its player.
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.confirmed', { responseId: 'response', outputEpoch: 0, resumable: false }),
    );
    expect(players[0]!.stops).toEqual(['cancelled']);
    expect(players[1]!.stops).toEqual(['cancelled']);
    expect(players[1]!.append).not.toHaveBeenCalled();
    writer.close();
  });

  it('rejects wrong-session and stale non-accounting events before side effects', async () => {
    const { controller, players, transport, writer } = await setup(2);
    await transport.emit(
      event('other', 2, 'tts.started', { responseId: 'wrong', playbackId: 'wrong', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 1, 'tts.started', { responseId: 'stale', playbackId: 'stale', sampleRate: 24000 }),
    );
    expect(players).toHaveLength(0);
    await transport.emit(
      event('session', 2, 'tts.started', { responseId: 'current', playbackId: 'current', sampleRate: 24000 }),
    );
    expect(players).toHaveLength(1);
    await transport.emit(
      event('session', 1, 'barge_in.provisional', { responseId: 'current', outputEpoch: 2, resumable: true }),
    );
    await transport.emit(
      event('session', 1, 'barge_in.rejected', { responseId: 'current', outputEpoch: 2, resumable: true }),
    );
    expect(players[0]!.pause).not.toHaveBeenCalled();
    expect(players[0]!.resume).not.toHaveBeenCalled();
    writer.close();
  });

  it('pauses active playback immediately when VAD speech starts', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'vad.speech_start', {
        streamId: '018f1f32-7abc-7def-8abc-0123456789ab',
        utteranceId: '018f1f32-7abd-7def-8abc-0123456789ab',
        captureStartSequence: 0,
      }),
    );
    expect(players[0]!.pause).toHaveBeenCalledOnce();
    writer.close();
  });

  it('defers an interruption resume until VAD speech ends', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 0, 'vad.speech_start', {
        streamId: '018f1f32-7abc-7def-8abc-0123456789ab',
        utteranceId: '018f1f32-7abd-7def-8abc-0123456789ab',
        captureStartSequence: 0,
      }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.resume).not.toHaveBeenCalled();
    await transport.emit(
      event('session', 0, 'vad.speech_end', {
        streamId: '018f1f32-7abc-7def-8abc-0123456789ab',
        utteranceId: '018f1f32-7abd-7def-8abc-0123456789ab',
        captureStartSequence: 0,
        captureEndSequence: 10,
      }),
    );
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    writer.close();
  });

  it('resumes a rejected provisional only after every local safe-resume guard holds', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.pause).toHaveBeenCalledOnce();
    await transport.emit(
      event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    expect(players[0]!.stops).toEqual([]);
    writer.close();
  });

  it('passes the host-authorized rewind through a resume decision', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 0, 'interruption.decision', {
        turnId: 'turn',
        responseId: 'response',
        playbackId: 'playback',
        outputEpoch: 0,
        action: 'resume',
        intent: 'continue_previous',
        confidence: 'high',
        disposition: 'resume_requested',
        pausedSampleOffset: 0,
        rewindMs: 500,
      }),
    );
    expect(players[0]!.resume).toHaveBeenCalledWith(500);
    writer.close();
  });

  it('continues playback and explains an unanswered interruption prompt', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.timed_out', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    expect(players[0]!.stops).toEqual([]);
    expect(controller.snapshot()).toMatchObject({
      dominant: 'speaking',
      playbackNotice: '',
    });
    writer.close();
  });

  it('ignores mismatched barge-in resolution events without cancelling the active response', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 1, 'barge_in.confirmed', { responseId: 'unrelated', outputEpoch: 0, resumable: false }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 9, resumable: true }),
    );
    expect(players[0]!.stops).toEqual([]);
    expect(players[0]!.resume).not.toHaveBeenCalled();
    expect(controller.snapshot().dominant).toBe('listening');
    await transport.emit(
      event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    expect(players[0]!.stops).toEqual([]);
    writer.close();
  });

  it('obeys a host-authorized resume without applying a second transcript heuristic', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 0, 'transcript.final', {
        turnId: 'new-turn',
        text: 'new meaningful speech',
        endpointComplete: true,
      }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    expect(players[0]!.stops).toEqual([]);
    expect(transport.terminalReceipts).toHaveLength(0);
    writer.close();
  });

  it('accepts only an identity-matched authoritative takeover decision', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 0, 'interruption.decision', {
        turnId: 'wrong',
        responseId: 'response',
        playbackId: 'other-playback',
        outputEpoch: 0,
        action: 'accept',
        intent: 'new_request',
        confidence: 'high',
        disposition: 'accept_takeover',
        pausedSampleOffset: 0,
      }),
    );
    expect(players[0]!.stops).toEqual([]);
    await transport.emit(
      event('session', 0, 'interruption.decision', {
        turnId: 'turn',
        responseId: 'response',
        playbackId: 'playback',
        outputEpoch: 0,
        action: 'accept',
        intent: 'new_request',
        confidence: 'high',
        disposition: 'accept_takeover',
        pausedSampleOffset: 0,
      }),
    );
    expect(players[0]!.resume).not.toHaveBeenCalled();
    expect(players[0]!.stops).toEqual(['cancelled']);
    expect(transport.terminalReceipts.get('0:playback')).toMatchObject({ reason: 'cancelled' });
    writer.close();
  });

  it('buffers an authoritative decision until a deferred pause checkpoint is persisted', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    let finishPause!: (progress: PlaybackProgress) => void;
    players[0]!.pause.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPause = resolve;
        }),
    );
    const provisional = transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    while (!players[0]!.pause.mock.calls.length) await new Promise<void>((resolve) => setImmediate(resolve));
    const decision = transport.emit(
      event('session', 0, 'interruption.decision', {
        turnId: 'turn',
        responseId: 'response',
        playbackId: 'playback',
        outputEpoch: 0,
        action: 'accept',
        intent: 'new_request',
        confidence: 'high',
        disposition: 'accept_takeover',
        pausedSampleOffset: 48,
      }),
    );
    await Promise.resolve();
    expect(players[0]!.stops).toEqual([]);
    finishPause({ playbackId: 'playback', outputEpoch: 0, playedSampleOffset: 48, generatedSamples: 96 });
    await Promise.all([provisional, decision]);
    expect(transport.pauseCheckpoints).toContainEqual(
      expect.objectContaining({ playbackId: 'playback', pausedSampleOffset: 48 }),
    );
    expect(players[0]!.stops).toEqual(['cancelled']);
    expect(transport.terminalReceipts.get('0:playback')).toMatchObject({
      finalPlayedSampleOffset: 0,
      reason: 'cancelled',
    });
    writer.close();
  });

  it('scopes progress and terminal deduplication to output epoch when playback IDs are reused', async () => {
    const { controller, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response-0', playbackId: 'shared', sampleRate: 24000 }),
    );
    await controller.reportPlaybackTerminal({
      playbackId: 'shared',
      cancelledEpoch: 0,
      finalPlayedSampleOffset: 0,
      reason: 'completed',
    });
    await transport.emit(
      event('session', 1, 'tts.started', { responseId: 'response-1', playbackId: 'shared', sampleRate: 24000 }),
    );
    await controller.reportPlaybackProgress({
      playbackId: 'shared',
      outputEpoch: 0,
      playedSampleOffset: 10,
      generatedSamples: 100,
    });
    await controller.reportPlaybackProgress({
      playbackId: 'shared',
      outputEpoch: 1,
      playedSampleOffset: 20,
      generatedSamples: 100,
    });
    await controller.reportPlaybackTerminal({
      playbackId: 'shared',
      cancelledEpoch: 1,
      finalPlayedSampleOffset: 20,
      reason: 'cancelled',
    });
    expect(transport.progressReports).toEqual([
      { playbackId: 'shared', outputEpoch: 1, playedSampleOffset: 20, generatedSamples: 100 },
    ]);
    expect(transport.terminalHistory).toEqual([
      { playbackId: 'shared', cancelledEpoch: 0, finalPlayedSampleOffset: 0, reason: 'completed' },
      { playbackId: 'shared', cancelledEpoch: 1, finalPlayedSampleOffset: 20, reason: 'cancelled' },
    ]);
    writer.close();
  });

  it('does not let a silence timer overwrite a newer reasoning state', async () => {
    let callback: (() => void) | undefined;
    const { controller, transport, writer } = await setup(0, (_delay, scheduled) => {
      callback = scheduled;
      return () => {
        callback = undefined;
      };
    });
    await transport.emit(
      event('session', 0, 'transcript.final', { turnId: 'turn', text: 'thought', endpointComplete: true }),
    );
    await transport.emit(
      event('session', 0, 'policy.decision', { turnId: 'turn', posture: 'silence', eligible: true }),
    );
    expect(controller.snapshot().dominant).toBe('intentional_silence');
    await transport.emit(
      event('session', 0, 'reasoning.final', {
        turnId: 'turn',
        responseId: 'response',
        posture: 'question',
        text: 'answer',
      }),
    );
    callback?.();
    expect(controller.snapshot().dominant).toBe('reasoning');
    writer.close();
  });

  it('resumes every host-authorized rejection regardless of transcript wording', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 0, 'transcript.final', { turnId: 'noise', text: 'um', endpointComplete: true }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    await transport.emit(
      event('session', 0, 'transcript.final', {
        turnId: 'speech',
        text: 'please stop speaking',
        endpointComplete: true,
      }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.resume).toHaveBeenCalledTimes(2);
    expect(players[0]!.stops).toEqual([]);
    writer.close();
  });

  it('immediately silences active playback and degrades on transport failure', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    transport.emitFailure('Conversation protocol failed.');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(players[0]!.stops).toEqual(['failed']);
    expect(controller.snapshot()).toMatchObject({
      dominant: 'degraded',
      degradedMessage: 'Conversation protocol failed.',
    });
    expect((await writer.getSession('session'))?.failures).toContain('client_degraded');
    writer.close();
  });

  it('stops only the matching playback with reason failed on response.failed', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'reasoning.started', { turnId: 'turn', responseId: 'response', posture: 'riff' }),
    );
    await transport.emit(
      event('session', 0, 'reasoning.final', {
        turnId: 'turn',
        responseId: 'response',
        posture: 'riff',
        text: 'Heard part of this answer',
      }),
    );
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'response.failed', { turnId: 'turn', responseId: 'response', reasonCode: 'tts_failed' }),
    );
    expect(players[0]!.stops).toEqual(['failed']);
    expect(transport.terminalReceipts.get('0:playback')).toMatchObject({
      finalPlayedSampleOffset: 0,
      reason: 'failed',
    });
    expect(controller.snapshot().conversationItems).toContainEqual(
      expect.objectContaining({ responseId: 'response', text: 'Heard part of this answer', playback: 'interrupted' }),
    );
    writer.close();
  });

  it('streams reasoning.delta previews into view state and materializes them on final', async () => {
    const { controller, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'reasoning.started', { turnId: 'turn', responseId: 'response', posture: 'riff' }),
    );
    await transport.emit(
      event('session', 0, 'reasoning.delta', { turnId: 'turn', responseId: 'response', text: 'A preview' }),
    );
    let item = controller
      .snapshot()
      .conversationItems.find((candidate) => candidate.kind === 'assistant' && candidate.responseId === 'response');
    expect(item).toMatchObject({ text: 'A preview', tentative: true });
    await transport.emit(
      event('session', 0, 'reasoning.delta', {
        turnId: 'turn',
        responseId: 'response',
        text: 'A preview that keeps growing',
      }),
    );
    item = controller
      .snapshot()
      .conversationItems.find((candidate) => candidate.kind === 'assistant' && candidate.responseId === 'response');
    expect(item).toMatchObject({ text: 'A preview that keeps growing', tentative: true });
    await transport.emit(
      event('session', 0, 'reasoning.final', {
        turnId: 'turn',
        responseId: 'response',
        posture: 'riff',
        text: 'A preview that keeps growing, now final',
      }),
    );
    item = controller
      .snapshot()
      .conversationItems.find((candidate) => candidate.kind === 'assistant' && candidate.responseId === 'response');
    expect(item).toMatchObject({ text: 'A preview that keeps growing, now final', tentative: false });
    writer.close();
  });

  it('clears a streaming preview when the response is cancelled via an epoch bump', async () => {
    const { controller, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'reasoning.started', { turnId: 'turn', responseId: 'response', posture: 'riff' }),
    );
    await transport.emit(
      event('session', 0, 'reasoning.delta', {
        turnId: 'turn',
        responseId: 'response',
        text: 'A preview that gets cut off',
      }),
    );
    expect(
      controller
        .snapshot()
        .conversationItems.some((candidate) => candidate.kind === 'assistant' && candidate.tentative),
    ).toBe(true);
    await transport.emit(event('session', 1, 'session.state', { phase: 'listening', personaDigest: 'a'.repeat(64) }));
    expect(
      controller
        .snapshot()
        .conversationItems.some((candidate) => candidate.kind === 'assistant' && candidate.tentative),
    ).toBe(false);
    writer.close();
  });

  it('never stops a newer or mismatched playback on response.failed', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'response.failed', { turnId: 'turn', responseId: 'other', reasonCode: 'tts_failed' }),
    );
    expect(players[0]!.stops).toEqual([]);
    expect(transport.terminalReceipts.size).toBe(0);
    await transport.emit(
      event('session', 1, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 1, 'response.failed', { turnId: 'turn', responseId: 'response', reasonCode: 'tts_failed' }),
    );
    expect(players[1]!.stops).toEqual(['failed']);
    expect(players[0]!.stops).toEqual([]);
    writer.close();
  });

  it('performs no playback operation when playback never started', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'response.failed', {
        turnId: 'turn',
        responseId: 'response',
        reasonCode: 'reasoning_invalid',
      }),
    );
    expect(players).toHaveLength(0);
    expect(transport.terminalReceipts.size).toBe(0);
    expect(controller.snapshot().conversationItems).toEqual([]);
    writer.close();
  });

  it('stops a superseded playback when a new response starts before the old one terminalized', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'reasoning.started', { turnId: 'turn-a', responseId: 'response-a', posture: 'riff' }),
    );
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response-a', playbackId: 'playback-a', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 1, 'reasoning.started', { turnId: 'turn-b', responseId: 'response-b', posture: 'riff' }),
    );
    expect(players[0]!.stops).toEqual(['cancelled']);
    expect(transport.terminalReceipts.get('0:playback-a')).toMatchObject({ reason: 'cancelled' });
    // A completed playback is already terminal and must not be double-stopped.
    await transport.emit(
      event('session', 1, 'tts.started', { responseId: 'response-b', playbackId: 'playback-b', sampleRate: 24000 }),
    );
    await controller.reportPlaybackTerminal({
      playbackId: 'playback-b',
      cancelledEpoch: 1,
      finalPlayedSampleOffset: 0,
      reason: 'completed',
    });
    await transport.emit(
      event('session', 2, 'reasoning.started', { turnId: 'turn-c', responseId: 'response-c', posture: 'riff' }),
    );
    expect(players[1]!.stops).toEqual([]);
    writer.close();
  });

  it('clears provisional interruption state on response.failed without resuming', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    await transport.emit(
      event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }),
    );
    expect(players[0]!.pause).toHaveBeenCalledOnce();
    await transport.emit(
      event('session', 0, 'response.failed', { turnId: 'turn', responseId: 'response', reasonCode: 'tts_failed' }),
    );
    expect(players[0]!.stops).toEqual(['failed']);
    expect(players[0]!.resume).not.toHaveBeenCalled();
    expect(controller.snapshot().conversationItems).toEqual([]);
    writer.close();
  });

  it('checkpoints pause, stops in-flight playback, releases the transport, and ignores late events', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(
      event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }),
    );
    expect(await controller.pause()).toBe(true);
    expect(controller.snapshot()).toMatchObject({ dominant: 'paused', announcement: 'Session paused' });
    expect(players[0]!.stops).toEqual(['stopped']);
    expect(transport.connected).toBe(false);
    expect(transport.terminalReceipts.get('0:playback')).toMatchObject({ reason: 'stopped' });
    expect(await writer.getSession('session')).toMatchObject({ state: 'paused', endedAt: null });
    await transport.emit(
      event('session', 0, 'transcript.final', { turnId: 'late', text: 'late event', endpointComplete: true }),
    );
    expect(controller.snapshot().conversationItems).toEqual([]);
    writer.close();
  });

  it('keeps the live runtime available when the pause checkpoint fails', async () => {
    const { controller, players, transport, writer } = await setup();
    vi.spyOn(writer, 'pauseSession').mockResolvedValue({
      ok: false,
      degradedReason: 'Could not save the pause checkpoint.',
    });
    expect(await controller.pause()).toBe(false);
    expect(players).toEqual([]);
    expect(transport.connected).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      dominant: 'degraded',
      degradedMessage: 'Could not save the pause checkpoint.',
    });
    writer.close();
  });

  it('reaches a clear stopped state and surfaces end-session persistence failure', async () => {
    const successful = await setup();
    await successful.controller.stop();
    expect(successful.controller.snapshot()).toMatchObject({ dominant: 'idle', announcement: 'Session stopped' });
    successful.writer.close();

    const failed = await setup();
    vi.spyOn(failed.writer, 'endSession').mockResolvedValue({
      ok: false,
      degradedReason: 'Could not save the stopped state.',
    });
    await failed.controller.stop();
    expect(failed.controller.snapshot()).toMatchObject({
      dominant: 'degraded',
      degradedMessage: 'Could not save the stopped state.',
    });
    failed.writer.close();
  });
});
