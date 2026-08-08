from __future__ import annotations

import hashlib
import json
import threading
import time
import wave
from pathlib import Path

import pytest

from benchmarks.harness.adapter import CancelToken, Cancelled
from benchmarks.harness.runner import ValidationError, _recompute_stt_soak
from benchmarks.harness.stt_runner import (
    PacedChunks,
    _micro_rates,
    _verified_model_path,
    compare_stt_runs,
    error_rates,
    run_stt,
)
from benchmarks.harness.timing import soak_timing_conforms
from services.audio.src.vad import EndpointerConfig

ROOT = Path(__file__).resolve().parents[3]


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def test_paced_chunks_run_20ms_vad_on_monotonic_capture_clock() -> None:
    clock = FakeClock()
    config = EndpointerConfig(speech_start_frames=2, speech_end_frames=2)
    samples = config.sample_rate * config.frame_ms // 1000
    speech = int(1000).to_bytes(2, "little", signed=True) * samples
    frames = [speech, speech, speech]

    class NeverCancelled:
        cancelled = False

        def raise_if_cancelled(self) -> None:
            return None

    paced = PacedChunks(
        frames,
        chunk_ms=80,
        vad_config=config,
        cancel=NeverCancelled(),  # type: ignore[arg-type]
        clock=clock,
        sleep=clock.sleep,
    )
    chunks = list(paced)
    assert len(chunks) == 2
    assert paced.evidence.expected_frames == paced.evidence.consumed_frames == 8
    assert paced.evidence.expected_chunks == paced.evidence.consumed_chunks == 2
    assert paced.evidence.speech_start == pytest.approx(100.04)
    assert paced.evidence.speech_end == pytest.approx(100.10)
    assert clock.now == pytest.approx(100.16)
    assert paced.evidence.deadline_overruns == 0


def test_paced_chunks_measure_adapter_side_queue_wait() -> None:
    config = EndpointerConfig(speech_start_frames=1, speech_end_frames=1)
    samples = config.sample_rate * config.frame_ms // 1000
    speech = int(1000).to_bytes(2, "little", signed=True) * samples
    paced = PacedChunks([speech] * 4, 80, config, CancelToken())
    assert list(paced)
    assert 0.05 <= paced.evidence.consumer_wait_seconds < 0.5
    assert paced.evidence.wait_seconds > 0


def test_config_model_path_must_equal_verified_manifest_path() -> None:
    entry = {
        "path": "models/verified/model.bin",
        "runtimePath": "models/verified",
    }
    assert (
        _verified_model_path({"modelPath": entry["runtimePath"]}, entry)
        == (ROOT / entry["runtimePath"]).resolve()
    )
    with pytest.raises(ValueError, match="does not match"):
        _verified_model_path({"modelPath": "models/other/model.bin"}, entry)


def test_saturated_paced_queue_cancellation_leaves_no_capture_worker() -> None:
    config = EndpointerConfig(speech_start_frames=1, speech_end_frames=1)
    samples = config.sample_rate * config.frame_ms // 1000
    speech = int(1000).to_bytes(2, "little", signed=True) * samples
    token = CancelToken()
    paced = PacedChunks([speech] * 200, 80, config, token)
    iterator = iter(paced)
    assert next(iterator)
    time.sleep(0.8)  # Producer fills its bounded eight-chunk queue.
    token.cancel()
    with pytest.raises(Cancelled):
        next(iterator)
    iterator.close()
    assert not any(
        thread.name == "paced-audio-capture" and thread.is_alive()
        for thread in threading.enumerate()
    )


