import type { TtsModelDescriptor, TtsModelSelection, VoiceCatalog } from '@app/contracts/settings';

export type ServiceState = 'starting' | 'ready' | 'degraded' | 'unavailable' | 'login_required' | 'rate_limited' | 'incompatible';

export interface ServiceStatus {
  state: ServiceState;
  label: string;
  detail: string;
  correctiveAction: string;
}

export interface ServiceStatuses {
  audio: ServiceStatus;
  pi: ServiceStatus;
}

export interface ReadinessSnapshot {
  capabilities: Array<{ id: string; label: string; state: 'ready' | 'needs_action' | 'unavailable'; reason: string; action: string }>;
  sidecar: string;
  reasoning?: 'ready' | 'checking' | 'login_required' | 'unavailable' | 'incompatible' | 'rate_limited';
  services?: ServiceStatuses;
  voiceCatalog?: VoiceCatalog;
  ttsModels?: TtsModelDescriptor[];
  activeTtsModel?: TtsModelSelection;
}

const initialStatus = (label: string): ServiceStatus => ({
  state: 'starting',
  label,
  detail: `${label} status has not been checked yet.`,
  correctiveAction: 'Continue and check readiness to connect.',
});

export const initialServiceStatuses: ServiceStatuses = {
  audio: initialStatus('Audio server'),
  pi: initialStatus('Pi service'),
};

/** Keeps older readiness fixtures useful while the richer service fields roll out. */
export function serviceStatusesFromSnapshot(snapshot: Pick<ReadinessSnapshot, 'sidecar' | 'reasoning' | 'services'>): ServiceStatuses {
  if (snapshot.services) return snapshot.services;
  const audioState: ServiceState = snapshot.sidecar === 'ready' ? 'ready' : snapshot.sidecar === 'starting' ? 'starting' : 'unavailable';
  const piState: ServiceState = snapshot.reasoning === 'checking' ? 'starting' : snapshot.reasoning ?? 'starting';
  return {
    audio: {
      state: audioState,
      label: 'Audio server',
      detail: audioState === 'ready' ? 'Local speech recognition and playback are ready.' : 'The local audio runtime needs attention.',
      correctiveAction: audioState === 'ready' ? 'No action needed.' : 'Check the audio runtime, then retry.',
    },
    pi: {
      state: piState,
      label: 'Pi service',
      detail: piState === 'ready' ? 'Pi is ready to provide responses.' : 'Pi status is not ready yet.',
      correctiveAction: piState === 'ready' ? 'No action needed.' : 'Retry, or continue transcript-only.',
    },
  };
}

export function serviceStateLabel(state: ServiceState): string {
  switch (state) {
    case 'starting': return 'Starting';
    case 'ready': return 'Ready';
    case 'degraded': return 'Degraded';
    case 'login_required': return 'Sign-in needed';
    case 'rate_limited': return 'Rate limited';
    case 'incompatible': return 'Incompatible';
    case 'unavailable': return 'Unavailable';
  }
}

export function aggregateServiceState(statuses: ServiceStatuses): ServiceState {
  const states = [statuses.audio.state, statuses.pi.state];
  if (states.includes('unavailable') || states.includes('login_required') || states.includes('incompatible')) return 'unavailable';
  if (states.includes('rate_limited') || states.includes('degraded')) return 'degraded';
  if (states.includes('starting')) return 'starting';
  return 'ready';
}
