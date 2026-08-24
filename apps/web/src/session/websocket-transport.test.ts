import { CONTRACT_VALIDATORS, type HostEvent, type PlaybackStoppedEvent } from '@app/contracts';
import { encodeBinaryAudioFrame } from '@app/contracts/binary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStrictHostEvent, WebSocketSessionTransport } from './websocket-transport';
import { activityLog } from './activity-log';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const originalWebSocket = globalThis.WebSocket;
const contractsRoot = resolve(import.meta.dirname, '../../../../packages/contracts');
const hostFixtureCases = [
  ['barge-in', 'barge-in'],
  ['failure', 'failure'],
  ['interruption-decision', 'interruption-decision'],
  ['policy-decision', 'policy-decision'],
  ['reasoning-delta', 'reasoning-delta'],
  ['reasoning-final', 'reasoning-final'],
  ['reasoning-started', 'reasoning-started'],
  ['response-failed', 'response-failed'],
  ['response.part_final', 'response.part_final'],
  ['response.part_started', 'response.part_started'],
  ['session-state', 'session-state'],
  ['transcript-final', 'transcript-final'],
  ['transcript-partial', 'transcript-partial'],
  ['tts-ended', 'tts-ended'],
  ['tts-started', 'tts-started'],
  ['tool-activity', 'tool-activity'],
  ['vad-speech-end', 'vad-speech-end'],
  ['vad-speech-start', 'vad-speech-start'],
] as const;
function hostFixture(directory: 'valid' | 'invalid', name: string): unknown {
  const filename = directory === 'invalid' ? name.replace(/[._]/g, '-') : name;
  return JSON.parse(readFileSync(resolve(contractsRoot, 'fixtures', directory, `${filename}.json`), 'utf8'));
}

describe('browser HostEvent validator parity', () => {
  it.each(hostFixtureCases)('accepts the canonical valid %s fixture', (_label, filename) => {
    const value = hostFixture('valid', filename);
    expect(CONTRACT_VALIDATORS.HostEvent(value)).toBe(true);
    expect(isStrictHostEvent(value)).toBe(true);
  });
  it.each(hostFixtureCases)('rejects the canonical invalid %s fixture', (_label, filename) => {
    const value = hostFixture('invalid', filename);
    expect(CONTRACT_VALIDATORS.HostEvent(value)).toBe(false);
    expect(isStrictHostEvent(value)).toBe(false);
  });
  it('rejects the invalid HostEvent regression fixture in both validators', () => {
    const value = hostFixture('invalid', 'host-event');
    expect(CONTRACT_VALIDATORS.HostEvent(value)).toBe(false);
    expect(isStrictHostEvent(value)).toBe(false);
  });
  it('accepts planning-scope tool activity without turn identity in both validators', () => {
    const base = hostFixture('valid', 'tool-activity') as Record<string, unknown>;
    const value = {
      ...base,
      payload: { scope: 'planning', toolCallId: 'tool-9', toolName: 'web_search', status: 'started' },
    };
    expect(CONTRACT_VALIDATORS.HostEvent(value)).toBe(true);
    expect(isStrictHostEvent(value)).toBe(true);
  });
  it('rejects tool activity with oversized or extra payload fields in both validators', () => {
    const base = hostFixture('valid', 'tool-activity') as Record<string, unknown>;
    const oversized = {
      ...base,
      payload: {
        scope: 'planning',
        toolCallId: 'tool-9',
        toolName: 'web_search',
        status: 'started',
        summary: 'x'.repeat(161),
      },
    };
    expect(CONTRACT_VALIDATORS.HostEvent(oversized)).toBe(false);
    expect(isStrictHostEvent(oversized)).toBe(false);
    const withArgs = {
      ...base,
      payload: {
        scope: 'planning',
        toolCallId: 'tool-9',
        toolName: 'web_search',
        status: 'started',
        args: { query: 'raw' },
      },
    };
    expect(CONTRACT_VALIDATORS.HostEvent(withArgs)).toBe(false);
    expect(isStrictHostEvent(withArgs)).toBe(false);
  });
});
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe('WebSocketSessionTransport terminal retries', () => {
  it('reuses the persisted terminal event identifier and immutable payload', () => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      sent: unknown[] = [];
      send(value: unknown) {
        this.sent.push(value);
      }
      close() {}
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const socket = new FakeWebSocket();
    const transport = new WebSocketSessionTransport('session', () => 9);
    (transport as unknown as { socket: FakeWebSocket; connected: boolean }).socket = socket;
    (transport as unknown as { connected: boolean }).connected = true;
    const event: PlaybackStoppedEvent = {
      protocolVersion: 1,
      sessionId: 'session',
      epoch: 3,
      eventId: 'terminal-event',
      monotonicMs: 42,
      type: 'playback.stopped',
      payload: { playbackId: 'playback', cancelledEpoch: 3, finalPlayedSampleOffset: 120, reason: 'cancelled' },
    };
    const first = {
      playbackId: 'playback',
      cancelledEpoch: 3,
      finalPlayedSampleOffset: 120,
      reason: 'cancelled' as const,
    };
    transport.sendTerminal(first, event);
    transport.sendTerminal({ ...first, reason: 'failed' }, { ...event, eventId: 'different' });
    const sent = socket.sent.map(
      (value) => JSON.parse(String(value)) as { eventId: string; payload: { reason: string } },
    );
    expect(sent).toEqual([
      expect.objectContaining({ eventId: 'terminal-event', payload: expect.objectContaining({ reason: 'cancelled' }) }),
      expect.objectContaining({ eventId: 'terminal-event', payload: expect.objectContaining({ reason: 'cancelled' }) }),
    ]);
  });
});

