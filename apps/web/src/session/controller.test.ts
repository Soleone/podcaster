import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackStopReason, PlaybackTerminal } from '../audio/playback-ledger';
import { StableTurnWriter, type StableEvent } from '../storage/stable-turn-writer';
import { SessionController, type ControlledPlayback } from './controller';
import { FakeSessionTransport } from './fake-transport';
import { initialSessionState } from './state';

let sequence = 0;
const databases: string[] = [];
const event = (sessionId: string, epoch: number, type: string, payload: Record<string, unknown>): StableEvent => ({ eventId: `event-${++sequence}`, sessionId, epoch, monotonicMs: sequence, type, payload });
afterEach(async () => { for (const name of databases.splice(0)) await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); }); });

class FakePlayback implements ControlledPlayback {
  generated = 0;
  pause = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  append = vi.fn();
  stops: PlaybackStopReason[] = [];
  private receipt?: PlaybackTerminal;
  constructor(private readonly playbackId: string, private readonly epoch: number) {}
  setGeneratedSamples(samples: number): void { this.generated = samples; }
  async stop(reason: PlaybackStopReason): Promise<PlaybackTerminal> {
    this.stops.push(reason);
    return this.receipt ??= { playbackId: this.playbackId, cancelledEpoch: this.epoch, finalPlayedSampleOffset: 0, reason };
  }
}

async function setup(epoch = 0, schedule?: (delay: number, callback: () => void) => () => void) {
  const name = `controller-${++sequence}`; databases.push(name);
  const writer = await StableTurnWriter.open(indexedDB, name);
  await writer.beginSession({ sessionId: 'session', sessionSeed: 'seed', personaDigest: 'digest' });
  const transport = new FakeSessionTransport();
  await transport.connect('capability');
  const players: FakePlayback[] = [];
  const controller = new SessionController({
    sessionId: 'session', transport, writer,
    initialState: { ...initialSessionState, dominant: 'listening', announcement: 'Listening', epoch },
    playbackFactory: input => { const player = new FakePlayback(input.playbackId, input.outputEpoch); players.push(player); return player; },
    ...(schedule ? { schedule } : {}),
  });
  return { controller, players, transport, writer };
}

