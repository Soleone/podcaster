import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Brain,
  Captions,
  Check,
  ChevronDown,
  CircleAlert,
  CircleStop,
  Copy,
  Ear,
  LoaderCircle,
  MessageCircleQuestion,
  Pause,
  Play,
  Trash,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import { ConfirmDeleteDialog } from '../components/ConfirmDeleteDialog';
import { ExportPopover } from '../components/ExportPopover';
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
import { Progress } from '../components/ui/progress';
import { Tabs, TabsContent } from '../components/ui/tabs';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '../components/ui/message-scroller';
import { activityLog, type ActivityEntry } from './activity-log';
import type { ExportOnProgress } from '../recording/splice';
import type { RecordingSessionViewState, RecordingTrimTargetId } from '../recording/trim-state';
import type { AgentActivityGroup, SessionViewState } from './state';
import './session.css';

const headings: Record<SessionViewState['dominant'], string> = {
  idle: 'Session stopped',
  planning: 'Preparing your session',
  ready: 'Ready to go live',
  paused: 'Session paused',
  listening: 'Listening',
  transcribing: 'Finishing transcript',
  deciding: 'Considering what you meant…',
  intentional_silence: 'Giving you space',
  reasoning: 'Forming a response…',
  speaking: 'Speaking',
  stopping: 'Stopping response…',
  degraded: 'Session needs attention',
};
const stateIcons: Record<SessionViewState['dominant'], LucideIcon | undefined> = {
  idle: CircleStop,
  planning: Brain,
  ready: Check,
  paused: Play,
  listening: Ear,
  transcribing: Captions,
  deciding: MessageCircleQuestion,
  intentional_silence: Pause,
  reasoning: Brain,
  speaking: Volume2,
  stopping: undefined,
  degraded: CircleAlert,
};

type SessionScreenProps = {
  state: SessionViewState;
  sessionId: string;
  agentName: string;
  elapsedSeconds: number;
  sessionPaused: boolean;
  lifecycleAction?: 'idle' | 'pausing' | 'resuming' | 'ending';
  onTogglePause: () => void;
  onStop: () => void;
  onCancelAssistant: () => void;
  onCancelPlanning: () => void;
  onRetryPlanning: () => void;
  onBeginLive: () => Promise<void> | undefined;
  settingsOpen: boolean;
  recording: RecordingSessionViewState;
  onToggleBubbleTrim: (targetId: RecordingTrimTargetId, trimmed: boolean) => Promise<boolean>;
  buildExport: (onProgress?: ExportOnProgress) => Promise<Blob | null>;
  readOnly?: boolean;
  /** Shown as the header play button on read-only views; resumes or continues the session. */
  onResume?: () => void;
  onExportingChange?: (exporting: boolean) => void;
  onDeleteRecording?: () => Promise<void>;
  exporting?: boolean;
  deleting?: boolean;
};