describe('WebSocketSessionTransport output binding', () => {
  it('binds the first output stream and computes contiguous sample offsets', () => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      sent: unknown[] = [];
      send(value: unknown) {
        this.sent.push(value);
      }
      close() {}
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const socket = new FakeWebSocket();
    const transport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 2);
    (transport as unknown as { socket: FakeWebSocket }).socket = socket;
    (transport as unknown as { outputs: { single: unknown } }).outputs.single = {
      playbackId: '018f1f32-7abf-7def-8abc-0123456789ab',
      outputEpoch: 2,
      expectedSequence: 0,
      sampleOffset: 0,
      terminal: false,
    };
    const chunks: Array<{ sequence: number; sampleOffset: number; samples: number }> = [];
    transport.onAudio((chunk) =>
      chunks.push({ sequence: chunk.sequence, sampleOffset: chunk.sampleOffset, samples: chunk.pcm16.length }),
    );
    const first = encodeBinaryAudioFrame(
      { channel: 2, streamId: 77, sequence: 0, monotonicUs: 1n, pcm16: new Int16Array(480) },
      64 * 1024,
    );
    const second = encodeBinaryAudioFrame(
      { channel: 2, streamId: 77, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(240) },
      64 * 1024,
    );
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(first.buffer);
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(second.buffer);
    expect(chunks).toEqual([
      { sequence: 0, sampleOffset: 0, samples: 480 },
      { sequence: 1, sampleOffset: 480, samples: 240 },
    ]);
  });

  it('fails closed on stream reuse, collision, and late output', () => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      closed: number | undefined;
      send() {}
      close(code: number) {
        this.closed = code;
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const make = (output: Record<string, unknown>, used: number[] = []) => {
      const socket = new FakeWebSocket();
      const transport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 2);
      (transport as unknown as { socket: FakeWebSocket }).socket = socket;
      (transport as unknown as { outputs: { single: unknown } }).outputs.single = output;
      const usedStreams = (transport as unknown as { usedOutputStreams: Set<number> }).usedOutputStreams;
      for (const stream of used) usedStreams.add(stream);
      return { transport, socket };
    };
    const binary = (streamId: number, sequence: number) =>
      encodeBinaryAudioFrame({ channel: 2, streamId, sequence, monotonicUs: 1n, pcm16: new Int16Array(480) }, 64 * 1024)
        .buffer;

    const reused = make(
      { playbackId: 'playback', outputEpoch: 2, expectedSequence: 0, sampleOffset: 0, terminal: false },
      [77],
    );
    (reused.transport as unknown as { handleBinary(data: unknown): void }).handleBinary(binary(77, 0));
    expect(reused.socket.closed).toBe(4000);

    const collision = make({
      playbackId: 'playback',
      outputEpoch: 2,
      streamId: 77,
      expectedSequence: 1,
      sampleOffset: 480,
      terminal: false,
    });
    (collision.transport as unknown as { handleBinary(data: unknown): void }).handleBinary(binary(78, 1));
    expect(collision.socket.closed).toBe(4000);

    const late = make({
      playbackId: 'playback',
      outputEpoch: 2,
      streamId: 77,
      expectedSequence: 1,
      sampleOffset: 480,
      terminal: true,
    });
    (late.transport as unknown as { handleBinary(data: unknown): void }).handleBinary(binary(77, 1));
    expect(late.socket.closed).toBe(4000);
  });

  it('terminalizes a cancelled binding, rejects its late PCM, and permits a fresh never-reused stream', () => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      closed: number | undefined;
      sent: unknown[] = [];
      send(value: unknown) {
        this.sent.push(value);
      }
      close(code: number) {
        this.closed = code;
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const socket = new FakeWebSocket();
    const transport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 3);
    (transport as unknown as { socket: FakeWebSocket; connected: boolean }).socket = socket;
    (transport as unknown as { connected: boolean }).connected = true;
    (transport as unknown as { outputs: { single: unknown } }).outputs.single = {
      playbackId: '018f1f32-7abf-7def-8abc-0123456789ab',
      outputEpoch: 2,
      streamId: 77,
      expectedSequence: 1,
      sampleOffset: 480,
      terminal: false,
    };
    (transport as unknown as { usedOutputStreams: Set<number> }).usedOutputStreams.add(77);
    transport.sendTerminal({
      playbackId: '018f1f32-7abf-7def-8abc-0123456789ab',
      cancelledEpoch: 2,
      finalPlayedSampleOffset: 240,
      reason: 'cancelled',
    });
    expect((transport as unknown as { outputs: { single: { terminal: boolean } } }).outputs.single.terminal).toBe(true);
    (transport as unknown as { outputs: { single: unknown } }).outputs.single = {
      playbackId: '018f1f32-7ac0-7def-8abc-0123456789ab',
      outputEpoch: 3,
      expectedSequence: 0,
      sampleOffset: 0,
      terminal: false,
    };
    const chunks: number[] = [];
    transport.onAudio((chunk) => chunks.push(chunk.pcm16.length));
    const fresh = encodeBinaryAudioFrame(
      { channel: 2, streamId: 78, sequence: 0, monotonicUs: 3n, pcm16: new Int16Array(480) },
      64 * 1024,
    ).buffer;
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(fresh);
    expect(chunks).toEqual([480]);
    expect(socket.closed).toBeUndefined();

    const lateSocket = new FakeWebSocket();
    const lateTransport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 3);
    (lateTransport as unknown as { socket: FakeWebSocket; connected: boolean }).socket = lateSocket;
    (lateTransport as unknown as { connected: boolean }).connected = true;
    (lateTransport as unknown as { outputs: { single: unknown } }).outputs.single = {
      playbackId: '018f1f32-7abf-7def-8abc-0123456789ab',
      outputEpoch: 2,
      streamId: 77,
      expectedSequence: 1,
      sampleOffset: 480,
      terminal: false,
    };
    lateTransport.sendTerminal({
      playbackId: '018f1f32-7abf-7def-8abc-0123456789ab',
      cancelledEpoch: 2,
      finalPlayedSampleOffset: 240,
      reason: 'cancelled',
    });
    const late = encodeBinaryAudioFrame(
      { channel: 2, streamId: 77, sequence: 1, monotonicUs: 2n, pcm16: new Int16Array(240) },
      64 * 1024,
    ).buffer;
    (lateTransport as unknown as { handleBinary(data: unknown): void }).handleBinary(late);
    expect(lateSocket.closed).toBe(4000);
  });

  it('fails closed on a sequence gap', () => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      closed: number | undefined;
      send() {}
      close(code: number) {
        this.closed = code;
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const socket = new FakeWebSocket();
    const transport = new WebSocketSessionTransport('018f1f32-7abc-7def-8abc-0123456789ab', () => 2);
    (transport as unknown as { socket: FakeWebSocket }).socket = socket;
    (transport as unknown as { outputs: { single: unknown } }).outputs.single = {
      playbackId: '018f1f32-7abf-7def-8abc-0123456789ab',
      responseId: '018f1f32-7ac1-7def-8abc-0123456789ab',
      outputEpoch: 2,
      expectedSequence: 0,
      sampleOffset: 0,
      terminal: false,
    };
    const gapped = encodeBinaryAudioFrame(
      { channel: 2, streamId: 77, sequence: 1, monotonicUs: 1n, pcm16: new Int16Array(480) },
      64 * 1024,
    );
    (transport as unknown as { handleBinary(data: unknown): void }).handleBinary(gapped.buffer);
    expect(socket.closed).toBe(4000);
  });
});

