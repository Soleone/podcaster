import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Mic2, Trash } from 'lucide-react';
import { Alert } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { SessionScreen } from '../session/SessionScreen';
import type { SessionViewState } from '../session/state';
import type { RecordingTrimTargetId } from '../recording/trim-state';
import { projectRecordingTrim, type RecordingSessionViewState } from '../recording/trim-state';
import { RecordingStore, type RecordingItemSummary } from '../storage/recording-store';
import type { StableTurnWriter } from '../storage/stable-turn-writer';
import type { StoredSession } from '../storage/schema';
import { exportSessionRecording, sessionDurationSeconds, sessionViewStateFromTurns } from './session-archive';
import './sessions.css';

export interface StoppedSessionProps {
  writer: StableTurnWriter;
  sessionId: string;
  agentName: string;
  onContinue: () => void;
  onBack: () => void;
}

/**
 * Read-only view of a session that is not currently running. The conversation
 * is rebuilt from stable storage; trim adjustments and recording export still
 * operate on the persisted recording so a session can be re-exported after it
 * ended.
 */
export function StoppedSession(props: StoppedSessionProps) {
  const [session, setSession] = useState<StoredSession | undefined>();
  const [view, setView] = useState<SessionViewState | undefined>();
  const [recording, setRecording] = useState<RecordingSessionViewState | undefined>(undefined);
  const [recordingError, setRecordingError] = useState<string | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const storeRef = useRef<RecordingStore | undefined>(undefined);
  const mounted = useRef(true);

  const loadRecording = useCallback(async (): Promise<void> => {
    const store = storeRef.current;
    if (!store) return;
    try {
      const [enabled, summaries] = await Promise.all([store.getRecordingEnabled(), store.getSessionItemSummaries(props.sessionId)]);
      if (mounted.current) setRecording(projectRecordingTrim(summaries, enabled));
    } catch {
      if (mounted.current) setRecordingError('Recording state could not be read.');
    }
  }, [props.sessionId]);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    void (async () => {
      const store = await RecordingStore.open();
      if (cancelled) { store.close(); return; }
      storeRef.current = store;
      const session = await props.writer.getSession(props.sessionId);
      if (cancelled) { store.close(); return; }
      if (!session) { if (!cancelled) setSession(undefined); return; }
      setSession(session);
      const viewState = await sessionViewStateFromTurns(props.writer, props.sessionId);
      if (!cancelled) setView(viewState);
      await loadRecording();
    })();
    return () => { cancelled = true; mounted.current = false; void storeRef.current?.close(); storeRef.current = undefined; };
  }, [props.sessionId, props.writer, loadRecording]);

  const toggleTrim = useCallback(async (targetId: RecordingTrimTargetId, trimmed: boolean): Promise<boolean> => {
    const store = storeRef.current;
    const current = recording;
    if (!store || !current) return false;
    const target = current.targets.get(targetId) ?? current.partTargets.get(targetId);
    if (!target) return false;
    try {
      await store.setItemsTrimmed(props.sessionId, target.itemIds, trimmed);
    } catch {
      setRecordingError('The message could not be updated. Try again.');
      return false;
    }
    setRecordingError(undefined);
    await loadRecording();
    return true;
  }, [props.sessionId, recording, loadRecording]);

  const exportRecording = useCallback(async () => {
    setExporting(true);
    setNotice(undefined);
    try {
      await exportSessionRecording(props.sessionId, props.writer);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The recording could not be exported.');
    } finally {
      setExporting(false);
    }
  }, [props.sessionId, props.writer]);

  const deleteRecording = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    setDeleting(true);
    try {
      await store.deleteSession(props.sessionId);
      setNotice('Recording deleted.');
    } finally {
      setDeleting(false);
      await loadRecording();
    }
  }, [props.sessionId, loadRecording]);

  if (!session) {
    return <main className="index-shell">
      <Card className="stopped-missing">
        <p className="eyebrow">Podcaster</p>
        <h1 className="stopped-missing-title">Session not found</h1>
        <p className="hint">This session may have been removed from this device.</p>
        <Button variant="outline" onClick={props.onBack}><ArrowLeft aria-hidden="true" />All sessions</Button>
      </Card>
    </main>;
  }

  if (!view || !recording) {
    return <main className="index-shell"><p className="hint"><Spinner className="size-4" />Loading session…</p></main>;
  }

  const elapsed = sessionDurationSeconds(session);
  return <main className="index-shell">
    <SessionScreen
      state={view}
      agentName={props.agentName}
      elapsedSeconds={elapsed}
      sessionPaused={false}
      onTogglePause={() => undefined}
      onStop={props.onBack}
      onCancelAssistant={() => undefined}
      onOpenSettings={() => undefined}
      settingsOpen={false}
      recording={recording}
      onToggleBubbleTrim={toggleTrim}
      readOnly
    />
    <Card className="stopped-actions" role="group" aria-label="Session actions">
      <div className="stopped-actions-status">
        <Badge variant="default">{session.state === 'active' ? 'Interrupted' : 'Ended'}</Badge>
        <span className="hint">{recording.totalCount === 0 ? 'No recording in this session.' : `${recording.includedCount} of ${recording.totalCount} recorded messages included in the export.`}</span>
      </div>
      <div className="button-row">
        <Button onClick={props.onContinue}><Mic2 aria-hidden="true" />Continue session</Button>
        <Button variant="secondary" disabled={exporting || recording.includedCount === 0} onClick={() => void exportRecording()}>{exporting ? <><Spinner className="size-4" />Exporting…</> : <><Download aria-hidden="true" />Export recording</>}</Button>
        <Button variant="outline" disabled={deleting || recording.totalCount === 0} onClick={() => void deleteRecording()}><Trash aria-hidden="true" />Delete recording</Button>
      </div>
      {recordingError ? <Alert variant="destructive">{recordingError}</Alert> : null}
      {notice ? <p className="hint" role="status">{notice}</p> : null}
    </Card>
  </main>;
}
