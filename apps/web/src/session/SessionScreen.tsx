import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Brain, Captions, ChevronDown, CircleAlert, CircleStop, Copy, Download, Ear, MessageCircleQuestion, Pause, Play, Trash, Volume2, type LucideIcon } from 'lucide-react';
import { ConversationRow, conversationItemStartsTurn } from '../components/conversation/conversation-item';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Bubble, BubbleContent } from '../components/ui/bubble';
import { Button } from '../components/ui/button';
import { ButtonGroup, ButtonGroupSeparator } from '../components/ui/button-group';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { Marker, MarkerContent, MarkerIcon } from '../components/ui/marker';
import { Message, MessageContent, MessageHeader } from '../components/ui/message';
import { cn } from '../lib/utils';
import { Spinner } from '../components/ui/spinner';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '../components/ui/message-scroller';
import { activityLog, type ActivityEntry } from './activity-log';
import type { RecordingSessionViewState, RecordingTrimTargetId } from '../recording/trim-state';
import type { SessionViewState } from './state';
import { SettingsButton } from '../settings/SettingsDialog';
import './session.css';

const headings: Record<SessionViewState['dominant'], string> = {
  idle: 'Session stopped', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering what you meant…', intentional_silence: 'Giving you space', reasoning: 'Forming a response…', speaking: 'Speaking', stopping: 'Stopping response…', degraded: 'Session needs attention',
};
const stateIcons: Record<SessionViewState['dominant'], LucideIcon | undefined> = {
  idle: CircleStop, listening: Ear, transcribing: Captions, deciding: MessageCircleQuestion, intentional_silence: Pause, reasoning: Brain, speaking: Volume2, stopping: undefined, degraded: CircleAlert,
};

type SessionScreenProps = { state: SessionViewState; agentName: string; elapsedSeconds: number; sessionPaused: boolean; onTogglePause: () => void; onStop: () => void; onCancelAssistant: () => void; onOpenSettings: () => void; settingsOpen: boolean; recording: RecordingSessionViewState; onToggleBubbleTrim: (targetId: RecordingTrimTargetId, trimmed: boolean) => Promise<boolean>; readOnly?: boolean; onExportRecording?: () => Promise<void>; onDeleteRecording?: () => Promise<void>; exporting?: boolean; deleting?: boolean };