const SESSION = '018f1f32-7abc-7def-8abc-0123456789ab';
let eventSequence = 0;
function hostEvent<T extends HostEvent['type']>(type: T, payload: Record<string, unknown>, epoch = 0): HostEvent {
  return {
    protocolVersion: 1,
    sessionId: SESSION,
    epoch,
    eventId: `018f1f32-7abd-7def-8abc-0123456789${(++eventSequence + 0xa0).toString(16).padStart(2, '0')}`,
    monotonicMs: Date.now(),
    type,
    payload,
  } as HostEvent;
}

class EventSocket {
  static OPEN = 1;
  readyState = 1;
  closed: number | undefined;
  failureMessages: string[] = [];
  onopen: (() => void) | undefined;
  onmessage: ((message: { data: unknown }) => void) | undefined;
  onerror: (() => void) | undefined;
  onclose: ((event?: { code?: number; reason?: string }) => void) | undefined;
  sent: unknown[] = [];
  send(value: unknown) {
    this.sent.push(value);
  }
  close(code: number) {
    this.closed = code;
  }
}

async function wiredTransport(socket: EventSocket, epoch = () => 0) {
  (globalThis as Record<string, unknown>).location ??= { protocol: 'http:', host: 'test' };
  const transport = new WebSocketSessionTransport(SESSION, epoch, () => socket as unknown as WebSocket);
  const connecting = transport.connect('capability');
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ type: 'authenticated' }) });
  await connecting;
  transport.onFailure((message) => socket.failureMessages.push(message));
  return transport;
}
function emitText(socket: EventSocket, event: HostEvent): void {
  socket.onmessage?.({ data: JSON.stringify(event) });
}
function emitBinary(socket: EventSocket, streamId: number, sequence: number, samples: number): void {
  const frame = encodeBinaryAudioFrame(
    { channel: 2, streamId, sequence, monotonicUs: 1n, pcm16: new Int16Array(samples) },
    64 * 1024,
  );
  socket.onmessage?.({ data: frame.buffer });
}

