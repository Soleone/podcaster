import { useEffect, useRef, useState } from 'react';
import { Brain, ChevronDown, CircleAlert, CircleCheck, Info, Mic, Volume2, type LucideIcon } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../lib/utils';
import type { TtsModelDescriptor, VoiceCatalog } from '@app/contracts/settings';

type Capability = { id: string; label: string; state: 'ready' | 'needs_action' | 'unavailable'; reason: string; action: string };
type Snapshot = { capabilities: Capability[]; sidecar: string; reasoning?: 'ready' | 'checking' | 'login_required' | 'unavailable' | 'incompatible' | 'rate_limited'; voiceCatalog?: VoiceCatalog; ttsModels?: TtsModelDescriptor[] };

type ReadinessProps = { sessionAvailable: boolean; onStart: (capability: string, reasoningMode: 'full' | 'transcript_only') => void; onCatalog?: (catalog: VoiceCatalog) => void; onModels?: (models: TtsModelDescriptor[]) => void; onCapability?: (capability: string) => void; className?: string };

const DISCLOSURE_KEY = 'podcaster.disclosure';
const DISCLOSURE_VERSION = 'voice-cloud-boundary-v1';

const capabilityIcons: Record<string, LucideIcon> = { voice_input: Mic, voice_output: Volume2, cloud_reasoning: Brain };
const capabilityBadge: Record<Capability['state'], 'default' | 'secondary' | 'destructive'> = { ready: 'default', needs_action: 'secondary', unavailable: 'destructive' };
const capabilityBadgeLabel: Record<Capability['state'], string> = { ready: 'Ready', needs_action: 'Needs attention', unavailable: 'Unavailable' };

