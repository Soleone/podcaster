from __future__ import annotations

import hashlib
import math
import threading
import time
from collections.abc import AsyncIterator
from typing import Any

import numpy as np
import pytest

from benchmarks.harness.adapter import CancelToken, Cancelled
from services.audio.src.tts.kokoro import (
    KokoroStreamingAdapter,
    MODEL_ID,
    MODEL_REVISION,
    MODEL_SHA256,
    ONNX_RELEASE_REVISION,
    PROVIDER,
    RUNTIME_CONTRACT,
    RUNTIME_REVISION,
    SAMPLE_RATE,
    VOICE,
    VOICES_SHA256,
    _verify_runtime_distribution,
    segment_text,
    validate_text,
)


def config(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "candidate": {
            "id": "kokoro",
            "modelId": MODEL_ID,
            "revision": MODEL_REVISION,
            "onnxReleaseRevision": ONNX_RELEASE_REVISION,
            "runtimeRevision": RUNTIME_REVISION,
            "runtime": RUNTIME_CONTRACT,
            "modelSha256": MODEL_SHA256,
            "voicesSha256": VOICES_SHA256,
            "voice": VOICE,
            "provider": PROVIDER,
            "precision": "float32",
        },
        "language": "en-us",
        "nativeSampleRate": 24_000,
        "comparisonSampleRate": 24_000,
        "outputFormat": "pcm_s16le_mono",
        "channels": 1,
        "sampleWidthBytes": 2,
        "chunkMs": 20,
        "gain": 0.9,
        "speed": 1.0,
        "resampler": "none",
        "timingMode": "harness-monotonic-request-first-audio-completion-v2",
        "timingBoundary": "harness-before-adapter-call-through-adapter-return-v1",
        "playbackBufferMs": 100,
        "rssScope": "synthesis-window-whole-process-rss-v1",
        "modelPath": "/verified/kokoro-v1.0.onnx",
        "voicesPath": "/verified/voices-v1.0.bin",
    }
    value.update(overrides)
    return value


class FakeBackend:
    def __init__(self, chunks: list[np.ndarray] | None = None) -> None:
        self.chunks = chunks or [np.linspace(-0.25, 0.25, 600, dtype=np.float32)]
        self.prepared: tuple[str, str, str] | None = None
        self.closed = False
        self.reset_count = 0
        self.poisoned = False
        self.error: BaseException | None = None
        self.delay = 0.0
        self.texts: list[str] = []

    def prepare(self, model_path: str, voices_path: str, provider: str) -> None:
        self.prepared = (model_path, voices_path, provider)

    def get_voices(self) -> list[str]:
        return [VOICE]

    async def create_stream(
        self, text: str, voice: str, speed: float, language: str
    ) -> AsyncIterator[tuple[np.ndarray, int]]:
        self.texts.append(text)
        assert (voice, speed, language) == (VOICE, 1.0, "en-us")
        if self.error:
            raise self.error
        for chunk in self.chunks:
            if self.delay:
                await __import__("asyncio").sleep(self.delay)
            yield chunk, SAMPLE_RATE

    def reset(self) -> None:
        if self.poisoned:
            raise RuntimeError("poisoned")
        self.reset_count += 1

    def close(self) -> None:
        self.closed = True


def prepared(backend: FakeBackend | None = None) -> tuple[KokoroStreamingAdapter, FakeBackend]:
    fake = backend or FakeBackend()
    adapter = KokoroStreamingAdapter(
        backend_factory=lambda: fake,
        asset_verifier=lambda path, expected, digest, label: None,
    )
    adapter.prepare(config())
    return adapter, fake


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("candidate", "modelId"), "wrong/model"),
        (("candidate", "revision"), "mutable"),
        (("candidate", "onnxReleaseRevision"), "wrong"),
        (("candidate", "runtimeRevision"), "wrong"),
        (("candidate", "runtime"), "latest"),
        (("candidate", "voice"), "af_bella"),
        (("candidate", "provider"), "CPUExecutionProvider"),
        (("candidate", "precision"), "float16"),
        (("language",), "en-US"),
        (("nativeSampleRate",), 16_000),
        (("comparisonSampleRate",), 48_000),
        (("outputFormat",), "wav"),
        (("gain",), 1.0),
        (("chunkMs",), 40),
    ],
)
def test_prepare_fails_closed_on_contract_mismatch(path: tuple[str, ...], value: Any) -> None:
    candidate = config()
    target = candidate
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    adapter = KokoroStreamingAdapter(
        backend_factory=FakeBackend,
        asset_verifier=lambda path, expected, digest, label: None,
    )
    with pytest.raises(ValueError, match="pinned contract|does not match"):
        adapter.prepare(candidate)


