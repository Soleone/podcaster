import type { PiSettings } from '@app/contracts';
import type { PiClient, PiReadiness } from './PiClient.js';

export const PI_CHECKING: PiReadiness = {
  status: 'unavailable',
  detail: 'Pi is checking the selected model.',
  correctiveAction: 'Keep this page open while Pi verifies provider access.',
};

const PI_UNAVAILABLE: PiReadiness = {
  status: 'unavailable',
  detail: 'Pi is unavailable.',
  correctiveAction: 'Retry, or use transcript-only mode.',
};
const DEFAULT_PROBE_TTL_MS = 10_000;
const DEFAULT_DOWNGRADE_CONFIRMATIONS = 2;

interface RequestedSettings {
  key: string;
  value: PiSettings;
}

interface ProbeEntry {
  key: string;
  settings: PiSettings;
  client: PiClient | undefined;
  value: PiReadiness | undefined;
  checkedAt: number;
  inFlight: Promise<void> | undefined;
  downgradeCount: number;
}

export interface PiReadinessProbeOptions {
  createClient(settings: PiSettings): PiClient;
  now?: () => number;
  ttlMs?: number;
  downgradeConfirmations?: number;
}

function settingsKey(settings: PiSettings): string {
  return JSON.stringify([settings.model, settings.thinkingLevel]);
}

function requestedSettings(settings: PiSettings): RequestedSettings {
  return { key: settingsKey(settings), value: { model: settings.model, thinkingLevel: settings.thinkingLevel } };
}

/**
 * Owns the one host-scoped Pi client used by readiness. A settings change
 * retires the old client before the new one is created, and cached state never
 * crosses the settings key boundary.
 */
export class PiReadinessProbe {
  private readonly createClient: PiReadinessProbeOptions['createClient'];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly downgradeConfirmations: number;
  private current: ProbeEntry | undefined;
  private desired: RequestedSettings | undefined;
  private reconcilePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: PiReadinessProbeOptions) {
    this.createClient = options.createClient;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS;
    this.downgradeConfirmations = options.downgradeConfirmations ?? DEFAULT_DOWNGRADE_CONFIRMATIONS;
  }

  /** Return the current snapshot without making the browser wait for a probe. */
  probe(settings: PiSettings): Promise<PiReadiness> {
    const requested = requestedSettings(settings);
    if (this.closed) return Promise.resolve(PI_UNAVAILABLE);

    if (this.desired?.key !== requested.key) {
      this.desired = requested;
      this.scheduleReconcile();
    }

    const current = this.current;
    if (!current || current.key !== requested.key || this.desired?.key !== requested.key) return Promise.resolve(PI_CHECKING);
    if (!current.client) {
      if (!current.value || this.now() - current.checkedAt >= this.ttlMs) this.scheduleReconcile();
      return Promise.resolve(current.value ?? PI_CHECKING);
    }
    if (!current.value || this.now() - current.checkedAt >= this.ttlMs) this.startProbe(current);
    return Promise.resolve(current.value ?? PI_CHECKING);
  }

  shutdown(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.desired = undefined;
    this.closePromise = (async () => {
      await this.reconcilePromise?.catch(() => undefined);
      const current = this.current;
      this.current = undefined;
      await current?.client?.shutdown().catch(() => undefined);
    })();
    return this.closePromise;
  }

  private scheduleReconcile(): void {
    if (this.closed || this.reconcilePromise) return;
    let run!: Promise<void>;
    run = this.reconcile().finally(() => {
      if (this.reconcilePromise === run) this.reconcilePromise = undefined;
      const current = this.current;
      if (!this.closed && this.desired && (!current || current.key !== this.desired.key)) this.scheduleReconcile();
    });
    this.reconcilePromise = run;
  }

  private async reconcile(): Promise<void> {
    while (!this.closed) {
      const desired = this.desired;
      if (!desired) return;
      const current = this.current;
      if (current?.key === desired.key && current.client) return;

      this.current = undefined;
      if (current?.client) await current.client.shutdown().catch(() => undefined);
      if (this.closed) return;

      const latest = this.desired;
      if (!latest) return;
      let client: PiClient;
      try {
        client = this.createClient(latest.value);
      } catch {
        this.current = {
          key: latest.key,
          settings: latest.value,
          client: undefined,
          value: PI_UNAVAILABLE,
          checkedAt: this.now(),
          inFlight: undefined,
          downgradeCount: 0,
        };
        return;
      }
      const entry: ProbeEntry = {
        key: latest.key,
        settings: latest.value,
        client,
        value: undefined,
        checkedAt: 0,
        inFlight: undefined,
        downgradeCount: 0,
      };
      this.current = entry;
      if (this.desired?.key !== entry.key) continue;
      this.startProbe(entry);
      return;
    }
  }

  private startProbe(entry: ProbeEntry): void {
    if (this.closed || this.current !== entry || !entry.client || entry.inFlight) return;
    const client = entry.client;
    let inFlight!: Promise<void>;
    inFlight = Promise.resolve()
      .then(() => client.probe())
      .catch(() => PI_UNAVAILABLE)
      .then(value => {
        if (this.current === entry && !this.closed && this.desired?.key === entry.key) this.accept(entry, value);
      })
      .finally(() => {
        if (entry.inFlight === inFlight) entry.inFlight = undefined;
      });
    entry.inFlight = inFlight;
  }

  private accept(entry: ProbeEntry, value: PiReadiness): void {
    entry.checkedAt = this.now();
    if (entry.value?.status === 'ready' && value.status !== 'ready') {
      entry.downgradeCount++;
      if (entry.downgradeCount < this.downgradeConfirmations) return;
    }
    entry.value = value;
    entry.downgradeCount = 0;
  }
}
