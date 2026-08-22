import { encodeMp3, type EncodeSampleRate } from './encode';

export interface EncodeRequest {
  requestId: number;
  pcm16: Int16Array;
  sampleRate: EncodeSampleRate;
  bitrateKbps: number;
  reportProgress?: boolean;
}
export interface EncodeResponse {
  requestId: number;
  mp3: Uint8Array;
}
export interface EncodeProgress {
  requestId: number;
  progress: number;
}
export interface EncodeFailure {
  requestId: number;
  error: string;
}

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: EncodeResponse | EncodeFailure | EncodeProgress, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const { requestId, pcm16, sampleRate, bitrateKbps, reportProgress } = event.data;
  const onProgress = reportProgress
    ? (fraction: number) => workerScope.postMessage({ requestId, progress: fraction } satisfies EncodeProgress)
    : undefined;
  try {
    const mp3 = encodeMp3(pcm16, sampleRate, bitrateKbps, onProgress);
    workerScope.postMessage({ requestId, mp3 } satisfies EncodeResponse, [mp3.buffer]);
  } catch (error) {
    workerScope.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error),
    } satisfies EncodeFailure);
  }
};