export function SessionScreen(props: SessionScreenProps) {
  const [trimAnnouncement, setTrimAnnouncement] = useState('');
  const handleTrim = useCallback(async (targetId: RecordingTrimTargetId, trimmed: boolean): Promise<boolean> => {
    const ok = await props.onToggleBubbleTrim(targetId, trimmed);
    setTrimAnnouncement(ok
      ? (trimmed ? 'Removed from recording.' : 'Restored to recording.')
      : 'That message could not be updated. Try again.');
    return ok;
  }, [props.onToggleBubbleTrim]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // An open settings dialog consumes Escape; it must not also cancel assistant speech.
      if (props.settingsOpen) return;
      if (event.key === 'Escape' && (props.state.dominant === 'reasoning' || props.state.dominant === 'speaking')) { event.preventDefault(); props.onCancelAssistant(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [props.onCancelAssistant, props.state.dominant, props.settingsOpen]);

  const assistantActive = props.state.dominant === 'reasoning' || props.state.dominant === 'speaking';
  const readOnly = props.readOnly === true;
  const agentName = props.agentName.trim() || 'Assistant';
  const canExport = !readOnly && props.recording.includedCount > 0 && !props.exporting && !props.deleting;
  const canDelete = !readOnly && props.recording.totalCount > 0 && !props.deleting && !props.exporting;
  // Keep the dimmed tentative row as the visible progress signal after a preview arrives.
  const hasAssistantText = props.state.conversationItems.some(item => item.kind === 'assistant' && item.text.trim() !== '');
  const showAssistantActivity = props.state.dominant === 'speaking' || (props.state.dominant === 'reasoning' && !hasAssistantText);
  const StateIcon = stateIcons[props.state.dominant];
  return <main className="mx-auto my-8 w-[min(56rem,calc(100%_-_2rem))]">
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{readOnly ? 'Ended session' : 'Active voice session'}</p>
      <div className="flex flex-wrap items-center gap-2">
        {readOnly ? <Button variant="outline" size="sm" onClick={props.onStop}><ArrowLeft data-icon="inline-start" aria-hidden="true" />All sessions</Button> : <>
          <ButtonGroup aria-label="Session controls" className="session-controls">
            <Button variant="outline" size="icon" aria-label={props.sessionPaused ? 'Resume session' : 'Pause session'} title={props.sessionPaused ? 'Resume session' : 'Pause session'} onClick={props.onTogglePause}>{props.sessionPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</Button>
            <Button variant="destructive" size="icon" aria-label="Stop session" title="Stop session" onClick={props.onStop}><CircleStop aria-hidden="true" /></Button>
            <ButtonGroupSeparator />
            <Button variant="secondary" size="sm" disabled={!canExport} title="Export recording" aria-label={props.exporting ? 'Exporting…' : 'Export recording'} onClick={() => void props.onExportRecording?.()}>
              {props.exporting ? <><Spinner aria-hidden="true" />Exporting…</> : <><Download data-icon="inline-start" aria-hidden="true" />Export</>}
            </Button>
            <Button variant="outline" size="sm" disabled={!canDelete} title="Delete recording" aria-label="Delete recording" onClick={() => void props.onDeleteRecording?.()}><Trash data-icon="inline-start" aria-hidden="true" /></Button>
          </ButtonGroup>
          <SettingsButton onClick={props.onOpenSettings} title="Settings · applies next session" />
        </>}
      </div>
    </header>
    <Card size="sm" data-state={props.state.dominant} className="mt-4 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <CardContent className="flex min-w-0 flex-1 items-center gap-2">
        {StateIcon ? <StateIcon className={cn('size-5 shrink-0', props.state.dominant === 'degraded' ? 'text-destructive' : 'text-primary')} aria-hidden="true" /> : <Spinner className="size-5 shrink-0 text-muted-foreground" />}
        <h1 id="session-status-heading" className="min-w-0 text-sm font-medium leading-snug">{headings[props.state.dominant]}</h1>
      </CardContent>
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="font-mono tabular-nums" aria-label={`Session elapsed ${props.elapsedSeconds} seconds`}>{formatElapsed(props.elapsedSeconds)}</Badge>
        {assistantActive && !readOnly ? <Button variant="secondary" size="sm" onClick={props.onCancelAssistant}>Stop speaking</Button> : null}
      </div>
    </Card>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{props.state.announcement}</p>
    {trimAnnouncement ? <p className="sr-only" role="status" aria-live="polite">{trimAnnouncement}</p> : null}
    {props.state.degradedMessage ? <Alert variant="destructive" className="mt-4"><CircleAlert aria-hidden="true" /><AlertDescription>{props.state.degradedMessage}</AlertDescription></Alert> : null}
    <section aria-labelledby="conversation-title" className="conversation mt-6 flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground ring-1 ring-foreground/10">
      <h2 id="conversation-title" className="border-b px-5 py-4 text-sm font-medium leading-snug">Conversation</h2>
      <div className="conversation-scroll">
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={48}>
          <MessageScroller>
            <MessageScrollerViewport aria-label="Conversation transcript">
              <MessageScrollerContent className="conversation-list p-3 pb-4" aria-busy={props.state.dominant === 'reasoning'}>
                {props.state.conversationItems.length === 0 && !props.state.tentativeText ? <MessageScrollerItem messageId="conversation-empty"><p className="text-sm text-muted-foreground">Your conversation will appear here.</p></MessageScrollerItem> : null}
                {props.state.conversationItems.filter(item => !(item.kind === 'assistant' && !item.text)).map(item => <MessageScrollerItem key={item.id} messageId={item.id} scrollAnchor={conversationItemStartsTurn(item)}><ConversationRow item={item} agentName={agentName} recording={props.recording} onToggleBubbleTrim={handleTrim} /></MessageScrollerItem>)}
                {showAssistantActivity ? <MessageScrollerItem messageId="assistant-activity"><Marker role="status" className="assistant-activity my-1"><MarkerIcon><Spinner /></MarkerIcon><MarkerContent><span className="font-medium">{agentName}</span> {props.state.dominant === 'speaking' ? 'is speaking…' : 'is thinking…'}</MarkerContent></Marker></MessageScrollerItem> : null}
                {props.state.tentativeText ? <MessageScrollerItem messageId="tentative-transcript"><Message align="end" className="conversation-message user-row"><MessageContent><MessageHeader>You · tentative</MessageHeader><Bubble variant="tinted" className="conversation-bubble-shell max-w-[min(78%,38rem)] max-[36rem]:max-w-[90%]"><BubbleContent className="conversation-bubble tentative border-dashed opacity-75"><p>{props.state.tentativeText}</p></BubbleContent></Bubble></MessageContent></Message></MessageScrollerItem> : null}
                {props.state.playbackNotice ? <MessageScrollerItem messageId="playback-notice"><Marker variant="separator" className="continuation-marker my-1"><MarkerContent>{props.state.playbackNotice}</MarkerContent></Marker></MessageScrollerItem> : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </section>
    <ActivityLogPanel />
  </main>;
}

function ActivityLogPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<readonly ActivityEntry[]>(() => activityLog.entries());
  const [notice, setNotice] = useState('');
  useEffect(() => activityLog.subscribe(setEntries), []);
  const copyLog = () => {
    try {
      void navigator.clipboard.writeText(activityLog.toText()).then(
        () => setNotice('Copied to clipboard'),
        () => setNotice('Copy failed'),
      );
    } catch { setNotice('Copy failed'); }
  };
  return <Card size="sm" className="activity-log mt-6">
    <CardHeader className="activity-log-header flex flex-row flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" size="sm" className="activity-log-toggle" aria-expanded={open} aria-controls="activity-log-region" onClick={() => setOpen(value => !value)}>
        <ChevronDown data-icon="inline-start" className={cn('transition-transform', open && 'rotate-180')} aria-hidden="true" />
        Activity log
        {entries.length > 0 ? <Badge variant="secondary" className="activity-log-count font-mono tabular-nums">{entries.length}</Badge> : null}
      </Button>
      {open ? <div className="activity-log-actions flex items-center gap-2">
        {notice ? <span className="activity-log-notice text-xs text-muted-foreground" role="status">{notice}</span> : null}
        <ButtonGroup aria-label="Activity log actions">
          <Button variant="outline" size="icon" title="Copy" aria-label="Copy entries" onClick={copyLog}><Copy aria-hidden="true" /></Button>
          <ButtonGroupSeparator />
          <Button variant="outline" size="icon" title="Clear" aria-label="Clear entries" onClick={() => { activityLog.clear(); setNotice(''); }}><Trash aria-hidden="true" /></Button>
        </ButtonGroup>
      </div> : null}
    </CardHeader>
    {open ? <CardContent id="activity-log-region" role="region" aria-label="Activity log entries" className="activity-log-region border-t p-2">
      {entries.length === 0 ? <p className="text-sm text-muted-foreground">No activity logged yet.</p> : <ul className="activity-log-list m-0 flex max-h-64 list-none flex-col overflow-y-auto p-0">
        {[...entries].reverse().map((entry, index) => <li key={`${entry.ts}-${index}`} className="activity-log-entry grid items-baseline gap-x-2 rounded-md px-2 py-1 text-xs leading-snug [overflow-wrap:anywhere] hover:bg-muted/50">
          <time className="log-entry-time font-mono text-[0.7rem] tabular-nums text-muted-foreground" dateTime={new Date(entry.ts).toISOString()}>{formatLogTime(entry.ts)}</time>
          <Badge className="log-level justify-self-start" variant={entry.level === 'error' ? 'destructive' : entry.level === 'warn' ? 'outline' : 'secondary'}>{entry.level}</Badge>
          <span className="log-entry-source truncate text-muted-foreground">{entry.source}</span>
          <span className="log-entry-message min-w-0">{entry.message}{entry.detail ? ` — ${entry.detail}` : ''}</span>
        </li>)}
      </ul>}
    </CardContent> : null}
  </Card>;
}
function formatElapsed(seconds: number): string { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, '0')}`; }
function formatLogTime(ts: number): string { const date = new Date(ts); return [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':'); }
