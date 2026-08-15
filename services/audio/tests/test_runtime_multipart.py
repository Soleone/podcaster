from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

from services.audio.src.runtime import SelectedAudioRuntime
from services.audio.src.stt.base import TranscriptUpdate, TranscriptionResult
from services.audio.src.tts.base import AudioChunk, SynthesisResult


@dataclass
class FakeStt:
    closed: bool = False

    def transcribe_stream(self, chunks, cancel, on_partial=None):
        values = list(chunks)
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

    def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
        assert text == "response"
        assert voice in (None, self.default_voice)
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


def ready_runtime():
    runtime = SelectedAudioRuntime(FakeStt(), FakeTts())
    runtime.mark_ready_for_test()
    events = []
    runtime.open_stream("018f1f32-7abc-7def-8abc-0123456789ab", 12, events.append, lambda _: None)
    return runtime, events


def drive_partial(runtime, events, response_id, epoch, part_index=None, part_id=None):
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_tts(stream, response_id, epoch, part_index=part_index, part_id=part_id)
    runtime.append_tts(stream, response_id, epoch, 0, "response", part_index=part_index, part_id=part_id)
    runtime.commit_tts(stream, response_id, epoch, 1, hashlib.sha256(b"response").hexdigest(), part_index=part_index, part_id=part_id)
    wait_for(events, "tts.ended")


def test_multipart_open_echoes_part_index_in_started_and_ended() -> None:
    runtime, events = ready_runtime()
    response = "018f1f32-7abd-7def-8abc-0123456789ab"
    drive_partial(runtime, events, response, 0, part_index=0)
    started = next(event for event in events if event["type"] == "tts.started")
    ended = next(event for event in events if event["type"] == "tts.ended")
    assert started["payload"]["partIndex"] == 0
    assert ended["payload"]["partIndex"] == 0
    assert "partId" not in started["payload"]
    assert "partId" not in ended["payload"]
    runtime.close_stream("018f1f32-7abc-7def-8abc-0123456789ab")


def test_multipart_open_echoes_part_index_and_part_id() -> None:
    runtime, events = ready_runtime()
    response = "018f1f32-7abd-7def-8abc-0123456789ab"
    part_id = "018f1f32-7abe-7def-8abc-0123456789ab"
    drive_partial(runtime, events, response, 0, part_index=0, part_id=part_id)
    started = next(event for event in events if event["type"] == "tts.started")
    ended = next(event for event in events if event["type"] == "tts.ended")
    assert started["payload"]["partIndex"] == 0
    assert started["payload"]["partId"] == part_id
    assert ended["payload"]["partIndex"] == 0
    assert ended["payload"]["partId"] == part_id
    runtime.close_stream("018f1f32-7abc-7def-8abc-0123456789ab")


def test_legacy_open_without_part_fields_emits_byte_identical_payloads() -> None:
    runtime, events = ready_runtime()
    response = "018f1f32-7abd-7def-8abc-0123456789ab"
    drive_partial(runtime, events, response, 0)
    started = next(event for event in events if event["type"] == "tts.started")
    ended = next(event for event in events if event["type"] == "tts.ended")
    assert set(started["payload"]) == {
        "streamId",
        "responseId",
        "epoch",
        "playbackId",
        "outputStreamId",
        "sampleRate",
        "voiceId",
    }
    assert started["payload"]["voiceId"] == "af_heart"
    assert set(ended["payload"]) == {
        "streamId",
        "responseId",
        "epoch",
        "playbackId",
        "generatedSamples",
    }
    runtime.close_stream("018f1f32-7abc-7def-8abc-0123456789ab")


def test_multipart_cancel_echoes_part_index_and_part_id() -> None:
    runtime, events = ready_runtime()
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    response = "018f1f32-7abd-7def-8abc-0123456789ab"
    part_id = "018f1f32-7abe-7def-8abc-0123456789ab"
    runtime.open_tts(stream, response, 0, part_index=0, part_id=part_id)
    runtime.cancel_tts(stream, response)
    wait_for(events, "tts.cancelled")
    cancelled = next(event for event in events if event["type"] == "tts.cancelled")
    assert cancelled["payload"]["partIndex"] == 0
    assert cancelled["payload"]["partId"] == part_id
    runtime.close_stream(stream)


