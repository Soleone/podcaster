from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from types import SimpleNamespace

import pytest

from benchmarks.harness.adapter import CancelToken, Cancelled
from services.audio.src.stt.parakeet import (
    MODEL_ID,
    MODEL_REVISION,
    NEMO_REVISION,
    RUNTIME,
    NemoBufferedParakeetBackend,
    ParakeetStreamingAdapter,
)


@dataclass
class FakeBackend:
    poisoned: bool = False
    prepared: tuple[object, ...] | None = None
    resets: int = 0
    closes: int = 0
    streams: list[list[bytes]] = field(default_factory=list)

    def prepare(self, *args: object) -> None:
        self.prepared = args

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
        if self.poisoned:
            raise RuntimeError("poisoned")
        self.resets += 1

    def close(self) -> None:
        self.closes += 1


def config(chunk: int = 80, right: int = 240) -> dict[str, object]:
    return {
        "candidate": {
            "id": "parakeet",
            "modelId": MODEL_ID,
            "revision": MODEL_REVISION,
            "runtime": RUNTIME,
            "runtimeRevision": NEMO_REVISION,
            "precision": "float32",
        },
        "modelPath": "models/parakeet-unified-en-0.6b/parakeet-unified-en-0.6b.nemo",
        "chunkMs": chunk,
        "captureChunkMs": 20,
        "leftContextMs": 5600,
        "rightContextMs": right,
        "algorithmicLatencyMs": chunk + right,
        "partialContract": "append-only-rnnt-v1",
        "language": "en-US",
    }


@pytest.fixture
def prepared() -> tuple[ParakeetStreamingAdapter, FakeBackend]:
    backend = FakeBackend()
    adapter = ParakeetStreamingAdapter(backend_factory=lambda: backend)
    adapter.prepare(config())
    return adapter, backend


def test_prepare_pins_model_runtime_precision_and_context(prepared) -> None:  # type: ignore[no-untyped-def]
    _, backend = prepared
    assert backend.prepared == (
        "models/parakeet-unified-en-0.6b/parakeet-unified-en-0.6b.nemo",
        80,
        20,
        5600,
        240,
        "en-US",
        "float32",
        NEMO_REVISION,
    )


@pytest.mark.parametrize("chunk,right", [(80, 80), (80, 160), (80, 240), (160, 400), (560, 560)])
def test_official_buffer_context_presets_are_accepted(chunk: int, right: int) -> None:
    ParakeetStreamingAdapter(backend_factory=FakeBackend).prepare(config(chunk, right))


@pytest.mark.parametrize(
    "chunk,left,right,expected",
    [
        (80, 5600, 80, [70, 1, 1]),
        (80, 5600, 160, [70, 1, 2]),
        (80, 5600, 240, [70, 1, 3]),
        (160, 5600, 400, [70, 2, 5]),
        (560, 5600, 560, [70, 7, 7]),
        (1040, 5600, 1040, [70, 13, 13]),
    ],
)
def test_attention_context_is_installed_for_every_supported_preset(
    chunk: int, left: int, right: int, expected: list[int]
) -> None:
    calls: list[list[int]] = []
    encoder = SimpleNamespace(
        subsampling_factor=8,
        set_default_att_context_size=lambda value: calls.append(value),
    )
    model = SimpleNamespace(
        cfg=SimpleNamespace(
            preprocessor=SimpleNamespace(window_stride=0.01),
            encoder=SimpleNamespace(att_context_style="chunked_limited_with_rc"),
        ),
        encoder=encoder,
    )
    assert NemoBufferedParakeetBackend._configure_attention_context(
        model, chunk, left, right
    ) == tuple(expected)
    assert calls == [expected]


def test_unified_attention_style_must_match_official_buffered_algorithm() -> None:
    model = SimpleNamespace(
        cfg=SimpleNamespace(
            preprocessor=SimpleNamespace(window_stride=0.01),
            encoder=SimpleNamespace(att_context_style="regular"),
        ),
        encoder=SimpleNamespace(subsampling_factor=8),
    )
    with pytest.raises(RuntimeError, match="attention style"):
        NemoBufferedParakeetBackend._configure_attention_context(model, 80, 5600, 240)


@pytest.mark.parametrize(
    "chunk_ms,right_ms,packet_count,expected_lengths",
    [
        (80, 240, 30, [10_240, 2_560, 2_560, 2_560, 1_280]),
        (160, 400, 40, [17_920, 5_120, 2_560]),
    ],
)
def test_capture_packets_are_reframed_to_exact_buffer_context(
    chunk_ms: int, right_ms: int, packet_count: int, expected_lengths: list[int]
) -> None:
    capture_bytes = 16_000 * 20 // 1000 * 2
    chunks = [bytes([index]) * capture_bytes for index in range(packet_count)]
    blocks = list(
        NemoBufferedParakeetBackend._buffered_pcm_blocks(
            chunks,
            CancelToken(),
            capture_bytes,
            16_000 * (chunk_ms + right_ms) // 1000 * 2,
            16_000 * chunk_ms // 1000 * 2,
        )
    )
    assert [len(block) for block, _ in blocks] == expected_lengths
    assert [last for _, last in blocks] == [False] * (len(blocks) - 1) + [True]
    assert b"".join(block for block, _ in blocks) == b"".join(chunks)


