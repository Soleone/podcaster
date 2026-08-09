import { encodeBinaryAudioFrame } from '@app/contracts/binary';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketSessionTransport } from './websocket-transport';
import type { StableEvent } from '../storage/stable-turn-writer';

const originalWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = originalWebSocket; });

describe('WebSocketSessionTransport terminal retries', () => {
  it('reuses the persisted terminal event identifier and immutable payload', () => {
    class FakeWebSocket { static OPEN = 1; readyState = 1; sent: unknown[] = []; send(value: unknown) { this.sent.push(value); } close() {} }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const socket = new FakeWebSocket();
    const transport = new WebSocketSessionTransport('session', () => 9);
    (transport as unknown as { socket: FakeWebSocket }).socket = socket;
    const event: StableEvent = { protocolVersion: 1, sessionId: 'session', epoch: 3, eventId: 'terminal-event', monotonicMs: 42, type: 'playback.stopped', payload: {} } as StableEvent & { protocolVersion: 1 };
    const first = { playbackId: 'playback', cancelledEpoch: 3, finalPlayedSampleOffset: 120, reason: 'cancelled' as const };
    transport.sendTerminal(first, event);
    transport.sendTerminal({ ...first, reason: 'failed' }, { ...event, eventId: 'different' });
    const sent = socket.sent.map(value => JSON.parse(String(value)) as { eventId: string; payload: { reason: string } });
    expect(sent).toEqual([
      expect.objectContaining({ eventId: 'terminal-event', payload: expect.objectContaining({ reason: 'cancelled' }) }),
      expect.objectContaining({ eventId: 'terminal-event', payload: expect.objectContaining({ reason: 'cancelled' }) }),
    ]);
  });
});