describe('WebSocketSessionTransport recovery', () => {
  it('waits for a planning terminal state and keeps cancellation out of the ordered start wait', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const pending = transport.startSession({
      sessionSeed: SESSION,
      reasoningMode: 'full',
      planning: { topic: 'radio', depth: 'standard' },
      settings: { version: 1, persona: '', voice: { catalogId: 'catalog', voiceId: 'voice', speedModifier: 1 } },
    });
    expect(pending).toBeInstanceOf(Promise);
    const start = JSON.parse(String(socket.sent.at(-1))) as { type: string; payload: { planning: unknown } };
    expect(start).toMatchObject({
      type: 'session.start',
      payload: { planning: { topic: 'radio', depth: 'standard' } },
    });
    transport.cancelPlanning();
    expect(JSON.parse(String(socket.sent.at(-1))).type).toBe('planning.cancel');
    emitText(
      socket,
      hostEvent('session.state', {
        phase: 'ready',
        personaDigest: '0'.repeat(64),
        planning: { status: 'cancelled', topic: 'radio', depth: 'standard', progress: 100 },
      }),
    );
    await expect(pending).resolves.toBe('cancelled');
    expectNoProtocolFailure(socket);
  });

  it('resolves the start handshake when the host goes live while preparation is still running', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const pending = transport.startSession({
      sessionSeed: SESSION,
      reasoningMode: 'full',
      planning: { topic: 'radio', depth: 'standard' },
      settings: { version: 1, persona: '', voice: { catalogId: 'catalog', voiceId: 'voice', speedModifier: 1 } },
    });
    expect(pending).toBeInstanceOf(Promise);
    emitText(
      socket,
      hostEvent('session.state', {
        phase: 'ready',
        personaDigest: '0'.repeat(64),
        planning: { status: 'planning', topic: 'radio', depth: 'standard', progress: 5 },
      }),
    );
    await expect(pending).resolves.toBe('planning');
    expectNoProtocolFailure(socket);
  });

  it('reconnects within the grace window, queues commands, and avoids a failure notification', async () => {
    vi.useFakeTimers();
    try {
      (globalThis as Record<string, unknown>).location = { protocol: 'http:', host: 'test' };
      const sockets = [new EventSocket()];
      let firstSocket = true;
      const transport = new WebSocketSessionTransport(
        SESSION,
        () => 0,
        () => {
          if (firstSocket) {
            firstSocket = false;
            return sockets[0] as unknown as WebSocket;
          }
          const socket = new EventSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        { reconnectWindowMs: 100, reconnectDelaysMs: [10] },
      );
      const failures: string[] = [];
      let reconnects = 0;
      transport.onFailure((message) => failures.push(message));
      transport.onReconnect(() => {
        reconnects++;
      });
      const connected = transport.connect('capability');
      sockets[0]!.onopen?.();
      sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'authenticated' }) });
      await connected;

      sockets[0]!.onclose?.({ code: 1006, reason: 'network' });
      transport.stopAudio(7);
      transport.sendProgress({
        playbackId: '018f1f32-7ac3-7def-8abc-0123456789ab',
        outputEpoch: 0,
        playedSampleOffset: 10,
        generatedSamples: 20,
      });
      transport.sendProgress({
        playbackId: '018f1f32-7ac3-7def-8abc-0123456789ab',
        outputEpoch: 0,
        playedSampleOffset: 15,
        generatedSamples: 20,
      });
      await vi.advanceTimersByTimeAsync(10);
      const replacement = sockets[1]!;
      replacement.onopen?.();
      replacement.onmessage?.({ data: JSON.stringify({ type: 'authenticated' }) });
      await Promise.resolve();

      expect(reconnects).toBe(1);
      expect(failures).toEqual([]);
      expect(replacement.sent).toHaveLength(3);
      expect(JSON.parse(String(replacement.sent[1]))).toMatchObject({ type: 'audio.stop', payload: { streamId: 7 } });
      expect(JSON.parse(String(replacement.sent[2]))).toMatchObject({
        type: 'playback.progress',
        payload: { playedSampleOffset: 15 },
      });
      transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a hung reconnect attempt via the handshake watchdog and keeps cycling', async () => {
    vi.useFakeTimers();
    try {
      (globalThis as Record<string, unknown>).location = { protocol: 'http:', host: 'test' };
      const sockets = [new EventSocket()];
      let firstSocket = true;
      const transport = new WebSocketSessionTransport(
        SESSION,
        () => 0,
        () => {
          if (firstSocket) {
            firstSocket = false;
            return sockets[0] as unknown as WebSocket;
          }
          const socket = new EventSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        { reconnectWindowMs: 60_000, reconnectDelaysMs: [10] },
      );
      const failures: string[] = [];
      transport.onFailure((message) => failures.push(message));
      const connected = transport.connect('capability');
      sockets[0]!.onopen?.();
      sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'authenticated' }) });
      await connected;

      sockets[0]!.onclose?.({ code: 1006, reason: 'network' });
      await vi.advanceTimersByTimeAsync(10);
      expect(sockets).toHaveLength(2);
      // The replacement socket opens but never completes authentication; the
      // watchdog must fail it instead of hanging on it forever.
      sockets[1]!.onopen?.();
      await vi.advanceTimersByTimeAsync(5_000);
      // Backoff continues after the abandoned attempt.
      await vi.advanceTimersByTimeAsync(10);
      expect(sockets).toHaveLength(3);
      expect(failures).toEqual([]);
      transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries immediately when a connectivity hint arrives during backoff', async () => {
    vi.useFakeTimers();
    try {
      (globalThis as Record<string, unknown>).location = { protocol: 'http:', host: 'test' };
      let emitHint: (() => void) | undefined;
      const unsubscribed = vi.fn();
      const subscribeConnectivityHints = (hint: () => void) => {
        emitHint = hint;
        return unsubscribed;
      };
      const sockets = [new EventSocket()];
      let firstSocket = true;
      const transport = new WebSocketSessionTransport(
        SESSION,
        () => 0,
        () => {
          if (firstSocket) {
            firstSocket = false;
            return sockets[0] as unknown as WebSocket;
          }
          const socket = new EventSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        { reconnectDelaysMs: [10_000], subscribeConnectivityHints },
      );
      const connected = transport.connect('capability');
      sockets[0]!.onopen?.();
      sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'authenticated' }) });
      await connected;

      sockets[0]!.onclose?.({ code: 1006, reason: 'network' });
      expect(emitHint).toBeTypeOf('function');
      // The backoff delay has not elapsed yet, but the hint short-circuits it.
      emitHint?.();
      expect(sockets).toHaveLength(2);
      sockets[1]!.onopen?.();
      sockets[1]!.onmessage?.({ data: JSON.stringify({ type: 'authenticated' }) });
      await Promise.resolve();

      // Listeners are detached once reconnection settles.
      expect(unsubscribed).toHaveBeenCalled();
      transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

