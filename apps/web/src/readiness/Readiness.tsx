import { useEffect, useRef, useState } from 'react';

type Capability = { id: string; label: string; state: 'ready' | 'needs_action' | 'unavailable'; reason: string; action: string };
type Snapshot = { capabilities: Capability[]; sidecar: string; reasoning?: string };

const DISCLOSURE_KEY = 'podcaster.disclosure';
const DISCLOSURE_VERSION = 'voice-cloud-boundary-v1';

export function Readiness(props: { sessionAvailable: boolean; onStart: (capability: string, reasoningMode: 'full' | 'transcript_only') => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [capability, setCapability] = useState<string>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      if (localStorage.getItem(DISCLOSURE_KEY) === DISCLOSURE_VERSION) void checkReadiness(false);
    } catch { /* storage may be unavailable; show disclosure normally */ }
  }, []);

  useEffect(() => {
    if (!acknowledged || !capability || snapshot?.sidecar === 'ready') return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/readiness', { method: 'POST', credentials: 'same-origin', headers: { 'x-podcaster-capability': capability } });
        if (response.ok && !cancelled) setSnapshot(await response.json() as Snapshot);
      } catch { /* the visible snapshot remains authoritative until the next retry */ }
    };
    const timer = setInterval(() => void refresh(), 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [acknowledged, capability, snapshot?.sidecar]);

  async function restoreMicrophonePermission() {
    try {
      const permission = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      if (permission?.state === 'granted') setMicrophoneReady(true);
    } catch { /* permission status is optional; explicit button remains available */ }
  }

  async function checkReadiness(remember: boolean) {
    setLoading(true); setError(undefined);
    try {
      const bootstrap = await fetch('/api/bootstrap', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disclosureAcknowledged: true }) });
      if (!bootstrap.ok) throw new Error('Secure bootstrap failed. Retry from this page.');
      const boot = await bootstrap.json() as { capability: string };
      const response = await fetch('/api/readiness', { method: 'POST', credentials: 'same-origin', headers: { 'x-podcaster-capability': boot.capability } });
      if (!response.ok) throw new Error('Readiness check failed. Retry from this page.');
      setCapability(boot.capability); setSnapshot(await response.json() as Snapshot); setAcknowledged(true);
      if (remember) {
        try { localStorage.setItem(DISCLOSURE_KEY, DISCLOSURE_VERSION); } catch { /* session can continue without persistence */ }
      }
      await restoreMicrophonePermission();
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

  const audioReady = snapshot?.sidecar === 'ready';
  const reasoningReady = snapshot?.capabilities.find(item => item.id === 'cloud_reasoning')?.state === 'ready';
  const realSessionReady = audioReady && reasoningReady;
  const transcriptOnlyReady = audioReady && !reasoningReady;
  const canStart = props.sessionAvailable || realSessionReady || transcriptOnlyReady;

  return <main>
    <p className="eyebrow">Local readiness</p><h1>Set up your thinking companion</h1>
    {!acknowledged ? <section aria-labelledby="privacy-title" className="card">
      <h2 id="privacy-title">Before you continue</h2>
      <p><strong>Speech recognition and voice playback run locally.</strong> For a response, the current transcript, bounded recent conversation context, your validated persona interpretation, and the selected response posture are sent through Pi/Codex to its configured cloud model provider. Raw audio and your full local history are not sent.</p>
      <p>This app does not request an ordinary API key and has no silent metered-provider fallback. The configured provider—not this app—controls its handling, retention, and model-improvement use under your account and settings.</p>
      <p><a href="https://help.openai.com/en/articles/11369540-codex-in-chatgpt-faq" rel="noreferrer">Codex data handling</a> · <a href="https://help.openai.com/en/articles/5722486/data-controls-faq" rel="noreferrer">OpenAI data controls</a> · <a href="https://openai.com/policies/privacy-policy/" rel="noreferrer">OpenAI privacy policy</a></p>
      <button type="button" onClick={() => void checkReadiness(true)} disabled={loading}>{loading ? 'Checking…' : 'Continue and check readiness'}</button>
    </section> : <section aria-labelledby="status-title" className="card">
      <h2 id="status-title">Readiness</h2><p role="status">Secure local connection established. Audio capture has not started.</p>
      <ul className="readiness-list">{snapshot?.capabilities.map(row => <li key={row.id}><div><strong>{row.label}</strong><span className={`badge ${row.state}`}>{row.state === 'needs_action' ? 'Needs attention' : row.state === 'unavailable' ? 'Unavailable' : 'Ready'}</span></div><p>{row.reason}</p><p><strong>Next:</strong> {row.action}</p></li>)}</ul>
      {!microphoneReady ? <button type="button" onClick={enableMicrophone} disabled={loading}>{loading ? 'Requesting microphone…' : 'Enable microphone'}</button> : <>
        <p className="success" role="status">Microphone permission is ready. Capture is stopped until the session starts.</p>
        {!transcriptOnlyReady ? <button type="button" onClick={() => capability && props.onStart(capability, 'full')} disabled={!capability || !canStart}>Start session</button> : null}
        {transcriptOnlyReady ? <>
          <p className="hint" role="status">Pi reasoning is unavailable. Transcript-only mode records stable local transcripts and does not generate or speak assistant responses.</p>
          <button type="button" onClick={() => capability && props.onStart(capability, 'transcript_only')} disabled={!capability}>Start transcript-only session</button>
        </> : null}
        {!canStart ? <p className="hint">Active conversation is unavailable until the host audio-model integration is ready.</p> : null}
      </>}
      <details><summary>Details</summary><p>Audio sidecar: {snapshot?.sidecar}. Session capability: {capability ? 'issued in memory' : 'not issued'}.</p></details>
    </section>}
    {error ? <p role="alert" className="error">{error}</p> : null}
  </main>;
}
