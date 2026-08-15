import { useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Progress } from '../components/ui/progress';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { downloadRecording } from './export';
import type { ExportProgress, ExportOnProgress } from './splice';
import type { RecordingSessionViewState } from './trim-state';

export interface RecordingControlsProps {
  sessionId: string;
  buildExport: (onProgress?: ExportOnProgress) => Promise<Blob | null>;
  recording: RecordingSessionViewState;
  onToggleRecording: (enabled: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}

export function RecordingControls({ sessionId, buildExport, recording, onToggleRecording, onDelete }: RecordingControlsProps) {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [notice, setNotice] = useState('');
  const { enabled, totalCount, includedCount, hydrated, pendingTargetId, error } = recording;
  const busy = exporting || pendingTargetId !== null;
  const allTrimmed = enabled && totalCount > 0 && includedCount === 0;
  const statusLabel = !enabled ? 'off' : totalCount === 0 ? '0 items' : `${includedCount} of ${totalCount} messages included`;

  const toggle = async () => { await onToggleRecording(!enabled); };
  const waitForPaint = () => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  const exportRecording = async () => {
    if (exporting || includedCount === 0) return;
    setExporting(true);
    setProgress({ phase: 'reading', message: 'Reading recording…', value: 0 });
    setNotice('');
    try {
      const blob = await buildExport(next => setProgress(next));
      if (blob) {
        await waitForPaint();
        downloadRecording(blob, sessionId);
      } else setNotice('The recording could not be built. Try again.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The recording could not be exported.');
    } finally {
      setExporting(false);
      setProgress(null);
    }
  };
  const remove = async () => { await onDelete(); };

  return <Card className="recording-controls" role="group" aria-label="Recording controls">
    <div className="recording-row">
      <div className="recording-toggle"><Switch checked={enabled} onCheckedChange={() => void toggle()} aria-label="Record this session" /><span>Record this session</span></div>
      <Badge className="recording-status" aria-label={`Recording status: ${statusLabel}`}>{statusLabel}</Badge>
    </div>
    <div className="recording-actions">
      <div className="button-row">
        <Button variant="secondary" disabled={!hydrated || includedCount === 0 || busy} onClick={() => void exportRecording()}>{exporting ? <><Spinner />Exporting…</> : 'Export'}</Button>
        <Button variant="outline" disabled={totalCount === 0} onClick={() => void remove()}>Delete</Button>
      </div>
      {exporting && progress ? (
        <div className="export-progress">
          <p className="hint" role="status" aria-live="polite">{progress.message}</p>
          <Progress value={Math.round(progress.value * 100)} aria-label="Export progress" aria-valuetext={progress.message} />
        </div>
      ) : null}
    </div>
    {allTrimmed ? <p className="hint">Every message is removed from the recording. Use Undo on any message to include it again.</p> : null}
    {notice || error ? <p className="hint" role="status">{notice || error}</p> : null}
  </Card>;
}