describe('WebSocketSessionTransport output binding', () => {
  it('binds the first output stream and computes contiguous sample offsets', () => {
    class FakeWebSocket { static OPEN = 1; readyState = 1; sent: unknown[] = []; send(value: unknown) { this.sent.push(value); } close() {} }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const socket = new FakeWebSocket();
    const transport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 2);
    (transport as unknown as { socket: FakeWebSocket }).socket = socket;
    (transport as unknown as { output: unknown }).output = { playbackId: '018f1f32-7abf-7def-8abc-0123456789ab', outputEpoch: 2, expectedSequence: 0, sampleOffset: 0, terminal: false };
    const chunks: Array<{ sequence: number; sampleOffset: number; samples: number }> = [];
    transport.onAudio(chunk => chunks.push({ sequence: chunk.sequence, sampleOffset: chunk.sampleOffset, samples: chunk.pcm16.length }));
    const first = encodeBinaryAudioFrame({ channel: 2, streamId: 77, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024);
    const second = encodeBinaryAudioFrame({ channel: 2, streamId: 77, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(240) }, 64 * 1024);
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(first.buffer);
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(second.buffer);
    expect(chunks).toEqual([{ sequence: 0, sampleOffset: 0, samples: 480 }, { sequence: 1, sampleOffset: 480, samples: 240 }]);
  });

  it('fails closed on stream reuse, collision, and late output', () => {
    class FakeWebSocket { static OPEN = 1; readyState = 1; closed: number | undefined; send() {} close(code: number) { this.closed = code; } }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const make = (output: Record<string, unknown>, used: number[] = []) => {
      const socket = new FakeWebSocket();
      const transport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 2);
      (transport as unknown as { socket: FakeWebSocket }).socket = socket;
      (transport as unknown as { output: unknown }).output = output;
      const usedStreams = (transport as unknown as { usedOutputStreams: Set<number> }).usedOutputStreams;
      for (const stream of used) usedStreams.add(stream);
      return { transport, socket };
    };
    const binary = (streamId: number, sequence: number) => encodeBinaryAudioFrame({ channel: 2, streamId, sequence, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024).buffer;

    const reused = make({ playbackId: 'playback', outputEpoch: 2, expectedSequence: 0, sampleOffset: 0, terminal: false }, [77]);
    (reused.transport as unknown as { handleBinary(data: unknown): void }).handleBinary(binary(77, 0));
    expect(reused.socket.closed).toBe(1008);

    const collision = make({ playbackId: 'playback', outputEpoch: 2, streamId: 77, expectedSequence: 1, sampleOffset: 480, terminal: false });
    (collision.transport as unknown as { handleBinary(data: unknown): void }).handleBinary(binary(78, 1));
    expect(collision.socket.closed).toBe(1008);

    const late = make({ playbackId: 'playback', outputEpoch: 2, streamId: 77, expectedSequence: 1, sampleOffset: 480, terminal: true });
    (late.transport as unknown as { handleBinary(data: unknown): void }).handleBinary(binary(77, 1));
    expect(late.socket.closed).toBe(1008);
  });

  it('terminalizes a cancelled binding, rejects its late PCM, and permits a fresh never-reused stream', () => {
    class FakeWebSocket { static OPEN = 1; readyState = 1; closed: number | undefined; sent: unknown[] = []; send(value: unknown) { this.sent.push(value); } close(code: number) { this.closed = code; } }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const socket = new FakeWebSocket();
    const transport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 3);
    (transport as unknown as { socket: FakeWebSocket }).socket = socket;
    (transport as unknown as { output: unknown }).output = { playbackId: '018f1f32-7abf-7def-8abc-0123456789ab', outputEpoch: 2, streamId: 77, expectedSequence: 1, sampleOffset: 480, terminal: false };
    (transport as unknown as { usedOutputStreams: Set<number> }).usedOutputStreams.add(77);
    transport.sendTerminal({ playbackId: '018f1f32-7abf-7def-8abc-0123456789ab', cancelledEpoch: 2, finalPlayedSampleOffset: 240, reason: 'cancelled' });
    expect((transport as unknown as { output: { terminal: boolean } }).output.terminal).toBe(true);
    (transport as unknown as { output: unknown }).output = { playbackId: '018f1f32-7ac0-7def-8abc-0123456789ab', outputEpoch: 3, expectedSequence: 0, sampleOffset: 0, terminal: false };
    const chunks: number[] = [];
    transport.onAudio(chunk => chunks.push(chunk.pcm16.length));
    const fresh = encodeBinaryAudioFrame({ channel: 2, streamId: 78, sequence: 0, monotonicUs: 3n, pcm16: new Int16Array(480) }, 64 * 1024).buffer;
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(fresh);
    expect(chunks).toEqual([480]);
    expect(socket.closed).toBeUndefined();

    const lateSocket = new FakeWebSocket();
    const lateTransport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 3);
    (lateTransport as unknown as { socket: FakeWebSocket }).socket = lateSocket;
    (lateTransport as unknown as { output: unknown }).output = { playbackId: '018f1f32-7abf-7def-8abc-0123456789ab', outputEpoch: 2, streamId: 77, expectedSequence: 1, sampleOffset: 480, terminal: false };
    lateTransport.sendTerminal({ playbackId: '018f1f32-7abf-7def-8abc-0123456789ab', cancelledEpoch: 2, finalPlayedSampleOffset: 240, reason: 'cancelled' });
    const late = encodeBinaryAudioFrame({ channel: 2, streamId: 77, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(240) }, 64 * 1024).buffer;
    (lateTransport as unknown as { handleBinary(data: unknown): void }).handleBinary(late);
    expect(lateSocket.closed).toBe(1008);
  });

  it('fails closed on a sequence gap', () => {
    class FakeWebSocket { static OPEN = 1; readyState = 1; closed: number | undefined; send() {} close(code: number) { this.closed = code; } }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const socket = new FakeWebSocket();
    const transport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 2);
    (transport as unknown as { socket: FakeWebSocket }).socket = socket;
    (transport as unknown as { output: unknown }).output = { playbackId: '018f1f32-7abf-7def-8abc-0123456789ab', responseId: '018f1f32-7ac1-7def-8abc-0123456789ab', outputEpoch: 2, expectedSequence: 0, sampleOffset: 0, terminal: false };
    const gapped = encodeBinaryAudioFrame({ channel: 2, streamId: 77, sequence: 1, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024);
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(gapped.buffer);
    expect(socket.closed).toBe(1008);
  });
});

const SESSION = '018f1f32-7abc-7def-8abc-0123456789ab';
let eventSequence = 0;
function hostEvent(type: string, payload: Record<string, unknown>, epoch = 0): StableEvent & { protocolVersion: 1 } {
  return { protocolVersion: 1, sessionId: SESSION, epoch, eventId: `018f1f32-7abd-7def-8abc-0123456789${(++eventSequence + 0xa0).toString(16).padStart(2, '0')}`, monotonicMs: Date.now(), type, payload };
}

