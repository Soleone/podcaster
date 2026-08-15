import { ExportPopover } from '../components/ExportPopover';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Switch } from '../components/ui/switch';
import type { ExportOnProgress } from './splice';
import type { RecordingSessionViewState } from './trim-state';

export interface RecordingControlsProps {
  sessionId: string;
  buildExport: (onProgress?: ExportOnProgress) => Promise<Blob | null>;
  recording: RecordingSessionViewState;
  onToggleRecording: (enabled: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}

export function RecordingControls({ sessionId, buildExport, recording, onToggleRecording, onDelete }: RecordingControlsProps) {
  const { enabled, totalCount, includedCount, hydrated, pendingTargetId, error } = recording;
  const busy = pendingTargetId !== null;
  const allTrimmed = enabled && totalCount > 0 && includedCount === 0;
  const statusLabel = !enabled ? 'off' : totalCount === 0 ? '0 items' : `${includedCount} of ${totalCount} messages included`;

  const toggle = async () => { await onToggleRecording(!enabled); };
  const remove = async () => { await onDelete(); };

  return <Card className="recording-controls" role="group" aria-label="Recording controls">
    <div className="recording-row">
      <div className="recording-toggle"><Switch checked={enabled} onCheckedChange={() => void toggle()} aria-label="Record this session" /><span>Record this session</span></div>
      <Badge className="recording-status" aria-label={`Recording status: ${statusLabel}`}>{statusLabel}</Badge>
    </div>
    <div className="recording-actions">
      <div className="button-row">
        <ExportPopover sessionId={sessionId} buildExport={buildExport} disabled={!hydrated || includedCount === 0 || busy} />
        <Button variant="outline" disabled={totalCount === 0} onClick={() => void remove()}>Delete</Button>
      </div>
    </div>
    {allTrimmed ? <p className="hint">Every message is removed from the recording. Use Undo on any message to include it again.</p> : null}
    {error ? <p className="hint" role="status">{error}</p> : null}
  </Card>;
}