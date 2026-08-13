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
    const result = reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella' }, catalog);
    expect(result.voice).toEqual({ catalogId: 'c1', voiceId: 'af_bella' });
    expect(result.notice).toBeUndefined();
  });

  it('rebases a still-available voice onto a changed catalog with a notice', () => {
    const changed = { ...catalog, catalogId: 'c2' };
    const result = reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella' }, changed);
    expect(result.voice).toEqual({ catalogId: 'c2', voiceId: 'af_bella' });
    expect(result.notice).toBe('rebase');
  });

  it('defaults to the verified default when the saved voice is gone', () => {
    const slim = { ...catalog, voices: [{ id: 'af_heart', label: 'Heart' }] };
    const result = reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella' }, slim);
    expect(result.voice).toEqual({ catalogId: 'c1', voiceId: 'af_heart' });
    expect(result.notice).toBe('defaulted');
  });

  it('disables voice when no verified catalog exists', () => {
    const result = reconcileVoice(undefined, undefined);
    expect(result.voice.catalogId).toBe('');
    expect(result.voice.voiceId).toBe('');
    expect(result.notice).toBe('missing_catalog');
  });

  it('honors exactOptionalPropertyTypes on the model', () => {
    const withNotice: SettingsModel = applyReconciled('persona', reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella' }, { ...catalog, catalogId: 'c2' }));
    expect(withNotice.notice).toBe('rebase');
    const clean: SettingsModel = applyReconciled('persona', reconcileVoice({ catalogId: 'c1', voiceId: 'af_bella' }, catalog));
    expect('notice' in clean).toBe(false);
  });

  it('produces a stable, input-sensitive digest', () => {
    const a = settingsDigest({ persona: 'x', voice: { catalogId: 'c', voiceId: 'v' } });
    expect(a).toBe(settingsDigest({ persona: 'x', voice: { catalogId: 'c', voiceId: 'v' } }));
    expect(a).not.toBe(settingsDigest({ persona: 'y', voice: { catalogId: 'c', voiceId: 'v' } }));
    expect(a).not.toBe(settingsDigest({ persona: 'x', voice: { catalogId: 'c', voiceId: 'w' } }));
  });
});
