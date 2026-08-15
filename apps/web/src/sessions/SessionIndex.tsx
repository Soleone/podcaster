import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Clock, History, Mic2, Play, Radio } from 'lucide-react';
import { Link } from 'react-router';
import type { VoiceCatalog } from '@app/contracts/settings';
import { Badge } from '../components/ui/badge';
import { Button, buttonVariants } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { ExportPopover } from '../components/ExportPopover';
import type { ExportOnProgress } from '../recording/splice';
import { Readiness } from '../readiness/Readiness';
import { RecordingStore } from '../storage/recording-store';
import type { StableTurnWriter } from '../storage/stable-turn-writer';
import { SettingsButton } from '../settings/SettingsDialog';
import { exportSessionRecording, loadSessionArchive, sessionDurationSeconds, type SessionSummary } from './session-archive';
import './sessions.css';

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
  sessionAvailable: boolean;
  liveSessionId: string | undefined;
  elapsedSeconds: number;
  onStart: (capability: string, reasoningMode: 'full' | 'transcript_only') => void;
  onCatalog: (catalog: VoiceCatalog) => void;
  onOpenSettings: () => void;
  onCapability: (capability: string) => void;
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
  return <main className="index-shell">
    <header className="index-header">
      <div>
        <p className="eyebrow">Podcaster</p>
        <h1 className="index-title">Your sessions</h1>
      </div>
      <SettingsButton onClick={props.onOpenSettings} />
    </header>

    {props.liveSessionId ? <Card className="live-session-card" aria-label="Active session">
      <div className="live-session-icon"><Radio aria-hidden="true" /></div>
      <div className="live-session-body">
        <p className="eyebrow">Active session</p>
        <p className="live-session-id">Session {shortSessionId(props.liveSessionId)}</p>
        <p className="live-session-meta"><Clock aria-hidden="true" />Running for {formatDuration(props.elapsedSeconds)}</p>
      </div>
      <Link to={`/session/${props.liveSessionId}`} className={buttonVariants({ variant: 'primary', size: 'default' })}><Play aria-hidden="true" />Open session</Link>
    </Card> : null}

    <section aria-label="Start a new session" className="index-readiness">
      <Readiness sessionAvailable={props.sessionAvailable} onStart={props.onStart} onCatalog={props.onCatalog} onCapability={props.onCapability} />
    </section>

    <section className="session-list" aria-labelledby="session-list-title">
      <h2 id="session-list-title" className="session-list-title"><History aria-hidden="true" />Past sessions</h2>
      {rows.length === 0 ? <Card className="session-list-empty">
        {summaries === undefined ? <p className="hint"><Spinner className="size-4" />Loading sessions…</p> : <p className="hint">No sessions yet. Start one above and it will appear here.</p>}
      </Card> : null}
      {rows.length > 0 ? <ul className="session-list-rows">
        {rows.map(row => <SessionRow key={row.session.sessionId} row={row} live={row.session.sessionId === props.liveSessionId} buildExport={buildExport} onContinue={() => props.onContinueSession(row.session.sessionId)} />)}
      </ul> : null}
    </section>
  </main>;
}

function SessionRow(props: { row: SessionSummary; live: boolean; buildExport: (sessionId: string) => (onProgress?: ExportOnProgress) => Promise<Blob>; onContinue: () => void }) {
  const { session, preview, turnCount, recordingItemCount, recordingEnabled } = props.row;
  const stopped = session.state === 'stopped';
  const recordingLabel = !recordingEnabled ? 'Recording off' : recordingItemCount === 0 ? 'No recording' : `${recordingItemCount} message${recordingItemCount === 1 ? '' : 's'} recorded`;
  return <li className="session-row">
    <div className="session-row-main">
      <p className="session-row-title"><span className="session-row-id">{shortSessionId(session.sessionId)}</span>
        <Badge variant={props.live ? 'success' : stopped ? 'default' : 'primary'}>{props.live ? 'Active' : stopped ? 'Stopped' : 'Active'}</Badge>
      </p>
      {preview ? <p className="session-row-preview">{preview}</p> : null}
      <p className="session-row-meta">
        <span>Started {formatWhen(session.startedAt)}</span>
        <span className="session-row-dot" aria-hidden="true">·</span>
        <span>{formatDuration(sessionDurationSeconds(session))}</span>
        <span className="session-row-dot" aria-hidden="true">·</span>
        <span>{turnCount} turn{turnCount === 1 ? '' : 's'}</span>
        <span className="session-row-dot" aria-hidden="true">·</span>
        <span>{recordingLabel}</span>
      </p>
    </div>
    <div className="session-row-actions">
      {props.live ? <Link to={`/session/${session.sessionId}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><Play aria-hidden="true" />Open</Link>
        : stopped ? <>
          <Button variant="secondary" size="sm" onClick={props.onContinue}><Mic2 aria-hidden="true" />Continue</Button>
          <Link to={`/session/${session.sessionId}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}><ArrowRight aria-hidden="true" />Open</Link>
        </> : <Button variant="secondary" size="sm" onClick={props.onContinue}><Play aria-hidden="true" />Resume</Button>}
      <ExportPopover sessionId={session.sessionId} buildExport={props.buildExport(session.sessionId)} disabled={recordingItemCount === 0} variant="outline" size="sm" />
    </div>
  </li>;
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}