def test_soak_summary_and_completion_reason_cannot_override_raw_iterations(
    tmp_path: Path,
) -> None:
    run = {
        "runId": "new-run",
        "command": ["benchmark", "--soak-minutes", "0.001"],
    }
    events = [
        {"type": "soak_started", "monotonicMs": 0.0, "detail": {}},
        {
            "type": "soak_iteration",
            "monotonicMs": 80.0,
            "detail": {
                "iteration": 1,
                "expectedFrames": 4,
                "consumedFrames": 4,
                "expectedChunks": 1,
                "consumedChunks": 1,
                "deadlineOverruns": 0,
                "droppedFrames": 0,
                "workerLeaks": 0,
                "resetCount": 1,
                "deadlineLatenessMs": [0.1, 0.2, 0.3, 0.4],
            },
        },
        {
            "type": "soak_completed",
            "monotonicMs": 100.0,
            "detail": {
                "reason": "forged frames=999/999;passed=True",
                "workerLeaks": 0,
                "severeFailures": 0,
            },
        },
    ]
    submitted = {
        "durationSeconds": 0.1,
        "passed": True,
        "severeFailures": 0,
        "underruns": 0,
        "droppedFrames": 0,
        "expectedFrames": 999,
        "consumedFrames": 999,
        "expectedChunks": 1,
        "consumedChunks": 1,
        "deadlineOverruns": 0,
        "deadlineLatenessP95Ms": 0.1,
        "deadlineLatenessMaxMs": 0.1,
        "timingConformance": True,
        "resetCount": 1,
        "workerLeaks": 0,
    }
    recomputed = _recompute_stt_soak(tmp_path, run, events, submitted)
    assert recomputed["expectedFrames"] == recomputed["consumedFrames"] == 4
    assert recomputed["deadlineLatenessP95Ms"] == pytest.approx(0.385)
    assert recomputed != submitted


def test_unpinned_legacy_soak_without_raw_iterations_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="raw iterations"):
        _recompute_stt_soak(
            tmp_path,
            {"runId": "not-accepted", "command": ["benchmark", "--soak-minutes", "30"]},
            [],
            {},
        )


def test_soak_timing_policy_recomputes_numeric_boundaries() -> None:
    assert soak_timing_conforms(
        {
            "timingConformance": True,
            "deadlineLatenessP95Ms": 20.0,
            "deadlineLatenessMaxMs": 100.0,
        }
    )
    assert not soak_timing_conforms(
        {
            "timingConformance": True,
            "deadlineLatenessP95Ms": 20.001,
            "deadlineLatenessMaxMs": 100.0,
        }
    )
    assert not soak_timing_conforms(
        {
            "timingConformance": True,
            "deadlineLatenessP95Ms": 0.1,
            "deadlineLatenessMaxMs": 100.001,
        }
    )


def test_corpus_micro_error_rate_is_not_macro_average() -> None:
    items = [
        {"status": "passed", "sourceId": "short", "transcript": "wrong"},
        {
            "status": "passed",
            "sourceId": "long",
            "transcript": "one two three four five six seven eight nine",
        },
    ]
    references = {
        "short": "right",
        "long": "one two three four five six seven eight nine",
    }
    micro_wer, _ = _micro_rates(items, references)
    macro = (
        sum(error_rates(references[item["sourceId"]], item["transcript"])[0] for item in items) / 2
    )
    assert micro_wer == pytest.approx(0.1)
    assert macro == pytest.approx(0.5)


def _tiny_manifest() -> tuple[Path, Path]:
    media = ROOT / "benchmarks/datasets/.pytest-t3-lifecycle.wav"
    manifest = ROOT / "benchmarks/datasets/.pytest-t3-lifecycle.manifest.json"
    with wave.open(str(media), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(int(1000).to_bytes(2, "little", signed=True) * 1600)
    digest = hashlib.sha256(media.read_bytes()).hexdigest()
    manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "id": "pytest-t3-lifecycle",
                "items": [
                    {
                        "sourceId": "one",
                        "path": str(media.relative_to(ROOT)),
                        "sha256": digest,
                        "reference": "one",
                    }
                ],
            }
        )
    )
    return media, manifest


