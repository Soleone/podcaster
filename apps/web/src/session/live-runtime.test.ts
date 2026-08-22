import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingStore } from '../storage/recording-store';
import { StableTurnWriter } from '../storage/stable-turn-writer';
import { FakeSessionTransport } from './fake-transport';
import { createLiveSessionRuntime } from './live-runtime';
import { initialSessionState } from './state';

let sequence = 0;
const databases: string[] = [];
afterEach(async () => {
  for (const name of databases.splice(0))
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
});

async function setup() {
  const name = `runtime-${++sequence}`;
  databases.push(name);
  const writer = await StableTurnWriter.open(indexedDB, `${name}-turns`);
  const transport = new FakeSessionTransport();
  const calls: string[] = [];
  let captureStops = 0;
  const store = await RecordingStore.open(indexedDB, `${name}-recordings`);
  const runtime = await createLiveSessionRuntime({
    sessionId: 'session',
    capability: 'fake',
    writer,
    transport,
    fake: true,
    openRecordingStore: async () => {
      calls.push('recording.open');
      return store;
    },
    createCapture: async () => {
      calls.push('capture.start');
      return {
        stop: async () => {
          captureStops++;
          calls.push('capture.stop');
        },
      };
    },
    createEncoder: () => async () => new Uint8Array(),
    initialState: { ...initialSessionState, dominant: 'listening', announcement: 'Listening' },
    seed: 'seed',
    reasoningMode: 'full',
    settings: { version: 1, persona: '', voice: { catalogId: 'catalog', voiceId: 'voice', speedModifier: 1 } },
    activate: async () => {
      calls.push('activate');
      const result = await writer.beginSession({ sessionId: 'session', sessionSeed: 'seed', personaDigest: 'digest' });
      if (!result.ok) throw new Error(result.degradedReason);
    },
    callbacks: { onView: () => undefined, onTransportFailure: () => undefined, onRecordingChanged: () => undefined },
  });
  return {
    runtime,
    writer,
    transport,
    calls,
    get captureStops() {
      return captureStops;
    },
  };
}

describe('live session runtime', () => {
  it('composes storage before transport and capture, then releases pause resources once', async () => {
    const setupResult = await setup();
    const { runtime, writer, transport, calls } = setupResult;
    expect(calls).toEqual(['recording.open', 'activate', 'capture.start']);
    expect(transport.connected).toBe(true);
    expect(await runtime.pause()).toBe(true);
    expect(calls).toContain('capture.stop');
    expect(setupResult.captureStops).toBe(1);
    expect(await runtime.pause()).toBe(true);
    expect(setupResult.captureStops).toBe(1);
    await runtime.dispose();
    writer.close();
  });

  it('rolls back a failed composition and makes dispose idempotent', async () => {
    const name = `runtime-failed-${++sequence}`;
    databases.push(name);
    const writer = await StableTurnWriter.open(indexedDB, `${name}-turns`);
    const transport = new FakeSessionTransport();
    const store = await RecordingStore.open(indexedDB, `${name}-recordings`);
    let stops = 0;
    await expect(
      createLiveSessionRuntime({
        sessionId: 'failed',
        capability: 'fake',
        writer,
        transport,
        fake: true,
        openRecordingStore: async () => store,
        createCapture: async () => ({
          stop: async () => {
            stops++;
          },
        }),
        createEncoder: () => async () => new Uint8Array(),
        seed: 'seed',
        reasoningMode: 'full',
        settings: { version: 1, persona: '', voice: { catalogId: 'catalog', voiceId: 'voice', speedModifier: 1 } },
        activate: async () => {
          const result = await writer.beginSession({
            sessionId: 'failed',
            sessionSeed: 'seed',
            personaDigest: 'digest',
          });
          if (!result.ok) throw new Error(result.degradedReason);
          throw new Error('start failed');
        },
        callbacks: {
          onView: () => undefined,
          onTransportFailure: () => undefined,
          onRecordingChanged: () => undefined,
        },
      }),
    ).rejects.toThrow('start failed');
    expect(transport.connected).toBe(false);
    expect(stops).toBe(0);
    writer.close();
  });
});
