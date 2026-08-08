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
