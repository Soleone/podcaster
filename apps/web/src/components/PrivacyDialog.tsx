import { useState } from 'react';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Spinner } from './ui/spinner';

export const DISCLOSURE_KEY = 'podcaster.disclosure';
export const DISCLOSURE_VERSION = 'voice-cloud-boundary-v1';

export interface PrivacyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}

export function PrivacyDialog({ open, onOpenChange, onConfirm }: PrivacyDialogProps) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  const confirm = async () => {
    if (connecting) return;
    setConnecting(true);
    setError(undefined);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Services could not be connected.');
    } finally {
      setConnecting(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby="privacy-dialog-description" className="max-h-[min(42rem,calc(100vh_-_2rem))] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Before you connect services</DialogTitle>
        <DialogDescription id="privacy-dialog-description">Speech stays local where it can. Read what leaves this device before starting a live session.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 text-sm leading-relaxed">
        <p><strong>Speech recognition and voice playback run locally.</strong> For a response, the current transcript, bounded recent conversation context, your saved persona (sent as system instructions to the configured cloud model), and the selected response posture are sent through Pi to its configured cloud model provider. Raw audio and your full local history are not sent. Voice selection always stays on this device.</p>
        <p>This app does not request an ordinary API key and has no silent metered-provider fallback. The configured provider, not this app, controls its handling, retention, and model-improvement use under your account and settings.</p>
        <p className="text-primary"><a className="underline-offset-4 hover:underline" href="https://help.openai.com/en/articles/11369540-codex-in-chatgpt-faq" rel="noreferrer">Codex data handling</a> · <a className="underline-offset-4 hover:underline" href="https://help.openai.com/en/articles/5722486-data-controls-faq" rel="noreferrer">OpenAI data controls</a> · <a className="underline-offset-4 hover:underline" href="https://openai.com/policies/privacy-policy/" rel="noreferrer">OpenAI privacy policy</a></p>
      </div>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={connecting}>Not now</Button>
        <Button onClick={() => void confirm()} disabled={connecting}>{connecting ? <><Spinner aria-hidden="true" />Connecting…</> : 'Continue and connect'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
