from __future__ import annotations

import hashlib
import json
import threading
import time
from dataclasses import dataclass, field as dataclass_field
from pathlib import Path

import pytest

from services.audio.src.binary_framing import BinaryAudioFrame, decode_frame
from services.audio.src.runtime import SelectedAudioRuntime
from services.audio.src.stt.base import TranscriptUpdate, TranscriptionResult
from services.audio.src.tts.base import AudioChunk, SynthesisResult
from services.audio.src.vad.endpointer import EndpointerConfig


@dataclass
class FakeStt:
    closed: bool = False

    def transcribe_stream(self, chunks, cancel, on_partial=None):
        values = list(chunks)
        assert values and all(len(chunk) == 10_240 for chunk in values)
        update = TranscriptUpdate(0, "hello", 0, 1.0)
        if on_partial:
            on_partial(update)
        return TranscriptionResult("hello world", (update,), (len(values) * 5_120) / 16_000, 0.01)

    def close(self):
        self.closed = True


@dataclass
class FakeTts:
    closed: bool = False
    default_voice: str = "af_heart"
    speed: float = 1.0
    speeds: list[float] = dataclass_field(default_factory=list)

    def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
        assert text == "response"
        assert voice in (None, self.default_voice)
        self.speeds.append(getattr(self, "speed", 1.0))
        for sequence in range(2):
            cancel.raise_if_cancelled()
            if on_audio:
                on_audio(AudioChunk(sequence, bytes(960), 24_000, sequence * 480))
        return SynthesisResult(24_000, 960, 0.04, 0.01, "a" * 64, 2)

    def get_voices(self):
        return [{"id": self.default_voice, "label": self.default_voice}]

    def voice_catalog(self):
        return {
            "catalogId": "catalog",
            "backendId": "kokoro",
            "modelId": "kokoro-82m-onnx",
            "runtimeConfigId": "rc",
            "revision": "rev",
            "defaultVoiceId": self.default_voice,
            "voices": self.get_voices(),
        }

    def has_voice(self, voice_id):
        return voice_id == self.default_voice

    def close(self):
        self.closed = True


def wait_for(events, kind):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if any(event.get("type") == kind for event in events):
            return
        time.sleep(0.01)
    raise AssertionError(f"missing {kind}: {events}")


def frame(sequence: int, sample: int) -> BinaryAudioFrame:
    pcm = int(sample).to_bytes(2, "little", signed=True) * 320
    return BinaryAudioFrame(1, 12, sequence, sequence * 20_000, pcm)


def ready_runtime():
    runtime = SelectedAudioRuntime(FakeStt(), FakeTts())
    runtime.mark_ready_for_test()
    events = []
    binary = []
    runtime.open_stream("018f1f32-7abc-7def-8abc-0123456789ab", 12, events.append, binary.append)
    return runtime, events, binary


def test_selected_qwen_catalog_owns_voice_and_speed_for_its_stream() -> None:
    class QwenFake(FakeTts):
        default_voice = "Ryan"
        speed = 1.0

        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            assert text == "response"
            self.speeds.append(getattr(self, "speed", 1.0))
            for sequence in range(2):
                cancel.raise_if_cancelled()
                if on_audio:
                    on_audio(AudioChunk(sequence, bytes(960), 24_000, sequence * 480))
            return SynthesisResult(24_000, 960, 0.04, 0.01, "a" * 64, 2)

        def voice_catalog(self):
            return {
                "catalogId": "qwen-catalog",
                "backendId": "qwen3",
                "modelId": "qwen3-tts-0.6b",
                "runtimeConfigId": "qwen-runtime",
                "revision": "qwen-rev",
                "defaultVoiceId": self.default_voice,
                "speed": {"supported": True, "min": 0.8, "max": 1.2, "default": 1.0},
                "voices": [{"id": "Ryan", "label": "Ryan"}, {"id": "Serena", "label": "Serena"}],
            }

    qwen = QwenFake()
    runtime = SelectedAudioRuntime(FakeStt(), FakeTts(), tts_adapters={"qwen3:qwen3-tts-0.6b": qwen})
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None, "capture", "qwen3", "qwen3-tts-0.6b")
    runtime.request_tts(stream, "018f1f32-7abd-7def-8abc-0123456789ab", 0, "response", voice_id="Serena", speed_modifier=1.15)
    wait_for(events, "tts.ended")
    started = next(event for event in events if event["type"] == "tts.started")
    assert started["payload"]["backendId"] == "qwen3"
    assert started["payload"]["modelId"] == "qwen3-tts-0.6b"
    assert qwen.speeds == [1.15]
    with pytest.raises(ValueError, match="selected model range"):
        runtime.open_tts(stream, "018f1f32-7abe-7def-8abc-0123456789ab", 1, voice_id="Serena", speed_modifier=1.5)
    runtime.close_stream(stream)