def test_compare_fails_closed_on_raw_buffer_context_mismatch(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr("benchmarks.harness.stt_runner.validate_run", lambda _: {})
    common = {
        "kind": "stt",
        "datasetSha256": "dataset",
        "precision": "float32",
        "language": "en-US",
        "normalizationVersion": "english-basic-v1",
        "timingMode": "realtime-paced-20ms-v1",
        "vad": {"frameMs": 20},
        "algorithmicLatencyMs": 320,
    }
    paths = []
    for index, semantics in enumerate(
        [
            {
                **common,
                "chunkMs": 320,
                "leftContextMs": 0,
                "rightContextMs": 0,
                "partialContract": "append-only-rnnt-v1",
            },
            {
                **common,
                "chunkMs": 80,
                "leftContextMs": 5600,
                "rightContextMs": 240,
                "partialContract": "cumulative-revising-rnnt-v1",
            },
        ]
    ):
        path = tmp_path / str(index)
        path.mkdir()
        (path / "run.json").write_text(
            json.dumps(
                {
                    "kind": "stt",
                    "runId": str(index),
                    "configId": str(index),
                    "models": [{"id": str(index), "revision": "rev", "precision": "float32"}],
                    "comparisonSemantics": semantics,
                    "comparisonSemanticsSha256": str(index),
                }
            )
        )
        (path / "summary.json").write_text("{}")
        paths.append(path)
    with pytest.raises(ValueError, match="chunkMs.*leftContextMs.*partialContract.*rightContextMs"):
        compare_stt_runs(paths)


def test_compare_reports_raw_ids_for_matched_runs(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr("benchmarks.harness.stt_runner.validate_run", lambda _: {})
    semantics = {"kind": "stt", "datasetSha256": "same", "chunkMs": 160}
    paths = []
    for index in range(2):
        path = tmp_path / str(index)
        path.mkdir()
        (path / "run.json").write_text(
            json.dumps(
                {
                    "kind": "stt",
                    "runId": f"run-{index}",
                    "configId": f"config-{index}",
                    "models": [
                        {"id": f"candidate-{index}", "revision": "rev", "precision": "float32"}
                    ],
                    "comparisonSemantics": semantics,
                    "comparisonSemanticsSha256": "same-hash",
                }
            )
        )
        (path / "summary.json").write_text(
            json.dumps({"wer": index / 10, "soak": {"passed": True}})
        )
        paths.append(path)
    report = compare_stt_runs(paths)
    assert [row["runId"] for row in report["runs"]] == ["run-0", "run-1"]
    assert [row["candidateId"] for row in report["runs"]] == ["candidate-0", "candidate-1"]


def test_reset_and_close_failures_keep_one_expected_item_and_cleanup_evidence(
    tmp_path: Path,
) -> None:
    class FailingAdapter:
        generation = 0
        backend = None
        resets = 0

        def prepare(self, config):  # type: ignore[no-untyped-def]
            return None

        def reset(self) -> None:
            self.resets += 1
            if self.resets == 2:
                raise RuntimeError("measured reset")
            self.generation += 1

        def transcribe(self, chunks, cancel):  # type: ignore[no-untyped-def]
            list(chunks)
            return "warmup"

        def close(self) -> None:
            raise RuntimeError("cleanup")

    media, manifest = _tiny_manifest()
    try:
        run_dir = run_stt(
            "nemotron",
            manifest,
            output_root=tmp_path,
            adapter_factory=FailingAdapter,  # type: ignore[arg-type]
        )
        run = json.loads((run_dir / "run.json").read_text())
        items = [json.loads(line) for line in (run_dir / "items.jsonl").read_text().splitlines()]
        assert run["status"] == "failed"
        measured = [item for item in items if not item["sourceId"].startswith("__run__:")]
        assert len(measured) == 1
        assert measured[0]["failure"]["stage"] == "reset"
        assert any(item["failure"]["stage"] == "close" for item in items)
    finally:
        media.unlink(missing_ok=True)
        manifest.unlink(missing_ok=True)
