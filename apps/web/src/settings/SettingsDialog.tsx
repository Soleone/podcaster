import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Settings, Sparkles } from 'lucide-react';
import { MAX_PERSONA_BYTES, PODCASTER_SYSTEM_PROMPT, utf8ByteLength, type VoiceCatalog, type VoicePreference } from '@app/contracts/settings';
import { Alert } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../components/ui/field';
import { ScrollArea } from '../components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../lib/utils';
import type { SettingsModel } from './settings-model';

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
  onSave: (persona: string, voice: VoicePreference) => Promise<void>;
}

export function SettingsDialog({ open, onOpenChange, model, catalog, saving, saveError, onSave }: SettingsDialogProps) {
  const [persona, setPersona] = useState(model.persona);
  const [voiceId, setVoiceId] = useState(model.voice.voiceId);
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPersona(model.persona);
    setVoiceId(model.voice.voiceId);
    setPromptOpen(false);
  }, [open, model.persona, model.voice.voiceId]);

  const personaBytes = useMemo(() => utf8ByteLength(persona), [persona]);
  const personaInvalid = personaBytes > MAX_PERSONA_BYTES;
  const catalogReady = Boolean(catalog && catalog.voices.length > 0);
  const selectedVoice = catalog?.voices.find(voice => voice.id === voiceId);
  const canSave = !personaInvalid && !saving;

  const commit = async () => {
    if (!canSave) return;
    const voice: VoicePreference = { catalogId: catalog?.catalogId ?? '', voiceId: catalogReady ? voiceId : '' };
    await onSave(persona, voice);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-lg" aria-describedby="settings-description">
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription id="settings-description">These apply to the next session you start. The active session is never changed mid-turn.</DialogDescription>
      </DialogHeader>
      <Tabs defaultValue="agent">
        <TabsList aria-label="Settings sections">
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="voice">Voice</TabsTrigger>
        </TabsList>
        <TabsContent value="agent" className="flex flex-col gap-4 pt-4">
          <FieldGroup>
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
                  className="min-h-40"
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
              <ScrollArea className="max-h-56 rounded-lg border border-border bg-muted/40 p-3">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">{PODCASTER_SYSTEM_PROMPT}</pre>
              </ScrollArea>
              <p className="mt-2 text-xs text-muted-foreground">Your saved persona is appended to this base prompt when the next session starts.</p>
            </CollapsibleContent>
          </Collapsible>
        </TabsContent>
        <TabsContent value="voice" className="flex flex-col gap-4 pt-4">
          {model.notice ? <Alert variant={model.notice === 'missing_catalog' ? 'destructive' : 'default'}><p>{VOICE_NOTICE_COPY[model.notice]}</p></Alert> : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-voice">Voice</FieldLabel>
              <FieldContent>
                {catalogReady ? <Select value={voiceId} onValueChange={value => { if (value) setVoiceId(value); }} disabled={!catalogReady}>
                  <SelectTrigger id="settings-voice" className="w-full" aria-label="Voice">
                    <SelectValue>{selectedVoice?.label ?? voiceId}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {catalog!.voices.map(voice => <SelectItem key={voice.id} value={voice.id}>
                      <span className="flex items-center gap-2"><Sparkles className="size-4" aria-hidden="true" />{voice.label}<span className="font-mono text-xs text-muted-foreground">{voice.id}</span></span>
                    </SelectItem>)}
                  </SelectContent>
                </Select> : <p className="text-sm text-muted-foreground">Voice options appear once the local audio engine reports its verified voices.</p>}
                {catalog ? <FieldDescription>Backend {catalog.backendId} · model {catalog.modelId} · revision {catalog.revision.slice(0, 8)}</FieldDescription> : null}
              </FieldContent>
            </Field>
          </FieldGroup>
        </TabsContent>
      </Tabs>
      {saveError ? <Alert variant="destructive"><p>{saveError}</p></Alert> : null}
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
