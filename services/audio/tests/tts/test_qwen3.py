from __future__ import annotations

import hashlib
import math
import threading
import time
from collections.abc import Iterator
from typing import Any

import numpy as np
import pytest

from benchmarks.harness.adapter import CancelToken, Cancelled
from services.audio.src.tts.qwen3 import (
    ATTENTION,
    BACKEND,
    CANDIDATE_ID,
    CHUNK_SIZE_CODEC_STEPS,
    DEVICE,
    FASTER_REPO_COMMIT,
    FASTER_RUNTIME_VERSION,
    LANGUAGE,
    MODEL_ID,
    MODEL_REVISION,
    MODEL_SHA256,
    OFFICIAL_RUNTIME_CONTRACT,
    PRECISION,
    PROVIDER,
    QWEN_REQUIREMENTS_LOCK_SHA256,
    RUNTIME_CONTRACT,
    SAMPLE_RATE,
    SPEAKER,
    Qwen3StreamingAdapter,
    _verify_runtime_distribution,
)


def config(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "candidate": {
            "id": CANDIDATE_ID,
            "modelId": MODEL_ID,
            "revision": MODEL_REVISION,
            "runtime": RUNTIME_CONTRACT,
            "runtimeRevision": FASTER_REPO_COMMIT,
            "fasterRuntimeRevision": FASTER_REPO_COMMIT,
            "fasterVersion": FASTER_RUNTIME_VERSION,
            "runtimeLock": "services/audio/qwen-requirements.lock",
            "runtimeLockSha256": QWEN_REQUIREMENTS_LOCK_SHA256,
            "officialRuntime": OFFICIAL_RUNTIME_CONTRACT,
            "modelSha256": MODEL_SHA256,
            "voice": SPEAKER,
            "provider": PROVIDER,
            "device": "cuda:0",
            "precision": PRECISION,
            "backend": BACKEND,
        },
        "language": LANGUAGE,
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
        "device": DEVICE,
        "dtype": PRECISION,
        "attnImplementation": ATTENTION,
        "backend": BACKEND,
        "chunkSizeCodecSteps": CHUNK_SIZE_CODEC_STEPS,
        "maxNewTokens": 2048,
        "minNewTokens": 2,
        "temperature": 0.9,
        "topK": 50,
        "topP": 1.0,
        "doSample": True,
        "repetitionPenalty": 1.05,
        "modelPath": "/verified/qwen3-tts-12hz-0.6b-customvoice",
    }
    value.update(overrides)
    return value


class FakeBackend:
    def __init__(self, chunks: list[np.ndarray] | None = None) -> None:
        self.chunks = chunks or [np.linspace(-0.25, 0.25, 600, dtype=np.float32)]
        self.prepared: tuple[str, str, str, str] | None = None
        self.closed = False
        self.reset_count = 0
        self.poisoned = False
        self.error: BaseException | None = None
        self.delay = 0.0
        self.texts: list[str] = []

    def prepare(self, model_path: str, device: str, dtype: str, attention: str) -> None:
        self.prepared = (model_path, device, dtype, attention)

    def get_voices(self) -> list[str]:
        return [SPEAKER]

    def create_stream(self, text: str, speaker: str, language: str) -> Iterator[Any]:
        self.texts.append(text)
        assert (speaker, language) == (SPEAKER, LANGUAGE)

        def packets() -> Iterator[Any]:
            if self.error:
                raise self.error
            for chunk in self.chunks:
                if self.delay:
                    time.sleep(self.delay)
                yield chunk, SAMPLE_RATE, {"chunk": len(self.texts)}

        return packets()

    def reset(self) -> None:
        if self.poisoned:
            raise RuntimeError("poisoned")
        self.reset_count += 1

    def close(self) -> None:
        self.closed = True


