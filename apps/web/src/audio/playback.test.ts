import { describe, expect, it, vi } from 'vitest';
import { BrowserPlayback } from './playback';
import type { PlaybackTerminal } from './playback-ledger';

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startTime = 0;
  connect = vi.fn();
  start = vi.fn((time = 0) => { this.startTime = time; });
  stop = vi.fn();
  finish(): void { this.onended?.(); }
}

class FakeAudioContext {
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  sources: FakeSource[] = [];
  gain = { gain: { value: 1 }, connect: vi.fn() };
  createGain = vi.fn(() => this.gain as unknown as GainNode);
  createBuffer = vi.fn((_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) }) as unknown as AudioBuffer);
  createBufferSource = vi.fn(() => {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
  suspend = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
}

function setup() {
  const context = new FakeAudioContext();
  const progress = vi.fn();
  const receipts: PlaybackTerminal[] = [];
  const terminal = vi.fn(async (receipt: PlaybackTerminal) => { receipts.push(receipt); });
  const playback = new BrowserPlayback('playback', 4, 24_000, { progress, terminal, degraded: vi.fn() }, () => context as unknown as AudioContext);
  return { context, playback, progress, receipts, terminal };
}

describe('BrowserPlayback', () => {
  it('accounts current audio-clock delivery on pause and mid-buffer stop', async () => {
    const { context, playback, progress, terminal } = setup();
    playback.setGeneratedSamples(2_400);
    playback.append(0, new Int16Array(2_400));
    context.currentTime = 0.025;
    await playback.pause();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ playedSampleOffset: 600 }));
    context.currentTime = 0.04;
    const receipt = await playback.stop('cancelled');
    expect(receipt).toEqual({ playbackId: 'playback', cancelledEpoch: 4, finalPlayedSampleOffset: 960, reason: 'cancelled' });
    expect(terminal).toHaveBeenCalledOnce();
  });

  it('keeps zero delivery when stopped before the first scheduled sample', async () => {
    const { context, playback, terminal } = setup();
    playback.setGeneratedSamples(2_400);
    playback.append(0, new Int16Array(2_400));
    context.currentTime = 0;
    expect(await playback.stop('stopped')).toMatchObject({ finalPlayedSampleOffset: 0 });
    expect(terminal).toHaveBeenCalledOnce();
  });

  it('emits one immutable completed receipt on natural completion and retries idempotently', async () => {
    const { context, playback, receipts, terminal } = setup();
    playback.setGeneratedSamples(2_400);
    playback.append(0, new Int16Array(2_400));
    context.currentTime = 0.1;
    context.sources[0]!.finish();
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    const completed = receipts[0]!;
    expect(completed).toEqual({ playbackId: 'playback', cancelledEpoch: 4, finalPlayedSampleOffset: 2_400, reason: 'completed' });
    expect(await playback.stop('cancelled')).toBe(completed);
    expect(terminal).toHaveBeenCalledOnce();
  });

  it('completes a declared zero-sample output exactly once and closes its context', async () => {
    const { context, playback, receipts, terminal } = setup();
    playback.setGeneratedSamples(0);
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    expect(receipts).toEqual([{ playbackId: 'playback', cancelledEpoch: 4, finalPlayedSampleOffset: 0, reason: 'completed' }]);
    expect(context.close).toHaveBeenCalledOnce();
    expect(await playback.stop('failed')).toBe(receipts[0]);
    expect(terminal).toHaveBeenCalledOnce();
  });
});
