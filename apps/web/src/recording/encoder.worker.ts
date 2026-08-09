import { encodeMp3, type EncodeSampleRate } from './encode';

export interface EncodeRequest {
  requestId: number;
  pcm16: Int16Array;
  sampleRate: EncodeSampleRate;
  bitrateKbps: number;
}
export interface EncodeResponse { requestId: number; mp3: Uint8Array }
export interface EncodeFailure { requestId: number; error: string }

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: EncodeResponse | EncodeFailure, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const { requestId, pcm16, sampleRate, bitrateKbps } = event.data;
  try {
    const mp3 = encodeMp3(pcm16, sampleRate, bitrateKbps);
    workerScope.postMessage({ requestId, mp3 } satisfies EncodeResponse, [mp3.buffer]);
  } catch (error) {
    workerScope.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) } satisfies EncodeFailure);
  }
};
