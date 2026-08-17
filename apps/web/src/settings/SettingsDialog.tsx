import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { DEFAULT_QWEN_VOICE_LANGUAGE, DEFAULT_TTS_MODEL, MAX_AGENT_NAME_BYTES, MAX_PERSONA_BYTES, MAX_VOICE_TONE_PROMPT_BYTES, PODCASTER_SYSTEM_PROMPT, QWEN_VOICE_LANGUAGES, ttsModelKey, voiceSpeedCapability, utf8ByteLength, withCustomVoices, type QwenVoiceLanguage, type TtsModelDescriptor, type TtsModelSelection, type VoiceCatalog, type VoicePreference } from '@app/contracts/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupText, InputGroupTextarea } from '../components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../lib/utils';
import { reconcileVoice, type SettingsModel } from './settings-model';
import { stopVoicePreview, type VoicePreviewHandle } from './voice-preview';
import { CustomVoiceSection } from './CustomVoiceSection';
import type { CustomVoiceRecord } from '../storage/custom-voice-store';
import type { ReferenceTake } from '../voice-enrollment/recorder';

const VOICE_NOTICE_COPY = {
  rebase: 'Your saved voice is still available on the current audio engine. It was moved to the new catalog.',
  defaulted: 'Your saved voice is no longer available on the current audio engine. The verified default was selected instead.',
  missing_catalog: 'No verified voice catalog is available yet. Voice output is unavailable until the local audio engine is ready.',
  model_unavailable: 'That TTS model is unavailable on this device. Kokoro remains selected as the usable local fallback.',
  speed_defaulted: 'The saved speed is not supported by this TTS model, so its declared default was selected.',
} as const;

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: SettingsModel;
  catalog: VoiceCatalog | undefined;
  models?: TtsModelDescriptor[];
  saving: boolean;
  saveError: string | undefined;
  onSave: (agentName: string, persona: string, voice: VoicePreference, selectedModel?: TtsModelSelection, voiceProfiles?: Record<string, VoicePreference>) => Promise<void>;
  onPreviewVoice?: (voiceId: string, speedModifier: number, selectedModel?: TtsModelSelection, catalogId?: string, tonePrompt?: string, language?: QwenVoiceLanguage, signal?: AbortSignal) => Promise<VoicePreviewHandle>;
  customVoices?: CustomVoiceRecord[];
  onEnrollCustomVoice?: (name: string, take: ReferenceTake) => Promise<void>;
  onDeleteCustomVoice?: (voiceId: string) => Promise<void>;
  onRenameCustomVoice?: (voiceId: string, name: string) => Promise<void>;
}

