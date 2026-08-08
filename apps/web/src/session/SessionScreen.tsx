import { useEffect, useRef } from 'react';
import type { SessionViewState } from './state';
import './session.css';

const headings: Record<SessionViewState['dominant'], string> = {
  idle: 'Session stopped', listening: 'Listening', transcribing: 'Finishing transcript', deciding: 'Considering whether to respond…', intentional_silence: 'Giving you space', reasoning: 'Forming a response…', speaking: 'Speaking', stopping: 'Stopping response…', degraded: 'Session needs attention',
};

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
  return <main className="session-shell">
    <header className="session-header"><div><p className="eyebrow">Active voice session</p><p aria-label={`Session elapsed ${props.elapsedSeconds} seconds`}>{formatElapsed(props.elapsedSeconds)}</p></div><button type="button" className="danger" onClick={props.onStop}>Stop session</button></header>
    <section className={`status-card state-${props.state.dominant}`} aria-labelledby="session-status-heading">
      <span className="state-cue" aria-hidden="true">●</span>
      <div><p className="state-kicker">Current state</p><h1 id="session-status-heading" tabIndex={-1} ref={statusRef}>{headings[props.state.dominant]}</h1></div>
    </section>
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{props.state.announcement}</p>
    {props.state.degradedMessage ? <p role="alert" className="error">{props.state.degradedMessage}</p> : null}
    {props.state.echoConfirmation ? <div className="echo-card" role="group" aria-labelledby="echo-title" ref={echoRef} tabIndex={-1}>
      <h2 id="echo-title">Did you start speaking?</h2><p>Playback is paused while you choose.</p>
      <div className="button-row"><button type="button" onClick={props.onConfirmEcho}>Yes, listen</button><button type="button" className="secondary" onClick={props.onRejectEcho}>No, continue</button></div>
    </div> : null}
    <section aria-labelledby="conversation-title" className="conversation"><h2 id="conversation-title">Conversation</h2>
      {props.state.tentativeText ? <p className="tentative"><span className="speaker">You, tentative</span>{props.state.tentativeText}</p> : null}
      {props.state.stableTurns.length === 0 ? <p className="hint">Stable speech will appear here. Tentative words are not saved.</p> : props.state.stableTurns.map(turn => <article key={turn.turnId}><p className="speaker">You</p><p>{turn.text}</p>{turn.posture ? <p className="posture">Posture: {turn.posture === 'silence' ? 'intentional silence' : turn.posture}</p> : null}</article>)}
      {props.state.assistantText ? <article><p className="speaker">Companion</p><p>{props.state.assistantText}</p></article> : null}
    </section>
    {assistantActive ? <button type="button" className="secondary stop-speaking" onClick={props.onCancelAssistant}>Stop speaking</button> : null}
  </main>;
}
function formatElapsed(seconds: number): string { const minutes = Math.floor(seconds / 60); return `${minutes}:${String(seconds % 60).padStart(2, '0')}`; }