class EventSocket {
  static OPEN = 1;
  readyState = 1;
  closed: number | undefined;
  failureMessages: string[] = [];
  onopen: (() => void) | undefined;
  onmessage: ((message: { data: unknown }) => void) | undefined;
  onerror: (() => void) | undefined;
  onclose: (() => void) | undefined;
  sent: unknown[] = [];
  send(value: unknown) { this.sent.push(value); }
  close(code: number) { this.closed = code; }
}

async function wiredTransport(socket: EventSocket, epoch = () => 0) {
  (globalThis as Record<string, unknown>).location ??= { protocol: 'http:', host: 'test' };
  const transport = new WebSocketSessionTransport(SESSION, epoch, () => socket as unknown as WebSocket);
  const connecting = transport.connect('capability');
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ type: 'authenticated' }) });
  await connecting;
  transport.onFailure(message => socket.failureMessages.push(message));
  return transport;
}
function emitText(socket: EventSocket, event: StableEvent): void { socket.onmessage?.({ data: JSON.stringify(event) }); }
function emitBinary(socket: EventSocket, streamId: number, sequence: number, samples: number): void {
  const frame = encodeBinaryAudioFrame({ channel: 2, streamId, sequence, monotonicUs: 1n, pcm16: new Int16Array(samples) }, 64 * 1024);
  socket.onmessage?.({ data: frame.buffer });
}

const REASONING = (responseId: string) => hostEvent('reasoning.started', { turnId: '018f1f32-7abe-7def-8abc-0123456789ab', responseId, posture: 'riff' });
const FINAL = (responseId: string, text = 'First sentence. Second sentence.') => hostEvent('reasoning.final', { turnId: '018f1f32-7abe-7def-8abc-0123456789ab', responseId, posture: 'riff', text });
const TTS_STARTED = (responseId: string, playbackId: string) => hostEvent('tts.started', { responseId, playbackId, sampleRate: 24_000 });
const TTS_ENDED = (responseId: string, playbackId: string, generatedSamples: number) => hostEvent('tts.ended', { responseId, playbackId, generatedSamples });
const FAILED = (responseId: string, reasonCode: 'reasoning_unavailable' | 'reasoning_invalid' | 'tts_failed' = 'tts_failed') => hostEvent('response.failed', { turnId: '018f1f32-7abe-7def-8abc-0123456789ab', responseId, reasonCode });

const turnUuid = '018f1f32-7abe-7def-8abc-0123456789ab';
const responseA = '018f1f32-7ac1-7def-8abc-0123456789ab';
const responseB = '018f1f32-7ac2-7def-8abc-0123456789ab';
const playbackA = '018f1f32-7ac3-7def-8abc-0123456789ab';
const playbackB = '018f1f32-7ac4-7def-8abc-0123456789ab';

function expectNoProtocolFailure(socket: EventSocket) {
  expect(socket.closed).toBeUndefined();
  expect(socket.failureMessages).toEqual([]);
}

