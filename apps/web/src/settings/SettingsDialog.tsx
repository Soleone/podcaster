import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Play, Settings, Square } from 'lucide-react';
import { MAX_AGENT_NAME_BYTES, MAX_PERSONA_BYTES, PODCASTER_SYSTEM_PROMPT, utf8ByteLength, type VoiceCatalog, type VoicePreference } from '@app/contracts/settings';
import { Alert } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../lib/utils';
import type { SettingsModel } from './settings-model';
import { stopVoicePreview, type VoicePreviewHandle } from './voice-preview';

const VOICE_NOTICE_COPY = {
  rebase: 'Your saved voice is still available on the current audio engine. It was moved to the new catalog.',
  defaulted: 'Your saved voice is no longer available on the current audio engine. The verified default was selected instead.',
  missing_catalog: 'No verified voice catalog is available yet. Voice output is unavailable until the local audio engine is ready.',
} as const;

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: SettingsModel;
  catalog: VoiceCatalog | undefined;
  saving: boolean;
  saveError: string | undefined;
  onSave: (agentName: string, persona: string, voice: VoicePreference) => Promise<void>;
  onPreviewVoice?: (voiceId: string) => Promise<VoicePreviewHandle>;
}

export function SettingsDialog({ open, onOpenChange, model, catalog, saving, saveError, onSave, onPreviewVoice }: SettingsDialogProps) {
  const [agentName, setAgentName] = useState(model.agentName);
  const [persona, setPersona] = useState(model.persona);
  const [voiceId, setVoiceId] = useState(model.voice.voiceId);
  const [promptOpen, setPromptOpen] = useState(false);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const previewHandleRef = useRef<VoicePreviewHandle | undefined>(undefined);

  useEffect(() => {
    // Stop anything audible before the dialog resets or closes; the unmount
    // cleanup below covers the remaining lifecycles.
    stopVoicePreview();
    previewHandleRef.current = undefined;
    if (!open) return;
    setAgentName(model.agentName);
    setPersona(model.persona);
    setVoiceId(model.voice.voiceId);
    setPromptOpen(false);
    setPreviewState('idle');
    setPreviewError(undefined);
  }, [open, model.agentName, model.persona, model.voice.voiceId]);

  useEffect(() => () => { previewHandleRef.current?.stop(); }, []);

  const agentNameBytes = useMemo(() => utf8ByteLength(agentName), [agentName]);
  const agentNameInvalid = agentNameBytes > MAX_AGENT_NAME_BYTES;
  const personaBytes = useMemo(() => utf8ByteLength(persona), [persona]);
  const personaInvalid = personaBytes > MAX_PERSONA_BYTES;
  const catalogReady = Boolean(catalog && catalog.voices.length > 0);
  const selectedVoice = catalog?.voices.find(voice => voice.id === voiceId);
  const canSave = !agentNameInvalid && !personaInvalid && !saving;

  const commit = async () => {
    if (!canSave) return;
    const voice: VoicePreference = { catalogId: catalog?.catalogId ?? '', voiceId: catalogReady ? voiceId : '' };
    await onSave(agentName, persona, voice);
  };

  const togglePreview = async () => {
    if (previewState === 'playing') {
      previewHandleRef.current?.stop();
      previewHandleRef.current = undefined;
      setPreviewState('idle');
      return;
    }
    if (previewState === 'loading' || !onPreviewVoice || !catalogReady) return;
    setPreviewError(undefined);
    setPreviewState('loading');
    try {
      const handle = await onPreviewVoice(voiceId);
      // The dialog may have closed or moved on while the fetch was in flight.
      previewHandleRef.current = handle;
      setPreviewState('playing');
      void handle.finished.then(
        () => {
          if (previewHandleRef.current === handle) { previewHandleRef.current = undefined; setPreviewState('idle'); }
        },
        () => {
          if (previewHandleRef.current === handle) { previewHandleRef.current = undefined; setPreviewState('idle'); setPreviewError('The preview stopped before it finished.'); }
        },
      );
    } catch {
      previewHandleRef.current = undefined;
      setPreviewState('idle');
      setPreviewError('Voice preview is unavailable right now. It needs the audio engine free, so try before starting a session.');
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="h-[min(46rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-lg" aria-describedby="settings-description">
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription id="settings-description">These apply to the next session you start. The active session is never changed mid-turn.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex flex-col gap-4">
        <Tabs defaultValue="agent" className="min-h-0 min-w-0 flex-1">
          <TabsList aria-label="Settings sections" className="w-full shrink-0">
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="voice">Voice</TabsTrigger>
          </TabsList>
          <TabsContent value="agent" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pt-4 pr-1">
            <FieldGroup>
              <Field data-invalid={agentNameInvalid || undefined}>
                <FieldLabel htmlFor="settings-agent-name">Agent name</FieldLabel>
                <FieldContent>
                  <Input
                    id="settings-agent-name"
                    value={agentName}
                    onChange={event => setAgentName(event.target.value)}
                    aria-invalid={agentNameInvalid || undefined}
                    aria-describedby="settings-agent-name-description settings-agent-name-counter"
                    placeholder="e.g. Oliver"
                    maxLength={MAX_AGENT_NAME_BYTES}
                  />
                  <FieldDescription id="settings-agent-name-description">Name shown above the assistant's messages in the conversation. It is kept out of the system prompt.</FieldDescription>
                  <p id="settings-agent-name-counter" className={cn('text-xs text-muted-foreground', agentNameInvalid && 'text-destructive')} aria-live="polite">
                    {agentNameBytes.toLocaleString()} / {MAX_AGENT_NAME_BYTES.toLocaleString()} bytes
                  </p>
                  {agentNameInvalid ? <FieldError>Agent name exceeds the {MAX_AGENT_NAME_BYTES}-byte limit.</FieldError> : null}
                </FieldContent>
              </Field>
              <Field data-invalid={personaInvalid || undefined}>
                <FieldLabel htmlFor="settings-persona">Persona</FieldLabel>
                <FieldContent>
                  <Textarea
                    id="settings-persona"
                    value={persona}
                    onChange={event => setPersona(event.target.value)}
                    aria-invalid={personaInvalid || undefined}
                    aria-describedby="settings-persona-description settings-persona-counter"
                    placeholder="Describe how the assistant should behave…"
                    className="h-48 min-h-40 resize-none"
                  />
                  <FieldDescription id="settings-persona-description">Free-form instructions appended to the base system prompt when the next session starts. Empty is allowed.</FieldDescription>
                  <p id="settings-persona-counter" className={cn('text-xs text-muted-foreground', personaInvalid && 'text-destructive')} aria-live="polite">
                    {personaBytes.toLocaleString()} / {MAX_PERSONA_BYTES.toLocaleString()} bytes
                  </p>
                  {personaInvalid ? <FieldError>Persona exceeds the {MAX_PERSONA_BYTES / 1024} KiB limit.</FieldError> : null}
                </FieldContent>
              </Field>
            </FieldGroup>
            <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
              <CollapsibleTrigger render={<Button variant="outline" className="w-full justify-between" />}>
                View base system prompt
                <ChevronDown className={cn('size-4 transition-transform', promptOpen && 'rotate-180')} aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">{PODCASTER_SYSTEM_PROMPT}</pre>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Your saved persona is appended to this base prompt when the next session starts.</p>
              </CollapsibleContent>
            </Collapsible>
          </TabsContent>
          <TabsContent value="voice" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pt-4 pr-1 sm:justify-center">
            {model.notice ? <Alert variant={model.notice === 'missing_catalog' ? 'destructive' : 'default'}><p>{VOICE_NOTICE_COPY[model.notice]}</p></Alert> : null}
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-voice">Voice</FieldLabel>
                <FieldContent>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      {catalogReady ? <Select value={voiceId} onValueChange={value => { if (value) { setVoiceId(value); if (previewHandleRef.current) { previewHandleRef.current.stop(); previewHandleRef.current = undefined; setPreviewState('idle'); } } }} disabled={!catalogReady}>
                        <SelectTrigger id="settings-voice" className="w-full" aria-label="Voice">
                          <SelectValue>{selectedVoice?.label ?? voiceId}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {catalog!.voices.map(voice => <SelectItem key={voice.id} value={voice.id}>{voice.label}</SelectItem>)}
                          </SelectGroup>
                        </SelectContent>
                      </Select> : <p className="text-sm text-muted-foreground">Voice options appear once the local audio engine reports its verified voices.</p>}
                    </div>
                    {catalogReady && onPreviewVoice ? <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      title={previewState === 'playing' ? 'Stop voice preview' : 'Preview voice'}
                      aria-label={previewState === 'playing' ? 'Stop voice preview' : 'Preview voice'}
                      disabled={previewState === 'loading'}
                      onClick={() => void togglePreview()}
                    >
                      {previewState === 'loading' ? <Spinner /> : previewState === 'playing' ? <Square className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                    </Button> : null}
                  </div>
                  {previewError ? <p className="text-xs text-destructive" role="status">{previewError}</p> : null}
                  {catalog ? <FieldDescription>Backend {catalog.backendId} · model {catalog.modelId} · revision {catalog.revision.slice(0, 8)}</FieldDescription> : null}
                </FieldContent>
              </Field>
            </FieldGroup>
          </TabsContent>
        </Tabs>
        {saveError ? <Alert variant="destructive" className="shrink-0"><p>{saveError}</p></Alert> : null}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={saving}>Cancel</Button>} />
        <Button onClick={() => void commit()} disabled={!canSave}>
          {saving ? <><Spinner />Saving…</> : 'Save settings'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function SettingsButton({ onClick, title = 'Open settings' }: { onClick: () => void; title?: string }) {
  return <Button variant="outline" size="icon" className="size-9" title={title} aria-label={title} onClick={onClick}><Settings className="size-4" aria-hidden="true" /></Button>;
}
