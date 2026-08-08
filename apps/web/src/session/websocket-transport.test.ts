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
    (transport as unknown as { output: unknown }).output = { playbackId: '018f1f32-7abf-7def-8abc-0123456789ab', outputEpoch: 2, expectedSequence: 0, sampleOffset: 0, terminal: false };
    const gapped = encodeBinaryAudioFrame({ channel: 2, streamId: 77, sequence: 1, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024);
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(gapped.buffer);
    expect(socket.closed).toBe(1008);
  });
});
