from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
import threading
from typing import Any, Protocol, TypeVar

T = TypeVar("T")


class Cancelled(RuntimeError):
    pass


class CancelToken:
    """Cancellation token with a linearized acceptance/cutoff boundary.

    ``cancel()`` and ``accept_unless_cancelled()`` share one re-entrant lock. Once
    an external ``cancel()`` call returns, no later acceptance callback can start.
    Re-entrancy lets an acceptance callback establish its own cutoff.
    """

    def __init__(self) -> None:
        self._cancelled = False
        self._cutoff_lock = threading.RLock()

    @property
    def cancelled(self) -> bool:
        with self._cutoff_lock:
            return self._cancelled

    def cancel(self) -> None:
        with self._cutoff_lock:
            self._cancelled = True

    def raise_if_cancelled(self) -> None:
        with self._cutoff_lock:
            if self._cancelled:
                raise Cancelled("benchmark item cancelled")

    def accept_unless_cancelled(self, callback: Callable[[], T]) -> T:
        with self._cutoff_lock:
            if self._cancelled:
                raise Cancelled("benchmark item cancelled")
            return callback()


class BenchmarkAdapter(Protocol):
    def prepare(self, config: dict[str, Any]) -> None: ...

    def transcribe(self, stream: Iterable[bytes], cancel: CancelToken) -> str: ...

    def synthesize(self, text: str, cancel: CancelToken) -> Iterable[bytes]: ...

    def reset(self) -> None: ...

    def close(self) -> None: ...


@dataclass
class SyntheticNullAdapter:
    prepared: bool = False
    closed: bool = False
    reset_count: int = 0

    def prepare(self, config: dict[str, Any]) -> None:
        if self.closed:
            raise RuntimeError("adapter is closed")
        if config.get("candidate", {}).get("id") != "synthetic-null":
            raise ValueError("synthetic adapter requires candidate synthetic-null")
        self.prepared = True

    def transcribe(self, stream: Iterable[bytes], cancel: CancelToken) -> str:
        if not self.prepared or self.closed:
            raise RuntimeError("adapter is not prepared")
        chunks = 0
        for _ in stream:
            cancel.raise_if_cancelled()
            chunks += 1
        cancel.raise_if_cancelled()
        return f"synthetic transcript {chunks}"

    def synthesize(self, text: str, cancel: CancelToken) -> Iterable[bytes]:
        if not self.prepared or self.closed:
            raise RuntimeError("adapter is not prepared")
        for word in text.split():
            cancel.raise_if_cancelled()
            yield word.encode("utf-8")

    def reset(self) -> None:
        if self.closed:
            raise RuntimeError("adapter is closed")
        self.reset_count += 1

    def close(self) -> None:
        self.closed = True
