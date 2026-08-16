import { describe, expect, it } from 'vitest';
import { applyReconciled, reconcileSettings, reconcileVoice, settingsDigest, type SettingsModel } from './settings-model';
import { ttsModelKey, type TtsModelDescriptor } from '@app/contracts/settings';

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

const qwenCatalog = {
  catalogId: 'q1',
  backendId: 'qwen3',
  modelId: 'qwen3-tts-0.6b',
  runtimeConfigId: 'qwen-runtime',
  revision: 'qwen-rev',
  defaultVoiceId: 'Ryan',
  speed: { supported: true, min: 0.8, max: 1.2, default: 1.0 },
  voices: [{ id: 'Ryan', label: 'Ryan' }, { id: 'Serena', label: 'Serena' }],
};
const kokoroModel: TtsModelDescriptor = { ...catalog, label: 'Kokoro CUDA', status: 'ready', voiceCatalog: catalog };
const qwenModel: TtsModelDescriptor = { ...qwenCatalog, label: 'faster-Qwen CUDA', status: 'ready', voiceCatalog: qwenCatalog };

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

  it('keeps independent Kokoro and Qwen profiles while switching models', () => {
    const kokoro = { backendId: 'kokoro', modelId: 'kokoro-82m-onnx' };
    const qwen = { backendId: 'qwen3', modelId: 'qwen3-tts-0.6b' };
    const profiles = {
      [ttsModelKey(kokoro)]: { ...{ catalogId: 'c1', voiceId: 'af_bella', speedModifier: 1.35 }, ...kokoro },
      [ttsModelKey(qwen)]: { ...{ catalogId: 'q1', voiceId: 'Serena', speedModifier: 0.85 }, ...qwen },
    };
    const onQwen = reconcileSettings({ selectedModel: qwen, voiceProfiles: profiles }, [kokoroModel, qwenModel]);
    expect(onQwen.selectedModel).toEqual(qwen);
    expect(onQwen.voice).toMatchObject({ voiceId: 'Serena', speedModifier: 0.85, backendId: 'qwen3' });
    const backOnKokoro = reconcileSettings({ selectedModel: kokoro, voiceProfiles: onQwen.voiceProfiles }, [kokoroModel, qwenModel]);
    expect(backOnKokoro.voice).toMatchObject({ voiceId: 'af_bella', speedModifier: 1.35, backendId: 'kokoro' });
  });

  it('resets a stale model voice and unsupported speed to that backend defaults', () => {
    const qwen = { backendId: 'qwen3', modelId: 'qwen3-tts-0.6b' };
    const result = reconcileSettings({ selectedModel: qwen, voiceProfiles: {
      [ttsModelKey(qwen)]: { catalogId: 'old', voiceId: 'removed', speedModifier: 1.8, ...qwen },
    } }, [qwenModel]);
    expect(result.voice).toMatchObject({ catalogId: 'q1', voiceId: 'Ryan', speedModifier: 1, backendId: 'qwen3' });
    expect(result.notice).toBe('speed_defaulted');
  });

  it('falls back to Kokoro when the saved Qwen model is unavailable', () => {
    const { voiceCatalog: _qwenCatalog, ...qwenUnavailableBase } = qwenModel;
    const unavailable: TtsModelDescriptor = { ...qwenUnavailableBase, status: 'unavailable', reason: 'CUDA unavailable', fallback: { backendId: 'kokoro', modelId: 'kokoro-82m-onnx' } };
    const result = reconcileSettings({ selectedModel: { backendId: 'qwen3', modelId: 'qwen3-tts-0.6b' }, voiceProfiles: {} }, [kokoroModel, unavailable]);
    expect(result.selectedModel).toEqual({ backendId: 'kokoro', modelId: 'kokoro-82m-onnx' });
    expect(result.voice.voiceId).toBe('af_heart');
    expect(result.notice).toBe('model_unavailable');
  });

  it('produces a stable, input-sensitive digest', () => {
    const a = settingsDigest({ agentName: 'Ada', persona: 'x', voice: { catalogId: 'c', voiceId: 'v', speedModifier: 1.0 } });
    expect(a).toBe(settingsDigest({ agentName: 'Ada', persona: 'x', voice: { catalogId: 'c', voiceId: 'v', speedModifier: 1.0 } }));
    expect(a).not.toBe(settingsDigest({ agentName: 'Lin', persona: 'x', voice: { catalogId: 'c', voiceId: 'v', speedModifier: 1.0 } }));
    expect(a).not.toBe(settingsDigest({ agentName: 'Ada', persona: 'y', voice: { catalogId: 'c', voiceId: 'v', speedModifier: 1.0 } }));
    expect(a).not.toBe(settingsDigest({ agentName: 'Ada', persona: 'x', voice: { catalogId: 'c', voiceId: 'w', speedModifier: 1.0 } }));
  });
});