def prepared(backend: FakeBackend | None = None) -> tuple[Qwen3StreamingAdapter, FakeBackend]:
    fake = backend or FakeBackend()
    adapter = Qwen3StreamingAdapter(
        backend_factory=lambda: fake,
        runtime_verifier=lambda: None,
        asset_verifier=lambda path, expected, digest, label: None,
    )
    adapter.prepare(config())
    return adapter, fake


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("candidate", "modelId"), "wrong/model"),
        (("candidate", "revision"), "mutable"),
        (("candidate", "runtimeRevision"), "wrong"),
        (("candidate", "runtime"), "latest"),
        (("candidate", "runtimeLockSha256"), "wrong"),
        (("candidate", "voice"), "Serena"),
        (("candidate", "provider"), "CPU"),
        (("candidate", "precision"), "float16"),
        (("candidate", "backend"), "ggml"),
        (("language",), "en-US"),
        (("nativeSampleRate",), 16_000),
        (("chunkMs",), 40),
        (("chunkSizeCodecSteps",), 1),
    ],
)
def test_prepare_fails_closed_on_contract_mismatch(path: tuple[str, ...], value: Any) -> None:
    candidate = config()
    target = candidate
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    adapter = Qwen3StreamingAdapter(
        backend_factory=FakeBackend,
        runtime_verifier=lambda: None,
        asset_verifier=lambda path, expected, digest, label: None,
    )
    with pytest.raises(ValueError, match="pinned contract|does not match"):
        adapter.prepare(candidate)


def test_prepare_binds_runtime_and_model_path_before_backend() -> None:
    calls: list[str] = []
    backend = FakeBackend()
    adapter = Qwen3StreamingAdapter(
        backend_factory=lambda: backend,
        runtime_verifier=lambda: calls.append("runtime"),
        asset_verifier=lambda path, expected, digest, label: calls.append("assets"),
    )
    adapter.prepare(config())
    assert calls == ["runtime", "assets"]
    assert backend.prepared == (
        "/verified/qwen3-tts-12hz-0.6b-customvoice",
        DEVICE,
        PRECISION,
        ATTENTION,
    )
    adapter.close()


def test_runtime_origin_revision_verifier_fails_closed(monkeypatch: Any) -> None:
    monkeypatch.setattr("services.audio.src.tts.qwen3._verify_lockfile", lambda: None)
    monkeypatch.setattr("services.audio.src.tts.qwen3._verify_faster_source", lambda: (_ for _ in ()).throw(RuntimeError("origin/revision mismatch")))
    monkeypatch.setattr("services.audio.src.tts.qwen3._verify_runtime_module_bindings", lambda: None)
    versions = {
        "faster-qwen3-tts": "0.3.2",
        "qwen-tts": "0.1.1",
        "transformers": "4.57.3",
        "accelerate": "1.12.0",
        "torch": "2.12.1",
    }

    class Distribution:
        def __init__(self, name: str) -> None:
            self.version = versions[name]

    monkeypatch.setattr("importlib.metadata.distribution", lambda name: Distribution(name))
    with pytest.raises(RuntimeError, match="origin/revision"):
        _verify_runtime_distribution()


def test_native_multiword_speaker_ids_are_mapped_to_catalog_labels() -> None:
    class NativeVoiceBackend(FakeBackend):
        def get_voices(self) -> list[str]:
            return ["ono_anna", "ryan"]

        def create_stream(self, text: str, speaker: str, language: str) -> Iterator[Any]:
            assert speaker == "ono_anna"
            return super().create_stream(text, SPEAKER, language)

    adapter, _ = prepared(NativeVoiceBackend())
    assert adapter.has_voice("Ono Anna")
    catalog = adapter.voice_catalog()
    assert catalog["defaultVoiceId"] == SPEAKER
    assert catalog["speed"] == {"supported": False, "min": 1.0, "max": 1.0, "default": 1.0}
    adapter.synthesize_stream("Mapped voice.", CancelToken(), voice="Ono Anna")
    adapter.close()