def test_prepare_rejects_wrong_exact_asset_path_or_sha256(tmp_path: Any, monkeypatch: Any) -> None:
    import services.audio.src.tts.kokoro as module

    model = tmp_path / "model.onnx"
    voices = tmp_path / "voices.bin"
    model.write_bytes(b"model")
    voices.write_bytes(b"voices")
    monkeypatch.setattr(module, "MODEL_SHA256", hashlib.sha256(b"model").hexdigest())
    monkeypatch.setattr(module, "VOICES_SHA256", hashlib.sha256(b"voices").hexdigest())
    value = config(modelPath=str(model), voicesPath=str(voices))
    value["candidate"]["modelSha256"] = module.MODEL_SHA256
    value["candidate"]["voicesSha256"] = module.VOICES_SHA256
    adapter = KokoroStreamingAdapter(
        backend_factory=FakeBackend,
        expected_model_path=model,
        expected_voices_path=voices,
    )
    adapter.prepare(value)
    adapter.close()

    wrong = tmp_path / "other.onnx"
    wrong.write_bytes(b"model")
    adapter = KokoroStreamingAdapter(
        backend_factory=FakeBackend,
        expected_model_path=model,
        expected_voices_path=voices,
    )
    wrong_path = config(modelPath=str(wrong), voicesPath=str(voices))
    wrong_path["candidate"]["modelSha256"] = module.MODEL_SHA256
    wrong_path["candidate"]["voicesSha256"] = module.VOICES_SHA256
    with pytest.raises(ValueError, match="exact path"):
        adapter.prepare(wrong_path)
    model.write_bytes(b"tampered")
    with pytest.raises(ValueError, match="SHA-256"):
        adapter.prepare(value)


def test_runtime_origin_revision_verifier_fails_closed(monkeypatch: Any) -> None:
    class Distribution:
        version = "0.5.0"
        def read_text(self, name: str) -> str:
            assert name == "direct_url.json"
            return '{"url":"https://evil.invalid/fork.git","vcs_info":{"vcs":"git","commit_id":"bad","requested_revision":"bad"}}'

    monkeypatch.setattr("importlib.metadata.distribution", lambda name: Distribution())
    with pytest.raises(RuntimeError, match="origin/revision"):
        _verify_runtime_distribution()


def test_runtime_gpu_and_proxy_versions_fail_closed(monkeypatch: Any) -> None:
    class Kokoro:
        version = "0.5.0"
        def read_text(self, name: str) -> str:
            assert name == "direct_url.json"
            return (
                '{"url":"https://github.com/thewh1teagle/kokoro-onnx.git",'
                '"vcs_info":{"vcs":"git","commit_id":"98ea02a5692534c2ba496708e2f19de25028412b",'
                '"requested_revision":"98ea02a5692534c2ba496708e2f19de25028412b"}}'
            )

    def distribution(name: str) -> Any:
        if name == "kokoro-onnx":
            return Kokoro()
        return type("Dist", (), {"version": "1.22.0"})()

    monkeypatch.setattr("importlib.metadata.distribution", distribution)
    _verify_runtime_distribution()

    def wrong_gpu(name: str) -> Any:
        if name == "kokoro-onnx":
            return Kokoro()
        if name == "onnxruntime-gpu":
            return type("Dist", (), {"version": "1.23.0"})()
        return type("Dist", (), {"version": "1.22.0"})()

    monkeypatch.setattr("importlib.metadata.distribution", wrong_gpu)
    with pytest.raises(RuntimeError, match="onnxruntime-gpu version"):
        _verify_runtime_distribution()

    def wrong_proxy(name: str) -> Any:
        if name == "kokoro-onnx":
            return Kokoro()
        if name == "onnxruntime":
            return type("Dist", (), {"version": "1.22.1"})()
        return type("Dist", (), {"version": "1.22.0"})()

    monkeypatch.setattr("importlib.metadata.distribution", wrong_proxy)
    with pytest.raises(RuntimeError, match="proxy version"):
        _verify_runtime_distribution()


