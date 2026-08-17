import { MAX_CUSTOM_VOICE_ENROLLMENT_BODY, type CustomVoiceEnrollment } from '@app/contracts/settings';
import { uint8ToBase64 } from './wav';
import type { ReferenceTake } from './recorder';
import type { CustomVoiceRecord } from '../storage/custom-voice-store';

export async function enrollCustomVoice(input: { capability: string; voiceId: string; name: string; take: ReferenceTake }): Promise<void> {
  const wavBase64 = uint8ToBase64(input.take.wavBytes);
  if (wavBase64.length > MAX_CUSTOM_VOICE_ENROLLMENT_BODY) throw new Error('The reference is too large to send to the local audio engine.');
  const body: CustomVoiceEnrollment = {
    voiceId: input.voiceId,
    name: input.name,
    refSha256: input.take.refSha256,
    sampleRate: input.take.signal.sampleRate,
    durationMs: input.take.durationMs,
    byteLength: input.take.wavBytes.byteLength,
    wavBase64,
  };
  const response = await fetch('/api/voices/custom', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-podcaster-capability': input.capability },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { detail?: string; error?: string } | undefined;
    throw new Error(detail?.detail ?? detail?.error ?? 'The voice could not be enrolled by the local audio engine.');
  }
}

export async function enrollStoredCustomVoice(input: { capability: string; voice: CustomVoiceRecord }): Promise<void> {
  const wavBytes = new Uint8Array(await input.voice.wav.arrayBuffer());
  const wavBase64 = uint8ToBase64(wavBytes);
  const body: CustomVoiceEnrollment = {
    voiceId: input.voice.voiceId,
    name: input.voice.name,
    refSha256: input.voice.refSha256,
    sampleRate: input.voice.sampleRate,
    durationMs: input.voice.durationMs,
    byteLength: wavBytes.byteLength,
    wavBase64,
  };
  const response = await fetch('/api/voices/custom', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-podcaster-capability': input.capability },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('The stored voice could not be restored in the local audio engine.');
}

export async function deleteCustomVoice(capability: string, voiceId: string): Promise<void> {
  const response = await fetch(`/api/voices/custom/${encodeURIComponent(voiceId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'x-podcaster-capability': capability },
  });
  if (!response.ok) throw new Error('The custom voice could not be deleted from the local audio engine.');
}
