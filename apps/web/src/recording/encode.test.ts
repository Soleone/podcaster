import { describe, expect, it, vi } from 'vitest';
import { encodeMp3 } from './encode';
import { createEncoderClient } from './encoder-client';

function tone(samples: number, sampleRate: number): Int16Array {
  const pcm = new Int16Array(samples);
  for (let index = 0; index < samples; index++)
    pcm[index] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * index) / sampleRate));
  return pcm;
}
function hasMp3FrameHeader(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

describe('encodeMp3', () => {
  it('returns a valid MP3 frame stream for 16, 24, and 44.1 kHz mono', () => {
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    for (const sampleRate of [16000, 24000, 44100] as const) {
      const bytes = encodeMp3(tone(sampleRate, sampleRate), sampleRate, 64);
      expect(hasMp3FrameHeader(bytes)).toBe(true);
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic for fixed input', () => {
    const pcm = tone(24000, 24000);
    expect(Buffer.from(encodeMp3(pcm, 24000, 64)).equals(Buffer.from(encodeMp3(pcm, 24000, 64)))).toBe(true);
  });

  it('encodes a payload shorter than one LAME frame', () => {
    const bytes = encodeMp3(tone(100, 16000), 16000, 64);
    expect(hasMp3FrameHeader(bytes)).toBe(true);
  });

  it('reports monotonic progress that ends at exactly 1', () => {
    const pcm = tone(24000, 24000);
    const fractions: number[] = [];
    encodeMp3(pcm, 24000, 64, (fraction) => fractions.push(fraction));
    expect(fractions.length).toBeGreaterThan(1);
    for (let index = 1; index < fractions.length; index++) {
      expect(fractions[index]!).toBeGreaterThanOrEqual(fractions[index - 1]!);
    }
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it('reports a final 1 even for a tiny input', () => {
    const fractions: number[] = [];
    encodeMp3(tone(100, 16000), 16000, 64, (fraction) => fractions.push(fraction));
    expect(fractions[fractions.length - 1]).toBe(1);
  });
});

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
interface FakeWorkerSetup {
  worker: FakeWorker;
  encode: ReturnType<typeof createEncoderClient>;
}

function fakeWorker(): FakeWorkerSetup {
  const worker: FakeWorker = { postMessage: vi.fn(), onmessage: null, onerror: null };
  // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
  const encode = createEncoderClient(() => worker as FakeWorker & Worker);
  return { worker, encode };
}
function respond(
  worker: FakeWorker,
  request: { requestId: number; pcm16: Int16Array; sampleRate: number; bitrateKbps: number },
  mp3: Uint8Array,
): void {
  // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
  worker.onmessage?.({ data: { requestId: request.requestId, mp3 } } as MessageEvent);
}

describe('encoder worker client', () => {
  it('resolves the encoded bytes routed by request id', async () => {
    const { worker, encode } = fakeWorker();
    const request = encode(tone(8000, 16000), 16000, 64);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const posted = worker.postMessage.mock.calls[0]![0] as {
      requestId: number;
      pcm16: Int16Array;
      sampleRate: number;
      bitrateKbps: number;
    };
    expect(posted).toMatchObject({ sampleRate: 16000, bitrateKbps: 64 });
    expect(posted.pcm16).toHaveLength(8000);
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]);
    respond(worker, posted, mp3);
    await expect(request).resolves.toEqual(mp3);
  });

  it('resolves concurrent requests independently', async () => {
    const { worker, encode } = fakeWorker();
    const first = encode(tone(8000, 16000), 16000, 64);
    const second = encode(tone(8000, 24000), 24000, 64);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const firstPost = worker.postMessage.mock.calls[0]![0] as {
      requestId: number;
      pcm16: Int16Array;
      sampleRate: number;
      bitrateKbps: number;
    };
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const secondPost = worker.postMessage.mock.calls[1]![0] as {
      requestId: number;
      pcm16: Int16Array;
      sampleRate: number;
      bitrateKbps: number;
    };
    expect(secondPost.requestId).not.toBe(firstPost.requestId);
    expect(secondPost.sampleRate).toBe(24000);
    respond(worker, secondPost, new Uint8Array([2]));
    respond(worker, firstPost, new Uint8Array([1]));
    await expect(first).resolves.toEqual(new Uint8Array([1]));
    await expect(second).resolves.toEqual(new Uint8Array([2]));
  });

  it('rejects pending requests when the worker errors and ignores late responses', async () => {
    const { worker, encode } = fakeWorker();
    const request = encode(new Int16Array(320), 16000, 64);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const posted = worker.postMessage.mock.calls[0]![0] as { requestId: number };
    const settled = request.then(
      () => 'resolved',
      // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
      (error) => `rejected:${(error as Error).message}`,
    );
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    worker.onmessage?.({ data: { requestId: posted.requestId, mp3: new Uint8Array([0xff, 0xfb]) } } as MessageEvent);
    await expect(settled).resolves.toMatch(/^rejected:/);
  });

  it('rejects a worker error payload for its request', async () => {
    const { worker, encode } = fakeWorker();
    const request = encode(new Int16Array(320), 16000, 64);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const posted = worker.postMessage.mock.calls[0]![0] as { requestId: number };
    const settled = request.then(
      () => 'resolved',
      // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
      (error) => `rejected:${(error as Error).message}`,
    );
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    worker.onmessage?.({ data: { requestId: posted.requestId, error: 'encoder exploded' } } as MessageEvent);
    await expect(settled).resolves.toMatch(/^rejected:encoder exploded$/);
  });

  it('forwards progress frames when a callback is supplied and resolves exact bytes', async () => {
    const { worker, encode } = fakeWorker();
    const onProgress = vi.fn();
    const request = encode(tone(8000, 16000), 16000, 64, onProgress);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const posted = worker.postMessage.mock.calls[0]![0] as { requestId: number; reportProgress?: boolean };
    expect(posted.reportProgress).toBe(true);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    worker.onmessage?.({ data: { requestId: posted.requestId, progress: 0.5 } } as MessageEvent);
    expect(onProgress).toHaveBeenCalledWith(0.5);
    const mp3 = new Uint8Array([0xff, 0xfb, 9, 8]);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    worker.onmessage?.({ data: { requestId: posted.requestId, mp3 } } as MessageEvent);
    await expect(request).resolves.toEqual(mp3);
  });

  it('omits reportProgress when no callback is supplied', async () => {
    const { worker, encode } = fakeWorker();
    encode(tone(8000, 16000), 16000, 64);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const posted = worker.postMessage.mock.calls[0]![0] as { requestId: number; reportProgress?: boolean };
    expect(posted).not.toHaveProperty('reportProgress');
  });

  it('ignores progress for an unknown request id without disturbing known requests', async () => {
    const { worker, encode } = fakeWorker();
    const onProgress = vi.fn();
    const request = encode(tone(8000, 16000), 16000, 64, onProgress);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    worker.onmessage?.({ data: { requestId: 9999, progress: 0.5 } } as MessageEvent);
    expect(onProgress).not.toHaveBeenCalled();
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const posted = worker.postMessage.mock.calls[0]![0] as { requestId: number };
    const mp3 = new Uint8Array([0xff, 0xfb, 1]);
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    worker.onmessage?.({ data: { requestId: posted.requestId, mp3 } } as MessageEvent);
    await expect(request).resolves.toEqual(mp3);
  });
});