def test_prepare_passes_verified_paths_and_cuda_provider() -> None:
    adapter, backend = prepared()
    assert backend.prepared == (
        "/verified/kokoro-v1.0.onnx",
        "/verified/voices-v1.0.bin",
        "CUDAExecutionProvider",
    )
    adapter.close()


@pytest.mark.parametrize("text", ["", "   \n", "bad\0text", "\ud800"])
def test_empty_and_malformed_text_rejected(text: str) -> None:
    with pytest.raises((ValueError, UnicodeError)):
        validate_text(text)


def test_oversized_text_rejected_before_backend() -> None:
    adapter, backend = prepared()
    with pytest.raises(ValueError, match="exceeds"):
        adapter.synthesize_stream("x" * 4_001, CancelToken())
    assert backend.texts == []
    adapter.close()


def test_segmentation_is_deterministic_and_preserves_words_and_punctuation() -> None:
    text = (
        "Dr. Rivera asked, ‘Why now?’ The RTX 4090 result was 3.14 times faster; "
        "however, state-of-the-art speech still needs careful listening."
    )
    first = segment_text(text, 55)
    assert first == segment_text(text, 55)
    assert len(first) >= 2
    assert "".join(first) == text


def test_segmentation_preserves_leading_trailing_and_mixed_whitespace_exactly() -> None:
    text = "  First line.\n\nSecond\tline has spaces.  \r\nThird line.\t"
    segments = segment_text(text, 32)
    assert len(segments) >= 2
    assert "".join(segments) == text


def test_order_pcm_framing_metadata_and_reset_isolation() -> None:
    backend = FakeBackend(
        [
            np.full(300, 0.25, dtype=np.float32),
            np.full(700, -0.25, dtype=np.float32),
        ]
    )
    adapter, _ = prepared(backend)
    chunks = []
    result = adapter.synthesize_stream("Hello world.", CancelToken(), chunks.append)
    assert [chunk.sequence for chunk in chunks] == [0, 1, 2]
    assert [chunk.sample_offset for chunk in chunks] == [0, 480, 960]
    assert all(len(chunk.pcm16) % 2 == 0 for chunk in chunks)
    assert [chunk.samples for chunk in chunks] == [480, 480, 40]
    payload = b"".join(chunk.pcm16 for chunk in chunks)
    assert result.sample_rate == 24_000
    assert result.total_samples == 1_000
    assert result.audio_seconds == pytest.approx(1_000 / 24_000)
    assert result.processing_seconds > 0
    assert result.chunk_count == 3
    assert result.sha256 == hashlib.sha256(payload).hexdigest()
    assert np.frombuffer(payload, dtype="<i2").max() < 32767
    adapter.reset()
    assert adapter.generation == backend.reset_count == 1
    adapter.close()


def test_first_nonempty_audio_precedes_final_result() -> None:
    adapter, _ = prepared()
    order: list[str] = []
    adapter.synthesize_stream("A short acknowledgement.", CancelToken(), lambda _: order.append("audio"))
    order.append("final")
    assert order[0] == "audio" and order[-1] == "final"
    adapter.close()


