import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingStore } from '../storage/recording-store';
import type { StableEvent } from '../storage/stable-turn-writer';
import { RecordingRecorder, type EncodeMp3 } from './recorder';

let dbName = '';
afterEach(async () => {
  if (dbName) {
    await new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(dbName); request.onsuccess = request.onerror = request.onblocked = () => resolve(); });
    dbName = '';
  }
});

const SESSION = '018f1f32-7abc-7def-8abc-0123456789ab';
const STREAM = '018f1f32-7abe-7def-8abc-0123456789ab';
const UTTERANCE = '018f1f32-7abf-7def-8abc-0123456789ab';
const TURN = '018f1f32-7ac0-7def-8abc-0123456789ab';
const RESPONSE = '018f1f32-7ac1-7def-8abc-0123456789ab';
const PLAYBACK = '018f1f32-7ac2-7def-8abc-0123456789ab';

function event(type: string, payload: Record<string, unknown>): StableEvent {
  return { eventId: '018f1f32-7abd-7def-8abc-0123456789ab', sessionId: SESSION, epoch: 0, monotonicMs: 1, type, payload };
}
function captureFrame(sequence: number) {
  return { streamId: 7, sequence, sampleOffset: sequence * 320, pcm16: new Int16Array(320).fill(1000) };
}

async function setup() {
  dbName = `recorder-${Date.now()}-${Math.random()}`;
  const store = await RecordingStore.open(indexedDB, dbName);
  const encode = vi.fn<EncodeMp3>(async (pcm, _sampleRate, _bitrateKbps) => new Uint8Array(Math.max(1, Math.ceil(pcm.length / 8))));
  let clock = 1000;
  const recorder = new RecordingRecorder({ sessionId: SESSION, store, encode, now: () => clock++ });
  return { store, encode, recorder };
}