def test_exact_initial_window_uses_explicit_empty_final_flush() -> None:
    capture_bytes = 16_000 * 20 // 1000 * 2
    blocks = list(
        NemoBufferedParakeetBackend._buffered_pcm_blocks(
            [b"\0" * capture_bytes] * 16,
            CancelToken(),
            capture_bytes,
            16_000 * 320 // 1000 * 2,
            16_000 * 80 // 1000 * 2,
        )
    )
    assert [(len(block), final) for block, final in blocks] == [
        (10_240, False),
        (0, True),
    ]


@pytest.mark.parametrize("chunk_ms,right_ms", [(80, 240), (160, 400)])
def test_first_buffer_block_does_not_prefetch_a_future_capture_packet(
    chunk_ms: int, right_ms: int
) -> None:
    capture_bytes = 16_000 * 20 // 1000 * 2
    required_packets = (chunk_ms + right_ms) // 20

    class CountingPackets:
        def __init__(self) -> None:
            self.consumed = 0

        def __iter__(self):  # type: ignore[no-untyped-def]
            return self

        def __next__(self) -> bytes:
            self.consumed += 1
            return b"\0" * capture_bytes

    packets = CountingPackets()
    blocks = NemoBufferedParakeetBackend._buffered_pcm_blocks(
        packets,
        CancelToken(),
        capture_bytes,
        16_000 * (chunk_ms + right_ms) // 1000 * 2,
        16_000 * chunk_ms // 1000 * 2,
    )
    first, is_last = next(blocks)
    assert len(first) == 16_000 * (chunk_ms + right_ms) // 1000 * 2
    assert packets.consumed == required_packets
    assert not is_last


@pytest.mark.parametrize(
    "patch",
    [
        {"leftContextMs": 0},
        {"rightContextMs": 241},
        {"algorithmicLatencyMs": 319},
        {"language": "auto"},
        {"candidate": {"id": "parakeet", "modelId": MODEL_ID, "revision": "main"}},
    ],
)
def test_unverified_contracts_fail_closed(patch: dict[str, object]) -> None:
    candidate = config()
    candidate.update(patch)
    with pytest.raises(ValueError):
        ParakeetStreamingAdapter(backend_factory=FakeBackend).prepare(candidate)


