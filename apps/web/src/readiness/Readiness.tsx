import { useState } from 'react';

type Capability = { id: string; label: string; state: 'ready' | 'needs_action' | 'unavailable'; reason: string; action: string };
type Snapshot = { capabilities: Capability[]; sidecar: string };

export function Readiness(props: { sessionAvailable: boolean; onStart: (capability: string) => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [capability, setCapability] = useState<string>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function continueToReadiness() {
    setLoading(true); setError(undefined);
    try {
      const bootstrap = await fetch('/api/bootstrap', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disclosureAcknowledged: true }) });
      if (!bootstrap.ok) throw new Error('Secure bootstrap failed. Retry from this page.');
      const boot = await bootstrap.json() as { capability: string };
      const response = await fetch('/api/readiness', { method: 'POST', credentials: 'same-origin', headers: { 'x-podcaster-capability': boot.capability } });
      if (!response.ok) throw new Error('Readiness check failed. Retry from this page.');
      setCapability(boot.capability); setSnapshot(await response.json() as Snapshot); setAcknowledged(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Readiness failed.'); }
    finally { setLoading(false); }
  }

  async function enableMicrophone() {
    setLoading(true); setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      for (const track of stream.getTracks()) track.stop();
      setMicrophoneReady(true);
    } catch {
      setError('Microphone access was not granted. Check browser permissions, then retry.');
    } finally { setLoading(false); }
  }

  return <main>
    <p className="eyebrow">Local readiness</p><h1>Set up your thinking companion</h1>
    {!acknowledged ? <section aria-labelledby="privacy-title" className="card">
      <h2 id="privacy-title">Before you continue</h2>
      <p><strong>Speech recognition and voice playback run locally.</strong> For a response, the current transcript, bounded recent conversation context, your validated persona interpretation, and the selected response posture are sent through Pi/Codex to its configured cloud model provider. Raw audio and your full local history are not sent.</p>
      <p>This app does not request an ordinary API key and has no silent metered-provider fallback. The configured provider—not this app—controls its handling, retention, and model-improvement use under your account and settings.</p>
      <p><a href="https://help.openai.com/en/articles/11369540-codex-in-chatgpt-faq" rel="noreferrer">Codex data handling</a> · <a href="https://help.openai.com/en/articles/5722486/data-controls-faq" rel="noreferrer">OpenAI data controls</a> · <a href="https://openai.com/policies/privacy-policy/" rel="noreferrer">OpenAI privacy policy</a></p>
      <button type="button" onClick={continueToReadiness} disabled={loading}>{loading ? 'Checking…' : 'Continue and check readiness'}</button>
    </section> : <section aria-labelledby="status-title" className="card">
      <h2 id="status-title">Readiness</h2><p role="status">Secure local connection established. Audio capture has not started.</p>
      <ul className="readiness-list">{snapshot?.capabilities.map(row => <li key={row.id}><div><strong>{row.label}</strong><span className={`badge ${row.state}`}>{row.state === 'needs_action' ? 'Needs attention' : row.state === 'unavailable' ? 'Unavailable' : 'Ready'}</span></div><p>{row.reason}</p><p><strong>Next:</strong> {row.action}</p></li>)}</ul>
      {!microphoneReady ? <button type="button" onClick={enableMicrophone} disabled={loading}>{loading ? 'Requesting microphone…' : 'Enable microphone'}</button> : <>
        <p className="success" role="status">Microphone permission is ready. Capture is stopped until the session starts.</p>
        <button type="button" onClick={() => capability && props.onStart(capability)} disabled={!capability || !props.sessionAvailable}>Start session</button>
        {!props.sessionAvailable ? <p className="hint">Active conversation is unavailable until the host audio-model integration is ready.</p> : null}
      </>}
      <details><summary>Details</summary><p>Audio sidecar: {snapshot?.sidecar}. Session capability: {capability ? 'issued in memory' : 'not issued'}.</p></details>
    </section>}
    {error ? <p role="alert" className="error">{error}</p> : null}
  </main>;
}
