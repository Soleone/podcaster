import { describe, expect, it, vi } from 'vitest';
import { BrowserPlayback } from './playback';
import type { PlaybackTerminal } from './playback-ledger';

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startTime = 0;
  connect = vi.fn();
  start = vi.fn((time = 0) => {
    this.startTime = time;
  });
  stop = vi.fn();
  finish(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  sources: FakeSource[] = [];
  bufferLengths: number[] = [];
  gain = { gain: { value: 1 }, connect: vi.fn() };
  createGain = vi.fn(() => this.gain as unknown as GainNode);
  createBuffer = vi.fn((_channels: number, length: number) => {
    this.bufferLengths.push(length);
    return { getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
  });
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
  const terminal = vi.fn(async (receipt: PlaybackTerminal) => {
    receipts.push(receipt);
  });
  const playback = new BrowserPlayback(
    'playback',
    4,
    24_000,
    { progress, terminal, degraded: vi.fn() },
    () => context as unknown as AudioContext,
  );
  return { context, playback, progress, receipts, terminal };
}

describe('BrowserPlayback', () => {
  it('accounts current audio-clock delivery on pause and mid-buffer stop', async () => {
    const { context, playback, progress, terminal } = setup();
    playback.setGeneratedSamples(2_400);
    playback.append(0, new Int16Array(2_400));
    context.currentTime = 0.025;
    const checkpoint = await playback.pause();
    expect(checkpoint).toMatchObject({
      playbackId: 'playback',
      outputEpoch: 4,
      playedSampleOffset: 600,
      generatedSamples: 2_400,
    });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ playedSampleOffset: 600 }));
    playback.append(2_400, new Int16Array(480));
    expect(context.sources).toHaveLength(2);
    await playback.resume();
    expect(context.resume).toHaveBeenCalledOnce();
    context.currentTime = 0.04;
    const receipt = await playback.stop('cancelled');
    expect(receipt).toEqual({
      playbackId: 'playback',
      cancelledEpoch: 4,
      finalPlayedSampleOffset: 960,
      reason: 'cancelled',
    });
    expect(terminal).toHaveBeenCalledOnce();
  });

  it('rebuilds the scheduled chain 500ms before a long-pause resume without rewinding ledger progress', async () => {
    const { context, playback, progress } = setup();
    playback.setGeneratedSamples(48_000);
    playback.append(0, new Int16Array(48_000));
    context.currentTime = 0.75;
    expect(await playback.pause()).toMatchObject({ playedSampleOffset: 18_000 });

    await playback.resume(500);

    expect(context.sources).toHaveLength(2);
    expect(context.sources[0]!.stop).toHaveBeenCalledOnce();
    expect(context.sources[1]!.start).toHaveBeenCalledWith(0.75);
    expect(context.bufferLengths).toEqual([48_000, 42_000]);
    // Replayed samples are intentionally not reported as a backward seek.
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ playedSampleOffset: 18_000 }));
    context.sources[1]!.finish();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ playedSampleOffset: 48_000 }));
  });

  it('resumes a short pause in place', async () => {
    const { context, playback } = setup();
    playback.setGeneratedSamples(48_000);
    playback.append(0, new Int16Array(48_000));
    context.currentTime = 0.75;
    await playback.pause();

    await playback.resume();

    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]!.stop).not.toHaveBeenCalled();
  });

  it('reports the streamed generated prefix before the final extent is declared', async () => {
    const { context, playback, progress, terminal } = setup();
    playback.append(0, new Int16Array(480));
    context.currentTime = 0.02;
    context.sources[0]!.finish();
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ playedSampleOffset: 480, generatedSamples: 480 }),
    );
    expect(terminal).not.toHaveBeenCalled();
    playback.setGeneratedSamples(480);
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
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
    expect(completed).toEqual({
      playbackId: 'playback',
      cancelledEpoch: 4,
      finalPlayedSampleOffset: 2_400,
      reason: 'completed',
    });
    expect(await playback.stop('cancelled')).toBe(completed);
    expect(terminal).toHaveBeenCalledOnce();
  });

  it('completes a declared zero-sample output exactly once and closes its context', async () => {
    const { context, playback, receipts, terminal } = setup();
    playback.setGeneratedSamples(0);
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    expect(receipts).toEqual([
      { playbackId: 'playback', cancelledEpoch: 4, finalPlayedSampleOffset: 0, reason: 'completed' },
    ]);
    expect(context.close).toHaveBeenCalledOnce();
    expect(await playback.stop('failed')).toBe(receipts[0]);
    expect(terminal).toHaveBeenCalledOnce();
  });
});
