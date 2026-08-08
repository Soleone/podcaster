from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field

import pytest

from benchmarks.harness.adapter import CancelToken, Cancelled
from services.audio.src.stt.nemotron import (
    LOOKAHEAD_BY_CHUNK_MS,
    NemotronStreamingAdapter,
    TransformersNemotronBackend,
)
from services.audio.src.vad import DeterministicEndpointer, EndpointerConfig


@dataclass
class FakeBackend:
    prepared: tuple[str, int, str, str] | None = None
    resets: int = 0
    closes: int = 0
    streams: list[list[bytes]] = field(default_factory=list)

    def prepare(self, model_path: str, chunk_ms: int, language: str, precision: str) -> None:
        self.prepared = (model_path, chunk_ms, language, precision)

    def stream(self, chunks, cancel, emit_text):  # type: ignore[no-untyped-def]
        captured = []
        for chunk in chunks:
            cancel.raise_if_cancelled()
            captured.append(chunk)
        self.streams.append(captured)
        emit_text("hello worl")
        emit_text("hello world")
        return "hello world"

    def reset(self) -> None:
        self.resets += 1

    def close(self) -> None:
        self.closes += 1


@pytest.fixture
def prepared() -> tuple[NemotronStreamingAdapter, FakeBackend]:
    backend = FakeBackend()
    adapter = NemotronStreamingAdapter(backend_factory=lambda: backend)
    adapter.prepare(
        {
            "candidate": {"id": "nemotron", "precision": "float32"},
            "modelPath": "models/nemotron",
            "chunkMs": 560,
            "language": "en-US",
        }
    )
    return adapter, backend


def test_prepare_pins_streaming_configuration(prepared) -> None:  # type: ignore[no-untyped-def]
    _, backend = prepared
    assert backend.prepared == ("models/nemotron", 560, "en-US", "float32")
    assert LOOKAHEAD_BY_CHUNK_MS == {80: 0, 160: 1, 320: 3, 560: 6, 1120: 13}


@pytest.mark.parametrize("chunk_ms", [80, 160, 320, 560, 1120])
def test_all_native_chunk_sizes_are_accepted(chunk_ms: int) -> None:
    adapter = NemotronStreamingAdapter(backend_factory=FakeBackend)
    adapter.prepare(
        {
            "candidate": {"id": "nemotron", "precision": "float32"},
            "modelPath": "models/nemotron",
            "chunkMs": chunk_ms,
            "language": "en-US",
        }
    )


def test_invalid_chunk_and_language_fail_closed() -> None:
    for patch in ({"chunkMs": 100}, {"language": "auto"}):
        config = {
            "candidate": {"id": "nemotron", "precision": "float32"},
            "modelPath": "models/nemotron",
            "chunkMs": 560,
            "language": "en-US",
            **patch,
        }
        with pytest.raises(ValueError):
            NemotronStreamingAdapter(backend_factory=FakeBackend).prepare(config)


