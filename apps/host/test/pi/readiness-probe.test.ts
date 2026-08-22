import { afterEach, describe, expect, it } from 'vitest';
import type { PiSettings } from '@app/contracts';
import { PI_CHECKING, PiReadinessProbe } from '../../src/pi/readiness-probe.js';
import type { PiClient, PiEvent, PiReadiness } from '../../src/pi/PiClient.js';

const settingsA: PiSettings = { model: 'provider/model-a', thinkingLevel: 'medium' };
const settingsB: PiSettings = { model: 'provider/model-b', thinkingLevel: 'high' };
const ready = (model: string): PiReadiness => ({
  status: 'ready',
  detail: `${model} is ready.`,
  correctiveAction: 'None.',
});
const unavailable: PiReadiness = { status: 'unavailable', detail: 'Pi is unavailable.', correctiveAction: 'Retry.' };

class FakeProbeClient implements PiClient {
  probeCalls = 0;
  shutdownCalls = 0;

  constructor(
    readonly settings: PiSettings,
    private readonly results: PiReadiness[],
  ) {}

  async probe(): Promise<PiReadiness> {
    this.probeCalls++;
    return this.results.shift() ?? unavailable;
  }

  async *request(): AsyncIterable<PiEvent> {}

  async shutdown(): Promise<void> {
    this.shutdownCalls++;
  }
}

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const owners: PiReadinessProbe[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
});

describe('settings-keyed Pi readiness probe', () => {
  it('isolates model caches, passes factory settings, and shuts down each owned client once', async () => {
    const clients: FakeProbeClient[] = [];
    const owner = new PiReadinessProbe({
      createClient: (settings) => {
        const client = new FakeProbeClient(settings, [ready(settings.model)]);
        clients.push(client);
        return client;
      },
    });
    owners.push(owner);

    expect(await owner.probe(settingsA)).toBe(PI_CHECKING);
    await flush();
    expect((await owner.probe(settingsA)).status).toBe('ready');

    expect(await owner.probe(settingsB)).toBe(PI_CHECKING);
    expect((await owner.probe(settingsB)).status).not.toBe('ready');
    await flush();
    expect((await owner.probe(settingsB)).status).toBe('ready');

    expect(clients.map((client) => client.settings)).toEqual([settingsA, settingsB]);
    expect(clients[0]?.shutdownCalls).toBe(1);
    await owner.shutdown();
    expect(clients[1]?.shutdownCalls).toBe(1);
  });

  it('resets downgrade confirmation when settings change', async () => {
    let clock = 0;
    const clients: FakeProbeClient[] = [];
    const owner = new PiReadinessProbe({
      now: () => clock,
      createClient: (settings) => {
        const results =
          settings.model === settingsA.model
            ? [ready(settings.model), unavailable]
            : [ready(settings.model), unavailable];
        const client = new FakeProbeClient(settings, results);
        clients.push(client);
        return client;
      },
    });
    owners.push(owner);

    await owner.probe(settingsA);
    await flush();
    clock = 10_001;
    expect((await owner.probe(settingsA)).status).toBe('ready');
    await flush();
    expect((await owner.probe(settingsA)).status).toBe('ready');

    expect(await owner.probe(settingsB)).toBe(PI_CHECKING);
    await flush();
    clock = 20_002;
    expect((await owner.probe(settingsB)).status).toBe('ready');
    await flush();
    expect((await owner.probe(settingsB)).status).toBe('ready');

    expect(clients).toHaveLength(2);
    expect(clients[0]?.shutdownCalls).toBe(1);
  });
});
