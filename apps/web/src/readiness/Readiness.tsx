import { useEffect, useRef, useState } from 'react';
import { Brain, ChevronDown, CircleAlert, CircleCheck, Info, Mic, Volume2, type LucideIcon } from 'lucide-react';
import { Alert } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../lib/utils';
import { SettingsButton } from '../settings/SettingsDialog';
import './readiness.css';

type Capability = { id: string; label: string; state: 'ready' | 'needs_action' | 'unavailable'; reason: string; action: string };
type VoiceInfo = { id: string; label: string };
type VoiceCatalog = { catalogId: string; backendId: string; modelId: string; runtimeConfigId: string; revision: string; defaultVoiceId: string; voices: VoiceInfo[] };
type Snapshot = { capabilities: Capability[]; sidecar: string; reasoning?: 'ready' | 'checking' | 'login_required' | 'unavailable' | 'incompatible' | 'rate_limited'; voiceCatalog?: VoiceCatalog };

const DISCLOSURE_KEY = 'podcaster.disclosure';
const DISCLOSURE_VERSION = 'voice-cloud-boundary-v1';

const capabilityIcons: Record<string, LucideIcon> = { voice_input: Mic, voice_output: Volume2, cloud_reasoning: Brain };
const capabilityBadge: Record<Capability['state'], 'success' | 'warning' | 'destructive'> = { ready: 'success', needs_action: 'warning', unavailable: 'destructive' };
const capabilityBadgeLabel: Record<Capability['state'], string> = { ready: 'Ready', needs_action: 'Needs attention', unavailable: 'Unavailable' };

export function Readiness(props: { sessionAvailable: boolean; onStart: (capability: string, reasoningMode: 'full' | 'transcript_only') => void; onCatalog?: (catalog: VoiceCatalog) => void; onOpenSettings: () => void; onCapability?: (capability: string) => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [capability, setCapability] = useState<string>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const restored = useRef(false);
  const lastReportedMic = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      if (localStorage.getItem(DISCLOSURE_KEY) === DISCLOSURE_VERSION) {
        // Returning users should not see the disclosure card while the readiness
        // check is doing network and local-runtime work in the background.
        setAcknowledged(true);
        void checkReadiness(false);
      }
    } catch { /* storage may be unavailable; show disclosure normally */ }
  }, []);

  useEffect(() => {
    if (!acknowledged || !capability) return;
    // Poll while the sidecar is still starting; once ready, only refresh to
    // re-report microphone-state changes so the voice-input row stops showing a
    // stale needs-action warning after the mic is granted.
    if (snapshot?.sidecar === 'ready' && lastReportedMic.current === microphoneReady) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/readiness', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-podcaster-capability': capability },
          body: JSON.stringify({ microphoneGranted: microphoneReady }),
        });
        if (response.ok && !cancelled) {
          lastReportedMic.current = microphoneReady;
          const next = await response.json() as Snapshot;
          setSnapshot(next);
          if (next.voiceCatalog) props.onCatalog?.(next.voiceCatalog);
        }
      } catch { /* the visible snapshot remains authoritative until the next retry */ }
    };
    const timer = setInterval(() => void refresh(), 2_000);
    void refresh();
    return () => { cancelled = true; clearInterval(timer); };
  }, [acknowledged, capability, snapshot?.sidecar, microphoneReady]);

  async function microphoneGrantedStatus(): Promise<boolean> {
    try {
      const permission = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      return permission?.state === 'granted';
    } catch {
      return false;
    }
  }

  async function checkReadiness(remember: boolean) {
    setLoading(true); setError(undefined);
    try {
      const bootstrap = await fetch('/api/bootstrap', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disclosureAcknowledged: true }) });
      if (!bootstrap.ok) throw new Error('Secure bootstrap failed. Retry from this page.');
      const boot = await bootstrap.json() as { capability: string };
      const granted = await microphoneGrantedStatus();
      const response = await fetch('/api/readiness', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-podcaster-capability': boot.capability }, body: JSON.stringify({ microphoneGranted: granted }) });
      if (!response.ok) throw new Error('Readiness check failed. Retry from this page.');
      setCapability(boot.capability);
      props.onCapability?.(boot.capability);
      const next = await response.json() as Snapshot;
      setSnapshot(next);
      if (next.voiceCatalog) props.onCatalog?.(next.voiceCatalog);
      setAcknowledged(true);
      if (remember) {
        try { localStorage.setItem(DISCLOSURE_KEY, DISCLOSURE_VERSION); } catch { /* session can continue without persistence */ }
      }
      if (granted) setMicrophoneReady(true);
    } catch (cause) {
      // If a returning user's silent refresh fails, restore the explicit retry
      // surface instead of leaving them on an unusable status card.
      setAcknowledged(false);
      setError(cause instanceof Error ? cause.message : 'Readiness failed.');
    }
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
  const reasoningChecking = snapshot?.reasoning === 'checking';
  const reasoningUnavailable = Boolean(snapshot?.reasoning && snapshot.reasoning !== 'ready' && !reasoningChecking);
  const realSessionReady = audioReady && (reasoningReady || reasoningChecking);
  const transcriptOnlyReady = audioReady && reasoningUnavailable;
  const canStart = props.sessionAvailable || realSessionReady || transcriptOnlyReady;

  const subhead = !snapshot && loading
    ? 'Checking local audio and Pi in the background…'
    : realSessionReady && reasoningChecking
      ? 'Pi is still warming up. You can start now.'
      : realSessionReady
        ? 'Everything is ready on this device.'
        : transcriptOnlyReady
          ? 'Transcript-only mode is ready. Assistant responses are unavailable.'
          : 'A few things need your attention before you can start.';

  return <main className="readiness-shell">
    <header className="readiness-header">
      <div>
        <p className="eyebrow">Get started</p>
        <h1 className="readiness-title">Set up your thinking companion</h1>
      </div>
      {acknowledged ? <SettingsButton onClick={props.onOpenSettings} /> : null}
    </header>
    {!acknowledged ? <Card className="readiness-card" aria-labelledby="privacy-title">
      <div className="readiness-card-head">
        <h2 id="privacy-title" className="readiness-card-title">Before you continue</h2>
      </div>
      <PrivacyStatement />
      <div className="readiness-actions"><Button onClick={() => void checkReadiness(true)} disabled={loading}>{loading ? <><Spinner />Checking…</> : 'Continue and check readiness'}</Button></div>
    </Card> : <Card className="readiness-card" aria-labelledby="status-title">
      <div className="readiness-card-head">
        <h2 id="status-title" className="readiness-card-title">Readiness</h2>
        <p role="status" className="readiness-subhead">{subhead}</p>
      </div>
      <ul className="capability-list">{snapshot?.capabilities.map(row => <CapabilityRow key={row.id} row={row} />)}</ul>
      {!microphoneReady ? <div className="readiness-actions"><Button onClick={() => void enableMicrophone()} disabled={loading}>{loading ? <><Spinner />{snapshot ? 'Requesting microphone…' : 'Checking readiness…'}</> : 'Enable microphone'}</Button></div> : <>
        <Alert role="status" variant="success" className="readiness-note"><CircleCheck className="size-4 mt-0.5 shrink-0 text-success" aria-hidden="true" /><p>Microphone permission is ready. Capture is stopped until the session starts.</p></Alert>
        <div className="readiness-actions">
          {!transcriptOnlyReady ? <Button onClick={() => capability && props.onStart(capability, 'full')} disabled={!capability || !canStart}>Start session</Button> : null}
          {transcriptOnlyReady ? <Button variant="secondary" onClick={() => capability && props.onStart(capability, 'transcript_only')} disabled={!capability}>Start transcript-only session</Button> : null}
        </div>
        {transcriptOnlyReady ? <p className="text-muted-foreground mt-3 leading-relaxed" role="status">Pi reasoning is unavailable. Transcript-only mode records stable local transcripts and does not generate or speak assistant responses.</p> : null}
        {!canStart ? <p className="text-muted-foreground mt-3 leading-relaxed">Active conversation is unavailable until the host audio-model integration is ready.</p> : null}
      </>}
      <div className="readiness-foot">
        <DisclosureToggle />
        <DetailsToggle sidecar={snapshot?.sidecar} capability={capability} />
      </div>
    </Card>}
    {error ? <Alert variant="destructive" className="readiness-note"><CircleAlert className="size-4 mt-0.5 shrink-0 text-destructive" aria-hidden="true" /><p>{error}</p></Alert> : null}
  </main>;
}