def test_append_only_partials_and_audio_duration_are_observable(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    chunk = b"\0" * 640
    observed = []
    result = adapter.transcribe_stream([chunk, chunk], CancelToken(), observed.append)
    assert result.text == "hello world"
    assert result.audio_seconds == pytest.approx(0.04)
    assert [update.text for update in observed] == ["hello worl", "hello world"]
    assert observed[1].replaced_characters == 0
    assert backend.streams == [[chunk, chunk]]


def test_revising_partial_is_rejected_as_untruthful_runtime_contract() -> None:
    class RevisingBackend(FakeBackend):
        def stream(self, chunks, cancel, emit_text):  # type: ignore[no-untyped-def]
            list(chunks)
            emit_text("hello world")
            emit_text("hello there")
            return "hello there"

    adapter = ParakeetStreamingAdapter(backend_factory=RevisingBackend)
    adapter.prepare(config())
    with pytest.raises(RuntimeError, match="append-only-rnnt-v1"):
        adapter.transcribe([b"\0" * 640], CancelToken())


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
        adapter.transcribe([b"\0" * 640], token)
    assert backend.streams == []


def test_cancel_after_partial_and_reset_isolates_next_stream() -> None:
    class CancellingBackend(FakeBackend):
        calls = 0

        def stream(self, chunks, cancel, emit_text):  # type: ignore[no-untyped-def]
            list(chunks)
            self.calls += 1
            emit_text("partial")
            cancel.raise_if_cancelled()
            return "final"

    backend = CancellingBackend()
    adapter = ParakeetStreamingAdapter(backend_factory=lambda: backend)
    adapter.prepare(config())
    token = CancelToken()
    with pytest.raises(Cancelled):
        adapter.transcribe_stream([b"\0" * 640], token, lambda _: token.cancel())
    adapter.reset()
    assert adapter.generation == 1
    assert adapter.transcribe([b"\0" * 640], CancelToken()) == "final"


def test_backend_failure_is_sanitized(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, _ = prepared

    class Broken(FakeBackend):
        def stream(self, chunks, cancel, emit_text):  # type: ignore[no-untyped-def]
            raise KeyError("secret detail")

    broken = ParakeetStreamingAdapter(backend_factory=Broken)
    broken.prepare(config())
    with pytest.raises(KeyError):
        broken.transcribe([b"\0" * 640], CancelToken())


def test_repeated_prepare_is_rejected_without_replacing_or_leaking_backend(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    with pytest.raises(RuntimeError, match="already prepared"):
        adapter.prepare(config())
    assert adapter.backend is backend
    assert backend.closes == 0
    adapter.close()
    assert backend.closes == 1


def test_concurrent_prepare_reserves_one_backend() -> None:
    entered = threading.Event()
    release = threading.Event()
    created: list[FakeBackend] = []

    class BlockingBackend(FakeBackend):
        def prepare(self, *args: object) -> None:
            super().prepare(*args)
            entered.set()
            assert release.wait(timeout=2)

    def factory() -> FakeBackend:
        backend = BlockingBackend()
        created.append(backend)
        return backend

    adapter = ParakeetStreamingAdapter(backend_factory=factory)
    errors: list[BaseException] = []
    thread = threading.Thread(
        target=lambda: _capture_error(lambda: adapter.prepare(config()), errors), daemon=True
    )
    thread.start()
    assert entered.wait(timeout=1)
    with pytest.raises(RuntimeError, match="preparing"):
        adapter.prepare(config())
    release.set()
    thread.join(timeout=2)
    assert not thread.is_alive() and not errors
    assert len(created) == 1 and adapter.backend is created[0]
    adapter.close()
    assert created[0].closes == 1


def _capture_error(call, errors: list[BaseException]) -> None:  # type: ignore[no-untyped-def]
    try:
        call()
    except BaseException as error:
        errors.append(error)


def test_reset_and_close_are_terminal(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    adapter.reset()
    adapter.close()
    assert backend.resets == 1 and backend.closes == 1
    with pytest.raises(RuntimeError):
        adapter.reset()
    with pytest.raises(RuntimeError):
        adapter.prepare(config())


def test_concurrent_adapter_stream_is_rejected_without_entering_backend(prepared) -> None:  # type: ignore[no-untyped-def]
    adapter, backend = prepared
    entered = threading.Event()
    release = threading.Event()

    def blocking_stream(chunks, cancel, emit_text):  # type: ignore[no-untyped-def]
        list(chunks)
        entered.set()
        assert release.wait(timeout=2)
        return "done"

    backend.stream = blocking_stream  # type: ignore[method-assign]
    thread = threading.Thread(
        target=lambda: adapter.transcribe([b"\0" * 640], CancelToken()), daemon=True
    )
    thread.start()
    assert entered.wait(timeout=1)
    with pytest.raises(RuntimeError, match="already active"):
        adapter.transcribe([b"\0" * 640], CancelToken())
    with pytest.raises(RuntimeError, match="active"):
        adapter.reset()
    release.set()
    thread.join(timeout=2)
    assert not thread.is_alive()


def test_concurrent_native_stream_is_rejected_before_second_decode(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    backend = NemoBufferedParakeetBackend(model=object())
    entered = threading.Event()
    release = threading.Event()
    calls = 0

    def decode(*args):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        entered.set()
        assert release.wait(timeout=2)
        return "done"

    monkeypatch.setattr(backend, "_decode", decode)
    thread = threading.Thread(
        target=lambda: backend.stream([], CancelToken(), lambda _: None), daemon=True
    )
    thread.start()
    assert entered.wait(timeout=1)
    with pytest.raises(RuntimeError, match="already active"):
        backend.stream([], CancelToken(), lambda _: None)
    release.set()
    thread.join(timeout=2)
    assert calls == 1 and not thread.is_alive()


def test_native_worker_cancellation_after_partial_leaves_no_worker(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    backend = NemoBufferedParakeetBackend(model=object())
    token = CancelToken()

    def decode(chunks, cancel, emit):  # type: ignore[no-untyped-def]
        emit("partial")
        deadline = time.monotonic() + 2
        while not cancel.cancelled:
            if time.monotonic() >= deadline:
                raise RuntimeError("cancel not observed")
            time.sleep(0.005)
        cancel.raise_if_cancelled()

    monkeypatch.setattr(backend, "_decode", decode)
    with pytest.raises(Cancelled):
        backend.stream([], token, lambda _: token.cancel())
    assert backend._active is None
    assert not any(t.name == "parakeet-stream" and t.is_alive() for t in threading.enumerate())


def test_native_failure_cleans_worker(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    backend = NemoBufferedParakeetBackend(model=object())
    monkeypatch.setattr(backend, "_decode", lambda *args: (_ for _ in ()).throw(ValueError("bad")))
    with pytest.raises(RuntimeError, match="ValueError.*poisoned"):
        backend.stream([], CancelToken(), lambda _: None)
    assert backend._active is None and backend.poisoned
    with pytest.raises(RuntimeError, match="poisoned"):
        backend.reset()
    assert not any(t.name == "parakeet-stream" and t.is_alive() for t in threading.enumerate())


def test_live_worker_poison_blocks_reuse_and_close() -> None:
    release = threading.Event()
    worker = threading.Thread(target=release.wait, name="parakeet-stream", daemon=True)
    worker.start()
    backend = NemoBufferedParakeetBackend(model=object(), _active=worker)
    with pytest.raises(RuntimeError, match="active"):
        backend.reset()
    with pytest.raises(RuntimeError, match="poisoned"):
        backend.close()
    assert backend.poisoned
    release.set()
    worker.join(timeout=1)
    with pytest.raises(RuntimeError, match="poisoned"):
        backend.reset()
