import type { Page } from '@playwright/test';

export async function installFakeMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Listener = () => void;
    class FakeTrack {
      private readonly listeners = new Map<string, Listener[]>();
      stop(): void {}
      addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
    }
    class FakeAudioBuffer {
      readonly channel = new Float32Array(this.length);
      constructor(readonly length: number, readonly sampleRate: number) {}
      get duration(): number { return this.length / this.sampleRate; }
      getChannelData(): Float32Array { return this.channel; }
    }
    class FakeAudioContext {
      currentTime = 0;
      readonly sampleRate = 48_000;
      readonly destination = {};
      readonly audioWorklet = { addModule: async (_path: string) => undefined };
      createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
      }
      createMediaStreamSource(_stream: unknown) {
        return { connect() {}, disconnect() {} };
      }
      createBuffer(_channels: number, length: number, sampleRate: number) {
        return new FakeAudioBuffer(length, sampleRate);
      }
      createBufferSource() {
        const context = this;
        return {
          buffer: null as FakeAudioBuffer | null,
          onended: null as (() => void) | null,
          connect() {},
          start(startTime = 0) {
            const source = this;
            queueMicrotask(() => {
              context.currentTime = Math.max(context.currentTime, startTime + (source.buffer?.duration ?? 0));
              source.onended?.();
            });
          },
          stop() {},
        };
      }
      async suspend(): Promise<void> {}
      async resume(): Promise<void> {}
      async close(): Promise<void> {}
    }
    class FakeAudioWorkletNode {
      readonly port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } = { onmessage: null };
      constructor(_context: unknown, _name: string) {
        queueMicrotask(() => this.port.onmessage?.({ data: new Float32Array(961) } as MessageEvent<Float32Array>));
      }
      connect(): void {}
      disconnect(): void {}
    }

    (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls++;
          const track = new FakeTrack();
          return { getTracks: () => [track] };
        },
      },
    });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode });
  });
}

export async function enterFakeSession(page: Page, origin: string): Promise<void> {
  await installFakeMicrophone(page);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue and check readiness' }).click();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.waitForFunction(() => Boolean(window.__podcasterTest));
}

export async function emit(page: Page, type: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ([eventType, eventPayload]) => {
    await window.__podcasterTest!.emit(eventType, eventPayload);
  }, [type, payload] as const);
}