def test_nonfinite_clipping_and_backend_failure_poison_no_secret_message() -> None:
    for values, match in [([math.nan], "non-finite"), ([2.0], "clip")]:
        backend = FakeBackend([np.asarray(values, dtype=np.float32)])
        adapter, _ = prepared(backend)
        with pytest.raises(RuntimeError, match="ValueError") as raised:
            adapter.synthesize_stream("Failure probe.", CancelToken())
        assert values.__repr__() not in str(raised.value)
        adapter.close()


def test_cancellation_before_synthesis_emits_nothing() -> None:
    adapter, _ = prepared()
    token = CancelToken()
    token.cancel()
    emitted = []
    with pytest.raises(Cancelled):
        adapter.synthesize_stream("Do not speak.", token, emitted.append)
    assert emitted == []
    assert adapter.worker_names == ()
    adapter.close()


def test_realistic_cancellation_after_first_audio_has_no_late_audio_or_workers() -> None:
    backend = FakeBackend([np.ones(480, dtype=np.float32) * 0.1 for _ in range(20)])
    backend.delay = 0.005
    adapter, _ = prepared(backend)
    token = CancelToken()
    emitted = []

    def accept(chunk: Any) -> None:
        emitted.append(chunk)
        if len(emitted) == 1:
            token.cancel()

    started = time.perf_counter()
    with pytest.raises(Cancelled):
        adapter.synthesize_stream("Cancel after first audio, please.", token, accept)
    assert time.perf_counter() - started < 1
    assert len(emitted) == 1
    assert adapter.worker_names == ()
    adapter.reset()
    adapter.close()


def _capture_error(errors: list[BaseException], operation: Any) -> None:
    try:
        operation()
    except BaseException as error:
        errors.append(error)


def test_external_cancel_race_linearizes_before_later_audio_acceptance() -> None:
    backend = FakeBackend([np.ones(480, dtype=np.float32) * 0.1 for _ in range(100)])
    adapter, _ = prepared(backend)
    token = CancelToken()
    first_entered = threading.Event()
    release_first = threading.Event()
    emitted: list[Any] = []

    def accept(chunk: Any) -> None:
        emitted.append(chunk)
        if len(emitted) == 1:
            first_entered.set()
            assert release_first.wait(1)

    cancel_returned = threading.Event()
    runner_error: list[BaseException] = []
    runner = threading.Thread(
        target=lambda: _capture_error(
            runner_error,
            lambda: adapter.synthesize_stream("Linearize external cancellation.", token, accept),
        ),
        name="test-kokoro-race-runner",
    )
    runner.start()
    assert first_entered.wait(1)
    canceller = threading.Thread(
        target=lambda: (token.cancel(), cancel_returned.set()), name="test-kokoro-race-canceller"
    )
    canceller.start()
    time.sleep(0.01)
    assert not cancel_returned.is_set()
    release_first.set()
    canceller.join(1)
    accepted_at_cutoff = len(emitted)
    runner.join(1)
    assert cancel_returned.is_set()
    assert len(emitted) == accepted_at_cutoff
    assert accepted_at_cutoff >= 1
    assert runner_error and isinstance(runner_error[0], Cancelled)
    assert adapter.worker_names == ()
    adapter.close()


def test_cancellation_during_named_runtime_executor_work_is_bounded() -> None:
    class RuntimeBackend(FakeBackend):
        async def create_stream(self, *args: Any) -> AsyncIterator[tuple[np.ndarray, int]]:
            await __import__("asyncio").to_thread(time.sleep, 0.08)
            yield np.ones(480, dtype=np.float32) * 0.1, SAMPLE_RATE

    adapter, _ = prepared(RuntimeBackend())
    token = CancelToken()
    observed = threading.Event()

    def watch() -> None:
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if any(name.startswith("kokoro-runtime-executor") for name in adapter.worker_names):
                observed.set()
                token.cancel()
                return
            time.sleep(0.001)

    watcher = threading.Thread(target=watch, name="test-kokoro-runtime-watcher")
    watcher.start()
    with pytest.raises(Cancelled):
        adapter.synthesize_stream("Cancel during runtime executor work.", token)
    watcher.join(1)
    assert observed.is_set()
    assert adapter.worker_names == ()
    adapter.close()


