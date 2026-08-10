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

    def synthesize_stream(self, text, cancel, on_audio=None):
        assert text == "response"
        for sequence in range(2):
            cancel.raise_if_cancelled()
            if on_audio:
                on_audio(AudioChunk(sequence, bytes(960), 24_000, sequence * 480))
        return SynthesisResult(24_000, 960, 0.04, 0.01, "a" * 64, 2)

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
    runtime.append_tts(stream, response_id, epoch, 0, "response")
    runtime.commit_tts(stream, response_id, epoch, 1, hashlib.sha256(b"response").hexdigest())
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
    }
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

    class BlockingTts:
        closed: bool = False

        def synthesize_stream(self, text, cancel, on_audio=None):
            first_release.wait(timeout=2)
            cancel.raise_if_cancelled()
            if on_audio:
                on_audio(AudioChunk(0, bytes(960), 24_000, 0))
            return SynthesisResult(24_000, 960, 0.04, 0.01, "a" * 64, 1)

        def close(self):
            self.closed = True

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


def test_third_open_raises_defensive_queue_bound() -> None:
    """len(state.tts) >= 2 remains the defensive bound for uncoordinated clients."""
    import threading

    release = threading.Event()

    class BlockingTts:
        closed: bool = False

        def synthesize_stream(self, text, cancel, on_audio=None):
            release.wait(timeout=2)
            return SynthesisResult(24_000, 960, 0.04, 0.01, "a" * 64, 1)

        def close(self):
            self.closed = True

    runtime = SelectedAudioRuntime(FakeStt(), BlockingTts())
    runtime.mark_ready_for_test()
    events = []
    stream = "018f1f32-7abc-7def-8abc-0123456789ab"
    runtime.open_stream(stream, 12, events.append, lambda _: None)
    first = "018f1f32-7abd-7def-8abc-0123456789ab"
    second = "018f1f32-7abe-7def-8abc-0123456789ab"
    third = "018f1f32-7abf-7def-8abc-0123456789ab"
    for response in (first, second):
        runtime.open_tts(stream, response, 0)
        runtime.append_tts(stream, response, 0, 0, "response")
        runtime.commit_tts(stream, response, 0, 1, hashlib.sha256(b"response").hexdigest())
    import pytest
    with pytest.raises(RuntimeError, match="TTS request queue exceeded bound"):
        runtime.open_tts(stream, third, 0)
    release.set()
    runtime.close_stream(stream)