def test_selected_model_catalog_identity_is_checked_before_stream_admission() -> None:
    class QwenFake(FakeTts):
        default_voice = "Ryan"

        def voice_catalog(self):
            return {
                "catalogId": "qwen-catalog",
                "backendId": "qwen3",
                "modelId": "qwen3-tts-0.6b",
                "runtimeConfigId": "qwen-runtime",
                "revision": "qwen-rev",
                "defaultVoiceId": self.default_voice,
                "speed": {"supported": False, "min": 1.0, "max": 1.0, "default": 1.0},
                "voices": [{"id": self.default_voice, "label": self.default_voice}],
            }

    runtime = SelectedAudioRuntime(FakeStt(), FakeTts(), tts_adapters={"qwen3:qwen3-tts-0.6b": QwenFake()})
    runtime.mark_ready_for_test()
    with pytest.raises(ValueError, match="catalog"):
        runtime.open_stream(
            "018f1f32-7abc-7def-8abc-0123456789ab",
            12,
            lambda _: None,
            lambda _: None,
            "capture",
            "qwen3",
            "qwen3-tts-0.6b",
            "stale-catalog",
        )
    runtime.close()


def test_unavailable_optional_qwen_keeps_kokoro_ready_and_reports_fallback() -> None:
    class MissingQwen(FakeTts):
        def voice_catalog(self):
            raise RuntimeError("Qwen runtime unavailable")

    runtime = SelectedAudioRuntime(FakeStt(), FakeTts(), tts_adapters={"qwen3:qwen3-tts-0.6b": MissingQwen()})
    runtime.mark_ready_for_test()
    payload = runtime.readiness()["payload"]
    assert payload["status"] == "ready"
    assert payload["voiceCatalog"]["backendId"] == "kokoro"
    qwen = next(model for model in payload["ttsModels"] if model["backendId"] == "qwen3")
    assert qwen["status"] == "unavailable"
    assert qwen["fallback"] == {"backendId": "kokoro", "modelId": "kokoro-82m-onnx"}


def test_qwen_synthesis_failure_does_not_poison_kokoro_fallback() -> None:
    class FailingQwen(FakeTts):
        default_voice = "Ryan"

        def voice_catalog(self):
            return {
                "catalogId": "qwen-catalog",
                "backendId": "qwen3",
                "modelId": "qwen3-tts-0.6b",
                "runtimeConfigId": "qwen-runtime",
                "revision": "qwen-rev",
                "defaultVoiceId": self.default_voice,
                "voices": [{"id": self.default_voice, "label": self.default_voice}],
            }

        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            raise RuntimeError("Qwen failed")

    qwen = FailingQwen()
    qwen.default_voice = "Ryan"
    runtime = SelectedAudioRuntime(FakeStt(), FakeTts(), tts_adapters={"qwen3:qwen3-tts-0.6b": qwen})
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    qwen_response = "018f1f32-7abd-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None, "capture", "qwen3", "qwen3-tts-0.6b")
    runtime.request_tts(stream, qwen_response, 0, "response", voice_id="Ryan")
    wait_for(events, "sidecar.failure")
    assert runtime.status == "ready"
    runtime.close_stream(stream)

    fallback_events = []
    fallback_stream = "018f1f32-7abe-7def-8abc-0123456789ab"
    runtime.open_stream(fallback_stream, 12, fallback_events.append, lambda _: None)
    runtime.request_tts(fallback_stream, "018f1f32-7abf-7def-8abc-0123456789ab", 0, "response")
    wait_for(fallback_events, "tts.ended")
    runtime.close_stream(fallback_stream)


def test_speed_modifier_is_applied_to_each_tts_stream() -> None:
    tts = FakeTts()
    runtime = SelectedAudioRuntime(FakeStt(), tts)
    runtime.mark_ready_for_test()
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    events = []
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    runtime.request_tts(stream, "018f1f32-7abd-7def-8abc-0123456789ab", 0, "response", speed_modifier=1.25)
    wait_for(events, "tts.ended")
    assert tts.speeds == [1.25]
    assert getattr(tts, "speed", 1.0) == 1.0


