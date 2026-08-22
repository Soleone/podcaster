import type { TtsModelDescriptor, TtsModelSelection, VoiceCatalog } from '@app/contracts/settings';

export type ServiceState =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'login_required'
  | 'rate_limited'
  | 'incompatible';
export type ServiceCheckState = 'starting' | 'warming' | 'ready' | 'needs_action' | 'unavailable';

export interface ServiceCheck {
  label: string;
  state: ServiceCheckState;
  detail?: string;
}

export interface ServiceStatus {
  state: ServiceState;
  label: string;
  detail: string;
  correctiveAction: string;
  progress?: number;
  checks?: readonly ServiceCheck[];
}

export interface ServiceStatuses {
  audio: ServiceStatus;
  pi: ServiceStatus;
}

export type SessionStartMode = 'full' | 'transcript_only';

export interface ReadinessSnapshot {
  capabilities: Array<{
    id: string;
    label: string;
    state: 'ready' | 'needs_action' | 'unavailable';
    reason: string;
    action: string;
  }>;
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
  correctiveAction: 'Review privacy terms to connect services.',
});

export const initialServiceStatuses: ServiceStatuses = {
  audio: initialStatus('Audio server'),
  pi: initialStatus('Pi service'),
};

export const fakeServiceStatuses: ServiceStatuses = {
  audio: {
    state: 'ready',
    label: 'Audio server',
    detail: 'Fake local audio services are ready.',
    correctiveAction: 'No action needed.',
    progress: 100,
    checks: [
      { label: 'Microphone', state: 'ready' },
      { label: 'Speech detection', state: 'ready' },
      { label: 'Voice engine', state: 'ready' },
    ],
  },
  pi: {
    state: 'ready',
    label: 'Pi service',
    detail: 'Fake Pi services are ready.',
    correctiveAction: 'No action needed.',
    progress: 100,
    checks: [{ label: 'Reasoning backend', state: 'ready' }],
  },
};

/** Converts the host's live session audio event into the global service shape. */
export function serviceStatusFromAudioEngine(audio: {
  status: 'starting' | 'warming' | 'ready' | 'failed' | 'retrying';
  capture: 'starting' | 'ready' | 'failed';
  vad: 'starting' | 'warming' | 'ready' | 'failed';
  tts: 'starting' | 'warming' | 'ready' | 'failed';
  detail?: string;
}): ServiceStatus {
  const checks: ServiceCheck[] = [
    { label: 'Microphone', state: checkState(audio.capture) },
    { label: 'Speech detection', state: checkState(audio.vad) },
    { label: 'Voice engine', state: checkState(audio.tts) },
  ];
  const readyCount = checks.filter((check) => check.state === 'ready').length;
  const failed = audio.status === 'failed' || checks.some((check) => check.state === 'unavailable');
  const ready = audio.status === 'ready';
  return {
    state: ready ? 'ready' : failed ? 'unavailable' : 'starting',
    label: 'Audio server',
    detail:
      audio.detail ??
      (ready ? 'Microphone, speech detection, and voice playback are ready.' : 'Preparing the local audio runtime.'),
    correctiveAction: failed
      ? 'Retry the session or check the local audio runtime.'
      : 'Keep this page open while the local runtime starts.',
    progress: ready ? 100 : Math.round((readyCount / checks.length) * 100),
    checks,
  };
}

function checkState(state: 'starting' | 'warming' | 'ready' | 'failed'): ServiceCheckState {
  return state === 'failed' ? 'unavailable' : state;
}

/** Keeps older readiness fixtures useful while the richer service fields roll out. */
export function serviceStatusesFromSnapshot(
  snapshot: Pick<ReadinessSnapshot, 'sidecar' | 'reasoning' | 'services'>,
): ServiceStatuses {
  if (snapshot.services) return snapshot.services;
  const audioState: ServiceState =
    snapshot.sidecar === 'ready' ? 'ready' : snapshot.sidecar === 'starting' ? 'starting' : 'unavailable';
  const piState: ServiceState = snapshot.reasoning === 'checking' ? 'starting' : (snapshot.reasoning ?? 'starting');
  return {
    audio: {
      state: audioState,
      label: 'Audio server',
      detail:
        audioState === 'ready'
          ? 'Local speech recognition and playback are ready.'
          : 'The local audio runtime needs attention.',
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
    case 'starting':
      return 'Starting';
    case 'ready':
      return 'Ready';
    case 'degraded':
      return 'Degraded';
    case 'login_required':
      return 'Sign-in needed';
    case 'rate_limited':
      return 'Rate limited';
    case 'incompatible':
      return 'Incompatible';
    case 'unavailable':
      return 'Unavailable';
  }
}

export function serviceCheckStateLabel(state: ServiceCheckState): string {
  switch (state) {
    case 'starting':
      return 'Starting';
    case 'warming':
      return 'Warming';
    case 'ready':
      return 'Ready';
    case 'needs_action':
      return 'Needs action';
    case 'unavailable':
      return 'Unavailable';
  }
}

export function aggregateServiceState(statuses: ServiceStatuses): ServiceState {
  const states = [statuses.audio.state, statuses.pi.state];
  const checks = [...(statuses.audio.checks ?? []), ...(statuses.pi.checks ?? [])];
  if (
    states.includes('unavailable') ||
    states.includes('login_required') ||
    states.includes('incompatible') ||
    checks.some((check) => check.state === 'unavailable')
  )
    return 'unavailable';
  if (
    states.includes('rate_limited') ||
    states.includes('degraded') ||
    checks.some((check) => check.state === 'needs_action')
  )
    return 'degraded';
  if (states.includes('starting') || checks.some((check) => check.state === 'starting' || check.state === 'warming'))
    return 'starting';
  return 'ready';
}

export function sessionStartBlocker(
  statuses: ServiceStatuses,
  microphoneGranted: boolean,
  capability: string | undefined,
  mode: SessionStartMode = 'full',
): string | undefined {
  if (!capability) return 'Connect services from the app bar before starting.';
  if (!microphoneGranted) return 'Enable the microphone from Services before starting.';
  if (statuses.audio.state !== 'ready') return statuses.audio.detail || 'The local audio service is not ready yet.';
  if (mode === 'full' && statuses.pi.state !== 'ready')
    return statuses.pi.detail || 'The reasoning service is not ready yet.';
  return undefined;
}