export function SessionScreen(props: SessionScreenProps) {
  const [trimAnnouncement, setTrimAnnouncement] = useState('');
  const handleTrim = useCallback(
    async (targetId: RecordingTrimTargetId, trimmed: boolean): Promise<boolean> => {
      const ok = await props.onToggleBubbleTrim(targetId, trimmed);
      setTrimAnnouncement(
        ok
          ? trimmed
            ? 'Removed from recording.'
            : 'Restored to recording.'
          : 'That message could not be updated. Try again.',
      );
      return ok;
    },
    [props.onToggleBubbleTrim],
  );
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // An open settings dialog consumes Escape; it must not also cancel assistant speech.
      if (props.settingsOpen) return;
      if (event.key === 'Escape' && (props.state.dominant === 'reasoning' || props.state.dominant === 'speaking')) {
        event.preventDefault();
        props.onCancelAssistant();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [props.onCancelAssistant, props.state.dominant, props.settingsOpen]);

  const assistantActive = props.state.dominant === 'reasoning' || props.state.dominant === 'speaking';
  // Pre-live phases (preparing / ready-to-go-live) have no audio engine or
  // capture yet; the planning card owns the actions and the microphone stays off.
  const prelive = props.state.dominant === 'planning' || props.state.dominant === 'ready';
  const readOnly = props.readOnly === true;
  const agentName = props.agentName.trim() || 'Assistant';
  const actionBusy = props.lifecycleAction !== undefined && props.lifecycleAction !== 'idle';
  const canExport = !actionBusy && props.recording.includedCount > 0 && !props.exporting && !props.deleting;
  const canDelete = !actionBusy && props.recording.totalCount > 0 && !props.deleting && !props.exporting;
  const pauseLabel =
    props.lifecycleAction === 'pausing'
      ? 'Pausing…'
      : props.lifecycleAction === 'resuming'
        ? 'Resuming…'
        : props.sessionPaused
          ? 'Resume session'
          : 'Pause session';
  const pauseBusy = props.lifecycleAction === 'pausing' || props.lifecycleAction === 'resuming';
  // Keep the dimmed tentative row as the visible progress signal after a preview arrives.
  const hasAssistantText = props.state.conversationItems.some(
    (item) => item.kind === 'assistant' && item.text.trim() !== '',
  );
  const showAssistantActivity =
    props.state.dominant === 'speaking' || (props.state.dominant === 'reasoning' && !hasAssistantText);
  const StateIcon = stateIcons[props.state.dominant];
  return (
    <main className="mx-auto mt-5 mb-8 w-[min(56rem,calc(100%_-_2rem))]">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {readOnly
            ? props.sessionPaused
              ? 'Paused session'
              : 'Ended session'
            : props.sessionPaused
              ? 'Paused voice session'
              : 'Active voice session'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {readOnly ? (
            <>
              <Button variant="outline" size="sm" onClick={props.onStop}>
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                All sessions
              </Button>
              {props.onResume ? (
                <ButtonGroup aria-label="Session controls" className="session-controls">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={props.sessionPaused ? 'Resume session' : 'Continue session'}
                    title={props.sessionPaused ? 'Resume session' : 'Continue session'}
                    onClick={props.onResume}
                  >
                    <Play aria-hidden="true" />
                  </Button>
                  <ButtonGroupSeparator />
                  <ExportPopover
                    sessionId={props.sessionId}
                    buildExport={props.buildExport}
                    disabled={!canExport}
                    variant="secondary"
                    size="icon"
                    iconOnly
                    onExportingChange={props.onExportingChange}
                  />
                  <ConfirmDeleteDialog
                    deleting={props.deleting ?? false}
                    onConfirm={async () => {
                      await props.onDeleteRecording?.();
                    }}
                    trigger={
                      <Button
                        variant="outline"
                        size="icon"
                        disabled={!canDelete}
                        title="Delete recording"
                        aria-label="Delete recording"
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                    }
                  />
                </ButtonGroup>
              ) : null}
            </>
          ) : (
            <>
              {!prelive ? (
                <ButtonGroup aria-label="Session controls" className="session-controls">
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={actionBusy}
                    aria-label={pauseLabel}
                    title={pauseLabel}
                    onClick={props.onTogglePause}
                    aria-busy={pauseBusy}
                  >
                    {pauseBusy ? (
                      <Spinner aria-hidden="true" />
                    ) : props.sessionPaused ? (
                      <Play aria-hidden="true" />
                    ) : (
                      <Pause aria-hidden="true" />
                    )}
                  </Button>
                  <ButtonGroupSeparator />
                  <ExportPopover
                    sessionId={props.sessionId}
                    buildExport={props.buildExport}
                    disabled={!canExport}
                    variant="secondary"
                    size="icon"
                    iconOnly
                    onExportingChange={props.onExportingChange}
                  />
                  <ConfirmDeleteDialog
                    deleting={props.deleting ?? false}
                    onConfirm={async () => {
                      await props.onDeleteRecording?.();
                    }}
                    trigger={
                      <Button
                        variant="outline"
                        size="icon"
                        disabled={!canDelete}
                        title="Delete recording"
                        aria-label="Delete recording"
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                    }
                  />
                </ButtonGroup>
              ) : null}
            </>
          )}
        </div>
      </header>
      <Card
        size="sm"
        data-state={props.state.dominant}
        className="mt-4 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2"
      >
        <CardContent className="flex min-w-0 flex-1 items-center gap-2">
          {StateIcon ? (
            <StateIcon
              className={cn(
                'size-5 shrink-0',
                props.state.dominant === 'degraded' ? 'text-destructive' : 'text-muted-foreground',
              )}
              aria-hidden="true"
            />
          ) : (
            <Spinner className="size-5 shrink-0 text-muted-foreground" />
          )}
          <h1 id="session-status-heading" className="min-w-0 text-sm font-medium leading-snug">
            {headings[props.state.dominant]}
          </h1>
        </CardContent>
        <div className="flex items-center gap-2 pr-(--card-spacing)">
          <Badge
            variant="secondary"
            className="font-mono tabular-nums"
            title={props.sessionPaused ? 'Active time; paused time is not counted' : 'Active session time'}
            aria-label={`Session active time ${props.elapsedSeconds} seconds`}
          >
            {formatElapsed(props.elapsedSeconds)}
          </Badge>
          {assistantActive && !readOnly ? (
            <Button variant="secondary" size="sm" onClick={props.onCancelAssistant}>
              Stop speaking
            </Button>
          ) : null}
        </div>
      </Card>
      {!readOnly && !prelive ? <AudioEngineStatusStrip status={props.state.audioEngine} /> : null}
      {props.state.planning.status !== 'skipped' ? (
        <PlanningStatusCard
          planning={props.state.planning}
          onCancelPlanning={props.onCancelPlanning}
          onRetryPlanning={props.onRetryPlanning}
          onBeginLive={props.onBeginLive}
        />
      ) : null}
      {props.state.agentActivity.length > 0 ? (
        <AgentActivityPanel groups={props.state.agentActivity} stableTurns={props.state.stableTurns} />
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {props.state.announcement}
      </p>
      {trimAnnouncement ? (
        <p className="sr-only" role="status" aria-live="polite">
          {trimAnnouncement}
        </p>
      ) : null}
      {props.state.degradedMessage ? (
        <Alert variant="destructive" className="mt-4">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{props.state.degradedMessage}</AlertDescription>
        </Alert>
      ) : null}
      <section
        aria-labelledby="conversation-title"
        className="conversation mt-6 flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground ring-1 ring-foreground/10"
      >
        <h2 id="conversation-title" className="border-b px-5 py-4 text-sm font-medium leading-snug">
          Conversation
        </h2>
        <div className="conversation-scroll">
          <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={48}>
            <MessageScroller>
              <MessageScrollerViewport aria-label="Conversation transcript">
                <MessageScrollerContent
                  className="conversation-list p-3 pb-4"
                  aria-busy={props.state.dominant === 'reasoning'}
                >
                  {props.state.conversationItems.length === 0 && !props.state.tentativeText ? (
                    <MessageScrollerItem messageId="conversation-empty">
                      <p className="text-sm text-muted-foreground">Your conversation will appear here.</p>
                    </MessageScrollerItem>
                  ) : null}
                  {props.state.conversationItems
                    .filter((item) => !(item.kind === 'assistant' && !item.text))
                    .map((item) => (
                      <MessageScrollerItem
                        key={item.id}
                        messageId={item.id}
                        scrollAnchor={conversationItemStartsTurn(item)}
                      >
                        <ConversationRow
                          item={item}
                          agentName={agentName}
                          recording={props.recording}
                          onToggleBubbleTrim={handleTrim}
                        />
                      </MessageScrollerItem>
                    ))}
                  {showAssistantActivity ? (
                    <MessageScrollerItem messageId="assistant-activity">
                      <Marker role="status" className="assistant-activity my-1">
                        <MarkerIcon>
                          <Spinner />
                        </MarkerIcon>
                        <MarkerContent>
                          <span className="font-medium">{agentName}</span>{' '}
                          {props.state.dominant === 'speaking' ? 'is speaking…' : 'is thinking…'}
                        </MarkerContent>
                      </Marker>
                    </MessageScrollerItem>
                  ) : null}
                  {props.state.tentativeText ? (
                    <MessageScrollerItem messageId="tentative-transcript">
                      <Message align="end" className="conversation-message user-row">
                        <MessageContent>
                          <MessageHeader>You · tentative</MessageHeader>
                          <Bubble
                            variant="tinted"
                            className="conversation-bubble-shell max-w-[min(78%,38rem)] max-[36rem]:max-w-[90%]"
                          >
                            <BubbleContent className="conversation-bubble tentative border-dashed opacity-75">
                              <p>{props.state.tentativeText}</p>
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : null}
                  {props.state.playbackNotice ? (
                    <MessageScrollerItem messageId="playback-notice">
                      <Marker variant="separator" className="continuation-marker my-1">
                        <MarkerContent>{props.state.playbackNotice}</MarkerContent>
                      </Marker>
                    </MessageScrollerItem>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
        </div>
      </section>
      <ActivityLogPanel />
    </main>
  );
}

function PlanningStatusCard({
  planning,
  onCancelPlanning,
  onRetryPlanning,
  onBeginLive,
}: {
  planning: SessionViewState['planning'];
  onCancelPlanning: () => void;
  onRetryPlanning: () => void;
  onBeginLive: () => Promise<void> | undefined;
}) {
  const [beginning, setBeginning] = useState(false);
  const active = planning.status === 'planning';
  const failed = planning.status === 'failed' || planning.status === 'cancelled';
  const label = active
    ? 'Preparing before live capture…'
    : planning.status === 'ready'
      ? 'Preparation ready'
      : planning.status === 'continued'
        ? 'Continuing without preparation'
        : planning.status === 'cancelled'
          ? 'Preparation cancelled'
          : 'Preparation needs attention';
  const stageLabel =
    planning.stage === 'researching'
      ? 'Researching'
      : planning.stage === 'finalizing'
        ? 'Finalizing notes'
        : 'Starting';
  const begin = async () => {
    setBeginning(true);
    try {
      await onBeginLive();
    } catch {
      // The host reports the failure through the session.state/failure events;
      // the card stays pre-live and the Begin action can be retried.
    } finally {
      setBeginning(false);
    }
  };
  return (
    <Card size="sm" className={cn('mt-3', failed && 'border-destructive/50')} data-planning-status={planning.status}>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-center gap-2 text-xs">
          {active ? (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : failed ? (
            <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
          ) : (
            <Check className="size-4 text-emerald-600" aria-hidden="true" />
          )}
          <span className="font-medium">{label}</span>
          {planning.attempt > 1 ? (
            <Badge variant="secondary" className="font-mono tabular-nums">
              attempt {planning.attempt}
            </Badge>
          ) : null}
          {active ? <span className="ml-auto tabular-nums text-muted-foreground">{stageLabel}</span> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {planning.detail ??
            (planning.topic
              ? `Topic: ${planning.topic}`
              : 'The live assistant will use the saved preparation when available.')}
        </p>
        <p className="text-xs font-medium text-muted-foreground" data-microphone-status="off">
          Microphone off — the session starts listening only after you go live.
        </p>
        {planning.notes ? (
          <details className="text-xs">
            <summary className="cursor-pointer font-medium">Show preparation notes</summary>
            <p className="mt-2 whitespace-pre-wrap leading-relaxed text-muted-foreground">{planning.notes}</p>
          </details>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <Button variant="outline" size="sm" onClick={onCancelPlanning}>
              Cancel preparation
            </Button>
          ) : null}
          {failed ? (
            <Button variant="outline" size="sm" onClick={onRetryPlanning}>
              Retry preparation
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void begin()} disabled={beginning} aria-busy={beginning}>
            {beginning ? (
              <>
                <Spinner aria-hidden="true" />
                Going live…
              </>
            ) : active || planning.status === 'cancelled' || planning.status === 'failed' ? (
              'Begin without preparation'
            ) : (
              'Begin live'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AudioEngineStatusStrip({ status }: { status: SessionViewState['audioEngine'] }) {
  const healthy = status.status === 'ready';
  const failed = status.status === 'failed';
  const completed = [status.capture, status.vad, status.tts].filter((value) => value === 'ready').length;
  const value = healthy ? 100 : Math.round((completed / 3) * 100);
  const label = healthy
    ? 'Audio engine ready'
    : failed
      ? 'Audio engine needs attention'
      : status.status === 'retrying'
        ? 'Reconnecting audio engine…'
        : 'Warming audio engine…';
  const detail = healthy
    ? 'Microphone, VAD, and voice are ready.'
    : (status.detail ??
      (failed
        ? 'The local audio engine could not continue.'
        : 'Preparing microphone, speech detection, and voice playback.'));
  return (
    <Card size="sm" className={cn('mt-3', failed && 'border-destructive/50')} data-audio-status={status.status}>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-center gap-2 text-xs">
          {healthy ? (
            <Check className="size-4 text-emerald-600" aria-hidden="true" />
          ) : failed ? (
            <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
          ) : (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
          <span className="font-medium">{label}</span>
          <span className="ml-auto text-muted-foreground">{value}%</span>
        </div>
        {!healthy ? (
          <Progress
            value={value}
            aria-label="Audio engine warmup progress"
            className="gap-0 [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-indicator]]:bg-primary"
          />
        ) : null}
        <p className="text-xs text-muted-foreground">{detail}</p>
        <div
          className="flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground"
          aria-label="Audio engine components"
        >
          <span>Mic {status.capture === 'ready' ? 'ready' : status.capture}</span>
          <span>VAD {status.vad === 'ready' ? 'ready' : status.vad}</span>
          <span>Voice {status.tts === 'ready' ? 'ready' : status.tts}</span>
        </div>
      </CardContent>
    </Card>
  );
}

type ActivityLogTab = 'activity';

function ActivityLogPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<readonly ActivityEntry[]>(() => activityLog.entries());
  const [tab, setTab] = useState<ActivityLogTab>('activity');
  const [notice, setNotice] = useState('');
  useEffect(() => activityLog.subscribe(setEntries), []);
  const activeEntries = entries;
  const copyLog = () => {
    try {
      void navigator.clipboard.writeText(activityLog.toText()).then(
        () => setNotice('Copied to clipboard'),
        () => setNotice('Copy failed'),
      );
    } catch {
      setNotice('Copy failed');
    }
  };
  return (
    <Card size="sm" className="activity-log mt-6">
      <Tabs value={tab} onValueChange={(value) => setTab(value as ActivityLogTab)} className="contents">
        <CardHeader className="activity-log-header flex flex-row flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="activity-log-toggle"
            aria-expanded={open}
            aria-controls="activity-log-region"
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown
              data-icon="inline-start"
              className={cn('transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
            Activity log
            {activeEntries.length > 0 ? (
              <Badge variant="secondary" className="activity-log-count font-mono tabular-nums">
                {activeEntries.length}
              </Badge>
            ) : null}
          </Button>
          {open ? (
            <div className="activity-log-actions flex flex-wrap items-center gap-2">
              {notice ? (
                <span className="activity-log-notice text-xs text-muted-foreground" role="status">
                  {notice}
                </span>
              ) : null}
              <ButtonGroup aria-label="Activity log actions">
                <Button variant="outline" size="icon" title="Copy" aria-label="Copy entries" onClick={copyLog}>
                  <Copy aria-hidden="true" />
                </Button>
                <ButtonGroupSeparator />
                <Button
                  variant="outline"
                  size="icon"
                  title="Clear"
                  aria-label="Clear entries"
                  onClick={() => {
                    activityLog.clear();
                    setNotice('');
                  }}
                >
                  <Trash aria-hidden="true" />
                </Button>
              </ButtonGroup>
            </div>
          ) : null}
        </CardHeader>
        {open ? (
          <CardContent
            id="activity-log-region"
            role="region"
            aria-label="Activity log entries"
            className="activity-log-region border-t p-2"
          >
            <TabsContent value="activity">
              <ActivityLogEntryList entries={activeEntries} emptyMessage="No activity logged yet." />
            </TabsContent>
          </CardContent>
        ) : null}
      </Tabs>
    </Card>
  );
}
function AgentActivityPanel({
  groups,
  stableTurns,
}: {
  groups: AgentActivityGroup[];
  stableTurns: SessionViewState['stableTurns'];
}) {
  const [open, setOpen] = useState(true);
  const running = groups.some((group) => group.entries.some((entry) => entry.status === 'running'));
  const entryCount = groups.reduce((count, group) => count + group.entries.length, 0);
  const labelFor = (group: AgentActivityGroup): string => {
    if (group.scope === 'planning') return 'Preparation';
    const turn = group.turnId ? stableTurns.find((item) => item.turnId === group.turnId) : undefined;
    const text = turn?.text.trim();
    if (!text) return 'Turn';
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  };
  return (
    <Card size="sm" className="agent-activity mt-3">
      <CardHeader className="agent-activity-header flex flex-row items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="agent-activity-toggle"
          aria-expanded={open}
          aria-controls="agent-activity-region"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown
            data-icon="inline-start"
            className={cn('transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
          Agent activity
          {running ? <Spinner className="agent-activity-running" aria-hidden="true" /> : null}
          <Badge variant="secondary" className="agent-activity-count font-mono tabular-nums">
            {entryCount}
          </Badge>
        </Button>
      </CardHeader>
      {open ? (
        <CardContent
          id="agent-activity-region"
          role="log"
          aria-label="Agent tool activity"
          className="agent-activity-region border-t p-2"
        >
          <ul className="agent-activity-groups m-0 flex max-h-64 list-none flex-col gap-2 overflow-y-auto p-0">
            {groups.map((group) => (
              <li key={group.key} className="agent-activity-group flex flex-col gap-1 rounded-md px-2 py-1">
                <p
                  className="agent-activity-group-label truncate text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
                  title={labelFor(group)}
                >
                  {labelFor(group)}
                </p>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {group.entries.map((entry) => (
                    <li
                      key={entry.toolCallId}
                      className="agent-activity-entry flex items-baseline gap-2 text-xs leading-snug [overflow-wrap:anywhere]"
                    >
                      {entry.status === 'running' ? (
                        <LoaderCircle
                          className="size-3.5 shrink-0 self-center animate-spin text-muted-foreground"
                          aria-label="Running"
                        />
                      ) : entry.status === 'done' ? (
                        <Check className="size-3.5 shrink-0 self-center text-emerald-600" aria-label="Done" />
                      ) : entry.status === 'failed' ? (
                        <CircleAlert className="size-3.5 shrink-0 self-center text-destructive" aria-label="Failed" />
                      ) : (
                        <CircleStop
                          className="size-3.5 shrink-0 self-center text-muted-foreground"
                          aria-label="Interrupted"
                        />
                      )}
                      <span className="agent-activity-tool shrink-0 font-medium">{entry.toolName}</span>
                      {entry.summary ? (
                        <span
                          className="agent-activity-summary min-w-0 truncate text-muted-foreground"
                          title={entry.summary}
                        >
                          {entry.summary}
                        </span>
                      ) : null}
                      {entry.durationMs !== undefined ? (
                        <span className="agent-activity-duration ml-auto shrink-0 font-mono text-[0.7rem] tabular-nums text-muted-foreground">
                          {formatDuration(entry.durationMs)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

function ActivityLogEntryList({ entries, emptyMessage }: { entries: readonly ActivityEntry[]; emptyMessage: string }) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  return (
    <ul className="activity-log-list m-0 flex max-h-64 list-none flex-col overflow-y-auto p-0">
      {[...entries].reverse().map((entry, index) => (
        <li
          key={`${entry.ts}-${index}`}
          className="activity-log-entry grid items-baseline gap-x-2 rounded-md px-2 py-1 text-xs leading-snug [overflow-wrap:anywhere] hover:bg-muted/50"
        >
          <time
            className="log-entry-time font-mono text-[0.7rem] tabular-nums text-muted-foreground"
            dateTime={new Date(entry.ts).toISOString()}
          >
            {formatLogTime(entry.ts)}
          </time>
          <Badge
            className="log-level justify-self-start"
            variant={entry.level === 'error' ? 'destructive' : entry.level === 'warn' ? 'outline' : 'secondary'}
          >
            {entry.level}
          </Badge>
          <span className="log-entry-source truncate text-muted-foreground">{entry.source}</span>
          <span className="log-entry-message min-w-0">
            {entry.message}
            {entry.detail ? ` — ${entry.detail}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}
function formatLogTime(ts: number): string {
  const date = new Date(ts);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}
