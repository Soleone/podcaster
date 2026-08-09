import { useEffect } from 'react';
import { ConversationRow, conversationItemStartsTurn } from '../components/conversation/conversation-item';
import { Alert } from '../components/ui/alert';
import { Bubble, BubbleContent } from '../components/ui/bubble';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Marker, MarkerContent } from '../components/ui/marker';
import { Message, MessageContent, MessageHeader } from '../components/ui/message';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '../components/ui/message-scroller';
import type { SessionViewState } from './state';
import './session.css';

const headings: Record<SessionViewState['dominant'], string> = {
  idle: 'Session stopped', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering what you meant…', intentional_silence: 'Giving you space', reasoning: 'Forming a response…', speaking: 'Speaking', stopping: 'Stopping response…', degraded: 'Session needs attention',
};

export function SessionScreen(props: { state: SessionViewState; elapsedSeconds: number; onStop: () => void; onCancelAssistant: () => void; onConfirmEcho: () => void; onRejectEcho: () => void }) {
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
      <div className="conversation-scroll">
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={48}>
          <MessageScroller>
            <MessageScrollerViewport aria-label="Conversation transcript">
              <MessageScrollerContent className="conversation-list" aria-busy={props.state.dominant === 'reasoning'}>
                {props.state.conversationItems.length === 0 && !props.state.tentativeText ? <MessageScrollerItem messageId="conversation-empty"><p className="hint">Your conversation will appear here.</p></MessageScrollerItem> : null}
                {props.state.conversationItems.map(item => <MessageScrollerItem key={item.id} messageId={item.id} scrollAnchor={conversationItemStartsTurn(item)}><ConversationRow item={item} /></MessageScrollerItem>)}
                {props.state.tentativeText ? <MessageScrollerItem messageId="tentative-transcript"><Message align="end" className="conversation-message user-row"><MessageContent><MessageHeader>You · tentative</MessageHeader><Bubble variant="tinted"><BubbleContent className="conversation-bubble tentative"><p>{props.state.tentativeText}</p></BubbleContent></Bubble></MessageContent></Message></MessageScrollerItem> : null}
                {props.state.playbackNotice ? <MessageScrollerItem messageId="playback-notice"><Marker variant="separator" className="continuation-marker"><MarkerContent>{props.state.playbackNotice}</MarkerContent></Marker></MessageScrollerItem> : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </section>
    {props.state.echoConfirmation ? <Card className="interruption-controls" role="group" aria-label="Paused response choices"><p>The previous response is paused while your intent is considered.</p><div className="button-row"><Button className="secondary" onClick={props.onRejectEcho}>Continue previous response</Button><Button onClick={props.onConfirmEcho}>Respond to me instead</Button></div></Card> : null}
    {assistantActive ? <Button className="secondary stop-speaking" onClick={props.onCancelAssistant}>Stop speaking</Button> : null}
  </main>;
}
function formatElapsed(seconds: number): string { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, '0')}`; }
