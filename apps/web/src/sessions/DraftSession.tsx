import { useEffect, useState } from 'react';
import { ArrowLeft, Check, CircleAlert, Clock3, Mic, Play, Sparkles } from 'lucide-react';
import type { SessionPlanningRequest, PlanningDepth } from '@app/contracts/settings';
import { MAX_PLANNING_TOPIC_BYTES, PLANNING_DEPTHS } from '@app/contracts/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../lib/utils';
import { sessionStartBlocker, type ServiceStatuses } from '../services/service-status';
import type { StableTurnWriter } from '../storage/stable-turn-writer';
import { MAX_SESSION_TITLE_LENGTH } from '../storage/schema';
import type { SessionPreparationDraft, StoredSession } from '../storage/schema';
import { StoppedSession } from './StoppedSession';

export interface DraftSessionProps {
  writer: StableTurnWriter;
  sessionId: string;
  agentName: string;
  serviceStatuses: ServiceStatuses;
  capability: string | undefined;
  microphoneGranted: boolean;
  privacyAcknowledged: boolean;
  onConnectServices: () => void;
  onEnableMicrophone: () => void | Promise<void>;
  onStart: (planning?: SessionPlanningRequest) => Promise<void>;
  onBack: () => void;
  onContinue: () => void;
}

const defaultPreparation: SessionPreparationDraft = { enabled: false, topic: '', depth: 'standard' };

