import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Mic2, Trash } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { ExportPopover } from '../components/ExportPopover';
import type { ExportOnProgress } from '../recording/splice';
import { SessionScreen } from '../session/SessionScreen';
import type { SessionViewState } from '../session/state';
import type { RecordingTrimTargetId } from '../recording/trim-state';
import { projectRecordingTrim, type RecordingSessionViewState } from '../recording/trim-state';
import { RecordingStore } from '../storage/recording-store';
import type { StableTurnWriter } from '../storage/stable-turn-writer';
import type { StoredSession } from '../storage/schema';
import { exportSessionRecording, sessionDurationSeconds, sessionViewStateFromTurns } from './session-archive';

export interface StoppedSessionProps {
  writer: StableTurnWriter;
  sessionId: string;
  agentName: string;
  darkMode: boolean;
  onToggleDarkMode: () => void;
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

  const buildExport = useCallback((onProgress?: ExportOnProgress) =>
    exportSessionRecording(props.sessionId, props.writer, onProgress), [props.sessionId, props.writer]);

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
    return <main className="mx-auto my-8 w-[min(56rem,calc(100%_-_2rem))]">
      <Card className="mx-auto max-w-md text-center">
        <CardHeader className="items-center">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Podcaster</p>
          <CardTitle><h1 className="m-0 text-base leading-snug font-medium">Session not found</h1></CardTitle>
          <CardDescription>This session may have been removed from this device.</CardDescription>
        </CardHeader>
        <CardFooter className="justify-center">
          <Button variant="outline" onClick={props.onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />All sessions</Button>
        </CardFooter>
      </Card>
    </main>;
  }

  if (!view || !recording) {
    return <main className="mx-auto my-8 flex w-[min(56rem,calc(100%_-_2rem))] items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading session…</main>;
  }

  const elapsed = sessionDurationSeconds(session);
  return <main className="mx-auto my-8 w-[min(56rem,calc(100%_-_2rem))]">
    <SessionScreen
      state={view}
      agentName={props.agentName}
      elapsedSeconds={elapsed}
      sessionPaused={false}
      onTogglePause={() => undefined}
      onStop={props.onBack}
      onCancelAssistant={() => undefined}
      onOpenSettings={() => undefined}
      darkMode={props.darkMode}
      onToggleDarkMode={props.onToggleDarkMode}
      settingsOpen={false}
      recording={recording}
      onToggleBubbleTrim={toggleTrim}
      readOnly
    />
    <Card className="mt-6" role="group" aria-label="Session actions">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{session.state === 'active' ? 'Interrupted' : 'Ended'}</Badge>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button className="min-h-11" onClick={props.onContinue}><Mic2 data-icon="inline-start" aria-hidden="true" />Continue session</Button>
            <ExportPopover sessionId={props.sessionId} buildExport={buildExport} disabled={recording.includedCount === 0} label="Export recording" variant="secondary" />
            <Button variant="outline" disabled={deleting || recording.totalCount === 0} onClick={() => void deleteRecording()}><Trash data-icon="inline-start" aria-hidden="true" />Delete recording</Button>
          </div>
        </div>
        {recordingError ? <Alert variant="destructive"><AlertDescription>{recordingError}</AlertDescription></Alert> : null}
        {notice ? <p className="text-sm text-muted-foreground" role="status">{notice}</p> : null}
      </CardContent>
    </Card>
  </main>;
}
