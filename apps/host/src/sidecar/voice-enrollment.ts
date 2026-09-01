import WebSocket, { type RawData } from 'ws';
import type { SidecarProcess } from './process.js';

const MAX_MESSAGE = 64 * 1024;
const CHUNK_BYTES = 60 * 1024;
// Enrolling a custom voice can cold-load the Qwen Base cloning model on CUDA
// (model + graph warmup + prompt extraction), which comfortably exceeds the
// conversational TTS target. Keep the host-side wait generous so a slow first
// enrollment is not cut off after the browser already committed the reference.
export const VOICE_ENROLLMENT_TIMEOUT_MS = 180_000;

export interface VoiceEnrollmentSidecarInput {
  voiceId: string;
  name: string;
  refSha256: string;
  sampleRate: number;
  durationMs: number;
  wav: Uint8Array;
}

function bytesOf(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) {
    const value = Buffer.concat(raw);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(raw);
}

function openVoiceSocket(sidecar: SidecarProcess, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${sidecar.origin.replace(/^http/, 'ws')}/stream`, {
      headers: { authorization: `Bearer ${sidecar.secret}` },
      origin: undefined,
      maxPayload: MAX_MESSAGE,
      perMessageDeflate: false,
    });
    let settled = false;
    const abort = () => {
      socket.close();
      if (!settled) {
        settled = true;
        reject(signal?.reason ?? new Error('voice enrollment cancelled'));
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('open', () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(socket);
    });
    socket.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function sendAndWait(
  sidecar: SidecarProcess,
  input: VoiceEnrollmentSidecarInput | { voiceId: string },
  remove: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const socket = await openVoiceSocket(sidecar, signal);
  const voiceId = input.voiceId;
  const timeout = setTimeout(() => socket.close(), VOICE_ENROLLMENT_TIMEOUT_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error('voice enrollment cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.on('message', (raw) => {
        if (
          done ||
          (Buffer.isBuffer(raw) === false && Array.isArray(raw) === false && raw instanceof ArrayBuffer === false)
        )
          return;
        let value: { type?: string; payload?: { voiceId?: string; code?: string; message?: string } };
        try {
          value = JSON.parse(Buffer.from(bytesOf(raw)).toString('utf8'));
        } catch {
          return;
        }
        if (value.type === 'voice.enrolled' && value.payload?.voiceId === voiceId) finish();
        else if (value.type === 'voice.removed' && value.payload?.voiceId === voiceId) finish();
        else if (value.type === 'voice.error' && value.payload?.voiceId === voiceId)
          finish(
            new Error(`${value.payload.code ?? 'voice_error'}: ${value.payload.message ?? 'voice operation failed'}`),
          );
      });
      socket.once('close', () => {
        signal?.removeEventListener('abort', onAbort);
        if (!done) finish(new Error('audio sidecar closed before voice operation completed'));
      });
      if (remove) {
        socket.send(JSON.stringify({ type: 'voice.remove', payload: { voiceId } }));
        return;
      }
      // SAFETY: only the two exported entry points call sendAndWait, and the
      // enrollment path always passes a full VoiceEnrollmentSidecarInput.
      const enrollment = input as VoiceEnrollmentSidecarInput;
      socket.send(
        JSON.stringify({
          type: 'voice.enroll',
          payload: {
            enrollment: {
              voiceId: enrollment.voiceId,
              name: enrollment.name,
              refSha256: enrollment.refSha256,
              sampleRate: enrollment.sampleRate,
              durationMs: enrollment.durationMs,
              byteLength: enrollment.wav.byteLength,
            },
          },
        }),
      );
      for (let offset = 0; offset < enrollment.wav.byteLength; offset += CHUNK_BYTES) {
        socket.send(enrollment.wav.subarray(offset, Math.min(offset + CHUNK_BYTES, enrollment.wav.byteLength)));
      }
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

export function enrollCustomVoiceInSidecar(
  sidecar: SidecarProcess,
  input: VoiceEnrollmentSidecarInput,
  signal?: AbortSignal,
): Promise<void> {
  return sendAndWait(sidecar, input, false, signal);
}

export function removeCustomVoiceFromSidecar(
  sidecar: SidecarProcess,
  voiceId: string,
  signal?: AbortSignal,
): Promise<void> {
  return sendAndWait(sidecar, { voiceId }, true, signal);
}
