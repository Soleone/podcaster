import { useCallback, useEffect, useState } from 'react';
import { Brain, Captions, ChevronDown, CircleAlert, CircleStop, Copy, Ear, MessageCircleQuestion, Pause, Trash, Volume2, type LucideIcon } from 'lucide-react';
import { ConversationRow, conversationItemStartsTurn } from '../components/conversation/conversation-item';
import { Alert } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Bubble, BubbleContent } from '../components/ui/bubble';
import { Button } from '../components/ui/button';
import { ButtonGroup, ButtonGroupSeparator } from '../components/ui/button-group';
import { Card } from '../components/ui/card';
import { Marker, MarkerContent } from '../components/ui/marker';
import { Message, MessageContent, MessageHeader } from '../components/ui/message';
import { cn } from '../lib/utils';
import { Spinner } from '../components/ui/spinner';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '../components/ui/message-scroller';
import { activityLog, type ActivityEntry } from './activity-log';
import type { RecordingSessionViewState, RecordingTrimTargetId } from '../recording/trim-state';
import type { SessionViewState } from './state';
import './session.css';

const headings: Record<SessionViewState['dominant'], string> = {
  idle: 'Session stopped', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering what you meant…', intentional_silence: 'Giving you space', reasoning: 'Forming a response…', speaking: 'Speaking', stopping: 'Stopping response…', degraded: 'Session needs attention',
};
const stateIcons: Record<SessionViewState['dominant'], LucideIcon | undefined> = {
  idle: CircleStop, listening: Ear, transcribing: Captions, deciding: MessageCircleQuestion, intentional_silence: Pause, reasoning: Brain, speaking: Volume2, stopping: undefined, degraded: CircleAlert,
};

