"""Local voice-enrollment validation for the audio sidecar.

Mirror of packages/contracts/src/settings/custom-voice.ts and the
packages/contracts/schema/voice-enrollment.json bounds. The sidecar revalidates
every reference before extracting a voice-clone prompt, so the browser is not a
trusted authority for format, duration, or signal quality.
"""
from __future__ import annotations

import hashlib
import io
import math
import wave
from dataclasses import dataclass
from typing import Any

CUSTOM_VOICE_PREFIX = "custom:"
CUSTOM_VOICE_SAMPLE_RATE = 16_000
CUSTOM_VOICE_CHANNELS = 1
CUSTOM_VOICE_SAMPLE_WIDTH_BYTES = 2
CUSTOM_VOICE_BYTES_PER_SECOND = (
    CUSTOM_VOICE_SAMPLE_RATE * CUSTOM_VOICE_SAMPLE_WIDTH_BYTES
)
WAV_HEADER_BYTES = 44
MIN_CUSTOM_VOICE_MS = 3_000
MAX_CUSTOM_VOICE_MS = 20_000
# Schema voice-enrollment.json bounds (bytes): 44 + ms//1000 * 32000.
MIN_CUSTOM_VOICE_BYTES = WAV_HEADER_BYTES + (MIN_CUSTOM_VOICE_MS // 1000) * CUSTOM_VOICE_BYTES_PER_SECOND
MAX_CUSTOM_VOICE_BYTES = WAV_HEADER_BYTES + (MAX_CUSTOM_VOICE_MS // 1000) * CUSTOM_VOICE_BYTES_PER_SECOND
MIN_REFERENCE_SIGNAL_RMS = 0.01
MIN_REFERENCE_SIGNAL_PEAK = 0.02
MAX_REFERENCE_SIGNAL_PEAK = 0.98
MAX_CUSTOM_VOICES = 8
MAX_VOICE_NAME_BYTES = 64


class EnrollmentError(ValueError):
    """Rejection with an actionable code usable by the voice.error wire reply."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def derive_voice_id(ref_sha256: str) -> str:
    return f"{CUSTOM_VOICE_PREFIX}{ref_sha256[:24]}"


def is_custom_voice_id(voice_id: str) -> bool:
    return voice_id.startswith(CUSTOM_VOICE_PREFIX)


def _utf8_bytes(value: str) -> int:
    return len(value.encode("utf-8"))


def validate_voice_id(voice_id: str, ref_sha256: str) -> None:
    if not is_custom_voice_id(voice_id):
        raise EnrollmentError("invalid_reference", "voice id is not a custom voice id")
    expected = derive_voice_id(ref_sha256)
    if voice_id != expected:
        raise EnrollmentError("invalid_reference", "voice id does not match the reference digest")


def validate_name(name: str) -> str:
    normalized = " ".join(name.split()).strip()
    if not normalized:
        raise EnrollmentError("invalid_reference", "voice name is empty")
    if _utf8_bytes(normalized) > MAX_VOICE_NAME_BYTES:
        raise EnrollmentError("invalid_reference", "voice name exceeds the byte limit")
    return normalized


@dataclass(frozen=True)
class DecodedReference:
    """Validated PCM16LE mono reference ready for prompt extraction."""

    pcm16: bytes
    samples: int
    duration_ms: int
    rms: float
    peak: float


def decode_reference(wav_bytes: bytes) -> DecodedReference:
    """Parse, bound, and quality-check one WAV reference.

    The browser and host share the same local contract; the sidecar is the
    final enforcement point before any model work happens.
    """
    if not isinstance(wav_bytes, (bytes, bytearray)) or not wav_bytes:
        raise EnrollmentError("decode_failed", "reference bytes are missing")
    if not (MIN_CUSTOM_VOICE_BYTES <= len(wav_bytes) <= MAX_CUSTOM_VOICE_BYTES):
        raise EnrollmentError("too_long" if len(wav_bytes) > MAX_CUSTOM_VOICE_BYTES else "too_short", "reference size is outside the allowed range")
    try:
        with wave.open(io.BytesIO(bytes(wav_bytes)), "rb") as source:
            if source.getnchannels() != CUSTOM_VOICE_CHANNELS or source.getsampwidth() != CUSTOM_VOICE_SAMPLE_WIDTH_BYTES:
                raise EnrollmentError("decode_failed", "reference is not mono PCM16LE")
            if source.getframerate() != CUSTOM_VOICE_SAMPLE_RATE:
                raise EnrollmentError("decode_failed", f"reference sample rate is not {CUSTOM_VOICE_SAMPLE_RATE}")
            frames = source.getnframes()
            pcm16 = source.readframes(frames)
    except (wave.Error, EOFError, OSError) as error:
        raise EnrollmentError("decode_failed", "reference WAV cannot be decoded") from error
    if len(pcm16) != frames * CUSTOM_VOICE_SAMPLE_WIDTH_BYTES:
        raise EnrollmentError("decode_failed", "reference WAV payload is truncated")
    duration_ms = round(frames / CUSTOM_VOICE_SAMPLE_RATE * 1000)
    if duration_ms < MIN_CUSTOM_VOICE_MS:
        raise EnrollmentError("too_short", "reference is shorter than the minimum duration")
    if duration_ms > MAX_CUSTOM_VOICE_MS:
        raise EnrollmentError("too_long", "reference exceeds the maximum duration")

    import numpy as np

    samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(np.square(samples)))) if samples.size else 0.0
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if not math.isfinite(rms) or not math.isfinite(peak) or peak > MAX_REFERENCE_SIGNAL_PEAK:
        raise EnrollmentError("clipped", "reference peaks exceed the allowed level")
    if rms < MIN_REFERENCE_SIGNAL_RMS or peak < MIN_REFERENCE_SIGNAL_PEAK:
        raise EnrollmentError("too_quiet", "reference signal is too quiet")
    return DecodedReference(
        pcm16=bytes(pcm16),
        samples=int(samples.size),
        duration_ms=duration_ms,
        rms=rms,
        peak=peak,
    )


def reference_sha256(wav_bytes: bytes) -> str:
    return hashlib.sha256(wav_bytes).hexdigest()


def enrollment_payload_check(payload: dict[str, Any]) -> None:
    """Cheap structural checks for the wire payload before model work."""
    if not isinstance(payload, dict):
        raise EnrollmentError("invalid_reference", "enrollment payload is invalid")
    for key in ("voiceId", "name", "refSha256"):
        if not isinstance(payload.get(key), str) or not payload[key]:
            raise EnrollmentError("invalid_reference", f"enrollment field {key} is invalid")