def test_preview_stream_coexists_with_capture_stream_and_synthesizes() -> None:
    runtime, events, _ = ready_runtime()
    preview_events = []
    session = "018f1f32-7abc-7def-8abc-0123456789ab"
    preview = "018f1f32-7abd-7def-8abc-0123456789ab"
    runtime.open_stream(preview, 0, preview_events.append, lambda _: None, "preview")
    with pytest.raises(RuntimeError, match="one active preview"):
        runtime.open_stream("018f1f32-7abe-7def-8abc-0123456789ab", 0, lambda _: None, lambda _: None, "preview")
    with pytest.raises(RuntimeError, match="one active capture"):
        runtime.open_stream("018f1f32-7abf-7def-8abc-0123456789ab", 13, lambda _: None, lambda _: None)
    runtime.request_tts(preview, "018f1f32-7ab0-7def-8abc-0123456789ab", 0, "response")
    wait_for(preview_events, "tts.ended")
    runtime.close_stream(preview)
    runtime.close_stream(session)


def test_preview_waits_for_session_tts_instead_of_poisoning_runtime() -> None:
    entered = threading.Event()
    release = threading.Event()
    calls = 0

    class SerializedTts(FakeTts):
        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                release.wait(1)
            return super().synthesize_stream(text, cancel, on_audio, voice)

    runtime = SelectedAudioRuntime(FakeStt(), SerializedTts())
    runtime.mark_ready_for_test()
    session_events = []
    preview_events = []
    session = "018f1f32-7abc-7def-8abc-0123456789ab"
    preview = "018f1f32-7abd-7def-8abc-0123456789ab"
    first = "018f1f32-7abe-7def-8abc-0123456789ab"
    second = "018f1f32-7abf-7def-8abc-0123456789ab"
    runtime.open_stream(session, 12, session_events.append, lambda _: None)
    runtime.open_stream(preview, 0, preview_events.append, lambda _: None, "preview")
    runtime.request_tts(session, first, 0, "response")
    assert entered.wait(1)
    runtime.request_tts(preview, second, 0, "response")
    assert not any(event["type"] == "tts.ended" for event in preview_events)
    release.set()
    wait_for(preview_events, "tts.ended")
    assert runtime.status == "ready"
    runtime.close_stream(preview)
    runtime.close_stream(session)


def test_vad_pre_roll_binding_partial_and_final_order() -> None:
    runtime, events, _ = ready_runtime()
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.accept_audio(stream, frame(0, 0))
    runtime.accept_audio(stream, frame(1, 500))
    runtime.accept_audio(stream, frame(2, 500))
    runtime.accept_audio(stream, frame(3, 500))
    start = next(event for event in events if event["type"] == "vad.speech_start")
    utterance = start["payload"]["utteranceId"]
    assert start["payload"]["captureStartSequence"] == 0
    runtime.bind_epoch(stream, utterance, 4)
    endpoint_sequence = 4 + EndpointerConfig().speech_end_frames
    for sequence in range(4, endpoint_sequence):
        runtime.accept_audio(stream, frame(sequence, 0))
    speech_end = next(event for event in events if event["type"] == "vad.speech_end")
    assert speech_end["payload"]["captureStartSequence"] == 0
    # captureEndSequence is the inclusive last speech frame: the frame at which
    # speech_end fires minus the configured trailing silence window.
    assert speech_end["payload"]["captureEndSequence"] == endpoint_sequence - 1 - EndpointerConfig().speech_end_frames
    assert speech_end["payload"]["captureEndSequence"] == 3
    wait_for(events, "stt.final")
    kinds = [event["type"] for event in events]
    assert kinds.index("vad.speech_start") < kinds.index("vad.speech_end") < kinds.index("stt.partial") < kinds.index("stt.final")
    assert next(event for event in events if event["type"] == "stt.final")["payload"]["epoch"] == 4
    runtime.close_stream(stream)


