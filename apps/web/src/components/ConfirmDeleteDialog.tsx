import { useState, type ReactElement } from 'react';
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

export interface ConfirmDeleteDialogProps {
  trigger: ReactElement;
  deleting?: boolean;
  onConfirm: () => Promise<void> | void;
}

export function ConfirmDeleteDialog({ trigger, deleting = false, onConfirm }: ConfirmDeleteDialogProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const busy = deleting || confirming;

  const handleOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (next) setError('');
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setError('');
    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The recording could not be deleted. Try again.');
    } finally {
      setConfirming(false);
    }
  };

  return <AlertDialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
    <AlertDialogPrimitive.Trigger render={trigger} />
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        className="fixed inset-0 isolate z-50 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      <AlertDialogPrimitive.Popup
        className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-4xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/5 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
      >
        <div className="flex flex-col gap-2">
          <AlertDialogPrimitive.Title className="font-heading text-base leading-none font-medium">Delete recording?</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="text-sm text-muted-foreground">
            This permanently deletes the recorded audio for this session. The conversation will remain available.
          </AlertDialogPrimitive.Description>
        </div>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogPrimitive.Close render={<Button variant="outline" disabled={busy}>Cancel</Button>} />
          <Button variant="destructive" disabled={busy} onClick={() => void handleConfirm()}>
            {busy ? <Spinner aria-hidden="true" /> : null}
            {busy ? 'Deleting…' : 'Delete recording'}
          </Button>
        </div>
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  </AlertDialogPrimitive.Root>;
}