describe('SessionController', () => {
  it('rejects wrong-session and stale non-accounting events before side effects', async () => {
    const { controller, players, transport, writer } = await setup(2);
    await transport.emit(event('other', 2, 'tts.started', { responseId: 'wrong', playbackId: 'wrong', sampleRate: 24000 }));
    await transport.emit(event('session', 1, 'tts.started', { responseId: 'stale', playbackId: 'stale', sampleRate: 24000 }));
    expect(players).toHaveLength(0);
    await transport.emit(event('session', 2, 'tts.started', { responseId: 'current', playbackId: 'current', sampleRate: 24000 }));
    expect(players).toHaveLength(1);
    await transport.emit(event('session', 1, 'barge_in.provisional', { responseId: 'current', outputEpoch: 2, resumable: true }));
    await transport.emit(event('session', 1, 'barge_in.rejected', { responseId: 'current', outputEpoch: 2, resumable: true }));
    expect(players[0]!.pause).not.toHaveBeenCalled();
    expect(players[0]!.resume).not.toHaveBeenCalled();
    expect(controller.snapshot().echoConfirmation).toBe(false);
    writer.close();
  });

  it('resumes a rejected provisional only after every local safe-resume guard holds', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }));
    await transport.emit(event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }));
    expect(players[0]!.pause).toHaveBeenCalledOnce();
    controller.setEchoRecovered(true);
    await controller.rejectBargeIn();
    expect(transport.commands).toContain('reject');
    await transport.emit(event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }));
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    expect(players[0]!.stops).toEqual([]);
    writer.close();
  });

  it('ignores mismatched barge-in resolution events without cancelling the active response', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }));
    await transport.emit(event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }));
    controller.setEchoRecovered(true);
    await transport.emit(event('session', 1, 'barge_in.confirmed', { responseId: 'unrelated', outputEpoch: 0, resumable: false }));
    await transport.emit(event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 9, resumable: true }));
    expect(players[0]!.stops).toEqual([]);
    expect(players[0]!.resume).not.toHaveBeenCalled();
    expect(controller.snapshot().echoConfirmation).toBe(true);
    await transport.emit(event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }));
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    expect(players[0]!.stops).toEqual([]);
    writer.close();
  });

  it('terminalizes instead of resuming after a newer stable turn and reports one terminal receipt', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }));
    await transport.emit(event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }));
    controller.setEchoRecovered(true);
    await transport.emit(event('session', 0, 'transcript.final', { turnId: 'new-turn', text: 'new speech', endpointComplete: true }));
    await transport.emit(event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }));
    expect(players[0]!.resume).not.toHaveBeenCalled();
    expect(players[0]!.stops).toEqual(['cancelled']);
    expect(transport.terminalReceipts.get('0:playback')).toMatchObject({ reason: 'cancelled', finalPlayedSampleOffset: 0 });
    await controller.reportPlaybackTerminal({ playbackId: 'playback', cancelledEpoch: 0, finalPlayedSampleOffset: 0, reason: 'cancelled' });
    expect(transport.terminalReceipts).toHaveLength(1);
    writer.close();
  });

  it('scopes progress and terminal deduplication to output epoch when playback IDs are reused', async () => {
    const { controller, transport, writer } = await setup();
    await transport.emit(event('session', 0, 'tts.started', { responseId: 'response-0', playbackId: 'shared', sampleRate: 24000 }));
    await controller.reportPlaybackTerminal({ playbackId: 'shared', cancelledEpoch: 0, finalPlayedSampleOffset: 0, reason: 'completed' });
    await transport.emit(event('session', 1, 'tts.started', { responseId: 'response-1', playbackId: 'shared', sampleRate: 24000 }));
    await controller.reportPlaybackProgress({ playbackId: 'shared', outputEpoch: 0, playedSampleOffset: 10, generatedSamples: 100 });
    await controller.reportPlaybackProgress({ playbackId: 'shared', outputEpoch: 1, playedSampleOffset: 20, generatedSamples: 100 });
    await controller.reportPlaybackTerminal({ playbackId: 'shared', cancelledEpoch: 1, finalPlayedSampleOffset: 20, reason: 'cancelled' });
    expect(transport.progressReports).toEqual([{ playbackId: 'shared', outputEpoch: 1, playedSampleOffset: 20, generatedSamples: 100 }]);
    expect(transport.terminalHistory).toEqual([
      { playbackId: 'shared', cancelledEpoch: 0, finalPlayedSampleOffset: 0, reason: 'completed' },
      { playbackId: 'shared', cancelledEpoch: 1, finalPlayedSampleOffset: 20, reason: 'cancelled' },
    ]);
    writer.close();
  });

  it('does not let a silence timer overwrite a newer reasoning state', async () => {
    let callback: (() => void) | undefined;
    const { controller, transport, writer } = await setup(0, (_delay, scheduled) => { callback = scheduled; return () => { callback = undefined; }; });
    await transport.emit(event('session', 0, 'transcript.final', { turnId: 'turn', text: 'thought', endpointComplete: true }));
    await transport.emit(event('session', 0, 'policy.decision', { turnId: 'turn', posture: 'silence', eligible: true }));
    expect(controller.snapshot().dominant).toBe('intentional_silence');
    await transport.emit(event('session', 0, 'reasoning.final', { turnId: 'turn', responseId: 'response', posture: 'question', text: 'answer' }));
    callback?.();
    expect(controller.snapshot().dominant).toBe('reasoning');
    writer.close();
  });

  it('requires fresh echo recovery evidence for each provisional interruption', async () => {
    const { controller, players, transport, writer } = await setup();
    await transport.emit(event('session', 0, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 }));
    await transport.emit(event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }));
    controller.setEchoRecovered(true);
    await transport.emit(event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }));
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    await transport.emit(event('session', 0, 'barge_in.provisional', { responseId: 'response', outputEpoch: 0, resumable: true }));
    await transport.emit(event('session', 0, 'barge_in.rejected', { responseId: 'response', outputEpoch: 0, resumable: true }));
    expect(players[0]!.resume).toHaveBeenCalledOnce();
    expect(players[0]!.stops).toEqual(['cancelled']);
    writer.close();
  });

  it('reaches a clear stopped state and surfaces end-session persistence failure', async () => {
    const successful = await setup();
    await successful.controller.stop();
    expect(successful.controller.snapshot()).toMatchObject({ dominant: 'idle', announcement: 'Session stopped' });
    successful.writer.close();

    const failed = await setup();
    vi.spyOn(failed.writer, 'endSession').mockResolvedValue({ ok: false, degradedReason: 'Could not save the stopped state.' });
    await failed.controller.stop();
    expect(failed.controller.snapshot()).toMatchObject({ dominant: 'degraded', degradedMessage: 'Could not save the stopped state.' });
    failed.writer.close();
  });
});