def test_ordered_20ms_pcm_framing_and_sha256() -> None:
    backend = FakeBackend(
        [
            np.full(300, 0.25, dtype=np.float32),
            np.full(700, -0.25, dtype=np.float32),
        ]
    )
    adapter, _ = prepared(backend)
    chunks: list[Any] = []
    result = adapter.synthesize_stream("Hello world.", CancelToken(), chunks.append)
    assert [chunk.sequence for chunk in chunks] == [0, 1, 2]
    assert [chunk.sample_offset for chunk in chunks] == [0, 480, 960]
    assert [chunk.samples for chunk in chunks] == [480, 480, 40]
    assert all(chunk.sample_rate == SAMPLE_RATE for chunk in chunks)
    payload = b"".join(chunk.pcm16 for chunk in chunks)
    assert result.total_samples == 1_000
    assert result.chunk_count == 3
    assert result.sha256 == hashlib.sha256(payload).hexdigest()
    assert result.audio_seconds == pytest.approx(1_000 / SAMPLE_RATE)
    adapter.close()


def test_faster_generator_emits_audio_before_synthesize_returns() -> None:
    adapter, _ = prepared()
    order: list[str] = []
    adapter.synthesize_stream("A short acknowledgement.", CancelToken(), lambda _: order.append("audio"))
    order.append("final")
    assert order[0] == "audio"
    assert order[-1] == "final"
    adapter.close()


def test_cancellation_after_first_chunk_has_no_late_audio_or_workers() -> None:
    backend = FakeBackend([np.ones(480, dtype=np.float32) * 0.1 for _ in range(20)])
    backend.delay = 0.005
    adapter, _ = prepared(backend)
    token = CancelToken()
    emitted: list[Any] = []

    def accept(chunk: Any) -> None:
        emitted.append(chunk)
        if len(emitted) == 1:
            token.cancel()

    with pytest.raises(Cancelled):
        adapter.synthesize_stream("Cancel after first audio.", token, accept)
    assert len(emitted) == 1
    assert adapter.worker_names == ()
    adapter.reset()
    adapter.close()


def test_backend_failure_is_sanitized_and_reusable() -> None:
    backend = FakeBackend()
    backend.error = RuntimeError("secret path /private")
    adapter, _ = prepared(backend)
    with pytest.raises(RuntimeError, match="RuntimeError") as raised:
        adapter.synthesize_stream("Failure probe.", CancelToken())
    assert "secret path" not in str(raised.value)
    backend.error = None
    adapter.reset()
    assert adapter.synthesize_stream("Recovered.", CancelToken()).total_samples > 0
    adapter.close()


def test_poisoned_worker_is_refused_until_it_finishes() -> None:
    class StuckBackend(FakeBackend):
        def create_stream(self, *args: Any) -> Iterator[Any]:
            def packets() -> Iterator[Any]:
                time.sleep(0.2)
                yield np.ones(480, dtype=np.float32), SAMPLE_RATE, {}

            return packets()

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


def test_reset_and_close_are_idempotent_at_the_terminal_boundary() -> None:
    adapter, backend = prepared()
    adapter.synthesize_stream("Lifecycle complete.", CancelToken())
    adapter.reset()
    assert adapter.generation == backend.reset_count == 1
    adapter.close()
    adapter.close()
    assert backend.closed
    with pytest.raises(RuntimeError, match="closed"):
        adapter.reset()
    with pytest.raises(RuntimeError, match="closed"):
        adapter.prepare(config())


def test_cancel_before_synthesis_emits_nothing() -> None:
    adapter, _ = prepared()
    token = CancelToken()
    token.cancel()
    emitted: list[Any] = []
    with pytest.raises(Cancelled):
        adapter.synthesize_stream("Do not speak.", token, emitted.append)
    assert emitted == []
    assert adapter.worker_names == ()
    adapter.close()


def test_nonfinite_audio_is_rejected_without_leaking_workers() -> None:
    adapter, _ = prepared(FakeBackend([np.asarray([math.nan], dtype=np.float32)]))
    with pytest.raises(RuntimeError, match="ValueError"):
        adapter.synthesize_stream("Bad audio.", CancelToken())
    assert adapter.worker_names == ()
    adapter.close()
