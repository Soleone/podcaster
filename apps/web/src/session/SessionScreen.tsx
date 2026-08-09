import { useEffect } from 'react';
import { Brain, Captions, CircleAlert, CircleStop, Ear, Loader2, MessageCircleQuestion, Pause, Volume2, type LucideIcon } from 'lucide-react';
import { ConversationRow, conversationItemStartsTurn } from '../components/conversation/conversation-item';
import { Alert } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
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
const stateIcons: Record<SessionViewState['dominant'], LucideIcon> = {
  idle: CircleStop, listening: Ear, transcribing: Captions, deciding: MessageCircleQuestion, intentional_silence: Pause, reasoning: Brain, speaking: Volume2, stopping: Loader2, degraded: CircleAlert,
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
  const StateIcon = stateIcons[props.state.dominant];
  return <main className="session-shell">
    <header className="session-header"><p className="eyebrow">Active voice session</p><Button className="danger" onClick={props.onStop}>Stop session</Button></header>
    <Card className={`status-bar state-${props.state.dominant}`}>
      <div className="status-label"><StateIcon className={`state-icon${props.state.dominant === 'stopping' ? ' state-icon-spin' : ''}`} aria-hidden="true" /><h1 id="session-status-heading">{headings[props.state.dominant]}</h1></div>
      <div className="status-actions"><Badge className="elapsed-badge" aria-label={`Session elapsed ${props.elapsedSeconds} seconds`}>{formatElapsed(props.elapsedSeconds)}</Badge>{assistantActive ? <Button className="secondary stop-speaking" onClick={props.onCancelAssistant}>Stop speaking</Button> : null}</div>
    </Card>
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{props.state.announcement}</p>
    {props.state.degradedMessage ? <Alert>{props.state.degradedMessage}</Alert> : null}
    <section aria-labelledby="conversation-title" className="conversation"><h2 id="conversation-title">Conversation</h2>
      <div className="conversation-scroll">
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={48}>
          <MessageScroller>
            <MessageScrollerViewport aria-label="Conversation transcript">
              <MessageScrollerContent className="conversation-list" aria-busy={props.state.dominant === 'reasoning'}>
                {props.state.conversationItems.length === 0 && !props.state.tentativeText ? <MessageScrollerItem messageId="conversation-empty"><p className="hint">Your conversation will appear here.</p></MessageScrollerItem> : null}
                {props.state.conversationItems.filter(item => !(item.kind === 'assistant' && !item.text)).map(item => <MessageScrollerItem key={item.id} messageId={item.id} scrollAnchor={conversationItemStartsTurn(item)}><ConversationRow item={item} /></MessageScrollerItem>)}
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
  </main>;
}
function formatElapsed(seconds: number): string { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, '0')}`; }