const REASONING = (responseId: string) =>
  hostEvent('reasoning.started', { turnId: '018f1f32-7abe-7def-8abc-0123456789ab', responseId, posture: 'riff' });
const FINAL = (responseId: string, text = 'First sentence. Second sentence.') =>
  hostEvent('reasoning.final', { turnId: '018f1f32-7abe-7def-8abc-0123456789ab', responseId, posture: 'riff', text });
const TTS_STARTED = (responseId: string, playbackId: string) =>
  hostEvent('tts.started', { responseId, playbackId, sampleRate: 24_000 });
const TTS_ENDED = (responseId: string, playbackId: string, generatedSamples: number) =>
  hostEvent('tts.ended', { responseId, playbackId, generatedSamples });
const FAILED = (
  responseId: string,
  reasonCode: 'reasoning_unavailable' | 'reasoning_invalid' | 'tts_failed' = 'tts_failed',
) => hostEvent('response.failed', { turnId: '018f1f32-7abe-7def-8abc-0123456789ab', responseId, reasonCode });
const DELTA = (responseId: string, text: string) =>
  hostEvent('reasoning.delta', { turnId: '018f1f32-7abe-7def-8abc-0123456789ab', responseId, text });

const turnUuid = '018f1f32-7abe-7def-8abc-0123456789ab';
const responseA = '018f1f32-7ac1-7def-8abc-0123456789ab';
const responseB = '018f1f32-7ac2-7def-8abc-0123456789ab';
const playbackA = '018f1f32-7ac3-7def-8abc-0123456789ab';
const playbackB = '018f1f32-7ac4-7def-8abc-0123456789ab';
const streamUuid = '018f1f32-7ac5-7def-8abc-0123456789ab';