def test_committed_stream_allows_one_prefetched_successor() -> None:
    """Decision 007: a committed (still synthesizing) stream must not block a
    prefetched successor from opening; the successor waits on the oldest fence."""
    import threading

    first_release = threading.Event()

    class BlockingTts(FakeTts):
        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            first_release.wait(timeout=2)
            cancel.raise_if_cancelled()
            if on_audio:
                on_audio(AudioChunk(0, bytes(960), 24_000, 0))
            return SynthesisResult(24_000, 960, 0.04, 0.01, "a" * 64, 1)

    runtime = SelectedAudioRuntime(FakeStt(), BlockingTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    first = "018f1f32-7abd-7def-8abc-0123456789ab"
    second = "018f1f32-7abe-7def-8abc-0123456789ab"
    runtime.open_tts(stream, first, 0)
    runtime.append_tts(stream, first, 0, 0, "first")
    runtime.commit_tts(stream, first, 0, 1, hashlib.sha256(b"first").hexdigest())
    # The first worker is blocked in synthesis; a prefetched successor must be
    # able to open (this raised "a progressive TTS stream is already open"
    # before the commit-detach fix).
    runtime.open_tts(stream, second, 0)
    runtime.append_tts(stream, second, 0, 0, "second")
    runtime.commit_tts(stream, second, 0, 1, hashlib.sha256(b"second").hexdigest())
    # The successor waits on the first worker's fence: its audio must not start.
    time.sleep(0.25)
    second_started = [e for e in events if e["type"] == "tts.started" and e["payload"]["responseId"] == second]
    assert not second_started
    first_release.set()
    wait_for(events, "tts.ended")
    ended = [event for event in events if event["type"] == "tts.ended"]
    assert len(ended) == 2
    second_started = [e for e in events if e["type"] == "tts.started" and e["payload"]["responseId"] == second]
    assert len(second_started) == 1
    ended_first = next(e for e in events if e["type"] == "tts.ended" and e["payload"]["responseId"] == first)
    assert events.index(second_started[0]) > events.index(ended_first)
    runtime.close_stream(stream)


def test_prefetched_multipart_siblings_share_parent_response_id() -> None:
    """Multipart parts use one response identity but retain independent TTS streams."""
    import threading

    first_started = threading.Event()
    release_first = threading.Event()
    calls = 0

    class BlockingTts(FakeTts):
        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            nonlocal calls
            calls += 1
            if calls == 1:
                first_started.set()
                release_first.wait(timeout=2)
            cancel.raise_if_cancelled()
            if on_audio:
                on_audio(AudioChunk(0, bytes(960), 24_000, 0))
            return SynthesisResult(24_000, 480, 0.02, 0.01, "a" * 64, 1)

    runtime = SelectedAudioRuntime(FakeStt(), BlockingTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    response = "018f1f32-7abd-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)

    runtime.open_tts(stream, response, 0, part_index=0)
    runtime.append_tts(stream, response, 0, 0, "response", part_index=0)
    runtime.commit_tts(stream, response, 0, 1, hashlib.sha256(b"response").hexdigest(), part_index=0)
    assert first_started.wait(1)

    # The second part has the same parent responseId, so routing must include
    # partIndex or it is incorrectly rejected as a duplicate response.
    runtime.open_tts(stream, response, 0, part_index=1)
    runtime.append_tts(stream, response, 0, 0, "response", part_index=1)
    runtime.commit_tts(stream, response, 0, 1, hashlib.sha256(b"response").hexdigest(), part_index=1)
    assert not any(event["type"] == "tts.started" and event["payload"].get("partIndex") == 1 for event in events)

    release_first.set()
    deadline = time.monotonic() + 2
    while len([event for event in events if event["type"] == "tts.ended"]) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    ended = [event for event in events if event["type"] == "tts.ended"]
    assert [event["payload"]["partIndex"] for event in ended] == [0, 1]
    runtime.close_stream(stream)


def test_rapid_double_replacement_waits_for_oldest_terminalization_fence() -> None:
    """A second replacement waits for the old response instead of poisoning capture."""
    import threading

    first_started = threading.Event()
    release_first = threading.Event()
    release_remaining = threading.Event()
    calls = 0

    class BlockingTts(FakeTts):
        def synthesize_stream(self, text, cancel, on_audio=None, voice=None):
            nonlocal calls
            calls += 1
            if calls == 1:
                first_started.set()
                release_first.wait(timeout=2)
            else:
                release_remaining.wait(timeout=2)
            cancel.raise_if_cancelled()
            if on_audio:
                on_audio(AudioChunk(0, bytes(960), 24_000, 0))
            return SynthesisResult(24_000, 480, 0.02, 0.01, "a" * 64, 1)

    runtime = SelectedAudioRuntime(FakeStt(), BlockingTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    first = "018f1f32-7abd-7def-8abc-0123456789ab"
    replacement = "018f1f32-7abe-7def-8abc-0123456789ab"
    second_replacement = "018f1f32-7abf-7def-8abc-0123456789ab"

    # Leave the original worker inside the adapter, then admit and commit the
    # first replacement. The replacement worker is retained behind the original
    # worker's terminalization fence, so the next open reaches the old bound.
    runtime.request_tts(stream, first, 0, "response")
    assert first_started.wait(1)
    runtime.cancel_tts(stream, first)
    runtime.request_tts(stream, replacement, 1, "response")

    opened = threading.Event()
    errors = []

    def open_second_replacement() -> None:
        try:
            runtime.open_tts(stream, second_replacement, 2)
        except BaseException as error:
            errors.append(error)
        else:
            opened.set()

    opener = threading.Thread(target=open_second_replacement)
    opener.start()
    assert not opened.wait(0.05)

    # Releasing the oldest worker frees exactly one bounded slot. The waiting
    # open must then succeed, while its worker remains fenced behind replacement.
    release_first.set()
    assert opened.wait(1)
    opener.join(timeout=1)
    assert not opener.is_alive()
    assert errors == []

    runtime.append_tts(stream, second_replacement, 2, 0, "response")
    runtime.commit_tts(
        stream,
        second_replacement,
        2,
        1,
        hashlib.sha256(b"response").hexdigest(),
    )
    release_remaining.set()
    deadline = time.monotonic() + 2
    while len([event for event in events if event["type"] in {"tts.ended", "tts.cancelled"}]) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len([event for event in events if event["type"] == "tts.cancelled"]) == 1
    assert len([event for event in events if event["type"] == "tts.ended"]) == 2
    assert not any(event["type"] == "sidecar.failure" for event in events)
    assert runtime.status == "ready"
    runtime.close_stream(stream)
