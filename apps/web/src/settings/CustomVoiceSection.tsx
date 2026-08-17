import { useEffect, useRef, useState } from 'react';
import { Mic, Pencil, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { MAX_CUSTOM_VOICE_MS, MAX_CUSTOM_VOICES, MIN_CUSTOM_VOICE_MS, VOICE_ENROLLMENT_CONSENT_ACK, VOICE_ENROLLMENT_CONSENT_COPY, VOICE_ENROLLMENT_RETENTION_COPY, normalizeCustomVoiceName } from '@app/contracts/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Field, FieldDescription, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import type { CustomVoiceRecord } from '../storage/custom-voice-store';
import { ReferenceRecorder, ReferenceRecordingError, finalizeReferenceRecording, referenceErrorCopy, type MicrophoneState, type ReferenceTake } from '../voice-enrollment/recorder';

export interface CustomVoiceSectionProps {
  voices: CustomVoiceRecord[];
  onEnroll: (name: string, take: ReferenceTake) => Promise<void>;
  onDelete: (voiceId: string) => Promise<void>;
  onRename: (voiceId: string, name: string) => Promise<void>;
}

export function CustomVoiceSection({ voices, onEnroll, onDelete, onRename }: CustomVoiceSectionProps) {
  const recorderRef = useRef<ReferenceRecorder | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [microphoneState, setMicrophoneState] = useState<MicrophoneState>('unrequested');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [take, setTake] = useState<ReferenceTake>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => () => {
    window.clearInterval(timerRef.current);
    recorderRef.current?.cancel();
    const audio = audioRef.current;
    audio?.pause();
    if (audio) URL.revokeObjectURL(audio.src);
  }, []);

  const start = async () => {
    if (!consent) { setError('Check the consent box before requesting the microphone.'); return; }
    setError(undefined);
    setMicrophoneState('requesting');
    const recorder = new ReferenceRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setMicrophoneState('granted');
      setRecording(true);
      const started = performance.now();
      timerRef.current = window.setInterval(() => setElapsedMs(Math.round(performance.now() - started)), 100);
    } catch (caught) {
      const code = caught instanceof ReferenceRecordingError ? caught.code : undefined;
      setMicrophoneState(code === 'mic_denied' ? 'denied' : code === 'mic_busy' ? 'busy' : 'unavailable');
      setError(referenceErrorCopy(caught));
      recorderRef.current = undefined;
    }
  };

  const stop = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    window.clearInterval(timerRef.current);
    setRecording(false);
    recorderRef.current = undefined;
    try {
      const source = await recorder.stop();
      setTake(await finalizeReferenceRecording(source));
      setMicrophoneState('unrequested');
      setElapsedMs(0);
    } catch (caught) {
      setTake(undefined);
      setMicrophoneState('unrequested');
      setError(referenceErrorCopy(caught));
    }
  };

  const discard = () => {
    setTake(undefined);
    setName('');
    setError(undefined);
    setElapsedMs(0);
  };

  const replay = () => {
    if (!take) return;
    audioRef.current?.pause();
    const audio = new Audio(URL.createObjectURL(take.wav));
    audioRef.current = audio;
    audio.onended = () => { URL.revokeObjectURL(audio.src); if (audioRef.current === audio) audioRef.current = undefined; };
    void audio.play().catch(() => setError('The reference preview could not start.'));
  };

  const save = async () => {
    if (!take || !consent) return;
    const normalized = normalizeCustomVoiceName(name);
    if (!normalized) { setError('Give the voice a name before saving.'); return; }
    setBusy(true);
    setError(undefined);
    try {
      await onEnroll(normalized, take);
      discard();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The custom voice could not be saved.');
    } finally { setBusy(false); }
  };

  const rename = async (voice: CustomVoiceRecord) => {
    const next = window.prompt('Rename custom voice', voice.name);
    if (next === null) return;
    const normalized = normalizeCustomVoiceName(next);
    if (!normalized) { setError('Voice names cannot be empty.'); return; }
    setBusy(true);
    try { await onRename(voice.voiceId, normalized); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The voice could not be renamed.'); }
    finally { setBusy(false); }
  };

  const remove = async (voice: CustomVoiceRecord) => {
    setBusy(true);
    try { await onDelete(voice.voiceId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The voice could not be deleted.'); }
    finally { setBusy(false); }
  };

  return <section className="rounded-xl border p-3" aria-labelledby="custom-voice-heading">
    <div className="mb-3">
      <h3 id="custom-voice-heading" className="text-sm font-medium">Voice cloning</h3>
      <p className="mt-1 text-xs text-muted-foreground">{VOICE_ENROLLMENT_CONSENT_COPY}</p>
    </div>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} aria-describedby="custom-voice-consent-copy" />
      <span id="custom-voice-consent-copy">{VOICE_ENROLLMENT_CONSENT_ACK}</span>
    </label>
    <p className="mt-2 text-xs text-muted-foreground">{VOICE_ENROLLMENT_RETENTION_COPY}</p>
    <div className="mt-3 flex items-center gap-2">
      {!recording ? <Button type="button" variant="outline" onClick={() => void start()} disabled={!consent || busy}><Mic aria-hidden="true" />Record reference</Button>
        : <Button type="button" variant="destructive" onClick={() => void stop()}><Square aria-hidden="true" />Stop recording</Button>}
      {recording ? <span className="text-sm tabular-nums" role="status">{(elapsedMs / 1000).toFixed(1)}s / {MAX_CUSTOM_VOICE_MS / 1000}s</span> : null}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Use a clear {MIN_CUSTOM_VOICE_MS / 1000} to {MAX_CUSTOM_VOICE_MS / 1000} second sample in a quiet room.</p>
    {microphoneState === 'requesting' ? <p className="mt-1 text-xs" role="status">Requesting microphone permission…</p> : null}
    {microphoneState === 'denied' ? <p className="mt-1 text-xs text-destructive" role="status">Microphone permission was denied. Allow it in the browser and try again.</p> : null}
    {microphoneState === 'busy' ? <p className="mt-1 text-xs text-destructive" role="status">The microphone is busy. Close other recording apps and try again.</p> : null}
    {take ? <div className="mt-3 rounded-lg bg-muted/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={replay}><Play aria-hidden="true" />Replay</Button>
        <Button type="button" variant="outline" size="sm" onClick={discard}><RotateCcw aria-hidden="true" />Re-record</Button>
        <span className="text-xs text-muted-foreground">{(take.durationMs / 1000).toFixed(1)}s, signal OK</span>
      </div>
      <Field className="mt-3">
        <FieldLabel htmlFor="custom-voice-name">Voice name</FieldLabel>
        <Input id="custom-voice-name" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. My voice" maxLength={64} />
        <FieldDescription>Saved after local quality checks. The reference is never uploaded.</FieldDescription>
      </Field>
      <Button type="button" className="mt-3" onClick={() => void save()} disabled={busy || !consent}>{busy ? <><Spinner aria-hidden="true" />Saving…</> : 'Save custom voice'}</Button>
    </div> : null}
    {voices.length > 0 ? <div className="mt-4 space-y-2" aria-label="Saved custom voices">
      <p className="text-xs font-medium">Saved on this device ({voices.length}/{MAX_CUSTOM_VOICES})</p>
      {voices.map(voice => <div key={voice.voiceId} className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-sm">
        <span className="min-w-0 truncate">{voice.name}</span>
        <span className="flex shrink-0 gap-1">
          <Button type="button" variant="ghost" size="icon" title={`Rename ${voice.name}`} aria-label={`Rename ${voice.name}`} onClick={() => void rename(voice)} disabled={busy}><Pencil aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" size="icon" title={`Delete ${voice.name}`} aria-label={`Delete ${voice.name}`} onClick={() => void remove(voice)} disabled={busy}><Trash2 aria-hidden="true" /></Button>
        </span>
      </div>)}
    </div> : null}
    {error ? <Alert variant="destructive" className="mt-3"><AlertDescription>{error}</AlertDescription></Alert> : null}
  </section>;
}