export function DraftSession(props: DraftSessionProps) {
  const [session, setSession] = useState<StoredSession | undefined>();
  const [title, setTitle] = useState('');
  const [preparation, setPreparation] = useState<SessionPreparationDraft>(defaultPreparation);
  const [hydrated, setHydrated] = useState(false);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void props.writer.getSession(props.sessionId).then(value => {
      if (cancelled) return;
      setSession(value);
      setTitle(value?.title ?? '');
      setPreparation(value?.preparation ?? defaultPreparation);
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [props.sessionId, props.writer]);

  useEffect(() => {
    if (!hydrated || session?.state !== 'draft') return;
    const timer = setTimeout(() => {
      setSaving(true);
      void props.writer.updateDraftSession(props.sessionId, preparation, title).then(result => {
        if (!result.ok) setError(result.degradedReason ?? 'The session details could not be saved.');
      }).finally(() => setSaving(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [hydrated, preparation, props.sessionId, props.writer, session?.state, title]);

  if (!hydrated) return <main className="mx-auto mt-5 mb-8 flex w-[min(56rem,calc(100%_-_2rem))] items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading session…</main>;
  if (!session) return <main className="mx-auto mt-5 mb-8 w-[min(56rem,calc(100%_-_2rem))]"><Card className="mx-auto max-w-md text-center"><CardHeader><CardTitle>Session not found</CardTitle><CardDescription>This session may have been removed from this device.</CardDescription></CardHeader><CardFooter className="justify-center"><Button variant="outline" onClick={props.onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />All sessions</Button></CardFooter></Card></main>;
  if (session.state !== 'draft') return <StoppedSession writer={props.writer} sessionId={props.sessionId} agentName={props.agentName} onContinue={props.onContinue} onBack={props.onBack} />;

  const topic = preparation.topic.trim();
  const topicBytes = new TextEncoder().encode(topic).length;
  const topicInvalid = preparation.enabled && (!topic || topicBytes > MAX_PLANNING_TOPIC_BYTES);
  const blocker = props.privacyAcknowledged
    ? sessionStartBlocker(props.serviceStatuses, props.microphoneGranted, props.capability)
    : 'Review privacy terms in Services before starting.';
  const canStart = !blocker && !topicInvalid && !starting;
  const serviceWaiting = Boolean(blocker);
  const serviceMessage = !props.privacyAcknowledged
    ? 'Connect services from the app bar before starting. You can keep editing this session while you decide.'
    : blocker?.toLowerCase().includes('microphone')
      ? 'Microphone access is the only remaining step. You can grant it from Services or here.'
      : blocker?.toLowerCase().includes('connect services')
        ? 'Services are not connected yet. Use Services in the app bar to connect them.'
        : blocker
          ? 'Your session is saved. You can keep editing it while the required services start.'
        : 'Audio and Pi are ready. Start when you are ready.';

  const enableMicrophone = async () => {
    setMicrophoneError(undefined);
    try { await props.onEnableMicrophone(); }
    catch (cause) { setMicrophoneError(cause instanceof Error ? cause.message : 'Microphone access was not granted.'); }
  };

  const start = async () => {
    if (!canStart || starting) return;
    setError(undefined);
    if (topicInvalid) {
      setError('Add a short topic for preparation, or turn preparation off.');
      return;
    }
    setStarting(true);
    try {
      const saved = await props.writer.updateDraftSession(props.sessionId, preparation, title);
      if (!saved.ok) throw new Error(saved.degradedReason ?? 'The session details could not be saved.');
      const planning = preparation.enabled ? { topic, depth: preparation.depth } : undefined;
      await props.onStart(planning);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The session could not be started.');
    } finally {
      setStarting(false);
    }
  };

  return <main className="mx-auto mt-5 mb-8 w-[min(56rem,calc(100%_-_2rem))]">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground" onClick={props.onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />All sessions</Button>
        <h1 className="text-2xl font-semibold leading-tight tracking-tight">New session</h1>
        <p className="mt-1 text-sm text-muted-foreground">Set the direction now. The microphone stays off until you start.</p>
      </div>
      <Badge variant="secondary"><Clock3 aria-hidden="true" />Not started</Badge>
    </header>

    <FieldGroup className="mt-6">
      <Field>
        <FieldLabel htmlFor="session-title">Session title</FieldLabel>
        <Input
          id="session-title"
          value={title}
          onChange={event => setTitle(event.target.value)}
          maxLength={MAX_SESSION_TITLE_LENGTH}
          placeholder="What should you remember this session by?"
          autoComplete="off"
          disabled={starting}
        />
        <FieldDescription>Give this session a name so it is easy to spot in your archive.</FieldDescription>
      </Field>
    </FieldGroup>

    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Prepare the conversation</CardTitle>
        <CardDescription>Optional private notes can give the live conversation a useful starting point.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input className="mt-0.5 size-4 accent-primary" type="checkbox" checked={preparation.enabled} onChange={event => setPreparation(value => ({ ...value, enabled: event.target.checked }))} disabled={starting} />
          <span><span className="font-medium">Prepare before going live</span><span className="mt-1 block text-muted-foreground">A bounded research pass creates private notes, talking points, and questions before capture begins.</span></span>
        </label>
        {preparation.enabled ? <div className="grid gap-4 border-t pt-4">
          <label className="grid gap-1.5 text-sm"><span className="font-medium">Rough topic</span><textarea className={cn('min-h-24 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring', topicInvalid && 'border-destructive')} value={preparation.topic} onChange={event => setPreparation(value => ({ ...value, topic: event.target.value }))} maxLength={2048} placeholder="What do you want to explore?" aria-invalid={topicInvalid} disabled={starting} /><span className="text-xs text-muted-foreground">Keep it brief. This is sent to the configured research provider.</span></label>
          <label className="grid gap-1.5 text-sm"><span className="font-medium">Preparation depth</span><select className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={preparation.depth} onChange={event => setPreparation(value => ({ ...value, depth: event.target.value as PlanningDepth }))} disabled={starting}>{PLANNING_DEPTHS.map(value => <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
        </div> : null}
        {saving ? <p className="text-xs text-muted-foreground" role="status">Saving session details…</p> : null}
      </CardContent>
    </Card>

    <Card className={cn('mt-4', serviceWaiting && 'border-amber-500/30')}>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          {serviceWaiting ? <CircleAlert className="size-4 text-amber-600" aria-hidden="true" /> : <Check className="size-4 text-emerald-600" aria-hidden="true" />}
          <span>{serviceWaiting ? 'Waiting to start' : 'Ready to start'}</span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{serviceMessage}</p>
        {(!props.privacyAcknowledged || !props.capability) ? <Button variant="outline" className="w-full sm:w-fit" onClick={props.onConnectServices}>{props.privacyAcknowledged ? 'Reconnect services' : 'Review privacy &amp; connect'}</Button> : null}
        {props.privacyAcknowledged && !props.microphoneGranted ? <Button variant="outline" className="w-full sm:w-fit" onClick={() => void enableMicrophone()} disabled={starting}><Mic data-icon="inline-start" aria-hidden="true" />Enable microphone</Button> : null}
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button className="min-h-11 w-full sm:w-auto" onClick={() => void start()} disabled={!canStart}>{starting ? <><Spinner aria-hidden="true" />Starting…</> : preparation.enabled ? <><Sparkles data-icon="inline-start" aria-hidden="true" />Prepare and start</> : <><Play data-icon="inline-start" aria-hidden="true" />Start session</>}</Button>
      </CardFooter>
    </Card>

    {microphoneError ? <Alert variant="destructive" className="mt-4"><AlertDescription>{microphoneError}</AlertDescription></Alert> : null}
    {error ? <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
  </main>;
}
