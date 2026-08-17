import {
  CUSTOM_VOICE_SAMPLE_RATE,
  CUSTOM_VOICE_ERROR_COPY,
  analyzeReferenceSignal,
  validateReferenceSignal,
  type CustomVoiceErrorCode,
  type ReferenceSignal,
} from '@app/contracts/settings';
import { offlineResample } from '../recording/resample';
import { encodeWavPcm16, floatToPcm16, sha256Hex } from './wav';

export type MicrophoneState = 'unrequested' | 'requesting' | 'granted' | 'denied' | 'unavailable' | 'busy';

export interface ReferenceTake {
  wav: Blob;
  wavBytes: Uint8Array;
  pcm16: Int16Array;
  signal: ReferenceSignal;
  refSha256: string;
  durationMs: number;
}

export class ReferenceRecordingError extends Error {
  readonly code: CustomVoiceErrorCode;
  constructor(code: CustomVoiceErrorCode, message = CUSTOM_VOICE_ERROR_COPY[code]) {
    super(message);
    this.name = 'ReferenceRecordingError';
    this.code = code;
  }
}

function mapMicrophoneError(error: unknown): ReferenceRecordingError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return new ReferenceRecordingError('mic_denied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new ReferenceRecordingError('mic_unavailable');
  if (name === 'NotReadableError' || name === 'AbortError') return new ReferenceRecordingError('mic_busy');
  return new ReferenceRecordingError('mic_unavailable');
}

export class ReferenceRecorder {
  state: MicrophoneState = 'unrequested';
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private chunks: Blob[] = [];
  private stopPromise: Promise<Blob> | undefined;

  async start(): Promise<void> {
    if (this.recorder && this.recorder.state === 'recording') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.state = 'unavailable';
      throw new ReferenceRecordingError('mic_unavailable');
    }
    this.state = 'requesting';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    } catch (error) {
      this.state = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError') ? 'denied' : 'unavailable';
      throw mapMicrophoneError(error);
    }
    this.state = 'granted';
    this.chunks = [];
    try {
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type)) ?? '';
      this.recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
      this.recorder.ondataavailable = event => { if (event.data.size > 0) this.chunks.push(event.data); };
      this.recorder.start(250);
    } catch (error) {
      this.release();
      this.state = 'unavailable';
      throw mapMicrophoneError(error);
    }
  }

  stop(): Promise<Blob> {
    if (this.stopPromise) return this.stopPromise;
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      this.release();
      return Promise.reject(new ReferenceRecordingError('decode_failed', 'No recording is active.'));
    }
    this.stopPromise = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        const value = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
        this.release();
        resolve(value);
      };
      recorder.onerror = () => {
        this.release();
        reject(new ReferenceRecordingError('decode_failed'));
      };
      try { recorder.stop(); } catch (error) { this.release(); reject(mapMicrophoneError(error)); }
    }).finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }

  cancel(): void {
    try { if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); } catch { /* cleanup is best effort */ }
    this.release();
  }

  private release(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    this.recorder = undefined;
    this.chunks = [];
  }
}

export async function finalizeReferenceRecording(recording: Blob): Promise<ReferenceTake> {
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const mixed = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const values = decoded.getChannelData(channel);
      for (let index = 0; index < values.length; index++) mixed[index] = (mixed[index] ?? 0) + (values[index] ?? 0) / decoded.numberOfChannels;
    }
    const resampled = offlineResample(mixed, decoded.sampleRate, CUSTOM_VOICE_SAMPLE_RATE);
    const signal = analyzeReferenceSignal(resampled, CUSTOM_VOICE_SAMPLE_RATE);
    const failure = validateReferenceSignal(signal);
    if (failure) throw new ReferenceRecordingError(failure);
    const pcm16 = floatToPcm16(resampled);
    const wavBytes = encodeWavPcm16(pcm16);
    const refSha256 = await sha256Hex(wavBytes);
    return { wav: new Blob([wavBytes], { type: 'audio/wav' }), wavBytes, pcm16, signal, refSha256, durationMs: signal.durationMs };
  } catch (error) {
    if (error instanceof ReferenceRecordingError) throw error;
    throw new ReferenceRecordingError('decode_failed');
  } finally {
    await context?.close().catch(() => undefined);
  }
}

export function referenceErrorCopy(error: unknown): string {
  return error instanceof ReferenceRecordingError ? error.message : CUSTOM_VOICE_ERROR_COPY.decode_failed;
}
