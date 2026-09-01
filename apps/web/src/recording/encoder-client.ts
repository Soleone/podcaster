import { type EncodeMp3, type EncodeSampleRate } from './encode';
import type { EncodeRequest } from './encoder.worker';
import EncodeWorker from './encoder.worker?worker';

interface PendingEncode {
  resolve(value: Uint8Array): void;
  reject(error: Error): void;
  onProgress?: (fraction: number) => void;
}

/**
 * Promise wrapper around the Vite module worker that runs encodeMp3 off the
 * main thread. Handles both per-turn (64 kbps) and final-export (128 kbps)
 * encodes.
 */
export function createEncoderClient(factory: () => Worker = () => new EncodeWorker()): EncodeMp3 {
  const worker = factory();
  const pending = new Map<number, PendingEncode>();
  let nextRequestId = 0;
  let terminated = false;
  worker.onmessage = (event: MessageEvent) => {
    // SAFETY: This value is constructed by this local test or platform boundary with the asserted shape.
    const message = event.data as { requestId: number; mp3?: Uint8Array; error?: string; progress?: number };
    const entry = pending.get(message.requestId);
    if (!entry) return;
    if (message.progress !== undefined) {
      if (message.mp3 === undefined && message.error === undefined) {
        entry.onProgress?.(message.progress);
        return;
      }
    }
    pending.delete(message.requestId);
    if (message.error !== undefined) entry.reject(new Error(message.error));
    else if (message.mp3 !== undefined) entry.resolve(message.mp3);
    else entry.reject(new Error('Encoder worker returned an empty response.'));
  };
  worker.onerror = (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message || 'Encoder worker failed.'));
    pending.clear();
  };
  return async (pcm16, sampleRate, bitrateKbps, onProgress) => {
    if (terminated) throw new Error('Encoder worker is terminated.');
    const requestId = nextRequestId++;
    const result = new Promise<Uint8Array>((resolve, reject) => {
      const entry: PendingEncode = { resolve, reject };
      if (onProgress) entry.onProgress = onProgress;
      pending.set(requestId, entry);
    });
    const request: EncodeRequest = { requestId, pcm16, sampleRate, bitrateKbps };
    if (onProgress) request.reportProgress = true;
    worker.postMessage(request);
    return result;
  };
}