def test_saturated_consumer_queue_cancellation_is_bounded() -> None:
    backend = FakeBackend([np.ones(480, dtype=np.float32) * 0.1 for _ in range(100)])
    adapter, _ = prepared(backend)
    token = CancelToken()
    entered = threading.Event()

    def slow_consumer(_chunk: Any) -> None:
        entered.set()
        time.sleep(0.08)

    canceller = threading.Thread(
        target=lambda: (entered.wait(1), token.cancel()), name="test-kokoro-canceller"
    )
    canceller.start()
    started = time.perf_counter()
    with pytest.raises(Cancelled):
        adapter.synthesize_stream("Queue saturation cancellation probe.", token, slow_consumer)
    canceller.join()
    assert time.perf_counter() - started < 1
    assert adapter.worker_names == ()
    adapter.close()


def test_backend_failure_is_sanitized_and_reusable_when_workers_stop() -> None:
    backend = FakeBackend()
    backend.error = RuntimeError("secret path /home/user/private")
    adapter, _ = prepared(backend)
    with pytest.raises(RuntimeError, match="RuntimeError") as raised:
        adapter.synthesize_stream("Backend failure.", CancelToken())
    assert "secret path" not in str(raised.value)
    backend.error = None
    adapter.reset()
    assert adapter.synthesize_stream("Recovered.", CancelToken()).total_samples > 0
    adapter.close()


def test_repeated_and_concurrent_prepare_and_stream_exclusion() -> None:
    adapter, _ = prepared()
    with pytest.raises(RuntimeError, match="already prepared"):
        adapter.prepare(config())

    backend = FakeBackend([np.ones(480, dtype=np.float32) * 0.1])
    backend.delay = 0.1
    concurrent, _ = prepared(backend)
    started = threading.Event()
    done: list[BaseException | None] = []

    def run() -> None:
        started.set()
        try:
            concurrent.synthesize_stream("First stream.", CancelToken())
            done.append(None)
        except BaseException as error:
            done.append(error)

    thread = threading.Thread(target=run, name="test-kokoro-stream-owner")
    thread.start()
    started.wait()
    while not concurrent._active:
        time.sleep(0.001)
    with pytest.raises(RuntimeError, match="already active"):
        concurrent.synthesize_stream("Second stream.", CancelToken())
    with pytest.raises(RuntimeError, match="active"):
        concurrent.reset()
    with pytest.raises(RuntimeError, match="active"):
        concurrent.close()
    thread.join()
    assert done == [None]
    concurrent.close()
    adapter.close()


def test_unresolved_worker_poisons_backend_and_prevents_reuse() -> None:
    class StuckBackend(FakeBackend):
        async def create_stream(self, *args: Any) -> AsyncIterator[tuple[np.ndarray, int]]:
            time.sleep(0.2)
            yield np.ones(480, dtype=np.float32), SAMPLE_RATE

    backend = StuckBackend()
    adapter, _ = prepared(backend)
    adapter.worker_timeout_seconds = 0.01
    token = CancelToken()
    timer = threading.Timer(0.01, token.cancel)
    timer.start()
    with pytest.raises(RuntimeError, match="poisoned"):
        adapter.synthesize_stream("Poison probe.", token)
    timer.join()
    assert adapter._poisoned and backend.poisoned
    with pytest.raises(RuntimeError, match="poisoned"):
        adapter.reset()
    time.sleep(0.25)
    assert adapter.worker_names == ()
    adapter.close()


def test_close_is_idempotent_terminal_and_no_surviving_workers() -> None:
    adapter, backend = prepared()
    adapter.synthesize_stream("Lifecycle complete.", CancelToken())
    adapter.close()
    adapter.close()
    assert backend.closed
    assert adapter.worker_names == ()
    with pytest.raises(RuntimeError, match="closed"):
        adapter.reset()
    with pytest.raises(RuntimeError, match="closed"):
        adapter.prepare(config())