export function SettingsDialog({ open, onOpenChange, model, catalog, models = [], saving, saveError, onSave, onPreviewVoice, customVoices = [], onEnrollCustomVoice, onDeleteCustomVoice, onRenameCustomVoice }: SettingsDialogProps) {
  const [agentName, setAgentName] = useState(model.agentName);
  const [persona, setPersona] = useState(model.persona);
  const [selectedModel, setSelectedModel] = useState<TtsModelSelection>(model.selectedModel ?? DEFAULT_TTS_MODEL);
  const [voiceProfiles, setVoiceProfiles] = useState<Record<string, VoicePreference>>(model.voiceProfiles ?? {});
  const [voiceId, setVoiceId] = useState(model.voice.voiceId);
  const [speedModifier, setSpeedModifier] = useState(String(model.voice.speedModifier));
  const [tonePrompt, setTonePrompt] = useState(model.voice.tonePrompt ?? '');
  const [language, setLanguage] = useState<QwenVoiceLanguage>(model.voice.language ?? DEFAULT_QWEN_VOICE_LANGUAGE);
  const [voiceNotice, setVoiceNotice] = useState(model.notice);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const previewHandleRef = useRef<VoicePreviewHandle | undefined>(undefined);
  const previewRequestRef = useRef<AbortController | undefined>(undefined);
  const previewGenerationRef = useRef(0);

  const invalidatePreview = (resetState = true) => {
    previewGenerationRef.current++;
    previewRequestRef.current?.abort();
    previewRequestRef.current = undefined;
    previewHandleRef.current?.stop();
    previewHandleRef.current = undefined;
    stopVoicePreview();
    if (resetState) setPreviewState('idle');
  };

  useEffect(() => {
    // Stop anything audible before the dialog resets or closes; also cancel a
    // request that has not produced a handle yet so an old backend cannot win
    // after the dialog moves to a new model.
    invalidatePreview();
    if (!open) return;
    setAgentName(model.agentName);
    setPersona(model.persona);
    setSelectedModel(model.selectedModel ?? DEFAULT_TTS_MODEL);
    setVoiceProfiles(model.voiceProfiles ?? {});
    setVoiceId(model.voice.voiceId);
    setSpeedModifier(String(model.voice.speedModifier));
    setTonePrompt(model.voice.tonePrompt ?? '');
    setLanguage(model.voice.language ?? DEFAULT_QWEN_VOICE_LANGUAGE);
    setVoiceNotice(model.notice);
    setPreviewState('idle');
    setPreviewError(undefined);
  }, [open, model.agentName, model.persona, model.selectedModel?.backendId, model.selectedModel?.modelId, model.voice.voiceId, model.voice.speedModifier, model.voice.tonePrompt, model.voice.language, model.notice, model.voiceProfiles, customVoices]);

  useEffect(() => () => { invalidatePreview(false); }, []);

  const agentNameInvalid = utf8ByteLength(agentName) > MAX_AGENT_NAME_BYTES;
  const personaBytes = useMemo(() => utf8ByteLength(persona), [persona]);
  const personaInvalid = personaBytes > MAX_PERSONA_BYTES;
  const selectedDescriptor = models.find(item => item.backendId === selectedModel.backendId && item.modelId === selectedModel.modelId);
  const selectedCatalog = selectedDescriptor?.voiceCatalog ?? (selectedModel.backendId === DEFAULT_TTS_MODEL.backendId && selectedModel.modelId === DEFAULT_TTS_MODEL.modelId ? catalog : undefined);
  const displayCatalog = selectedModel.backendId === 'qwen3' ? withCustomVoices(selectedCatalog, customVoices) : selectedCatalog;
  const speedCapability = selectedDescriptor?.speed ?? voiceSpeedCapability(displayCatalog);
  const speedModifierValue = Number(speedModifier);
  const speedModifierInvalid = !Number.isFinite(speedModifierValue)
    || speedModifierValue < speedCapability.min
    || speedModifierValue > speedCapability.max
    || (!speedCapability.supported && speedModifierValue !== speedCapability.default);
  const tonePromptBytes = useMemo(() => utf8ByteLength(tonePrompt), [tonePrompt]);
  const tonePromptInvalid = selectedModel.backendId === 'qwen3' && tonePromptBytes > MAX_VOICE_TONE_PROMPT_BYTES;
  const catalogReady = Boolean(displayCatalog && displayCatalog.voices.length > 0);
  const selectedVoice = displayCatalog?.voices.find(voice => voice.id === voiceId);
  const canSave = !agentNameInvalid && !personaInvalid && !speedModifierInvalid && !tonePromptInvalid && !saving && (!catalogReady || Boolean(voiceId));

  const selectModel = (value: string | null) => {
    const next = models.find(item => ttsModelKey(item) === value);
    if (!next || next.status !== 'ready' || !next.voiceCatalog) return;
    const nextModel = { backendId: next.backendId, modelId: next.modelId };
    const key = ttsModelKey(nextModel);
    const nextCatalogBase = next.speed ? { ...next.voiceCatalog, speed: next.speed } : next.voiceCatalog;
    const nextCatalog = next.backendId === 'qwen3' ? withCustomVoices(nextCatalogBase, customVoices) : nextCatalogBase;
    const reconciled = reconcileVoice(voiceProfiles[key], nextCatalog);
    const nextVoice = { ...reconciled.voice, ...nextModel };
    setSelectedModel(nextModel);
    setVoiceProfiles(previous => ({ ...previous, [key]: nextVoice }));
    setVoiceId(nextVoice.voiceId);
    setSpeedModifier(String(nextVoice.speedModifier));
    setTonePrompt(nextVoice.tonePrompt ?? '');
    setLanguage(nextVoice.language ?? DEFAULT_QWEN_VOICE_LANGUAGE);
    setVoiceNotice(reconciled.notice);
    invalidatePreview();
  };

  const commit = async () => {
    if (!canSave) return;
    const selectedSpeed = speedCapability.supported ? speedModifierValue : speedCapability.default;
    const voice: VoicePreference = { catalogId: displayCatalog?.catalogId ?? '', voiceId: catalogReady ? voiceId : '', speedModifier: selectedSpeed, ...(selectedModel.backendId === 'qwen3' && tonePrompt.trim() ? { tonePrompt: tonePrompt.trim() } : {}), ...(selectedModel.backendId === 'qwen3' ? { language } : {}), backendId: selectedModel.backendId, modelId: selectedModel.modelId };
    const profiles = { ...voiceProfiles, [ttsModelKey(selectedModel)]: voice };
    await onSave(agentName, persona, voice, selectedModel, profiles);
  };

  const togglePreview = async () => {
    if (previewState === 'playing') {
      invalidatePreview();
      return;
    }
    if (previewState === 'loading' || !onPreviewVoice || !catalogReady) return;
    setPreviewError(undefined);
    setPreviewState('loading');
    const request = new AbortController();
    const generation = ++previewGenerationRef.current;
    previewRequestRef.current = request;
    try {
      const handle = await onPreviewVoice(voiceId, speedCapability.supported ? speedModifierValue : speedCapability.default, selectedModel, displayCatalog?.catalogId, selectedModel.backendId === 'qwen3' && tonePrompt.trim() ? tonePrompt.trim() : undefined, selectedModel.backendId === 'qwen3' ? language : undefined, request.signal);
      // The dialog may have closed or moved on while the fetch was in flight.
      if (generation !== previewGenerationRef.current || request.signal.aborted || !open) {
        handle.stop();
        return;
      }
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
    } catch (caught) {
      if (generation !== previewGenerationRef.current || request.signal.aborted) return;
      previewHandleRef.current = undefined;
      setPreviewState('idle');
      const detail = caught instanceof Error && caught.message ? caught.message : undefined;
      setPreviewError(detail ?? 'Voice preview couldn\u2019t start. Check the audio engine, then try again.');
    } finally {
      if (previewRequestRef.current === request) previewRequestRef.current = undefined;
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="h-[min(46rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-lg" aria-describedby="settings-description">
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription id="settings-description">These apply to the next session you start. The active session is never changed mid-turn.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 min-w-0 flex flex-col gap-4">
        <Tabs defaultValue="agent" className="min-h-0 min-w-0 flex-1">
          <TabsList aria-label="Settings sections" className="w-full shrink-0">
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="voice">Voice</TabsTrigger>
          </TabsList>
          <TabsContent value="agent" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pt-4 pb-1">
            <FieldGroup>
              <Field data-invalid={agentNameInvalid || undefined}>
                <FieldLabel htmlFor="settings-agent-name">Agent name</FieldLabel>
                <Input
                  id="settings-agent-name"
                  value={agentName}
                  onChange={event => setAgentName(event.target.value)}
                  aria-invalid={agentNameInvalid || undefined}
                  aria-describedby="settings-agent-name-description"
                  placeholder="e.g. Oliver"
                  maxLength={MAX_AGENT_NAME_BYTES}
                />
                <FieldDescription id="settings-agent-name-description">Name shown above the assistant's messages in the conversation. It is kept out of the system prompt.</FieldDescription>
                {agentNameInvalid ? <FieldError>Agent name exceeds the {MAX_AGENT_NAME_BYTES}-byte limit.</FieldError> : null}
              </Field>
            </FieldGroup>
            <Accordion multiple defaultValue={['persona']} className="shrink-0 rounded-xl">
              <AccordionItem value="persona">
                <AccordionTrigger>Persona</AccordionTrigger>
                <AccordionContent aria-labelledby="settings-persona-panel-label">
                  <span id="settings-persona-panel-label" className="sr-only">Agent behavior settings</span>
                  <Field data-invalid={personaInvalid || undefined}>
                    <FieldLabel className="sr-only" htmlFor="settings-persona">Persona</FieldLabel>
                    <InputGroup>
                      <InputGroupTextarea
                        id="settings-persona"
                        value={persona}
                        onChange={event => setPersona(event.target.value)}
                        aria-invalid={personaInvalid || undefined}
                        aria-describedby="settings-persona-description settings-persona-counter"
                        placeholder="Describe how the assistant should behave…"
                        className="h-48 max-h-48 min-h-40 min-w-0 overflow-y-auto"
                      />
                      <InputGroupAddon align="block-end">
                        <InputGroupText id="settings-persona-counter" className={cn('text-xs', personaInvalid && 'text-destructive')} aria-live="polite">
                          {personaBytes.toLocaleString()} / {MAX_PERSONA_BYTES.toLocaleString()}
                        </InputGroupText>
                      </InputGroupAddon>
                    </InputGroup>
                    <FieldDescription id="settings-persona-description">Free-form instructions appended to the base system prompt when the next session starts. Empty is allowed.</FieldDescription>
                    {personaInvalid ? <FieldError>Persona exceeds the {MAX_PERSONA_BYTES / 1024} KiB limit.</FieldError> : null}
                  </Field>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="system-prompt">
                <AccordionTrigger>View base system prompt</AccordionTrigger>
                <AccordionContent>
                  <Field data-disabled>
                    <FieldLabel className="sr-only" htmlFor="settings-system-prompt">Base system prompt</FieldLabel>
                    <Textarea
                      id="settings-system-prompt"
                      className="h-48 max-h-48 min-h-48 overflow-y-auto disabled:cursor-default"
                      disabled
                      value={PODCASTER_SYSTEM_PROMPT}
                      aria-describedby="settings-system-prompt-description"
                    />
                    <FieldDescription id="settings-system-prompt-description">Your saved persona is appended to this base prompt when the next session starts.</FieldDescription>
                  </Field>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </TabsContent>
          <TabsContent value="voice" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pt-4 pb-1">
            {voiceNotice ? <Alert variant={voiceNotice === 'missing_catalog' || voiceNotice === 'model_unavailable' ? 'destructive' : 'default'}><AlertDescription>{VOICE_NOTICE_COPY[voiceNotice]}</AlertDescription></Alert> : null}
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-tts-model">Speech model</FieldLabel>
                <FieldContent>
                  {models.length > 0 ? <Select value={ttsModelKey(selectedModel)} onValueChange={selectModel}>
                    <SelectTrigger id="settings-tts-model" className="w-full" aria-label="Speech model">
                      <SelectValue>{selectedDescriptor?.label ?? `${selectedModel.backendId} · ${selectedModel.modelId}`}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {models.map(item => <SelectItem key={ttsModelKey(item)} value={ttsModelKey(item)} disabled={item.status !== 'ready'}>{item.label}{item.status !== 'ready' ? ' · unavailable' : ''}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select> : <p className="text-sm text-muted-foreground">The local audio engine will report selectable models when it is ready.</p>}
                  {selectedDescriptor?.status === 'unavailable' ? <FieldDescription className="text-destructive">{selectedDescriptor.reason ?? 'This model is unavailable.'} Kokoro remains the production fallback.</FieldDescription> : selectedDescriptor ? <FieldDescription>{selectedDescriptor.label} · backend {selectedDescriptor.backendId}</FieldDescription> : null}
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel htmlFor="settings-voice">Voice</FieldLabel>
                <FieldContent>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      {catalogReady ? <Select value={voiceId} onValueChange={value => { if (value) { setVoiceId(value); setVoiceProfiles(previous => ({ ...previous, [ttsModelKey(selectedModel)]: { catalogId: displayCatalog!.catalogId, voiceId: value, speedModifier: speedCapability.supported ? speedModifierValue : speedCapability.default, ...(selectedModel.backendId === 'qwen3' && tonePrompt.trim() ? { tonePrompt: tonePrompt.trim() } : {}), ...(selectedModel.backendId === 'qwen3' ? { language } : {}), ...selectedModel } })); invalidatePreview(); } }} disabled={!catalogReady}>
                        <SelectTrigger id="settings-voice" className="w-full" aria-label="Voice">
                          <SelectValue>{selectedVoice?.label ?? voiceId}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {displayCatalog!.voices.map(voice => <SelectItem key={voice.id} value={voice.id}>{voice.label}</SelectItem>)}
                          </SelectGroup>
                        </SelectContent>
                      </Select> : <p className="text-sm text-muted-foreground">Voice options appear once the selected model reports its verified catalog.</p>}
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
                      {previewState === 'loading' ? <Spinner aria-hidden="true" /> : previewState === 'playing' ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
                    </Button> : null}
                  </div>
                  {previewError ? <p className="text-xs text-destructive" role="status">{previewError}</p> : null}
                  {displayCatalog ? <FieldDescription>Backend {displayCatalog.backendId} · model {displayCatalog.modelId} · revision {displayCatalog.revision.slice(0, 8)}</FieldDescription> : null}
                </FieldContent>
              </Field>
              {selectedModel.backendId === 'qwen3' ? <Field data-invalid={tonePromptInvalid || undefined}>
                <FieldLabel htmlFor="settings-voice-tone">Tone / style instruction</FieldLabel>
                <FieldContent>
                  <Textarea
                    id="settings-voice-tone"
                    value={tonePrompt}
                    onChange={event => { setTonePrompt(event.target.value); setVoiceProfiles(previous => ({ ...previous, [ttsModelKey(selectedModel)]: { catalogId: displayCatalog?.catalogId ?? '', voiceId, speedModifier: speedCapability.supported ? speedModifierValue : speedCapability.default, ...(event.target.value.trim() ? { tonePrompt: event.target.value.trim() } : {}), ...(selectedModel.backendId === 'qwen3' ? { language } : {}), ...selectedModel } })); invalidatePreview(); }}
                    aria-invalid={tonePromptInvalid || undefined}
                    aria-describedby="settings-voice-tone-description settings-voice-tone-counter"
                    placeholder="e.g. Warm, calm, and reassuring"
                    className="min-h-20"
                  />
                  <div className="flex justify-end text-xs text-muted-foreground" id="settings-voice-tone-counter" aria-live="polite">{tonePromptBytes.toLocaleString()} / {MAX_VOICE_TONE_PROMPT_BYTES.toLocaleString()}</div>
                  <FieldDescription id="settings-voice-tone-description">Qwen uses this instruction to shape delivery, such as warmth, energy, or pacing. Leave empty for the model default. Preview uses this instruction too.</FieldDescription>
                  {tonePromptInvalid ? <FieldError>Tone instruction exceeds the {MAX_VOICE_TONE_PROMPT_BYTES}-byte limit.</FieldError> : null}
                </FieldContent>
              </Field> : null}
              {selectedModel.backendId === 'qwen3' ? <Field>
                <FieldLabel htmlFor="settings-voice-language">Language</FieldLabel>
                <FieldContent>
                  <Select value={language} onValueChange={value => { if (value && (QWEN_VOICE_LANGUAGES as readonly string[]).includes(value)) { const next = value as QwenVoiceLanguage; setLanguage(next); setVoiceProfiles(previous => ({ ...previous, [ttsModelKey(selectedModel)]: { catalogId: displayCatalog?.catalogId ?? '', voiceId, speedModifier: speedCapability.supported ? speedModifierValue : speedCapability.default, ...(tonePrompt.trim() ? { tonePrompt: tonePrompt.trim() } : {}), language: next, ...selectedModel } })); invalidatePreview(); } }}>
                    <SelectTrigger id="settings-voice-language" className="w-full" aria-label="Language">
                      <SelectValue>{language}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {QWEN_VOICE_LANGUAGES.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>Qwen supports these ten synthesis languages. The selected language applies to the next session and voice preview.</FieldDescription>
                </FieldContent>
              </Field> : null}
              <Field data-invalid={speedModifierInvalid || undefined}>
                <FieldLabel htmlFor="settings-voice-speed">Speed modifier</FieldLabel>
                <FieldContent>
                  <Input
                    id="settings-voice-speed"
                    type="number"
                    min={speedCapability.min}
                    max={speedCapability.max}
                    step="0.05"
                    value={speedModifier}
                    disabled={!speedCapability.supported}
                    onChange={event => { setSpeedModifier(event.target.value); setVoiceProfiles(previous => ({ ...previous, [ttsModelKey(selectedModel)]: { catalogId: displayCatalog?.catalogId ?? '', voiceId, speedModifier: Number(event.target.value), ...(selectedModel.backendId === 'qwen3' && tonePrompt.trim() ? { tonePrompt: tonePrompt.trim() } : {}), ...(selectedModel.backendId === 'qwen3' ? { language } : {}), ...selectedModel } })); invalidatePreview(); }}
                    aria-invalid={speedModifierInvalid || undefined}
                    aria-describedby="settings-voice-speed-description"
                  />
                  <FieldDescription id="settings-voice-speed-description">{speedCapability.supported ? `Use this model's declared range ${speedCapability.min} to ${speedCapability.max}. ${speedCapability.default} is its normal speed.` : 'This model does not declare playback-speed control; its normal speed is fixed at 1.0.'}</FieldDescription>
                  {speedModifierInvalid ? <FieldError>Speed modifier is outside this model's declared capability.</FieldError> : null}
                </FieldContent>
              </Field>
            </FieldGroup>
            {selectedModel.backendId === 'qwen3' && onEnrollCustomVoice && onDeleteCustomVoice && onRenameCustomVoice ? <CustomVoiceSection
              voices={customVoices}
              onEnroll={onEnrollCustomVoice}
              onDelete={onDeleteCustomVoice}
              onRename={onRenameCustomVoice}
            /> : null}
          </TabsContent>
        </Tabs>
        {saveError ? <Alert variant="destructive" className="shrink-0"><AlertDescription>{saveError}</AlertDescription></Alert> : null}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={saving}>Cancel</Button>} />
        <Button onClick={() => void commit()} disabled={!canSave}>
          {saving ? <><Spinner aria-hidden="true" />Saving…</> : 'Save settings'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
