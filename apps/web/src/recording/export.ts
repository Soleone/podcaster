import type { RecordingStore } from '../storage/recording-store';

export function downloadRecording(blob: Blob, sessionId: string, at = new Date()): void {
  const prefix = sessionId.slice(0, 8);
  const date = at.toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `podcaster-${prefix}-${date}.mp3`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function deleteSessionRecording(sessionId: string, store: RecordingStore): Promise<void> {
  await store.deleteSession(sessionId);
}
