import { useEffect, useRef } from 'react';
import { ConversationRow } from '../components/conversation/conversation-item';
import { Alert } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ScrollArea } from '../components/ui/scroll-area';
import type { SessionViewState } from './state';
import './session.css';

const headings: Record<SessionViewState['dominant'], string> = {
  idle: 'Session stopped', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering what you meant…', intentional_silence: 'Giving you space', reasoning: 'Forming a response…', speaking: 'Speaking', stopping: 'Stopping response…', degraded: 'Session needs attention',
};

export function maintainConversationScroll(viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight'> | null, nearBottom: boolean): void {
  if (viewport && nearBottom) viewport.scrollTop = viewport.scrollHeight;
}

export function SessionScreen(props: { state: SessionViewState; elapsedSeconds: number; onStop: () => void; onCancelAssistant: () => void; onConfirmEcho: () => void; onRejectEcho: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => {
    maintainConversationScroll(viewportRef.current, nearBottom.current);
  }, [props.state.conversationItems, props.state.tentativeText]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (props.state.dominant === 'reasoning' || props.state.dominant === 'speaking' || props.state.echoConfirmation)) { event.preventDefault(); props.onCancelAssistant(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [props.onCancelAssistant, props.state.dominant, props.state.echoConfirmation]);

  const assistantActive = props.state.dominant === 'reasoning' || props.state.dominant === 'speaking' || props.state.echoConfirmation;
  return <main className="session-shell">
    <header className="session-header"><div><p className="eyebrow">Active voice session</p><p aria-label={`Session elapsed ${props.elapsedSeconds} seconds`}>{formatElapsed(props.elapsedSeconds)}</p></div><Button className="danger" onClick={props.onStop}>Stop session</Button></header>
    <Card className={`status-card state-${props.state.dominant}`}><span className="state-cue" aria-hidden="true">●</span><div><p className="state-kicker">Current state</p><h1 id="session-status-heading" tabIndex={-1}>{headings[props.state.dominant]}</h1></div></Card>
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{props.state.announcement}</p>
    {props.state.degradedMessage ? <Alert>{props.state.degradedMessage}</Alert> : null}
    <section aria-labelledby="conversation-title" className="conversation"><h2 id="conversation-title">Conversation</h2>
      <ScrollArea className="conversation-scroll" viewportRef={viewportRef} onViewportScroll={event => { const target = event.currentTarget; nearBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80; }}>
        <div className="conversation-list">
          {props.state.conversationItems.length === 0 && !props.state.tentativeText ? <p className="hint">Your conversation will appear here.</p> : null}
          {props.state.conversationItems.map(item => <ConversationRow key={item.id} item={item} />)}
          {props.state.tentativeText ? <div className="conversation-row user-row"><Card className="conversation-bubble user-bubble tentative"><span className="speaker">You · tentative</span><p>{props.state.tentativeText}</p></Card></div> : null}
          {props.state.playbackNotice ? <p className="continuation-marker">{props.state.playbackNotice}</p> : null}
        </div>
      </ScrollArea>
    </section>
    {props.state.echoConfirmation ? <Card className="interruption-controls" role="group" aria-label="Paused response choices"><p>The previous response is paused while your intent is considered.</p><div className="button-row"><Button className="secondary" onClick={props.onRejectEcho}>Continue previous response</Button><Button onClick={props.onConfirmEcho}>Respond to me instead</Button></div></Card> : null}
    {assistantActive ? <Button className="secondary stop-speaking" onClick={props.onCancelAssistant}>Stop speaking</Button> : null}
  </main>;
}
function formatElapsed(seconds: number): string { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, '0')}`; }
