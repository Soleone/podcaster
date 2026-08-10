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