describe('WebSocketSessionTransport progressive ordering', () => {
  it('accepts tts.started before reasoning.final and streams contiguous PCM', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: Array<{ sequence: number; sampleOffset: number; samples: number }> = [];
    transport.onAudio(chunk => chunks.push({ sequence: chunk.sequence, sampleOffset: chunk.sampleOffset, samples: chunk.pcm16.length }));
    emitText(socket, REASONING(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    emitBinary(socket, 77, 1, 240);
    emitText(socket, FINAL(responseA));
    emitText(socket, TTS_ENDED(responseA, playbackA, 720));
    expectNoProtocolFailure(socket);
    expect(chunks).toEqual([{ sequence: 0, sampleOffset: 0, samples: 480 }, { sequence: 1, sampleOffset: 480, samples: 240 }]);
  });

  it('accepts tts.started after reasoning.final as well', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: number[] = [];
    transport.onAudio(chunk => chunks.push(chunk.pcm16.length));
    emitText(socket, REASONING(responseA));
    emitText(socket, FINAL(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    emitText(socket, TTS_ENDED(responseA, playbackA, 480));
    expectNoProtocolFailure(socket);
    expect(chunks).toEqual([480]);
  });

  it('accepts response.failed followed by the generic failure without disconnecting', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, REASONING(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    emitText(socket, FAILED(responseA));
    emitText(socket, hostEvent('failure', { code: 'tts_failed', detail: 'The response could not be completed successfully.', correctiveAction: 'Continue listening.', recoverable: true }));
    expectNoProtocolFailure(socket);
    // Late PCM for the failed response is rejected after the cutoff.
    emitBinary(socket, 77, 1, 240);
    expect(socket.closed).toBe(1008);
  });

  it('rejects a tts.started whose response identity was never established', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, TTS_STARTED(responseA, playbackA));
    expect(socket.closed).toBe(1008);
  });

  it('rejects mismatched, duplicated, and stale identity sequences', async () => {
    const mismatched = new EventSocket();
    await wiredTransport(mismatched);
    emitText(mismatched, REASONING(responseA));
    emitText(mismatched, TTS_STARTED(responseB, playbackB));
    expect(mismatched.closed).toBe(1008);

    const duplicateStarted = new EventSocket();
    await wiredTransport(duplicateStarted);
    emitText(duplicateStarted, REASONING(responseA));
    emitText(duplicateStarted, REASONING(responseA));
    expect(duplicateStarted.closed).toBe(1008);

    const staleEpoch = new EventSocket();
    await wiredTransport(staleEpoch);
    emitText(staleEpoch, REASONING(responseA));
    emitText(staleEpoch, hostEvent('tts.started', { responseId: responseA, playbackId: playbackA, sampleRate: 24_000 }, 1));
    expect(staleEpoch.closed).toBe(1008);

    const duplicateOutput = new EventSocket();
    await wiredTransport(duplicateOutput);
    emitText(duplicateOutput, REASONING(responseA));
    emitText(duplicateOutput, TTS_STARTED(responseA, playbackA));
    emitText(duplicateOutput, TTS_STARTED(responseA, playbackA));
    expect(duplicateOutput.closed).toBe(1008);
  });

  it('accepts a superseding reasoning.started when the previous response never terminalized', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: number[] = [];
    transport.onAudio(chunk => chunks.push(chunk.pcm16.length));
    // Response A starts, gets a tts.started and PCM, then is superseded before ending.
    emitText(socket, REASONING(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    // Response B supersedes A without any terminal event for A.
    emitText(socket, REASONING(responseB));
    emitText(socket, TTS_STARTED(responseB, playbackB));
    emitBinary(socket, 78, 0, 240);
    emitText(socket, FINAL(responseB));
    emitText(socket, TTS_ENDED(responseB, playbackB, 240));
    expectNoProtocolFailure(socket);
    expect(chunks).toEqual([480, 240]);
    // Late PCM for the superseded response A is rejected fail-closed.
    emitBinary(socket, 77, 1, 240);
    expect(socket.closed).toBe(1008);
  });

  it('rejects reuse of a consumed output stream by a later response', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, REASONING(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    emitText(socket, FINAL(responseA));
    emitText(socket, TTS_ENDED(responseA, playbackA, 480));
    emitText(socket, REASONING(responseB));
    emitText(socket, TTS_STARTED(responseB, playbackB));
    emitBinary(socket, 77, 0, 480);
    expect(socket.closed).toBe(1008);
  });

  it('rejects a reasoning.final that contradicts the established response', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, REASONING(responseA));
    emitText(socket, FINAL(responseB));
    expect(socket.closed).toBe(1008);
  });

  it('accepts a second full response after the first completes normally', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: number[] = [];
    transport.onAudio(chunk => chunks.push(chunk.pcm16.length));
    emitText(socket, REASONING(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    emitText(socket, FINAL(responseA));
    emitText(socket, TTS_ENDED(responseA, playbackA, 480));
    // Second response must establish fresh identity after terminal cleanup.
    emitText(socket, REASONING(responseB));
    emitText(socket, TTS_STARTED(responseB, playbackB));
    emitBinary(socket, 78, 0, 240);
    emitText(socket, FINAL(responseB));
    emitText(socket, TTS_ENDED(responseB, playbackB, 240));
    expectNoProtocolFailure(socket);
    expect(chunks).toEqual([480, 240]);
  });
});
