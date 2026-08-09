import { useCallback, useEffect, useState } from 'react';
import type { RecordingStore } from '../storage/recording-store';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { deleteSessionRecording, downloadRecording } from './export';

export interface RecordingControlsProps {
  sessionId: string;
  store: RecordingStore;
  buildExport: () => Promise<Blob | null>;
  onToggleRecording: (enabled: boolean) => Promise<void>;
}

export function RecordingControls({ sessionId, store, buildExport, onToggleRecording }: RecordingControlsProps) {
  const [enabled, setEnabled] = useState(false);
  const [itemCount, setItemCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    const [flag, count] = await Promise.all([store.getRecordingEnabled(), store.countSessionItems(sessionId)]);
    setEnabled(flag);
    setItemCount(count);
  }, [store, sessionId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await onToggleRecording(next);
    await refresh();
  };
  const exportRecording = async () => {
    if (exporting || itemCount === 0) return;
    setExporting(true);
    setNotice('');
    try {
      const blob = await buildExport();
      if (blob) downloadRecording(blob, sessionId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The recording could not be exported.');
    } finally {
      setExporting(false);
      await refresh();
    }
  };
  const remove = async () => {
    await deleteSessionRecording(sessionId, store);
    await refresh();
  };

  return <Card className="recording-controls" role="group" aria-label="Recording controls">
    <div className="recording-row">
      <div className="recording-toggle"><Switch checked={enabled} onCheckedChange={() => void toggle()} aria-label="Record this session" /><span>Record this session</span></div>
      <Badge className="recording-status" aria-label={`Recording status: ${enabled ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : 'off'}`}>{enabled ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : 'off'}</Badge>
    </div>
    <div className="button-row">
      <Button variant="secondary" disabled={itemCount === 0 || exporting} onClick={() => void exportRecording()}>{exporting ? <><Spinner />Exporting…</> : 'Export'}</Button>
      <Button variant="outline" disabled={itemCount === 0} onClick={() => void remove()}>Delete</Button>
    </div>
    {notice ? <p className="hint">{notice}</p> : null}
  </Card>;
}
