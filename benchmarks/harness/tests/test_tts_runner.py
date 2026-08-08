from __future__ import annotations

import json
import wave
from pathlib import Path
from typing import Any

import pytest

from benchmarks.harness.adapter import CancelToken
from benchmarks.harness.checksums import ChecksumError, verify_dataset
from benchmarks.harness.runner import ROOT, ValidationError, validate_run
from benchmarks.harness.tts_runner import (
    compare_tts_runs,
    probe_kokoro_cancellation,
    run_tts,
)
from services.audio.src.tts.base import AudioChunk, SynthesisResult

CONFIG = ROOT / "benchmarks/configs/tts/kokoro.yaml"
PROMPTS = ROOT / "benchmarks/datasets/tts-prompts-v1.manifest.json"


class FakeTtsAdapter:
    def __init__(self) -> None:
        self.prepared = False
        self.closed = False
        self.generation = 0
        self._poisoned = False

    def prepare(self, config: dict[str, Any]) -> None:
        assert config["candidate"]["voice"] == "af_heart"
        assert config["candidate"]["provider"] == "CPUExecutionProvider"
        self.prepared = True

    def synthesize_stream(self, text: str, cancel: CancelToken, on_audio=None) -> SynthesisResult:  # type: ignore[no-untyped-def]
        cancel.raise_if_cancelled()
        pcm = (b"\x00\x01" * 480) + (b"\x00\xff" * 120)
        chunks = [pcm[:960], pcm[960:]]
        offset = 0
        for sequence, value in enumerate(chunks):
            cancel.raise_if_cancelled()
            if on_audio:
                on_audio(AudioChunk(sequence, value, 24_000, offset))
            offset += len(value) // 2
        cancel.raise_if_cancelled()
        import hashlib

        return SynthesisResult(
            sample_rate=24_000,
            total_samples=600,
            audio_seconds=0.025,
            processing_seconds=0.005,
            sha256=hashlib.sha256(pcm).hexdigest(),
            chunk_count=2,
        )

    def reset(self) -> None:
        self.generation += 1

    def close(self) -> None:
        self.closed = True


def test_prompt_manifest_is_tracked_complete_and_hash_verified(tmp_path: Path) -> None:
    manifest, digest = verify_dataset(PROMPTS, ROOT)
    assert manifest["kind"] == "tts-prompts"
    assert len(manifest["items"]) == 24
    assert len({item["category"] for item in manifest["items"]}) >= 10
    assert len(digest) == 64

    changed = json.loads(PROMPTS.read_text())
    changed["items"][0]["text"] += " changed"
    path = tmp_path / "changed.json"
    path.write_text(json.dumps(changed))
    with pytest.raises(ChecksumError, match="checksum mismatch"):
        verify_dataset(path, ROOT)


def test_tts_runner_writes_valid_pcm_metadata_and_recomputable_summary(tmp_path: Path) -> None:
    run = run_tts("kokoro", CONFIG, PROMPTS, tmp_path, adapter_factory=FakeTtsAdapter)
    assert validate_run(run) == {"items": 24, "events": 72, "ratings": 0}
    data = json.loads((run / "run.json").read_text())
    summary = json.loads((run / "summary.json").read_text())
    items = [json.loads(line) for line in (run / "items.jsonl").read_text().splitlines()]
    assert data["models"][0]["voice"] == "af_heart"
    assert data["models"][0]["provider"] == "CPUExecutionProvider"
    assert summary["counts"] == {"total": 24, "passed": 24, "failed": 0, "cancelled": 0}
    assert summary["totalSamples"] == 14_400
    assert summary["ttsTimeToFirstAudioMs"]["p95"] >= 0
    assert all(item["promptSha256"] for item in items)
    with wave.open(str(run / items[0]["audioPath"]), "rb") as source:
        assert (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (
            1,
            2,
            24_000,
        )
        assert source.getnframes() == 600


def test_tts_validation_rejects_audio_and_prompt_tampering(tmp_path: Path) -> None:
    run = run_tts("kokoro", CONFIG, PROMPTS, tmp_path / "runs", adapter_factory=FakeTtsAdapter)
    item = json.loads((run / "items.jsonl").read_text().splitlines()[0])
    with (run / item["audioPath"]).open("ab") as target:
        target.write(b"late")
    with pytest.raises(ValidationError, match="content|WAV"):
        validate_run(run)

    run = run_tts("kokoro", CONFIG, PROMPTS, tmp_path / "other", adapter_factory=FakeTtsAdapter)
    lines = (run / "items.jsonl").read_text().splitlines()
    changed = json.loads(lines[0])
    changed["promptSha256"] = "0" * 64
    lines[0] = json.dumps(changed)
    (run / "items.jsonl").write_text("\n".join(lines) + "\n")
    with pytest.raises(ValidationError, match="prompt checksum"):
        validate_run(run)


def test_tts_compare_fails_closed_on_shared_semantics_mismatch(tmp_path: Path) -> None:
    first = run_tts("kokoro", CONFIG, PROMPTS, tmp_path / "runs", adapter_factory=FakeTtsAdapter)
    second = run_tts("kokoro", CONFIG, PROMPTS, tmp_path / "runs", adapter_factory=FakeTtsAdapter)
    assert len(compare_tts_runs([first, second])["runs"]) == 2
    run_data = json.loads((second / "run.json").read_text())
    run_data["comparisonSemantics"]["gain"] = 1.0
    (second / "run.json").write_text(json.dumps(run_data))
    with pytest.raises(ValueError, match="unmatched TTS comparison semantics"):
        compare_tts_runs([first, second])


def test_short_playback_paced_soak_has_raw_iterations_and_no_workers(tmp_path: Path) -> None:
    command = [
        ".venv-kokoro/bin/python",
        "-m",
        "benchmarks.harness",
        "run",
        "--kind",
        "tts",
        "--candidate",
        "kokoro",
        "--config",
        str(CONFIG.relative_to(ROOT)),
        "--prompts",
        str(PROMPTS.relative_to(ROOT)),
        "--soak-minutes",
        "0.001",
    ]
    run = run_tts(
        "kokoro",
        CONFIG,
        PROMPTS,
        tmp_path,
        command=command,
        soak_minutes=0.001,
        adapter_factory=FakeTtsAdapter,
    )
    validate_run(run)
    summary = json.loads((run / "summary.json").read_text())
    events = [json.loads(line) for line in (run / "events.jsonl").read_text().splitlines()]
    assert summary["soak"]["passed"]
    assert summary["soak"]["expectedSamples"] == summary["soak"]["consumedSamples"]
    assert any(event["type"] == "soak_iteration" for event in events)


def test_real_cancellation_probe_contract_names_workers_and_has_no_survivors() -> None:
    probe = probe_kokoro_cancellation(CONFIG, PROMPTS, adapter_factory=FakeTtsAdapter)
    assert probe["outcome"] == "cancelled"
    assert probe["acceptedChunks"] == 1
    assert probe["postCloseSurvivingWorkers"] == []
    assert "kokoro-inference" in probe["checkedWorkerPrefixes"]
    assert not probe["backendPoisoned"]
