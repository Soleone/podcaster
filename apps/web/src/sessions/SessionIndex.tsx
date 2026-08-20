import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Clock, History, LoaderCircle, Mic2, Play, Plus, Radio } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '../components/ui/badge';
import { Button, buttonVariants } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../lib/utils';
import { ExportPopover } from '../components/ExportPopover';
import type { ExportOnProgress } from '../recording/splice';
import { RecordingStore } from '../storage/recording-store';
import type { StableTurnWriter } from '../storage/stable-turn-writer';
import { exportSessionRecording, loadSessionArchive, sessionDurationSeconds, type SessionSummary } from './session-archive';

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Today ${time}` : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export interface SessionIndexProps {
  writer: StableTurnWriter;
  liveSessionId: string | undefined;
  liveSessionPaused: boolean;
  elapsedSeconds: number;
  creatingDraft?: boolean;
  onCreateDraft: () => void | Promise<void>;
  onContinueSession: (sessionId: string) => void;
}

export function SessionIndex(props: SessionIndexProps) {
  const [summaries, setSummaries] = useState<SessionSummary[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = await RecordingStore.open();
      try {
        const archive = await loadSessionArchive(props.writer, store);
        if (!cancelled) setSummaries(archive);
      } catch {
        if (!cancelled) setSummaries([]);
      } finally {
        store.close();
      }
    })();
    return () => { cancelled = true; };
  }, [props.writer, props.liveSessionId]);

  const buildExport = useCallback((sessionId: string) => (onProgress?: ExportOnProgress) =>
    exportSessionRecording(sessionId, props.writer, onProgress), [props.writer]);

  const rows = summaries ?? [];
  return <main className="mx-auto mt-5 mb-8 w-[min(56rem,calc(100%_-_2rem))]">
    <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold leading-tight tracking-tight">Your sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">Start with a draft. Services only matter when you go live.</p>
      </div>
      <Button className="min-h-11" onClick={() => void props.onCreateDraft()} disabled={props.creatingDraft}>{props.creatingDraft ? <><LoaderCircle className="animate-spin" aria-hidden="true" />Creating…</> : <><Plus aria-hidden="true" />New session</>}</Button>
    </header>

    {props.liveSessionId ? <Card aria-label={props.liveSessionPaused ? 'Paused session' : 'Active session'} className="mb-8">
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Radio className="size-5" aria-hidden="true" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{props.liveSessionPaused ? 'Paused session' : 'Active session'}</p>
          <p className="mt-1 font-medium tabular-nums">Session {shortSessionId(props.liveSessionId)}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground"><Clock className="size-3.5 shrink-0" aria-hidden="true" />{props.liveSessionPaused ? 'Active time' : 'Running for'} {formatDuration(props.elapsedSeconds)}</p>
        </div>
        <Link to={`/session/${props.liveSessionId}`} className={cn(buttonVariants({ variant: 'default', size: 'default' }), 'w-full sm:w-auto')}><Play data-icon="inline-start" aria-hidden="true" />Open session</Link>
      </CardContent>
    </Card> : null}

    <section aria-labelledby="session-list-title">
      <h2 id="session-list-title" className="mb-3 flex items-center gap-2 text-base font-medium leading-snug"><History className="size-4 text-muted-foreground" aria-hidden="true" />Past sessions</h2>
      {rows.length === 0 ? <Card>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          {summaries === undefined ? <><Spinner />Loading sessions…</> : 'No sessions yet. Create one above and it will appear here.'}
        </CardContent>
      </Card> : null}
      {rows.length > 0 ? <ul className="flex list-none flex-col gap-3 p-0">
        {rows.map(row => <SessionRow key={row.session.sessionId} row={row} live={row.session.sessionId === props.liveSessionId} buildExport={buildExport} onContinue={() => props.onContinueSession(row.session.sessionId)} />)}
      </ul> : null}
    </section>
  </main>;
}

function SessionRow(props: { row: SessionSummary; live: boolean; buildExport: (sessionId: string) => (onProgress?: ExportOnProgress) => Promise<Blob>; onContinue: () => void }) {
  const { session, preview, turnCount, recordingItemCount, recordingEnabled } = props.row;
  const draft = session.state === 'draft';
  const stopped = session.state === 'stopped';
  const paused = session.state === 'paused';
  const recordingLabel = !recordingEnabled ? 'Recording off' : recordingItemCount === 0 ? 'No recording' : `${recordingItemCount} message${recordingItemCount === 1 ? '' : 's'} recorded`;
  return <li>
    <Card size="sm">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="font-medium tabular-nums">{shortSessionId(session.sessionId)}</span>
            <Badge variant={props.live || (!stopped && !paused && !draft) ? 'default' : 'secondary'}>{props.live ? (paused ? 'Paused' : 'Active') : draft ? 'Not started' : stopped ? 'Ended' : paused ? 'Paused' : 'Active'}</Badge>
          </p>
          {preview ? <p className="mt-1 truncate text-sm">{preview}</p> : null}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{draft ? 'Created' : 'Started'} {formatWhen(session.startedAt)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDuration(sessionDurationSeconds(session))}</span>
            <span aria-hidden="true">·</span>
            <span>{turnCount} turn{turnCount === 1 ? '' : 's'}</span>
            <span aria-hidden="true">·</span>
            <span>{recordingLabel}</span>
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          {props.live ? <Link to={`/session/${session.sessionId}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><Play data-icon="inline-start" aria-hidden="true" />Open</Link>
            : draft ? <Link to={`/session/${session.sessionId}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><ArrowRight data-icon="inline-start" aria-hidden="true" />Open draft</Link>
            : stopped ? <>
              <Button variant="secondary" size="sm" onClick={props.onContinue}><Mic2 data-icon="inline-start" aria-hidden="true" />Continue</Button>
              <Link to={`/session/${session.sessionId}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}><ArrowRight data-icon="inline-start" aria-hidden="true" />Open</Link>
            </> : <Button variant="secondary" size="sm" onClick={props.onContinue}><Play data-icon="inline-start" aria-hidden="true" />Resume</Button>}
          <ExportPopover sessionId={session.sessionId} buildExport={props.buildExport(session.sessionId)} disabled={recordingItemCount === 0} variant="outline" size="sm" />
        </div>
      </CardContent>
    </Card>
  </li>;
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
