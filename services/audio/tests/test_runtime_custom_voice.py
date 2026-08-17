from __future__ import annotations

from services.audio.src.runtime import QWEN_MODEL_ID, SelectedAudioRuntime
from services.audio.tests.test_runtime import FakeStt, FakeTts


class QwenEnrollmentFake(FakeTts):
    default_voice = 'Ryan'

    def __init__(self):
        super().__init__()
        self.custom: dict[str, str] = {}

    def voice_catalog(self):
        return {
            'catalogId': 'qwen-catalog',
            'backendId': 'qwen3',
            'modelId': 'qwen3-tts-0.6b',
            'runtimeConfigId': 'qwen-runtime',
            'revision': 'qwen-rev',
            'defaultVoiceId': self.default_voice,
            'voices': ([{'id': self.default_voice, 'label': self.default_voice}]
                       + [{'id': voice_id, 'label': label} for voice_id, label in sorted(self.custom.items())]),
        }

    def enroll_custom_voice(self, voice_id, name, ref_sha256, wav_bytes):
        self.custom[voice_id] = name

    def remove_custom_voice(self, voice_id):
        self.custom.pop(voice_id, None)


def test_runtime_refreshes_qwen_catalog_on_enroll_and_delete():
    qwen = QwenEnrollmentFake()
    runtime = SelectedAudioRuntime(FakeStt(), FakeTts(), tts_adapters={f'qwen3:{QWEN_MODEL_ID}': qwen})
    runtime.mark_ready_for_test()
    voice_id = 'custom:aaaaaaaaaaaaaaaaaaaaaaaa'
    runtime.enroll_custom_voice(voice_id, 'Local voice', 'a' * 64, b'wav')
    payload = runtime.readiness()['payload']
    descriptor = next(item for item in payload['ttsModels'] if item['backendId'] == 'qwen3')
    assert descriptor['voiceCatalog']['voices'][-1] == {'id': voice_id, 'label': 'Local voice'}
    runtime.remove_custom_voice(voice_id)
    descriptor = next(item for item in runtime.readiness()['payload']['ttsModels'] if item['backendId'] == 'qwen3')
    assert all(item['id'] != voice_id for item in descriptor['voiceCatalog']['voices'])
    runtime.close()
