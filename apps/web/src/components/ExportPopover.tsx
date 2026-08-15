import { useCallback, useState } from 'react';
import { Download } from 'lucide-react';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover';
import { Progress } from './ui/progress';
import { Spinner } from './ui/spinner';
import { downloadRecording } from '../recording/export';
import type { ExportProgress, ExportOnProgress } from '../recording/splice';

type Status = 'idle' | 'exporting' | 'saved' | 'error';

export interface ExportPopoverProps {
  sessionId: string;
  /** Builds and returns the export blob, reporting phase progress. Returns null when nothing can be produced. */
  buildExport: (onProgress?: ExportOnProgress) => Promise<Blob | null>;
  /** Disable the trigger until a recording is actually available to export. */
  disabled?: boolean;
  label?: string;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'xs';
  className?: string;
}

/**
 * The export UX for a recording: an Export trigger that opens a popover showing
 * the live build/download progress (phase + percent) and the final outcome.
 * Reused wherever an export already exists, e.g. the live recording controls
 * and the per-session export buttons on the index and stopped views.
 */
export function ExportPopover({ sessionId, buildExport, disabled, label = 'Export', variant = 'secondary', size = 'default', className }: ExportPopoverProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [notice, setNotice] = useState('');

  const waitForPaint = () => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  const run = useCallback(async () => {
    if (disabled || status === 'exporting') return;
    setStatus('exporting');
    setProgress({ phase: 'reading', message: 'Reading recording…', value: 0 });
    setNotice('');
    try {
      const blob = await buildExport(next => setProgress(next));
      if (blob) {
        await waitForPaint();
        downloadRecording(blob, sessionId);
        setStatus('saved');
      } else {
        setNotice('The recording could not be built. Try again.');
        setStatus('error');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The recording could not be exported.');
      setStatus('error');
    }
  }, [disabled, status, buildExport, sessionId]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void run();
  };

  const statusText = status === 'exporting'
    ? progress?.message ?? 'Exporting…'
    : status === 'saved'
      ? 'Download started.'
      : status === 'error'
        ? notice || 'The recording could not be exported.'
        : 'Run the export to build and download this recording.';

  return <Popover open={open} onOpenChange={handleOpenChange}>
    <PopoverTrigger render={
      <Button variant={variant} size={size} disabled={disabled} className={className}>
        {status === 'exporting' ? <Spinner /> : <Download />}
        {status === 'exporting' ? 'Exporting…' : label}
      </Button>
    } />
    <PopoverContent className="w-64">
      <PopoverTitle className="mb-1">Export recording</PopoverTitle>
      <p className="hint" role="status" aria-live="polite">{statusText}</p>
      {status === 'exporting' && progress
        ? <Progress value={Math.round(progress.value * 100)} aria-label="Export progress" aria-valuetext={progress.message} />
        : null}
      {status === 'error' ? <Alert variant="destructive">{notice || 'The recording could not be exported.'}</Alert> : null}
    </PopoverContent>
  </Popover>;
}