describe('WebSocketSessionTransport VAD relay', () => {
  it('forwards strict vad.speech_start and vad.speech_end events to listeners', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const seen: string[] = [];
    transport.onEvent((event) => {
      seen.push(event.type);
    });
    emitText(
      socket,
      hostEvent('vad.speech_start', { streamId: streamUuid, utteranceId: turnUuid, captureStartSequence: 3 }),
    );
    emitText(
      socket,
      hostEvent('vad.speech_end', {
        streamId: streamUuid,
        utteranceId: turnUuid,
        captureStartSequence: 3,
        captureEndSequence: 41,
      }),
    );
    expectNoProtocolFailure(socket);
    expect(seen).toEqual(['vad.speech_start', 'vad.speech_end']);
  });

  it('accepts and forwards a real host UUIDv4 streamId for both VAD events', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const seen: string[] = [];
    transport.onEvent((event) => {
      seen.push(event.type);
    });
    // The real host emits a sidecar stream id from node:crypto randomUUID() (UUIDv4).
    const v4Stream = 'b39b7a1c-2d4e-4f6a-9b8c-0d1e2f3a4b5c';
    emitText(
      socket,
      hostEvent('vad.speech_start', { streamId: v4Stream, utteranceId: turnUuid, captureStartSequence: 3 }),
    );
    emitText(
      socket,
      hostEvent('vad.speech_end', {
        streamId: v4Stream,
        utteranceId: turnUuid,
        captureStartSequence: 3,
        captureEndSequence: 41,
      }),
    );
    expectNoProtocolFailure(socket);
    expect(seen).toEqual(['vad.speech_start', 'vad.speech_end']);
  });

  it('still fails closed when a UUIDv4 streamId is combined with a malformed value elsewhere', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    const v4Stream = 'b39b7a1c-2d4e-4f6a-9b8c-0d1e2f3a4b5c';
    emitText(
      socket,
      hostEvent('vad.speech_start', { streamId: v4Stream, utteranceId: 'not-a-uuid', captureStartSequence: 0 }),
    );
    expect(socket.closed).toBe(4000);
  });

  it('rejects malformed VAD payloads fail-closed', async () => {
    const badStream = new EventSocket();
    await wiredTransport(badStream);
    emitText(
      badStream,
      hostEvent('vad.speech_start', { streamId: 'not-a-uuid', utteranceId: turnUuid, captureStartSequence: 0 }),
    );
    expect(badStream.closed).toBe(4000);

    const missingEnd = new EventSocket();
    await wiredTransport(missingEnd);
    emitText(
      missingEnd,
      hostEvent('vad.speech_end', { streamId: streamUuid, utteranceId: turnUuid, captureStartSequence: 0 }),
    );
    expect(missingEnd.closed).toBe(4000);

    const negativeEnd = new EventSocket();
    await wiredTransport(negativeEnd);
    emitText(
      negativeEnd,
      hostEvent('vad.speech_end', {
        streamId: streamUuid,
        utteranceId: turnUuid,
        captureStartSequence: 0,
        captureEndSequence: -1,
      }),
    );
    expect(negativeEnd.closed).toBe(4000);
  });
});

function expectNoProtocolFailure(socket: EventSocket) {
  expect(socket.closed).toBeUndefined();
  expect(socket.failureMessages).toEqual([]);
}