def test_partials_revisions_and_audio_duration_are_observable(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    chunk = b"\0" * (16_000 * 560 // 1000 * 2)
    observed = []
    result = adapter.transcribe_stream([chunk, chunk], CancelToken(), observed.append)
    assert result.text == "hello world"
    assert result.audio_seconds == pytest.approx(1.12)
    assert [update.text for update in observed] == ["hello worl", "hello world"]
    assert observed[1].replaced_characters == 0
    assert backend.streams == [[chunk, chunk]]


def test_append_only_partial_contract_rejects_revising_backend() -> None:
    class RevisingBackend(FakeBackend):
        def stream(self, chunks, cancel, emit_text):  # type: ignore[no-untyped-def]
            list(chunks)
            emit_text("hello world")
            emit_text("hello there")
            return "hello there"

    adapter = NemotronStreamingAdapter(backend_factory=RevisingBackend)
    adapter.prepare(
        {
            "candidate": {"id": "nemotron", "precision": "float32"},
            "modelPath": "models/nemotron",
            "chunkMs": 560,
            "language": "en-US",
        }
    )
    with pytest.raises(RuntimeError, match="append-only-rnnt-v1"):
        adapter.transcribe([b"\0" * 17_920], CancelToken())


def test_wrong_pcm_chunk_size_fails_before_backend(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    with pytest.raises(ValueError, match="exactly"):
        adapter.transcribe([b"\0\0"], CancelToken())
    assert backend.streams == []


def test_cancel_before_stream_does_not_reach_backend(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    token = CancelToken()
    token.cancel()
    with pytest.raises(Cancelled):
        adapter.transcribe([b"\0" * 17_920], token)
    assert backend.streams == []


def test_midstream_cancel_isolated_from_next_generation(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    token = CancelToken()
    chunk = b"\0" * 17_920

    def interrupted():  # type: ignore[no-untyped-def]
        yield chunk
        token.cancel()
        yield chunk

    with pytest.raises(Cancelled):
        adapter.transcribe(interrupted(), token)
    adapter.reset()
    assert adapter.transcribe([chunk], CancelToken()) == "hello world"
    assert backend.streams == [[chunk]]


def test_reset_isolates_streams_and_close_is_terminal(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    adapter.reset()
    adapter.reset()
    assert adapter.generation == 2
    assert backend.resets == 2
    adapter.close()
    assert backend.closes == 1
    with pytest.raises(RuntimeError):
        adapter.reset()


def test_native_stream_cancels_after_partial_and_cleans_worker(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import torch
    import transformers

    class ControlledStreamer:
        def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
            self.values: queue.Queue[str | None] = queue.Queue()

        def on_finalized_text(self, text: str, stream_end: bool = False) -> None:
            if text:
                self.values.put(text)
            if stream_end:
                self.values.put(None)

        def __iter__(self):  # type: ignore[no-untyped-def]
            return self

        def __next__(self) -> str:
            value = self.values.get(timeout=1)
            if value is None:
                raise StopIteration
            return value

    class ControlledModel:
        def generate(self, **kwargs) -> None:  # type: ignore[no-untyped-def]
            streamer = kwargs["streamer"]
            criteria = kwargs["stopping_criteria"]
            streamer.on_finalized_text("hello ")
            inputs = torch.zeros((1, 1), dtype=torch.long)
            deadline = time.monotonic() + 2
            while not bool(criteria(inputs, None)[0]):
                if time.monotonic() >= deadline:
                    raise RuntimeError("cancellation was not observed")
                time.sleep(0.005)
            streamer.on_finalized_text("", stream_end=True)

    monkeypatch.setattr(transformers, "TextIteratorStreamer", ControlledStreamer)
    backend = TransformersNemotronBackend(model=ControlledModel(), processor=type("P", (), {"tokenizer": object()})())
    monkeypatch.setattr(backend, "_feature_generator", lambda chunks, cancel: ({}, iter(())))
    token = CancelToken()
    observed: list[str] = []

    def on_partial(text: str) -> None:
        observed.append(text)
        token.cancel()

    with pytest.raises(Cancelled):
        backend.stream([], token, on_partial)
    assert observed == ["hello "]
    assert backend._active is None
    assert not any(
        thread.name == "nemotron-stream" and thread.is_alive()
        for thread in threading.enumerate()
    )


def test_native_streamer_failure_cleans_worker(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import transformers

    class FailingStreamer:
        def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
            pass

        def __iter__(self):  # type: ignore[no-untyped-def]
            return self

        def __next__(self) -> str:
            raise RuntimeError("streamer failed")

        def on_finalized_text(self, text: str, stream_end: bool = False) -> None:
            pass

    class CompletedModel:
        def generate(self, **kwargs) -> None:  # type: ignore[no-untyped-def]
            return None

    monkeypatch.setattr(transformers, "TextIteratorStreamer", FailingStreamer)
    backend = TransformersNemotronBackend(model=CompletedModel(), processor=type("P", (), {"tokenizer": object()})())
    monkeypatch.setattr(backend, "_feature_generator", lambda chunks, cancel: ({}, iter(())))
    with pytest.raises(RuntimeError, match="streamer failed"):
        backend.stream([], CancelToken(), lambda text: None)
    assert backend._active is None
    assert not any(
        thread.name == "nemotron-stream" and thread.is_alive()
        for thread in threading.enumerate()
    )


def test_native_backend_retains_live_worker_and_poison_blocks_reuse() -> None:
    release = threading.Event()
    worker = threading.Thread(
        target=release.wait, name="nemotron-stream", daemon=True
    )
    worker.start()
    backend = TransformersNemotronBackend(model=object(), processor=object(), _active=worker)
    with pytest.raises(RuntimeError, match="active"):
        backend.reset()
    with pytest.raises(RuntimeError, match="active"):
        backend.close()
    assert backend._active is worker and worker.is_alive()
    backend._poisoned = True
    release.set()
    worker.join(timeout=1)
    with pytest.raises(RuntimeError, match="poisoned"):
        backend.reset()


def test_vad_start_end_and_reset_are_deterministic() -> None:
    config = EndpointerConfig(speech_start_frames=2, speech_end_frames=2)
    vad = DeterministicEndpointer(config)
    frame_samples = config.sample_rate * config.frame_ms // 1000
    speech = int(1000).to_bytes(2, "little", signed=True) * frame_samples
    silence = b"\0\0" * frame_samples
    assert vad.accept(speech) is None
    assert vad.accept(speech) == "speech_start"
    assert vad.accept(silence) is None
    assert vad.accept(silence) == "speech_end"
    vad.reset()
    assert not vad.in_speech


def test_default_vad_keeps_a_natural_pause_inside_the_same_turn() -> None:
    config = EndpointerConfig()
    vad = DeterministicEndpointer(config)
    frame_samples = config.sample_rate * config.frame_ms // 1000
    speech = int(1000).to_bytes(2, "little", signed=True) * frame_samples
    silence = b"\0\0" * frame_samples
    for _ in range(config.speech_start_frames):
        transition = vad.accept(speech)
    assert transition == "speech_start"
    for _ in range(config.speech_end_frames - 1):
        assert vad.accept(silence) is None
    assert vad.in_speech
    assert vad.accept(speech) is None
    assert vad.in_speech


def test_vad_rejects_wrong_frame_size() -> None:
    vad = DeterministicEndpointer(EndpointerConfig())
    with pytest.raises(ValueError, match="exactly"):
        vad.accept(b"\0\0")
