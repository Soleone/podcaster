from __future__ import annotations

import hashlib
import io
import types
import wave

import numpy as np
import pytest

from benchmarks.harness.adapter import CancelToken
from services.audio.src.tts.qwen import (
    LANGUAGE,
    SAMPLE_RATE,
    Qwen3StreamingAdapter,
)
from services.audio.tests.tts.test_qwen3 import FakeBackend, config


def reference_wav() -> bytes:
    sample_rate = 16_000
    values = (np.sin(np.arange(sample_rate * 5, dtype=np.float32) * 2 * np.pi * 220 / sample_rate) * 10_000).astype('<i2')
    output = io.BytesIO()
    with wave.open(output, 'wb') as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(values.tobytes())
    return output.getvalue()


class CloneQwenModel:
    tts_model_type = 'base'

    def create_voice_clone_prompt(self, *, ref_audio, ref_text, x_vector_only_mode):
        assert ref_text == ''
        assert x_vector_only_mode is True
        assert ref_audio[1] == 16_000
        return [types.SimpleNamespace()]

    def _prompt_items_to_voice_clone_prompt(self, _items):
        return {
            'ref_code': [None],
            'ref_spk_embedding': ['deterministic-speaker-embedding'],
            'x_vector_only_mode': [True],
            'icl_mode': [False],
        }


class CloneBackend:
    def __init__(self):
        self.model = types.SimpleNamespace(model=CloneQwenModel())
        self.poisoned = False
        self.prepared = False
        self.closed = False
        self.prompts = []

    def prepare(self, model_path, device, dtype, attention):
        self.prepared = True

    def create_stream(self, text, prompt, language):
        assert text == 'hello'
        assert language == LANGUAGE
        self.prompts.append(prompt)
        return iter([(np.linspace(-0.2, 0.2, 600, dtype=np.float32), SAMPLE_RATE, {})])

    def reset(self):
        assert self.prepared

    def close(self):
        self.closed = True


def test_custom_voice_uses_base_prompt_and_is_appended_after_stock():
    wav = reference_wav()
    digest = hashlib.sha256(wav).hexdigest()
    voice_id = f'custom:{digest[:24]}'
    clone = CloneBackend()
    adapter = Qwen3StreamingAdapter(
        backend_factory=FakeBackend,
        asset_verifier=lambda *args, **kwargs: None,
        clone_asset_verifier=lambda *args, **kwargs: None,
        clone_backend_factory=lambda: clone,
        runtime_verifier=lambda: None,
    )
    adapter.prepare(config())
    adapter.enroll_custom_voice(voice_id, 'My voice', digest, wav)
    catalog = adapter.voice_catalog()
    assert [voice['id'] for voice in catalog['voices']][-1] == voice_id
    assert catalog['voices'][-1]['label'] == 'My voice'

    chunks = []
    result = adapter.synthesize_stream('hello', CancelToken(), chunks.append, voice=voice_id)
    assert result.total_samples == 600
    assert len(chunks) > 0
    assert clone.prompts[0]['ref_spk_embedding'] == ['deterministic-speaker-embedding']

    adapter.enroll_custom_voice(voice_id, 'Renamed', digest, wav)
    assert adapter.voice_catalog()['voices'][-1]['label'] == 'Renamed'
    assert adapter.remove_custom_voice(voice_id) is True
    assert adapter.remove_custom_voice(voice_id) is False
    with pytest.raises(ValueError, match='absent'):
        adapter.synthesize_stream('hello', CancelToken(), voice=voice_id)
    adapter.close()
    assert clone.closed is True