export function SessionScreen(props: { state: SessionViewState; elapsedSeconds: number; onStop: () => void; onCancelAssistant: () => void; recording: RecordingSessionViewState; onToggleBubbleTrim: (targetId: RecordingTrimTargetId, trimmed: boolean) => Promise<boolean> }) {
  const [trimAnnouncement, setTrimAnnouncement] = useState('');
  const handleTrim = useCallback(async (targetId: RecordingTrimTargetId, trimmed: boolean): Promise<boolean> => {
    const ok = await props.onToggleBubbleTrim(targetId, trimmed);
    setTrimAnnouncement(ok
      ? (trimmed ? 'Removed from recording.' : 'Restored to recording.')
      : 'That bubble could not be updated. Try again.');
    return ok;
  }, [props.onToggleBubbleTrim]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (props.state.dominant === 'reasoning' || props.state.dominant === 'speaking')) { event.preventDefault(); props.onCancelAssistant(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [props.onCancelAssistant, props.state.dominant]);

  const assistantActive = props.state.dominant === 'reasoning' || props.state.dominant === 'speaking';
  // Keep the "typing" shimmer only until the first reasoning preview arrives; the
  // dimmed tentative row then takes over as the visible progress signal.
  const hasAssistantText = props.state.conversationItems.some(item => item.kind === 'assistant' && item.text.trim() !== '');
  const showAssistantActivity = props.state.dominant === 'speaking' || (props.state.dominant === 'reasoning' && !hasAssistantText);
  const StateIcon = stateIcons[props.state.dominant];
  return <main className="session-shell">
    <header className="session-header"><p className="eyebrow">Active voice session</p><Button variant="destructive" className="max-sm:w-full" onClick={props.onStop}>Stop session</Button></header>
    <Card className={`status-bar state-${props.state.dominant}`}>
      <div className="status-label">{StateIcon ? <StateIcon className="state-icon" aria-hidden="true" /> : <Spinner className="state-icon" />}<h1 id="session-status-heading">{headings[props.state.dominant]}</h1></div>
      <div className="status-actions"><Badge className="elapsed-badge" aria-label={`Session elapsed ${props.elapsedSeconds} seconds`}>{formatElapsed(props.elapsedSeconds)}</Badge>{assistantActive ? <Button variant="secondary" onClick={props.onCancelAssistant}>Stop speaking</Button> : null}</div>
    </Card>
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{props.state.announcement}</p>
    {trimAnnouncement ? <p className="visually-hidden" role="status" aria-live="polite">{trimAnnouncement}</p> : null}
    {props.state.degradedMessage ? <Alert>{props.state.degradedMessage}</Alert> : null}
    <section aria-labelledby="conversation-title" className="conversation"><h2 id="conversation-title">Conversation</h2>
      <div className="conversation-scroll">
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={48}>
          <MessageScroller>
            <MessageScrollerViewport aria-label="Conversation transcript">
              <MessageScrollerContent className="conversation-list" aria-busy={props.state.dominant === 'reasoning'}>
                {props.state.conversationItems.length === 0 && !props.state.tentativeText ? <MessageScrollerItem messageId="conversation-empty"><p className="hint">Your conversation will appear here.</p></MessageScrollerItem> : null}
                {props.state.conversationItems.filter(item => !(item.kind === 'assistant' && !item.text)).map(item => <MessageScrollerItem key={item.id} messageId={item.id} scrollAnchor={conversationItemStartsTurn(item)}><ConversationRow item={item} recording={props.recording} onToggleBubbleTrim={handleTrim} /></MessageScrollerItem>)}
                {showAssistantActivity ? <MessageScrollerItem messageId="assistant-activity"><Marker role="status" className="assistant-activity"><MarkerContent className="shimmer"><span className="font-medium">Oliver</span> {props.state.dominant === 'speaking' ? 'is speaking…' : 'is typing…'}</MarkerContent></Marker></MessageScrollerItem> : null}
                {props.state.tentativeText ? <MessageScrollerItem messageId="tentative-transcript"><Message align="end" className="conversation-message user-row"><MessageContent><MessageHeader>You · tentative</MessageHeader><Bubble variant="tinted"><BubbleContent className="conversation-bubble tentative"><p>{props.state.tentativeText}</p></BubbleContent></Bubble></MessageContent></Message></MessageScrollerItem> : null}
                {props.state.playbackNotice ? <MessageScrollerItem messageId="playback-notice"><Marker variant="separator" className="continuation-marker"><MarkerContent>{props.state.playbackNotice}</MarkerContent></Marker></MessageScrollerItem> : null}
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
  return <Card className="activity-log">
    <div className="activity-log-header">
      <Button variant="ghost" size="sm" className="activity-log-toggle" aria-expanded={open} aria-controls="activity-log-region" onClick={() => setOpen(value => !value)}>
        <ChevronDown className={cn('activity-log-chevron', open && 'activity-log-chevron-open')} aria-hidden="true" />
        Activity log
        {entries.length > 0 ? <Badge className="activity-log-count">{entries.length}</Badge> : null}
      </Button>
      {open ? <div className="activity-log-actions">
        {notice ? <span className="activity-log-notice" role="status">{notice}</span> : null}
        <ButtonGroup aria-label="Activity log actions">
          <Button variant="outline" size="icon" className="size-8" title="Copy" aria-label="Copy entries" onClick={copyLog}><Copy className="activity-log-icon" aria-hidden="true" /></Button>
          <ButtonGroupSeparator />
          <Button variant="outline" size="icon" className="size-8" title="Clear" aria-label="Clear entries" onClick={() => { activityLog.clear(); setNotice(''); }}><Trash className="activity-log-icon" aria-hidden="true" /></Button>
        </ButtonGroup>
      </div> : null}
    </div>
    {open ? <div id="activity-log-region" role="region" aria-label="Activity log entries" className="activity-log-region">
      {entries.length === 0 ? <p className="hint">No activity logged yet.</p> : <ul className="activity-log-list">
        {[...entries].reverse().map((entry, index) => <li key={`${entry.ts}-${index}`} className="activity-log-entry">
          <time className="log-entry-time font-mono" dateTime={new Date(entry.ts).toISOString()}>{formatLogTime(entry.ts)}</time>
          <Badge className="log-level" variant={entry.level === 'error' ? 'destructive' : entry.level === 'warn' ? 'warning' : 'primary'}>{entry.level}</Badge>
          <span className="log-entry-source">{entry.source}</span>
          <span className="log-entry-message">{entry.message}{entry.detail ? ` — ${entry.detail}` : ''}</span>
        </li>)}
      </ul>}
    </div> : null}
  </Card>;
}
function formatElapsed(seconds: number): string { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, '0')}`; }
function formatLogTime(ts: number): string { const date = new Date(ts); return [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':'); }