describe('RecordingRecorder', () => {
  it('slices user audio to the exact capture range and backfills turnId from transcript.final', async () => {
    const { store, encode, recorder } = await setup();
    await store.setRecordingEnabled(true);
    await recorder.start();
    for (let sequence = 0; sequence <= 10; sequence++) recorder.onCaptureAudio(captureFrame(sequence));
    recorder.onSessionEvent(event('vad.speech_start', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0 }));
    for (let sequence = 11; sequence <= 20; sequence++) recorder.onCaptureAudio(captureFrame(sequence));
    recorder.onSessionEvent(event('vad.speech_end', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0, captureEndSequence: 12 }));
    recorder.onSessionEvent(event('transcript.final', { turnId: UTTERANCE, text: 'hello', endpointComplete: true }));
    await expect.poll(async () => (await store.getSessionItems(SESSION)).length).toBe(1);
    const item = (await store.getSessionItems(SESSION))[0]!;
    expect(item).toMatchObject({
      role: 'user', sampleRate: 16000, sampleCount: 13 * 320, captureStartSequence: 0, captureEndSequence: 12,
      turnId: UTTERANCE, truncated: false, interrupted: false, recordSeq: 0, responseId: null, playbackId: null, deliveredSamples: null,
    });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0]![0]).toBeInstanceOf(Int16Array);
    expect(encode.mock.calls[0]![0].length).toBe(13 * 320);
    expect(encode.mock.calls[0]![1]).toBe(16000);
    expect(encode.mock.calls[0]![2]).toBe(64);
    expect(item.data.type).toBe('audio/mpeg');
    store.close();
  });

  it('buffers the full generated agent PCM and finalizes at playback.stopped with delivered extent and interruption', async () => {
    const { store, recorder } = await setup();
    await store.setRecordingEnabled(true);
    await recorder.start();
    recorder.onSessionEvent(event('reasoning.started', { turnId: TURN, responseId: RESPONSE, posture: 'riff' }));
    recorder.onSessionEvent(event('tts.started', { responseId: RESPONSE, playbackId: PLAYBACK, sampleRate: 24000 }));
    recorder.onPlaybackAudio({ playbackId: PLAYBACK, sampleOffset: 0, pcm16: new Int16Array(480).fill(500) });
    recorder.onPlaybackAudio({ playbackId: PLAYBACK, sampleOffset: 480, pcm16: new Int16Array(480).fill(500) });
    recorder.onSessionEvent(event('playback.stopped', { playbackId: PLAYBACK, cancelledEpoch: 3, finalPlayedSampleOffset: 720, reason: 'cancelled' }));
    await expect.poll(async () => (await store.getSessionItems(SESSION)).length).toBe(1);
    const item = (await store.getSessionItems(SESSION))[0]!;
    expect(item).toMatchObject({
      role: 'agent', sampleRate: 24000, sampleCount: 960, deliveredSamples: 720, interrupted: true,
      terminalReason: 'cancelled', outputEpoch: 3, turnId: TURN, responseId: RESPONSE, playbackId: PLAYBACK,
      truncated: false, captureStartSequence: null, captureEndSequence: null,
    });
    store.close();
  });

  it('marks completed playback as delivered and not interrupted', async () => {
    const { store, recorder } = await setup();
    await store.setRecordingEnabled(true);
    await recorder.start();
    recorder.onSessionEvent(event('reasoning.started', { turnId: TURN, responseId: RESPONSE, posture: 'riff' }));
    recorder.onSessionEvent(event('tts.started', { responseId: RESPONSE, playbackId: PLAYBACK, sampleRate: 24000 }));
    recorder.onPlaybackAudio({ playbackId: PLAYBACK, sampleOffset: 0, pcm16: new Int16Array(960).fill(500) });
    recorder.onSessionEvent(event('playback.stopped', { playbackId: PLAYBACK, cancelledEpoch: 0, finalPlayedSampleOffset: 960, reason: 'completed' }));
    await expect.poll(async () => (await store.getSessionItems(SESSION)).length).toBe(1);
    const item = (await store.getSessionItems(SESSION))[0]!;
    expect(item).toMatchObject({ interrupted: false, terminalReason: 'completed', deliveredSamples: 960 });
    store.close();
  });

  it('produces no agent item when the response fails, even with a late playback.stopped', async () => {
    const { store, recorder } = await setup();
    await store.setRecordingEnabled(true);
    await recorder.start();
    recorder.onSessionEvent(event('reasoning.started', { turnId: TURN, responseId: RESPONSE, posture: 'riff' }));
    recorder.onSessionEvent(event('tts.started', { responseId: RESPONSE, playbackId: PLAYBACK, sampleRate: 24000 }));
    recorder.onPlaybackAudio({ playbackId: PLAYBACK, sampleOffset: 0, pcm16: new Int16Array(480).fill(500) });
    recorder.onSessionEvent(event('response.failed', { turnId: TURN, responseId: RESPONSE, reasonCode: 'tts_failed' }));
    recorder.onSessionEvent(event('playback.stopped', { playbackId: PLAYBACK, cancelledEpoch: 0, finalPlayedSampleOffset: 240, reason: 'cancelled' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await store.getSessionItems(SESSION)).toHaveLength(0);
    store.close();
  });

  it('finalizes an open user slice as truncated on stop and drops open agent buffers', async () => {
    const { store, recorder } = await setup();
    await store.setRecordingEnabled(true);
    await recorder.start();
    recorder.onSessionEvent(event('vad.speech_start', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0 }));
    for (let sequence = 0; sequence <= 5; sequence++) recorder.onCaptureAudio(captureFrame(sequence));
    recorder.onSessionEvent(event('reasoning.started', { turnId: TURN, responseId: RESPONSE, posture: 'riff' }));
    recorder.onSessionEvent(event('tts.started', { responseId: RESPONSE, playbackId: PLAYBACK, sampleRate: 24000 }));
    recorder.onPlaybackAudio({ playbackId: PLAYBACK, sampleOffset: 0, pcm16: new Int16Array(480).fill(500) });
    await recorder.stop(true);
    const items = await store.getSessionItems(SESSION);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ role: 'user', truncated: true, captureStartSequence: 0, captureEndSequence: 5, turnId: null });
    store.close();
  });


  it('resumes the record sequence after the highest persisted item', async () => {
    const { store, recorder } = await setup();
    await store.setRecordingEnabled(true);
    await recorder.start();
    recorder.onSessionEvent(event('vad.speech_start', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0 }));
    recorder.onCaptureAudio(captureFrame(0));
    recorder.onSessionEvent(event('vad.speech_end', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0, captureEndSequence: 0 }));
    await expect.poll(async () => (await store.getSessionItems(SESSION)).length).toBe(1);
    store.close();

    const reopened = await RecordingStore.open(indexedDB, dbName);
    const resumed = new RecordingRecorder({ sessionId: SESSION, store: reopened, encode: vi.fn(async () => new Uint8Array(8)) });
    await resumed.start();
    resumed.onSessionEvent(event('vad.speech_start', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0 }));
    resumed.onCaptureAudio(captureFrame(0));
    resumed.onSessionEvent(event('vad.speech_end', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0, captureEndSequence: 0 }));
    await expect.poll(async () => (await reopened.getSessionItems(SESSION)).length).toBe(2);
    const items = await reopened.getSessionItems(SESSION);
    expect(items.map(item => item.recordSeq).sort((a, b) => a - b)).toEqual([0, 1]);
    reopened.close();
  });

  it('starts every newly persisted row untrimmed', async () => {
    const { store, recorder } = await setup();
    await store.setRecordingEnabled(true);
    await recorder.start();
    recorder.onSessionEvent(event('vad.speech_start', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0 }));
    recorder.onCaptureAudio(captureFrame(0));
    recorder.onSessionEvent(event('vad.speech_end', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0, captureEndSequence: 0 }));
    await expect.poll(async () => (await store.getSessionItems(SESSION)).length).toBe(1);
    expect((await store.getSessionItems(SESSION))[0]!.trimmed).toBe(false);
    store.close();
  });
});
