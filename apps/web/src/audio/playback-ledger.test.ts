import { describe, expect, it } from 'vitest';
import { PlaybackLedger } from './playback-ledger';

describe('PlaybackLedger', () => {
  it('advances only contiguous actually played samples and clamps generated extent', () => {
    const ledger = new PlaybackLedger('p', 2, 24_000);
    ledger.setGeneratedSamples(640);
    expect(ledger.addChunk(320, new Int16Array(320))).toBe(0);
    expect(ledger.markPlayed(640)).toBeUndefined();
    expect(ledger.addChunk(0, new Int16Array(320))).toBe(640);
    expect(ledger.markPlayed(900)?.playedSampleOffset).toBe(640);
  });

  it('returns one immutable retry-safe terminal and ignores later progress', () => {
    const ledger = new PlaybackLedger('p', 4, 24_000);
    ledger.setGeneratedSamples(320);
    ledger.addChunk(0, new Int16Array(320));
    expect(ledger.markPlayed(100)?.playedSampleOffset).toBe(100);
    const first = ledger.stop('cancelled');
    const retry = ledger.stop('failed');
    expect(retry).toBe(first);
    expect(retry).toEqual({ playbackId: 'p', cancelledEpoch: 4, finalPlayedSampleOffset: 100, reason: 'cancelled' });
    expect(ledger.markPlayed(320)).toBeUndefined();
  });

  it('keeps unspoken output at zero', () => {
    const ledger = new PlaybackLedger('p', 0, 24_000);
    ledger.setGeneratedSamples(1000);
    expect(ledger.stop('cancelled').finalPlayedSampleOffset).toBe(0);
  });
});