describe('WebSocketSessionTransport progressive ordering', () => {
  it('accepts tts.started before reasoning.final and streams contiguous PCM', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: Array<{ sequence: number; sampleOffset: number; samples: number }> = [];
    transport.onAudio((chunk) =>
      chunks.push({ sequence: chunk.sequence, sampleOffset: chunk.sampleOffset, samples: chunk.pcm16.length }),
    );
    emitText(socket, REASONING(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    emitBinary(socket, 77, 1, 240);
    emitText(socket, FINAL(responseA));
    emitText(socket, TTS_ENDED(responseA, playbackA, 720));
    expectNoProtocolFailure(socket);
    expect(chunks).toEqual([
      { sequence: 0, sampleOffset: 0, samples: 480 },
      { sequence: 1, sampleOffset: 480, samples: 240 },
    ]);
  });

  it('forwards reasoning.delta for the established response and fails closed on a mismatch', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const seen: Array<{ type: string; text?: unknown }> = [];
    transport.onEvent((event) => {
      seen.push({ type: event.type, text: 'text' in event.payload ? event.payload.text : undefined });
    });
    emitText(socket, REASONING(responseA));
    emitText(socket, DELTA(responseA, 'A first preview'));
    emitText(socket, DELTA(responseA, 'A first preview that grows'));
    expectNoProtocolFailure(socket);
    expect(seen).toEqual([
      { type: 'reasoning.started', text: undefined },
      { type: 'reasoning.delta', text: 'A first preview' },
      { type: 'reasoning.delta', text: 'A first preview that grows' },
    ]);
    // A preview for an unestablished response is a protocol anomaly.
    emitText(socket, DELTA(responseB, 'orphan preview'));
    expect(socket.closed).toBe(4000);
  });

  it('fails closed on a reasoning.delta with empty text', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, REASONING(responseA));
    emitText(socket, hostEvent('reasoning.delta', { turnId: turnUuid, responseId: responseA, text: '' }));
    expect(socket.closed).toBe(4000);
  });

  it('accepts tts.started after reasoning.final as well', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: number[] = [];
    transport.onAudio((chunk) => chunks.push(chunk.pcm16.length));
    emitText(socket, REASONING(responseA));
    emitText(socket, FINAL(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    emitText(socket, TTS_ENDED(responseA, playbackA, 480));
    expectNoProtocolFailure(socket);
    expect(chunks).toEqual([480]);
  });

  it('accepts the selected backend identity on tts.started', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, REASONING(responseA));
    emitText(
      socket,
      hostEvent('tts.started', {
        responseId: responseA,
        playbackId: playbackA,
        sampleRate: 24_000,
        backendId: 'qwen3',
        modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
      }),
    );
    expectNoProtocolFailure(socket);
  });

  it('accepts response.failed followed by the generic failure without disconnecting', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, REASONING(responseA));
    emitText(socket, TTS_STARTED(responseA, playbackA));
    emitBinary(socket, 77, 0, 480);
    emitText(socket, FAILED(responseA));
    emitText(
      socket,
      hostEvent('failure', {
        code: 'tts_failed',
        detail: 'The response could not be completed successfully.',
        correctiveAction: 'Continue listening.',
        recoverable: true,
      }),
    );
    expectNoProtocolFailure(socket);
    // Late PCM for the failed response is rejected after the cutoff.
    emitBinary(socket, 77, 1, 240);
    expect(socket.closed).toBe(4000);
  });

  it('rejects a tts.started whose response identity was never established', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, TTS_STARTED(responseA, playbackA));
    expect(socket.closed).toBe(4000);
  });

  it('rejects mismatched, duplicated, and stale identity sequences', async () => {
    const mismatched = new EventSocket();
    await wiredTransport(mismatched);
    emitText(mismatched, REASONING(responseA));
    emitText(mismatched, TTS_STARTED(responseB, playbackB));
    expect(mismatched.closed).toBe(4000);

    const duplicateStarted = new EventSocket();
    await wiredTransport(duplicateStarted);
    emitText(duplicateStarted, REASONING(responseA));
    emitText(duplicateStarted, REASONING(responseA));
    expect(duplicateStarted.closed).toBe(4000);

    const staleEpoch = new EventSocket();
    await wiredTransport(staleEpoch);
    emitText(staleEpoch, REASONING(responseA));
    emitText(
      staleEpoch,
      hostEvent('tts.started', { responseId: responseA, playbackId: playbackA, sampleRate: 24_000 }, 1),
    );
    expect(staleEpoch.closed).toBe(4000);

    const duplicateOutput = new EventSocket();
    await wiredTransport(duplicateOutput);
    emitText(duplicateOutput, REASONING(responseA));
    emitText(duplicateOutput, TTS_STARTED(responseA, playbackA));
    emitText(duplicateOutput, TTS_STARTED(responseA, playbackA));
    expect(duplicateOutput.closed).toBe(4000);
  });

  it('accepts a superseding reasoning.started when the previous response never terminalized', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: number[] = [];
    transport.onAudio((chunk) => chunks.push(chunk.pcm16.length));
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
    expect(socket.closed).toBe(4000);
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
    expect(socket.closed).toBe(4000);
  });

  it('rejects a reasoning.final that contradicts the established response', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(socket, REASONING(responseA));
    emitText(socket, FINAL(responseB));
    expect(socket.closed).toBe(4000);
  });

  it('accepts a second full response after the first completes normally', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: number[] = [];
    transport.onAudio((chunk) => chunks.push(chunk.pcm16.length));
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

describe('WebSocketSessionTransport multi-part output routing', () => {
  it('routes interleaved part PCM by outputStreamId and keeps parent identity across parts', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const chunks: Array<{ playbackId: string; sampleOffset: number; samples: number }> = [];
    transport.onAudio((chunk) =>
      chunks.push({ playbackId: chunk.playbackId, sampleOffset: chunk.sampleOffset, samples: chunk.pcm16.length }),
    );
    // Part 0 (stall): same responseId as part 1, new reasoning.started per part.
    // The wire contract emits response.part_started BEFORE reasoning.started.
    emitText(
      socket,
      hostEvent('response.part_started', { turnId: turnUuid, responseId: responseA, partIndex: 0, kind: 'stall' }),
    );
    emitText(
      socket,
      hostEvent('reasoning.started', { turnId: turnUuid, responseId: responseA, posture: 'riff', partIndex: 0 }),
    );
    emitText(
      socket,
      hostEvent('tts.started', {
        responseId: responseA,
        playbackId: playbackA,
        sampleRate: 24_000,
        outputStreamId: 77,
        partIndex: 0,
      }),
    );
    // Part 1 (body) starts while part 0 PCM is still streaming.
    emitText(
      socket,
      hostEvent('response.part_started', { turnId: turnUuid, responseId: responseA, partIndex: 1, kind: 'body' }),
    );
    emitText(
      socket,
      hostEvent('reasoning.started', { turnId: turnUuid, responseId: responseA, posture: 'riff', partIndex: 1 }),
    );
    emitText(
      socket,
      hostEvent('tts.started', {
        responseId: responseA,
        playbackId: playbackB,
        sampleRate: 24_000,
        outputStreamId: 78,
        partIndex: 1,
      }),
    );
    // Interleave binary frames from both streams; each must route to its own part.
    emitBinary(socket, 77, 0, 480);
    emitBinary(socket, 78, 0, 240);
    emitBinary(socket, 77, 1, 160);
    emitBinary(socket, 78, 1, 120);
    emitText(
      socket,
      hostEvent('reasoning.final', {
        turnId: turnUuid,
        responseId: responseA,
        posture: 'riff',
        partIndex: 1,
        text: 'The body answer.',
      }),
    );
    emitText(
      socket,
      hostEvent('response.part_final', { turnId: turnUuid, responseId: responseA, partIndex: 1, kind: 'body' }),
    );
    emitText(
      socket,
      hostEvent('tts.ended', { responseId: responseA, playbackId: playbackA, generatedSamples: 640, partIndex: 0 }),
    );
    emitText(
      socket,
      hostEvent('tts.ended', { responseId: responseA, playbackId: playbackB, generatedSamples: 360, partIndex: 1 }),
    );
    expectNoProtocolFailure(socket);
    expect(chunks).toEqual([
      { playbackId: playbackA, sampleOffset: 0, samples: 480 },
      { playbackId: playbackB, sampleOffset: 0, samples: 240 },
      { playbackId: playbackA, sampleOffset: 480, samples: 160 },
      { playbackId: playbackB, sampleOffset: 240, samples: 120 },
    ]);
  });

  it('accepts response.part_started as the first event of a brand-new response', async () => {
    const socket = new EventSocket();
    const transport = await wiredTransport(socket);
    const seen: string[] = [];
    transport.onEvent((event) => {
      seen.push(event.type);
    });
    // The host emits response.part_started before reasoning.started, so on a
    // fresh transport latestResponseId is still undefined when it arrives; it
    // must establish the response instead of failing the session.
    emitText(
      socket,
      hostEvent('response.part_started', { turnId: turnUuid, responseId: responseA, partIndex: 0, kind: 'stall' }),
    );
    emitText(
      socket,
      hostEvent('reasoning.started', { turnId: turnUuid, responseId: responseA, posture: 'riff', partIndex: 0 }),
    );
    expectNoProtocolFailure(socket);
    expect(seen).toEqual(['response.part_started', 'reasoning.started']);
  });

  it('records part lifecycle and first-audio latency in the activity log', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    const append = vi.spyOn(activityLog, 'append');
    // Real wire order: part_started precedes reasoning.started for each part.
    emitText(
      socket,
      hostEvent('response.part_started', { turnId: turnUuid, responseId: responseA, partIndex: 0, kind: 'stall' }),
    );
    emitText(
      socket,
      hostEvent('reasoning.started', { turnId: turnUuid, responseId: responseA, posture: 'riff', partIndex: 0 }),
    );
    emitText(
      socket,
      hostEvent('tts.started', {
        responseId: responseA,
        playbackId: playbackA,
        sampleRate: 24_000,
        outputStreamId: 77,
        partIndex: 0,
      }),
    );
    emitBinary(socket, 77, 0, 480);
    emitText(
      socket,
      hostEvent('reasoning.final', {
        turnId: turnUuid,
        responseId: responseA,
        posture: 'riff',
        partIndex: 0,
        text: 'Stall.',
      }),
    );
    emitText(
      socket,
      hostEvent('response.part_final', { turnId: turnUuid, responseId: responseA, partIndex: 0, kind: 'stall' }),
    );
    emitText(
      socket,
      hostEvent('tts.ended', { responseId: responseA, playbackId: playbackA, generatedSamples: 480, partIndex: 0 }),
    );
    const entries = append.mock.calls.map((call) => call[0]);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'transport', message: 'part stall 0 started' }),
        expect.objectContaining({ source: 'transport', message: 'part 0 first audio' }),
        expect.objectContaining({ source: 'transport', message: 'part stall 0 final' }),
      ]),
    );
    expectNoProtocolFailure(socket);
  });

  it('rejects a multipart tts.started that reuses an output stream id', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(
      socket,
      hostEvent('reasoning.started', { turnId: turnUuid, responseId: responseA, posture: 'riff', partIndex: 0 }),
    );
    emitText(
      socket,
      hostEvent('tts.started', {
        responseId: responseA,
        playbackId: playbackA,
        sampleRate: 24_000,
        outputStreamId: 77,
        partIndex: 0,
      }),
    );
    emitText(
      socket,
      hostEvent('reasoning.started', { turnId: turnUuid, responseId: responseA, posture: 'riff', partIndex: 1 }),
    );
    emitText(
      socket,
      hostEvent('tts.started', {
        responseId: responseA,
        playbackId: playbackB,
        sampleRate: 24_000,
        outputStreamId: 77,
        partIndex: 1,
      }),
    );
    expect(socket.closed).toBe(4000);
  });
});

describe('WebSocketSessionTransport protocol failure diagnostics', () => {
  it('reports the failing event type in the failure notification and closes with a client-valid code', async () => {
    const socket = new EventSocket();
    await wiredTransport(socket);
    emitText(
      socket,
      hostEvent('vad.speech_start', { streamId: 'not-a-uuid', utteranceId: turnUuid, captureStartSequence: 0 }),
    );
    expect(socket.closed).toBe(4000);
    expect(socket.failureMessages).toEqual([expect.stringContaining('vad.speech_start')]);
  });

  it('never lets a throwing close() escape onmessage and still notifies the failure', async () => {
    class ThrowingSocket extends EventSocket {
      override close(): never {
        throw new Error('close exploded');
      }
    }
    const socket = new ThrowingSocket();
    await wiredTransport(socket);
    expect(() =>
      emitText(
        socket,
        hostEvent('reasoning.final', {
          turnId: turnUuid,
          responseId: responseA,
          posture: 'riff',
          text: 'Unexpected final',
        }),
      ),
    ).not.toThrow();
    expect(socket.failureMessages).toHaveLength(1);
    expect(socket.failureMessages[0]).toContain('reasoning.final');
  });
});
