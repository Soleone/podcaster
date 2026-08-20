from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Protocol


class Cancellation(Protocol):
    @property
    def cancelled(self) -> bool: ...

    def raise_if_cancelled(self) -> None: ...


@dataclass(frozen=True)
class TranscriptUpdate:
    sequence: int
    text: str
    replaced_characters: int
    monotonic_ms: float


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    updates: tuple[TranscriptUpdate, ...]
    audio_seconds: float
    processing_seconds: float


PartialCallback = Callable[[TranscriptUpdate], None]


class StreamingSttAdapter(Protocol):
    def prepare(self, config: dict[str, object]) -> None: ...

    def transcribe_stream(
        self,
        stream: Iterable[bytes],
        cancel: Cancellation,
        on_partial: PartialCallback | None = None,
    ) -> TranscriptionResult: ...

    def reset(self) -> None: ...

    def close(self) -> None: ...
