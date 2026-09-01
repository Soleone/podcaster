import type { Page } from '@playwright/test';
import type { JsonObject } from '../../src/lib/json-values';

export interface FakeBrowserOptions {
  decodeDelayMs?: number;
}

export async function installFakeMicrophone(page: Page, options: FakeBrowserOptions = {}): Promise<void> {
  await page.addInitScript((initOptions: FakeBrowserOptions) => {
    type Listener = () => void;
    interface FakeBrowserWindow extends Window {
      __podcasterFakeWorkletNode?: FakeAudioWorkletNode;
      getUserMediaCalls: number;
    }
    class FakeTrack {
      private readonly listeners = new Map<string, Listener[]>();
      stop(): void {}
      addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
    }
    class FakeAudioBuffer {
      readonly channel = new Float32Array(this.length);
      constructor(
        readonly length: number,
        readonly sampleRate: number,
      ) {}
      get duration(): number {
        return this.length / this.sampleRate;
      }
      getChannelData(): Float32Array {
        return this.channel;
      }
    }
    class FakeAudioBufferSource {
      buffer: FakeAudioBuffer | null = null;
      onended: (() => void) | null = null;
      constructor(private readonly context: FakeAudioContext) {}
      connect(): void {}
      start(startTime = 0): void {
        queueMicrotask(() => {
          this.context.currentTime = Math.max(this.context.currentTime, startTime + (this.buffer?.duration ?? 0));
          this.onended?.();
        });
      }
      stop(): void {}
    }
    class FakeAudioContext {
      currentTime = 0;
      readonly sampleRate = 48_000;
      readonly destination = {};
      readonly audioWorklet = { addModule: async (_path: string) => undefined };
      createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
      }
      createMediaStreamSource(_stream: MediaStream) {
        return { connect() {}, disconnect() {} };
      }
      createBuffer(_channels: number, length: number, sampleRate: number) {
        return new FakeAudioBuffer(length, sampleRate);
      }
      createBufferSource(): FakeAudioBufferSource {
        return new FakeAudioBufferSource(this);
      }
      async suspend(): Promise<void> {}
      async resume(): Promise<void> {}
      async close(): Promise<void> {}
      async decodeAudioData(_data: ArrayBuffer): Promise<FakeAudioBuffer> {
        // The recording export path decodes each MP3 item before splicing; the
        // fake returns one second of silence at 16 kHz. The optional delay lets
        // the export-progress UI observe the decoding phase.
        if ((initOptions.decodeDelayMs ?? 0) > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, initOptions.decodeDelayMs));
        }
        return new FakeAudioBuffer(16_000, 16_000);
      }
    }
    interface MessagePortLike {
      onmessage: ((event: MessageEvent<Float32Array>) => void) | null;
    }
    class FakeAudioWorkletNode {
      readonly port: MessagePortLike = { onmessage: null };
      constructor(_context: BaseAudioContext, _name: string) {
        // SAFETY: this init script adds only the declared test-only window properties.
        // SAFETY: this init script adds only the declared test-only window properties.
        const fakeWindow = window as FakeBrowserWindow;
        fakeWindow.__podcasterFakeWorkletNode = this;
        queueMicrotask(() => this.port.onmessage?.(new MessageEvent('message', { data: new Float32Array(961) })));
      }
      connect(): void {}
      disconnect(): void {}
    }

    // SAFETY: this init script adds only the declared test-only window properties.
    const fakeWindow = window as FakeBrowserWindow;
    fakeWindow.getUserMediaCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          fakeWindow.getUserMediaCalls++;
          const track = new FakeTrack();
          return { getTracks: () => [track] };
        },
      },
    });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode });
  }, options);
}

export async function enterFakeSession(page: Page, origin: string, options: FakeBrowserOptions = {}): Promise<void> {
  await installFakeMicrophone(page, options);
  await page.goto(origin);
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.waitForFunction(() => Boolean(window.__podcasterTest));
}

export async function emit(page: Page, type: string, payload: JsonObject): Promise<void> {
  await page.evaluate(
    async ([eventType, eventPayload]) => {
      await window.__podcasterTest!.emit(eventType, eventPayload);
    },
    [type, payload],
  );
}
