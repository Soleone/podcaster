from __future__ import annotations

import hashlib
import io
import wave

import numpy as np
import pytest

from services.audio.src.voice_enrollment import EnrollmentError, decode_reference, derive_voice_id


def wav(duration_seconds=5, amplitude=10_000):
    values = (np.sin(np.arange(int(16_000 * duration_seconds), dtype=np.float32) * 2 * np.pi * 220 / 16_000) * amplitude).astype('<i2')
    output = io.BytesIO()
    with wave.open(output, 'wb') as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16_000)
        target.writeframes(values.tobytes())
    return output.getvalue()


def test_reference_format_and_signal_are_revalidated():
    value = wav()
    decoded = decode_reference(value)
    assert decoded.samples == 80_000
    assert 4_999 <= decoded.duration_ms <= 5_001
    assert decoded.rms > 0.01
    digest = hashlib.sha256(value).hexdigest()
    assert derive_voice_id(digest) == f'custom:{digest[:24]}'


def test_silence_and_wrong_duration_are_actionable():
    silence = io.BytesIO()
    with wave.open(silence, 'wb') as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16_000)
        target.writeframes(bytes(16_000 * 5 * 2))
    with pytest.raises(EnrollmentError, match='quiet') as error:
        decode_reference(silence.getvalue())
    assert error.value.code == 'too_quiet'
    with pytest.raises(EnrollmentError) as error:
        decode_reference(wav(2))
    assert error.value.code == 'too_short'


def test_clipped_signal_is_rejected():
    with pytest.raises(EnrollmentError) as error:
        decode_reference(wav(5, 32_767))
    assert error.value.code == 'clipped'