def test_stt_streams_exact_chunks_after_binding_before_endpoint_and_tracks_unpadded_duration() -> None:
    first_chunk = threading.Event()
    observed: list[bytes] = []

    class StreamingStt(FakeStt):
        def transcribe_stream(self, chunks, cancel, on_partial=None):
            for chunk in chunks:
                observed.append(chunk)
                if len(observed) == 1:
                    if on_partial:
                        on_partial(TranscriptUpdate(0, "live", 0, 1.0))
                    first_chunk.set()
            return TranscriptionResult("live final", (), len(observed) * 0.32, 0.01)

    runtime = SelectedAudioRuntime(StreamingStt(), FakeTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    for sequence in range(3):
        runtime.accept_audio(stream, frame(sequence, 500))
    utterance = next(event for event in events if event["type"] == "vad.speech_start")["payload"]["utteranceId"]
    runtime.bind_epoch(stream, utterance, 7)
    for sequence in range(3, 16):
        runtime.accept_audio(stream, frame(sequence, 500))
    assert first_chunk.wait(1)
    assert any(event["type"] == "stt.partial" for event in events)
    assert not any(event["type"] == "vad.speech_end" for event in events)
    endpoint_sequence = 16 + EndpointerConfig().speech_end_frames
    for sequence in range(16, endpoint_sequence):
        runtime.accept_audio(stream, frame(sequence, 0))
    wait_for(events, "stt.final")
    assert observed and all(len(chunk) == 10_240 for chunk in observed)
    assert runtime.last_stt_audio_samples == endpoint_sequence * 320
    expected_chunks = (runtime.last_stt_audio_samples + 5_119) // 5_120
    assert len(observed) == expected_chunks
    runtime.close_stream(stream)


def test_rejects_duplicate_sequence_and_duplicate_epoch_binding() -> None:
    runtime, events, _ = ready_runtime()
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.accept_audio(stream, frame(0, 500))
    try:
        runtime.accept_audio(stream, frame(0, 500))
    except ValueError as error:
        assert "sequence" in str(error)
    else:
        raise AssertionError("duplicate sequence accepted")
    runtime.accept_audio(stream, frame(1, 500))
    runtime.accept_audio(stream, frame(2, 500))
    utterance = next(event for event in events if event["type"] == "vad.speech_start")["payload"]["utteranceId"]
    runtime.bind_epoch(stream, utterance, 0)
    try:
        runtime.bind_epoch(stream, utterance, 1)
    except ValueError:
        pass
    else:
        raise AssertionError("duplicate binding accepted")


def test_selected_nemotron_config_and_manifest_revision_and_digests_are_verified(tmp_path: Path) -> None:
    model_dir = tmp_path / "models/nemotron"
    model_dir.mkdir(parents=True)
    model = model_dir / "model.safetensors"
    config_file = model_dir / "config.json"
    model.write_bytes(b"selected-model")
    config_file.write_bytes(b"selected-config")
    model_digest = hashlib.sha256(model.read_bytes()).hexdigest()
    config_digest = hashlib.sha256(config_file.read_bytes()).hexdigest()
    config = {
        "schemaVersion": 1,
        "id": "nemotron-3.5-transformers-fp32-320ms-paced-v1",
        "candidate": {
            "modelId": "nvidia/nemotron-3.5-asr-streaming-0.6b",
            "revision": "selected-revision",
            "sha256": model_digest,
        },
        "modelPath": "models/nemotron",
    }
    stt_config = tmp_path / "nemotron.json"
    stt_config.write_text(json.dumps(config))
    manifest = tmp_path / "model-manifest.json"
    manifest.write_text(json.dumps({
        "schemaVersion": 1,
        "models": [{
            "id": "nvidia/nemotron-3.5-asr-streaming-0.6b",
            "revision": "selected-revision",
            "sha256": model_digest,
            "runtimePath": "models/nemotron",
            "files": [
                {"path": "models/nemotron/model.safetensors", "sha256": model_digest},
                {"path": "models/nemotron/config.json", "sha256": config_digest},
            ],
        }],
    }))
    runtime = SelectedAudioRuntime(
        FakeStt(), FakeTts(), root=tmp_path, stt_config_path=stt_config,
        model_manifest_path=manifest,
        expected_stt_config_sha256=hashlib.sha256(stt_config.read_bytes()).hexdigest(),
    )
    verified = runtime._verified_stt_config()
    assert verified["modelPath"] == str(model_dir.resolve())

    manifest_data = json.loads(manifest.read_text())
    manifest_data["models"][0]["revision"] = "wrong-revision"
    manifest.write_text(json.dumps(manifest_data))
    with pytest.raises(RuntimeError, match="revision or digest"):
        runtime._verified_stt_config()


def test_selected_kokoro_config_manifest_and_files_are_verified(tmp_path: Path) -> None:
    model_dir = tmp_path / "models/kokoro"
    model_dir.mkdir(parents=True)
    model = model_dir / "kokoro.onnx"
    voices = model_dir / "voices.bin"
    model.write_bytes(b"selected-kokoro")
    voices.write_bytes(b"selected-voices")
    model_digest = hashlib.sha256(model.read_bytes()).hexdigest()
    voices_digest = hashlib.sha256(voices.read_bytes()).hexdigest()
    candidate = {
        "modelId": "hexgrad/Kokoro-82M", "revision": "model-revision",
        "onnxReleaseRevision": "onnx-revision", "runtimeRevision": "runtime-revision",
        "runtime": "runtime-contract", "voice": "af_heart",
        "provider": "CUDAExecutionProvider", "precision": "float32",
        "modelSha256": model_digest, "voicesSha256": voices_digest,
    }
    config = {
        "schemaVersion": 1, "id": "kokoro-82m-onnx-fp32-af-heart-cuda-v1",
        "candidate": candidate, "modelPath": "models/kokoro/kokoro.onnx",
        "voicesPath": "models/kokoro/voices.bin", "language": "en-us",
        "nativeSampleRate": 24_000, "comparisonSampleRate": 24_000,
    }
    config_path = tmp_path / "kokoro.json"
    config_path.write_text(json.dumps(config))
    manifest_path = tmp_path / "manifest.json"
    manifest = {
        "schemaVersion": 1,
        "models": [{
            "id": candidate["modelId"], "revision": candidate["revision"],
            "onnxReleaseRevision": candidate["onnxReleaseRevision"],
            "runtimeRevision": candidate["runtimeRevision"], "runtime": candidate["runtime"],
            "voice": candidate["voice"], "provider": candidate["provider"],
            "precision": candidate["precision"], "language": config["language"],
            "nativeSampleRate": config["nativeSampleRate"], "sha256": model_digest,
            "runtimePath": config["modelPath"], "voicesPath": config["voicesPath"],
            "files": [
                {"path": config["modelPath"], "sha256": model_digest},
                {"path": config["voicesPath"], "sha256": voices_digest},
            ],
        }],
    }
    manifest_path.write_text(json.dumps(manifest))
    runtime = SelectedAudioRuntime(
        FakeStt(), FakeTts(), root=tmp_path, tts_config_path=config_path,
        model_manifest_path=manifest_path,
        expected_tts_config_sha256=hashlib.sha256(config_path.read_bytes()).hexdigest(),
    )
    verified = runtime._verified_tts_config()
    assert verified["modelPath"] == str(model.resolve())
    assert verified["voicesPath"] == str(voices.resolve())
    for field, invalid, message in (
        ("voice", "wrong", "identity or digest"),
        ("provider", "CPUExecutionProvider", "identity or digest"),
        ("precision", "float16", "identity or digest"),
        ("language", "fr-fr", "language or sample rate"),
        ("nativeSampleRate", 16_000, "language or sample rate"),
    ):
        mutated = json.loads(json.dumps(manifest))
        mutated["models"][0][field] = invalid
        manifest_path.write_text(json.dumps(mutated))
        with pytest.raises(RuntimeError, match=message):
            runtime._verified_tts_config()
    manifest_path.write_text(json.dumps(manifest))


def test_cancelled_tts_queues_replacement_until_adapter_exits() -> None:
    entered = threading.Event()
    second_entered = threading.Event()
    release = threading.Event()
    calls = 0

    class BlockingTts(FakeTts):
        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                release.wait(1)
            else:
                second_entered.set()
            cancel.raise_if_cancelled()
            return super().synthesize_stream(text, cancel, on_audio)

    runtime = SelectedAudioRuntime(FakeStt(), BlockingTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    first = "018f1f32-7abd-7def-8abc-0123456789ab"
    second = "018f1f32-7abe-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    runtime.request_tts(stream, first, 0, "response")
    assert entered.wait(1)
    runtime.cancel_tts(stream, first)
    runtime.request_tts(stream, second, 1, "response")
    assert not second_entered.wait(0.05)
    assert not any(event["type"] == "tts.started" and event["payload"]["responseId"] == second for event in events)
    release.set()
    wait_for(events, "tts.cancelled")
    assert second_entered.wait(1)
    wait_for(events, "tts.ended")
    assert runtime.status == "ready"
    runtime.close_stream(stream)


def test_closing_stream_rejects_concurrent_tts_and_fences_worker() -> None:
    entered = threading.Event()
    release = threading.Event()

    class BlockingTts(FakeTts):
        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            entered.set()
            release.wait(1)
            cancel.raise_if_cancelled()
            return super().synthesize_stream(text, cancel, on_audio)

    runtime = SelectedAudioRuntime(FakeStt(), BlockingTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    runtime.request_tts(stream, "018f1f32-7abd-7def-8abc-0123456789ab", 0, "response")
    assert entered.wait(1)
    closer = threading.Thread(target=lambda: runtime.close_stream(stream))
    closer.start()
    deadline = time.monotonic() + 1
    while not runtime._streams[stream].closed and time.monotonic() < deadline:
        time.sleep(0.01)
    with pytest.raises(RuntimeError, match="closing"):
        runtime.request_tts(stream, "018f1f32-7abe-7def-8abc-0123456789ab", 1, "response")
    assert not any(event["type"] == "stream.closed" for event in events)
    release.set()
    closer.join(timeout=1)
    assert not closer.is_alive()
    assert events[-1]["type"] == "stream.closed"
    assert not runtime.worker_names


def test_tts_metadata_precedes_binary_and_reports_exact_samples() -> None:
    runtime, events, binary = ready_runtime()
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    response = "018f1f32-7abd-7def-8abc-0123456789ab"
    runtime.request_tts(stream, response, 0, "response")
    wait_for(events, "tts.ended")
    assert [event["type"] for event in events].index("tts.started") < [event["type"] for event in events].index("tts.ended")
    assert len(binary) == 2
    decoded = [decode_frame(value, 64 * 1024) for value in binary]
    assert [value.sequence for value in decoded] == [0, 1]
    assert all(value.channel == 2 for value in decoded)
    assert events[-1]["payload"]["generatedSamples"] == 960


def test_capture_queue_overflow_fails_visibly() -> None:
    runtime, _, _ = ready_runtime()
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    failure = None
    for sequence in range(1_600):
        try:
            runtime.accept_audio(stream, frame(sequence, 500))
        except RuntimeError as error:
            failure = error
            break
    assert failure is not None and "bound" in str(failure)


def test_reset_accepts_a_fresh_capture_sequence_after_pause() -> None:
    runtime, _, _ = ready_runtime()
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"

    runtime.accept_audio(stream, frame(0, 0))
    runtime.accept_audio(stream, frame(1, 0))
    runtime.reset_stream(stream)

    # The browser creates a new AudioFramePacker after a pause, so the first
    # frame after resume starts at sequence zero rather than continuing 1.
    runtime.accept_audio(stream, frame(0, 0))
    assert runtime.status == "ready"
    runtime.close_stream(stream)


def test_reset_suppresses_late_partial_and_final_without_poisoning_runtime() -> None:
    release = threading.Event()

    class DelayedStt(FakeStt):
        def transcribe_stream(self, chunks, cancel, on_partial=None):
            list(chunks)
            release.wait(1)
            if on_partial:
                on_partial(TranscriptUpdate(0, "late", 0, 1.0))
            return TranscriptionResult("late final", (), 0.1, 0.01)

    runtime = SelectedAudioRuntime(DelayedStt(), FakeTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    for sequence in range(3):
        runtime.accept_audio(stream, frame(sequence, 500))
    utterance = next(event for event in events if event["type"] == "vad.speech_start")["payload"]["utteranceId"]
    runtime.bind_epoch(stream, utterance, 0)
    for sequence in range(3, 23):
        runtime.accept_audio(stream, frame(sequence, 0))
    runtime.reset_stream(stream)
    release.set()
    deadline = time.monotonic() + 1
    while runtime.worker_names and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not any(event["type"] in {"stt.partial", "stt.final", "sidecar.failure"} for event in events)
    assert runtime.status == "ready"


def test_noise_start_while_prior_utterance_finalizes_does_not_close_stream() -> None:
    release = threading.Event()

    class FinalizingStt(FakeStt):
        def transcribe_stream(self, chunks, cancel, on_partial=None):
            values = list(chunks)
            release.wait(1)
            return TranscriptionResult("first final", (), (len(values) * 5_120) / 16_000, 0.01)

    runtime = SelectedAudioRuntime(FinalizingStt(), FakeTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    for sequence in range(3):
        runtime.accept_audio(stream, frame(sequence, 500))
    utterance = next(event for event in events if event["type"] == "vad.speech_start")["payload"]["utteranceId"]
    runtime.bind_epoch(stream, utterance, 0)
    endpoint_sequence = 3 + EndpointerConfig().speech_end_frames
    for sequence in range(3, endpoint_sequence):
        runtime.accept_audio(stream, frame(sequence, 0))
    assert any(event["type"] == "vad.speech_end" for event in events)

    # A background-noise start before finalization is ignored rather than
    # classified as an invalid stream that disconnects capture.
    noise_end_sequence = endpoint_sequence + EndpointerConfig().speech_start_frames
    for sequence in range(endpoint_sequence, noise_end_sequence):
        runtime.accept_audio(stream, frame(sequence, 500))
    assert runtime.status == "ready"
    assert len([event for event in events if event["type"] == "vad.speech_start"]) == 1

    release.set()
    wait_for(events, "stt.final")
    second_start_sequence = noise_end_sequence + 20
    for sequence in range(noise_end_sequence, second_start_sequence):
        runtime.accept_audio(stream, frame(sequence, 0))
    for sequence in range(second_start_sequence, second_start_sequence + EndpointerConfig().speech_start_frames):
        runtime.accept_audio(stream, frame(sequence, 500))
    assert len([event for event in events if event["type"] == "vad.speech_start"]) == 2
    assert runtime.status == "ready"
    runtime.reset_stream(stream)
    runtime.close_stream(stream)


def test_adapter_exception_poisons_runtime_until_restart() -> None:
    class ExplodingTts(FakeTts):
        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            raise RuntimeError("adapter failed")

    runtime = SelectedAudioRuntime(FakeStt(), ExplodingTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    runtime.request_tts(stream, "018f1f32-7abd-7def-8abc-0123456789ab", 0, "response")
    wait_for(events, "sidecar.failure")
    assert runtime.status == "failed"
    try:
        runtime.request_tts(stream, "018f1f32-7abe-7def-8abc-0123456789ab", 0, "response")
    except RuntimeError as error:
        assert "restart" in str(error)
    else:
        raise AssertionError("poisoned runtime accepted more work")


def test_cancel_return_is_a_no_more_audio_cutoff() -> None:
    first = threading.Event()
    continue_synthesis = threading.Event()

    class DelayedTts(FakeTts):
        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            assert on_audio is not None
            on_audio(AudioChunk(0, bytes(960), 24_000, 0))
            first.set()
            continue_synthesis.wait(1)
            on_audio(AudioChunk(1, bytes(960), 24_000, 480))
            return SynthesisResult(24_000, 960, 0.04, 0.01, "a" * 64, 2)

    runtime = SelectedAudioRuntime(FakeStt(), DelayedTts())
    runtime.mark_ready_for_test()
    events = []
    binary = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    response = "018f1f32-7abd-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, binary.append)
    runtime.request_tts(stream, response, 0, "response")
    assert first.wait(1)
    runtime.cancel_tts(stream, response)
    count_at_cutoff = len(binary)
    continue_synthesis.set()
    wait_for(events, "tts.cancelled")
    assert len(binary) == count_at_cutoff
    assert runtime.status == "ready"


def test_tts_cancel_does_not_reset_active_stt_utterance() -> None:
    runtime, events, _ = ready_runtime()
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    for sequence in range(3):
        runtime.accept_audio(stream, frame(sequence, 500))
    utterance = next(event for event in events if event["type"] == "vad.speech_start")["payload"]["utteranceId"]
    response = "018f1f32-7abd-7def-8abc-0123456789ab"
    runtime.request_tts(stream, response, 0, "response")
    runtime.cancel_tts(stream, response)
    runtime.bind_epoch(stream, utterance, 1)
    endpoint_sequence = 3 + EndpointerConfig().speech_end_frames
    for sequence in range(3, endpoint_sequence):
        runtime.accept_audio(stream, frame(sequence, 0))
    wait_for(events, "stt.final")
    assert next(event for event in events if event["type"] == "stt.final")["payload"]["utteranceId"] == utterance
