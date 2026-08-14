import { describe, expect, it } from 'vitest';
import { applyReconciled, reconcileVoice, settingsDigest, type SettingsModel } from './settings-model';

const catalog = {
  catalogId: 'c1',
  backendId: 'kokoro',
  modelId: 'kokoro-82m-onnx',
  runtimeConfigId: 'rc',
  revision: 'rev',
  defaultVoiceId: 'af_heart',
  voices: [
    { id: 'af_heart', label: 'Heart' },
    { id: 'af_bella', label: 'Bella' },
  ],
};

describe('settings-model voice reconciliation', () => {
  it('keeps a matching voice preference against the same catalog', () => {
    const result = reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella', speedModifier: 1.0 }, catalog);
    expect(result.voice).toEqual({ catalogId: 'c1', voiceId: 'af_bella', speedModifier: 1.0 });
    expect(result.notice).toBeUndefined();
  });

  it('rebases a still-available voice onto a changed catalog with a notice', () => {
    const changed = { ...catalog, catalogId: 'c2' };
    const result = reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella', speedModifier: 1.0 }, changed);
    expect(result.voice).toEqual({ catalogId: 'c2', voiceId: 'af_bella', speedModifier: 1.0 });
    expect(result.notice).toBe('rebase');
  });

  it('defaults to the verified default when the saved voice is gone', () => {
    const slim = { ...catalog, voices: [{ id: 'af_heart', label: 'Heart' }] };
    const result = reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella', speedModifier: 1.0 }, slim);
    expect(result.voice).toEqual({ catalogId: 'c1', voiceId: 'af_heart', speedModifier: 1.0 });
    expect(result.notice).toBe('defaulted');
  });

  it('keeps a saved voice while the verified catalog is still loading', () => {
    const preference = { catalogId: 'c1', voiceId: 'af_bella', speedModifier: 1.0 };
    const result = reconcileVoice(preference, undefined);
    expect(result.voice).toEqual(preference);
    expect(result.notice).toBe('missing_catalog');
  });

  it('disables voice when no verified catalog exists', () => {
    const result = reconcileVoice(undefined, undefined);
    expect(result.voice.catalogId).toBe('');
    expect(result.voice.voiceId).toBe('');
    expect(result.notice).toBe('missing_catalog');
  });

  it('honors exactOptionalPropertyTypes on the model', () => {
    const withNotice: SettingsModel = applyReconciled({ agentName: 'Ada', persona: 'persona' }, reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella', speedModifier: 1.0 }, { ...catalog, catalogId: 'c2' }));
    expect(withNotice.agentName).toBe('Ada');
    expect(withNotice.notice).toBe('rebase');
    const clean: SettingsModel = applyReconciled({ agentName: 'Ada', persona: 'persona' }, reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella', speedModifier: 1.0 }, catalog));
    expect('notice' in clean).toBe(false);
  });

  it('produces a stable, input-sensitive digest', () => {
    const a = settingsDigest({ agentName: 'Ada', persona: 'x', voice: { catalogId: 'c', voiceId: 'v', speedModifier: 1.0 } });
    expect(a).toBe(settingsDigest({ agentName: 'Ada', persona: 'x', voice: { catalogId: 'c', voiceId: 'v', speedModifier: 1.0 } }));
    expect(a).not.toBe(settingsDigest({ agentName: 'Lin', persona: 'x', voice: { catalogId: 'c', voiceId: 'v', speedModifier: 1.0 } }));
    expect(a).not.toBe(settingsDigest({ agentName: 'Ada', persona: 'y', voice: { catalogId: 'c', voiceId: 'v', speedModifier: 1.0 } }));
    expect(a).not.toBe(settingsDigest({ agentName: 'Ada', persona: 'x', voice: { catalogId: 'c', voiceId: 'w', speedModifier: 1.0 } }));
  });
});
