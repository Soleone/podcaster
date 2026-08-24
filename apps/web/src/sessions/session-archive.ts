import { createBrowserDecoder, buildRecording, type ExportOnProgress } from '../recording/splice';
import { createEncoderClient } from '../recording/encoder-client';
import { offlineResample } from '../recording/resample';
import { conversationFromStoredTurns } from '../session/conversation';
import { initialSessionState, type SessionViewState } from '../session/state';
import { RecordingStore } from '../storage/recording-store';
import type { StoredSession } from '../storage/schema';
import { sessionActiveDurationMs, type StableTurnWriter } from '../storage/stable-turn-writer';

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
  const body = (await response.json()) as { capability?: string };
  if (!body.capability) throw new Error('The host did not return a session capability.');
  return body.capability;
}

/** Every local session with per-session turn and recording counts, newest first. */
export async function loadSessionArchive(
  writer: StableTurnWriter,
  recordingStore: RecordingStore,
): Promise<SessionSummary[]> {
  const sessions = await writer.listSessions();
  const summaries = await Promise.all(
    sessions.map(async (session) => {
      const [turnCount, recordingItemCount, turns] = await Promise.all([
        writer.countTurns(session.sessionId),
        recordingStore.countSessionItems(session.sessionId),
        writer.getTurns(session.sessionId),
      ]);
      const preview = turns.find((turn) => turn.stableText?.trim())?.stableText ?? '';
      // Recording is always on, so every session reports as recorded.
      return { session, turnCount, recordingItemCount, recordingEnabled: true, preview };
    }),
  );
  return summaries;
}

/**
 * Builds the final recording for any stored session, without needing that
 * session to be live. Reports phase progress through {@link onProgress} and
 * returns the finished blob so the caller decides how to deliver it. Throws
 * when nothing can be exported.
 */
export async function exportSessionRecording(
  sessionId: string,
  writer: StableTurnWriter,
  onProgress?: ExportOnProgress,
): Promise<Blob> {
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
 * Rebuilds the conversation view from durable turns. Assistant responses keep
 * their stored playback disposition (completed, interrupted, paused) so the
 * transcript survives both read-only inspection and a later resume.
 */
export async function sessionViewStateFromTurns(
  writer: StableTurnWriter,
  sessionId: string,
  mode: 'draft' | 'stopped' | 'paused' | 'active' = 'stopped',
): Promise<SessionViewState> {
  const [turns, session] = await Promise.all([writer.getTurns(sessionId), writer.getSession(sessionId)]);
  const paused = mode === 'paused';
  const planning = session?.planning;
  return {
    ...initialSessionState,
    planning: planning
      ? {
          // A stale persisted running attempt is normalized to a terminal
          // interrupted failure; it is never resumed implicitly.
          status: planning.status === 'planning' ? 'failed' : planning.status,
          attempt: typeof planning.attempt === 'number' ? planning.attempt : 0,
          ...(planning.stage ? { stage: planning.stage } : {}),
          ...(typeof planning.deadlineMs === 'number' ? { deadlineMs: planning.deadlineMs } : {}),
          ...(planning.reasonCode ? { reasonCode: planning.reasonCode } : {}),
          ...(planning.status === 'planning' ? { reasonCode: 'interrupted' as const } : {}),
          ...(planning.topic ? { topic: planning.topic } : {}),
          ...(planning.depth ? { depth: planning.depth } : {}),
          ...(planning.detail ? { detail: planning.detail } : {}),
          ...(planning.notes ? { notes: planning.notes } : {}),
        }
      : initialSessionState.planning,
    dominant: mode === 'active' ? 'listening' : paused ? 'paused' : 'idle',
    announcement:
      mode === 'active'
        ? 'Listening'
        : paused
          ? 'Session paused'
          : mode === 'draft'
            ? 'Not started'
            : 'Session stopped',
    playbackNotice: paused ? 'Any assistant response in progress was stopped and will not resume automatically.' : '',
    stableTurns: turns
      .filter((turn) => turn.stableText !== null)
      .map((turn) => ({
        turnId: turn.turnId,
        text: turn.stableText!,
        ...(turn.posture ? { posture: turn.posture } : {}),
        ...(turn.policyReason ? { policyReason: turn.policyReason } : {}),
      })),
    conversationItems: conversationFromStoredTurns(turns),
  };
}

/** Foreground session duration in whole seconds. Paused time is excluded. */
export function sessionDurationSeconds(session: StoredSession): number {
  return Math.floor(sessionActiveDurationMs(session) / 1000);
}
