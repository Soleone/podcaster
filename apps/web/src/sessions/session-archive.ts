import { createBrowserDecoder, buildRecording, type ExportOnProgress } from '../recording/splice';
import { createEncoderClient } from '../recording/encoder-client';
import { offlineResample } from '../recording/resample';
import { conversationFromStoredTurns } from '../session/conversation';
import { initialSessionState, type SessionViewState } from '../session/state';
import { RecordingStore } from '../storage/recording-store';
import type { StoredSession } from '../storage/schema';
import type { StableTurnWriter } from '../storage/stable-turn-writer';

/** One row of the index listing: session facts plus cheap per-session counts. */
export interface SessionSummary {
  session: StoredSession;
  turnCount: number;
  recordingItemCount: number;
  recordingEnabled: boolean;
  /** First stable user turn, used as the identifying preview line. */
  preview: string;
}

/** Bootstraps a fresh capability token from the host, like the readiness flow. */
export async function bootstrapCapability(): Promise<string> {
  const response = await fetch('/api/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disclosureAcknowledged: true }),
  });
  if (!response.ok) throw new Error('The secure session connection could not be established.');
  const body = await response.json() as { capability?: string };
  if (!body.capability) throw new Error('The host did not return a session capability.');
  return body.capability;
}

/** Every local session with per-session turn and recording counts, newest first. */
export async function loadSessionArchive(writer: StableTurnWriter, recordingStore: RecordingStore): Promise<SessionSummary[]> {
  const [sessions, enabled] = await Promise.all([writer.listSessions(), recordingStore.getRecordingEnabled()]);
  const summaries = await Promise.all(sessions.map(async session => {
    const [turnCount, recordingItemCount, turns] = await Promise.all([writer.countTurns(session.sessionId), recordingStore.countSessionItems(session.sessionId), writer.getTurns(session.sessionId)]);
    const preview = turns.find(turn => turn.stableText?.trim())?.stableText ?? '';
    return { session, turnCount, recordingItemCount, recordingEnabled: enabled, preview };
  }));
  return summaries;
}

/**
 * Builds the final recording for any stored session, without needing that
 * session to be live. Reports phase progress through {@link onProgress} and
 * returns the finished blob so the caller decides how to deliver it. Throws
 * when nothing can be exported.
 */
export async function exportSessionRecording(sessionId: string, writer: StableTurnWriter, onProgress?: ExportOnProgress): Promise<Blob> {
  const store = await RecordingStore.open();
  try {
    const blob = await buildRecording(sessionId, {
      store,
      turns: writer,
      decode: createBrowserDecoder(),
      resample: offlineResample,
      encode: createEncoderClient(),
      ...(onProgress ? { onProgress } : {}),
    });
    if (!blob) throw new Error('This session has no recorded messages to export.');
    return blob;
  } finally {
    store.close();
  }
}

/**
 * Rebuilds the conversation view for a session that is not currently running.
 * Assistant responses keep their stored playback disposition (completed,
 * interrupted, paused) so the transcript reads like it ended.
 */
export async function sessionViewStateFromTurns(writer: StableTurnWriter, sessionId: string): Promise<SessionViewState> {
  const turns = await writer.getTurns(sessionId);
  return {
    ...initialSessionState,
    dominant: 'idle',
    announcement: 'Session stopped',
    stableTurns: turns.filter(turn => turn.stableText !== null).map(turn => ({ turnId: turn.turnId, text: turn.stableText!, ...(turn.posture ? { posture: turn.posture } : {}), ...(turn.policyReason ? { policyReason: turn.policyReason } : {}) })),
    conversationItems: conversationFromStoredTurns(turns),
  };
}

/** Duration in whole seconds between the session start and its recorded end (or now). */
export function sessionDurationSeconds(session: StoredSession): number {
  const start = new Date(session.startedAt).getTime();
  const end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  return Math.max(0, Math.floor((end - start) / 1000));
}
