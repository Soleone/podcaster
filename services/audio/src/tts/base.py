from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, TypeVar

T = TypeVar("T")

DEFAULT_VOICE_SPEED_MODIFIER = 1.0
MIN_VOICE_SPEED_MODIFIER = 0.5
MAX_VOICE_SPEED_MODIFIER = 2.0


def speed_capability(*, supported: bool = True, minimum: float = MIN_VOICE_SPEED_MODIFIER, maximum: float = MAX_VOICE_SPEED_MODIFIER, default: float = DEFAULT_VOICE_SPEED_MODIFIER) -> dict[str, object]:
    """Return the JSON-safe speed contract advertised by a TTS adapter."""
    return {"supported": supported, "min": minimum, "max": maximum, "default": default}


class TtsCancelled(RuntimeError):
    """Raised after the caller establishes the local no-more-audio cutoff."""


class Cancellation(Protocol):
    @property
    def cancelled(self) -> bool: ...

    def raise_if_cancelled(self) -> None: ...

    def accept_unless_cancelled(self, callback: Callable[[], T]) -> T: ...


@dataclass(frozen=True)
class AudioChunk:
    sequence: int
    pcm16: bytes
    sample_rate: int
    sample_offset: int

    @property
    def samples(self) -> int:
        return len(self.pcm16) // 2


@dataclass(frozen=True)
class SynthesisResult:
    sample_rate: int
    total_samples: int
    audio_seconds: float
    processing_seconds: float
    sha256: str
    chunk_count: int


AudioCallback = Callable[[AudioChunk], None]


class StreamingTtsAdapter(Protocol):
    def prepare(self, config: dict[str, object]) -> None: ...

    def synthesize_stream(
        self,
        text: str,
        cancel: Cancellation,
        on_audio: AudioCallback | None = None,
        voice: str | None = None,
    ) -> SynthesisResult: ...

    def reset(self) -> None: ...

    def close(self) -> None: ...
