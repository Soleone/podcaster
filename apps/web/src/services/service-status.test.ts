import { describe, expect, it } from 'vitest';
import { aggregateServiceState, serviceStatusFromAudioEngine, serviceStatusesFromSnapshot, serviceStateLabel } from './service-status';

const ready = { state: 'ready' as const, label: 'service', detail: 'ready', correctiveAction: 'No action needed.' };

describe('service status state machine', () => {
  it('prioritizes unavailable dependencies over degraded and starting states', () => {
    expect(aggregateServiceState({ audio: { ...ready, state: 'degraded' }, pi: { ...ready, state: 'unavailable' } })).toBe('unavailable');
    expect(aggregateServiceState({ audio: { ...ready, state: 'degraded' }, pi: { ...ready, state: 'ready' } })).toBe('degraded');
    expect(aggregateServiceState({ audio: { ...ready, state: 'starting' }, pi: ready })).toBe('starting');
    expect(aggregateServiceState({ audio: ready, pi: ready })).toBe('ready');
  });

  it('maps legacy readiness fields while richer service fields are absent', () => {
    const statuses = serviceStatusesFromSnapshot({ sidecar: 'ready', reasoning: 'checking' });
    expect(statuses.audio.state).toBe('ready');
    expect(statuses.pi.state).toBe('starting');
  });

  it('publishes live audio component progress for the global service surface', () => {
    const status = serviceStatusFromAudioEngine({ status: 'warming', capture: 'ready', vad: 'warming', tts: 'starting', detail: 'Loading speech models.' });
    expect(status).toMatchObject({ state: 'starting', progress: 33, detail: 'Loading speech models.' });
    expect(status.checks).toEqual([
      { label: 'Microphone', state: 'ready' },
      { label: 'Speech detection', state: 'warming' },
      { label: 'Voice engine', state: 'starting' },
    ]);
    expect(aggregateServiceState({ audio: status, pi: ready })).toBe('starting');
    expect(aggregateServiceState({ audio: { ...status, checks: [{ label: 'Microphone', state: 'needs_action' }] }, pi: ready })).toBe('degraded');
  });

  it('uses human-readable labels for every state', () => {
    expect(serviceStateLabel('login_required')).toBe('Sign-in needed');
    expect(serviceStateLabel('rate_limited')).toBe('Rate limited');
    expect(serviceStateLabel('incompatible')).toBe('Incompatible');
  });
});
