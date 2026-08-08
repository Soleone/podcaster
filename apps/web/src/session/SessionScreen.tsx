import { useEffect, useRef } from 'react';
import type { SessionViewState } from './state';
import './session.css';

const headings: Record<SessionViewState['dominant'], string> = {
  idle: 'Session stopped', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering whether to respond…', intentional_silence: 'Giving you space', reasoning: 'Forming a response…', speaking: 'Speaking', stopping: 'Stopping response…', degraded: 'Session needs attention',
};

function ReplySelectedBadge() {
  return <span className="reply-warranted"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 9.7 6.3l4.8 1.7-4.8 1.7L8 14.5 6.3 9.7 1.5 8l4.8-1.7L8 1.5Z" /></svg>Reply selected</span>;
}

const quietReasons: Record<string, string> = {
  response_budget_exhausted: 'response limit',
  interruption_cooldown: 'interruption cooldown',
  invitation_required: 'waiting for an invitation',
  too_short: 'turn too short',
  unfinished: 'unfinished thought',
};

function quietLabel(reason?: string): string {
  const detail = reason ? quietReasons[reason] : undefined;
  return detail ? `Companion stayed quiet · ${detail}` : 'Companion stayed quiet';
}

export function SessionScreen(props: { state: SessionViewState; elapsedSeconds: number; onStop: () => void; onCancelAssistant: () => void; onConfirmEcho: () => void; onRejectEcho: () => void }) {
  const echoRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLHeadingElement>(null);
  const wasEcho = useRef(false);
  useEffect(() => {
    if (props.state.echoConfirmation) echoRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else if (wasEcho.current) statusRef.current?.focus();
    wasEcho.current = props.state.echoConfirmation;
  }, [props.state.echoConfirmation]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (props.state.dominant === 'reasoning' || props.state.dominant === 'speaking' || props.state.echoConfirmation)) {
        event.preventDefault(); props.onCancelAssistant();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [props.onCancelAssistant, props.state.dominant, props.state.echoConfirmation]);

  const assistantActive = props.state.dominant === 'reasoning' || props.state.dominant === 'speaking' || props.state.echoConfirmation;
  const visibleTurns = props.state.stableTurns.filter(turn => turn.text.trim().length > 0);
  return <main className="session-shell">
    <header className="session-header"><div><p className="eyebrow">Active voice session</p><p aria-label={`Session elapsed ${props.elapsedSeconds} seconds`}>{formatElapsed(props.elapsedSeconds)}</p></div><button type="button" className="danger" onClick={props.onStop}>Stop session</button></header>
    <section className={`status-card state-${props.state.dominant}`} aria-labelledby="session-status-heading">
      <span className="state-cue" aria-hidden="true">●</span>
      <div><p className="state-kicker">Current state</p><h1 id="session-status-heading" tabIndex={-1} ref={statusRef}>{headings[props.state.dominant]}</h1>{props.state.dominant === 'listening' ? <p className="state-guidance">Take your time. A natural pause will not end your turn.</p> : null}</div>
    </section>
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{props.state.announcement}</p>
    {props.state.degradedMessage ? <p role="alert" className="error">{props.state.degradedMessage}</p> : null}
    {props.state.playbackNotice ? <p className="playback-notice">{props.state.playbackNotice}</p> : null}
    {props.state.echoConfirmation ? <div className="echo-card" role="group" aria-labelledby="echo-title" ref={echoRef} tabIndex={-1}>
      <h2 id="echo-title">Are you taking the turn?</h2><p>The response is paused. Keep speaking and it will listen, or continue the response now. If you do nothing, the response continues automatically.</p>
      <div className="button-row"><button type="button" onClick={props.onConfirmEcho}>Stop response and listen</button><button type="button" className="secondary" onClick={props.onRejectEcho}>Continue response</button></div>
    </div> : null}
    <section aria-labelledby="conversation-title" className="conversation"><h2 id="conversation-title">Conversation</h2>
      {props.state.tentativeText ? <p className="tentative"><span className="speaker">You, tentative</span>{props.state.tentativeText}</p> : null}
      {visibleTurns.length === 0 ? <p className="hint">Stable speech will appear here. Quiet sections stay out of the transcript.</p> : visibleTurns.map(turn => <article key={turn.turnId} className={turn.posture && turn.posture !== 'silence' ? 'reply-turn' : undefined}>
        <div className="turn-heading"><p className="speaker">You</p>{turn.posture && turn.posture !== 'silence' ? <ReplySelectedBadge /> : null}</div>
        <p>{turn.text}</p>
        {turn.posture === 'silence' ? <p className="posture">{quietLabel(turn.policyReason)}</p> : null}
      </article>)}
      {props.state.assistantText ? <article className="assistant-turn"><p className="speaker">Companion</p><p>{props.state.assistantText}</p></article> : null}
    </section>
    {assistantActive ? <button type="button" className="secondary stop-speaking" onClick={props.onCancelAssistant}>Stop speaking</button> : null}
  </main>;
}
function formatElapsed(seconds: number): string { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, '0')}`; }