function PrivacyStatement() {
  return <>
    <p className="readiness-copy"><strong>Speech recognition and voice playback run locally.</strong> For a response, the current transcript, bounded recent conversation context, your saved persona (sent as system instructions to the configured cloud model), and the selected response posture are sent through Pi to its configured cloud model provider. Raw audio and your full local history are not sent. Voice selection always stays on this device.</p>
    <p className="readiness-copy">This app does not request an ordinary API key and has no silent metered-provider fallback. The configured provider—not this app—controls its handling, retention, and model-improvement use under your account and settings.</p>
    <p className="readiness-links"><a href="https://help.openai.com/en/articles/11369540-codex-in-chatgpt-faq" rel="noreferrer">Codex data handling</a> · <a href="https://help.openai.com/en/articles/5722486-data-controls-faq" rel="noreferrer">OpenAI data controls</a> · <a href="https://openai.com/policies/privacy-policy/" rel="noreferrer">OpenAI privacy policy</a></p>
  </>;
}

function CapabilityRow({ row }: { row: Capability }) {
  const Icon = capabilityIcons[row.id] ?? Info;
  const ready = row.state === 'ready';
  return <li className="capability-row">
    <span className="capability-icon"><Icon className="size-4" aria-hidden="true" /></span>
    <div className="capability-body">
      <div className="capability-head">
        <span className="capability-label">{row.label}</span>
        <Badge variant={capabilityBadge[row.state]}>{capabilityBadgeLabel[row.state]}</Badge>
      </div>
      {!ready ? <>
        <p className="capability-reason">{row.reason}</p>
        {row.action ? <p className="capability-action"><span className="capability-next">Next:</span> {row.action}</p> : null}
      </> : null}
    </div>
  </li>;
}

// Quiet "Privacy terms" affordance that re-opens the disclosure copy in place,
// so the privacy boundary stays re-readable at the moment the user presses Start.
function DisclosureToggle() {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="sm" className="readiness-ghost-link" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      Privacy terms
    </Button>
    {open ? <div className="readiness-foot-body" role="region" aria-label="Privacy terms"><PrivacyStatement /></div> : null}
  </>;
}

function DetailsToggle({ sidecar, capability }: { sidecar: string | undefined; capability: string | undefined }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="sm" className="readiness-details-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ChevronDown className={cn('readiness-chevron', open && 'readiness-chevron-open')} aria-hidden="true" />
      Details
    </Button>
    {open ? <div className="readiness-foot-body" role="region" aria-label="Readiness diagnostics">
      <p className="readiness-diagnostics-label">Diagnostics</p>
      <p className="readiness-diagnostics">Audio sidecar: {sidecar ?? 'unknown'}. Session capability: {capability ? 'issued in memory' : 'not issued'}.</p>
    </div> : null}
  </>;
}