export function Readiness(props: ReadinessProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [capability, setCapability] = useState<string>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
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
          // Publish the complete model set first. Otherwise a persisted Qwen
          // selection can be temporarily reconciled against the legacy
          // Kokoro-only catalog before the model descriptors arrive.
          if (next.ttsModels) props.onModels?.(next.ttsModels);
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
      // Publish the complete model set first. Otherwise a persisted Qwen
      // selection can be temporarily reconciled against the legacy
      // Kokoro-only catalog before the model descriptors arrive.
      if (next.ttsModels) props.onModels?.(next.ttsModels);
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

  async function startSession(reasoningMode: 'full' | 'transcript_only'): Promise<void> {
    if (!capability || starting) return;
    setStarting(true);
    setError(undefined);
    try {
      await props.onStart(capability, reasoningMode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Session could not be started.');
    } finally {
      setStarting(false);
    }
  }

  const subhead = starting
    ? 'Starting your session…'
    : !snapshot && loading
    ? 'Checking local audio and Pi in the background…'
    : realSessionReady && reasoningChecking
      ? 'Pi is still warming up. You can start now.'
      : realSessionReady
        ? 'Everything is ready on this device.'
        : transcriptOnlyReady
          ? 'Transcript-only mode is ready. Assistant responses are unavailable.'
          : 'A few things need your attention before you can start.';

  return <section className={cn('mx-auto my-12 w-[min(46rem,calc(100%_-_2rem))]', props.className)}>
    {!acknowledged ? <Card aria-labelledby="privacy-title">
      <CardHeader>
        <CardTitle><h2 id="privacy-title" className="m-0 text-base leading-snug font-medium">Before you continue</h2></CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <PrivacyStatement />
      </CardContent>
      <CardFooter className="justify-end">
        {/* Primary readiness CTAs keep a 44px touch target while Button stays registry-exact. */}
        <Button className="min-h-11 w-full sm:w-auto" onClick={() => void checkReadiness(true)} disabled={loading}>{loading ? <><Spinner aria-hidden="true" />Checking…</> : 'Continue and check readiness'}</Button>
      </CardFooter>
    </Card> : <Card aria-labelledby="status-title">
      <CardHeader>
        <CardTitle><h2 id="status-title" className="m-0 text-base leading-snug font-medium">Readiness</h2></CardTitle>
        <CardDescription role="status">{subhead}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col">{snapshot?.capabilities.map(row => <CapabilityRow key={row.id} row={row} />)}</ul>
        {!microphoneReady ? <div className="flex flex-wrap justify-end gap-3">
          <Button className="min-h-11 w-full sm:w-auto" onClick={() => void enableMicrophone()} disabled={loading}>{loading ? <><Spinner aria-hidden="true" />{snapshot ? 'Requesting microphone…' : 'Checking readiness…'}</> : 'Enable microphone'}</Button>
        </div> : <>
          <Alert role="status">
            <CircleCheck aria-hidden="true" />
            <AlertDescription>Microphone permission is ready. Capture is stopped until the session starts.</AlertDescription>
          </Alert>
          <div className="flex flex-wrap justify-end gap-3">
            {!transcriptOnlyReady ? <Button className="min-h-11 w-full sm:w-auto" onClick={() => void startSession('full')} disabled={!capability || !canStart || starting}>{starting ? <><Spinner aria-hidden="true" />Starting…</> : 'Start session'}</Button> : null}
            {transcriptOnlyReady ? <Button variant="secondary" className="min-h-11 w-full sm:w-auto" onClick={() => void startSession('transcript_only')} disabled={!capability || starting}>{starting ? <><Spinner aria-hidden="true" />Starting…</> : 'Start transcript-only session'}</Button> : null}
          </div>
          {transcriptOnlyReady ? <p className="text-muted-foreground leading-relaxed" role="status">Pi reasoning is unavailable. Transcript-only mode records stable local transcripts and does not generate or speak assistant responses.</p> : null}
          {!canStart ? <p className="text-muted-foreground leading-relaxed">Active conversation is unavailable until the host audio-model integration is ready.</p> : null}
        </>}
      </CardContent>
      <CardFooter className="flex-wrap gap-3">
        <DisclosureToggle />
        <DetailsToggle sidecar={snapshot?.sidecar} capability={capability} />
      </CardFooter>
    </Card>}
    {error ? <Alert variant="destructive" className="mt-4">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{error}</AlertDescription>
    </Alert> : null}
  </section>;
}

function PrivacyStatement() {
  return <>
    <p className="leading-relaxed"><strong>Speech recognition and voice playback run locally.</strong> For a response, the current transcript, bounded recent conversation context, your saved persona (sent as system instructions to the configured cloud model), and the selected response posture are sent through Pi to its configured cloud model provider. Raw audio and your full local history are not sent. Voice selection always stays on this device.</p>
    <p className="leading-relaxed">This app does not request an ordinary API key and has no silent metered-provider fallback. The configured provider—not this app—controls its handling, retention, and model-improvement use under your account and settings.</p>
    <p className="leading-relaxed text-primary"><a className="underline-offset-4 hover:underline" href="https://help.openai.com/en/articles/11369540-codex-in-chatgpt-faq" rel="noreferrer">Codex data handling</a> · <a className="underline-offset-4 hover:underline" href="https://help.openai.com/en/articles/5722486-data-controls-faq" rel="noreferrer">OpenAI data controls</a> · <a className="underline-offset-4 hover:underline" href="https://openai.com/policies/privacy-policy/" rel="noreferrer">OpenAI privacy policy</a></p>
  </>;
}

function CapabilityRow({ row }: { row: Capability }) {
  const Icon = capabilityIcons[row.id] ?? Info;
  const ready = row.state === 'ready';
  return <li className="flex items-start gap-3 border-t py-3 first:border-t-0 first:pt-0 last:pb-0">
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" aria-hidden="true" /></span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-medium">{row.label}</span>
        <Badge variant={capabilityBadge[row.state]}>{capabilityBadgeLabel[row.state]}</Badge>
      </div>
      {!ready ? <>
        <p className="mt-1 text-sm leading-relaxed">{row.reason}</p>
        {row.action ? <p className="mt-1 text-sm text-muted-foreground"><span className="font-medium text-foreground">Next:</span> {row.action}</p> : null}
      </> : null}
    </div>
  </li>;
}

// Quiet "Privacy terms" affordance that re-opens the disclosure copy in place,
// so the privacy boundary stays re-readable at the moment the user presses Start.
function DisclosureToggle() {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="sm" className="text-muted-foreground" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      Privacy terms
    </Button>
    {open ? <div className="basis-full w-full border-t pt-3" role="region" aria-label="Privacy terms"><PrivacyStatement /></div> : null}
  </>;
}

function DetailsToggle({ sidecar, capability }: { sidecar: string | undefined; capability: string | undefined }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="sm" className="text-muted-foreground" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ChevronDown data-icon="inline-start" className={cn('transition-transform', open && 'rotate-180')} aria-hidden="true" />
      Details
    </Button>
    {open ? <div className="basis-full w-full border-t pt-3" role="region" aria-label="Readiness diagnostics">
      <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Diagnostics</p>
      <p className="text-sm leading-relaxed text-muted-foreground">Audio sidecar: {sidecar ?? 'unknown'}. Session capability: {capability ? 'issued in memory' : 'not issued'}.</p>
    </div> : null}
  </>;
}
