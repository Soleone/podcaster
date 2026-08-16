from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from benchmarks.harness.adapter import CancelToken, Cancelled, SyntheticNullAdapter
from benchmarks.harness.checksums import ChecksumError, verify_dataset, verify_models
from benchmarks.harness.fixtures import pcm_chunks
from benchmarks.harness.randomization import (
    RevealLockedError,
    blind_mapping,
    prepare_listening,
    prepare_listening_runs,
    reveal_mapping,
    submit_ratings,
    verify_ratings_lock,
    write_sealed_mapping,
)
from benchmarks.harness.runner import (
    ValidationError,
    _summary,
    normalize_summary,
    run_synthetic,
    validate_run,
)
from benchmarks.harness.util import canonical_json, deterministic_source_manifest, sha256_bytes, source_state

ROOT = Path(__file__).resolve().parents[3]
CONFIG = ROOT / "benchmarks/configs/common.yaml"


def test_tracked_result_schemas_match_canonical_contracts() -> None:
    for name in ("run.json", "item.json", "event.json", "summary.json", "rating.json"):
        assert (ROOT / "benchmarks/results/schema" / name).read_bytes() == (
            ROOT / "packages/contracts/schema/benchmarks" / name
        ).read_bytes()


def test_source_state_reproduces_the_committed_source_manifest() -> None:
    manifest = deterministic_source_manifest(ROOT)
    source_id, _dirty = source_state(ROOT, manifest)
    assert source_id == f"source-{sha256_bytes(canonical_json(manifest))[:16]}"


def test_seeded_synthetic_runs_are_schema_valid_and_normalized_equal(tmp_path: Path) -> None:
    first = run_synthetic(CONFIG, tmp_path / "one")
    second = run_synthetic(CONFIG, tmp_path / "two")

    assert validate_run(first) == {"items": 6, "events": 24, "ratings": 0}
    assert validate_run(second) == {"items": 6, "events": 24, "ratings": 0}
    assert normalize_summary(first) == normalize_summary(second)

    run = json.loads((first / "run.json").read_text())
    assert run["machine"]["gpu"]
    assert set(run["runtimes"]) == {"python", "node", "cuda", "cudnn", "pytorch"}
    assert run["command"]
    assert run["datasetSha256"]
    assert run["configSha256"]


def test_accepted_milestone_2_schema_v1_artifacts_still_validate() -> None:
    for name in (
        "2026-08-07T071627164Z-source-70460-a517e378",
        "2026-08-07T071627340Z-source-70460-e388e755",
    ):
        assert validate_run(ROOT / "benchmarks/results" / name) == {
            "items": 6,
            "events": 24,
            "ratings": 0,
        }


def test_stt_validation_recomputes_accuracy_and_soak_evidence(tmp_path: Path) -> None:
    paced_source = ROOT / "benchmarks/results/2026-08-07T201353964Z-source-6da33-d3fab140"
    paced = tmp_path / "paced"
    shutil.copytree(paced_source, paced)
    summary = json.loads((paced / "summary.json").read_text())
    summary["wer"] += 0.01
    (paced / "summary.json").write_text(json.dumps(summary))
    with pytest.raises(ValidationError, match="summary does not match"):
        validate_run(paced)

    soak_source = ROOT / "benchmarks/results/2026-08-07T202500188Z-source-b6b6d-b65ea6b2"
    soak = tmp_path / "soak"
    shutil.copytree(soak_source, soak)
    summary = json.loads((soak / "summary.json").read_text())
    summary["soak"]["resetCount"] += 1
    (soak / "summary.json").write_text(json.dumps(summary))
    with pytest.raises(ValidationError, match="raw iterations"):
        validate_run(soak)


def test_events_are_monotonic_and_keep_cancel_and_failure_visible(tmp_path: Path) -> None:
    run_dir = run_synthetic(CONFIG, tmp_path)
    events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert [event["monotonicMs"] for event in events] == sorted(
        event["monotonicMs"] for event in events
    )
    kinds = [event["type"] for event in events]
    assert "cancel_requested" in kinds
    assert "silence_observed" in kinds
    assert "failure" in kinds
    items = [json.loads(line) for line in (run_dir / "items.jsonl").read_text().splitlines()]
    assert [item["status"] for item in items] == [
        "passed",
        "passed",
        "cancelled",
        "cancelled",
        "failed",
        "failed",
    ]
    assert all(item["metrics"]["peakVramBytes"] is None for item in items)
    assert all(item["metrics"]["steadyVramBytes"] is None for item in items)


def test_validation_rejects_backwards_clock(tmp_path: Path) -> None:
    run_dir = run_synthetic(CONFIG, tmp_path)
    events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]
    events[-1]["monotonicMs"] = 0
    (run_dir / "events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
    with pytest.raises(ValidationError, match="moved backwards"):
        validate_run(run_dir)


def test_dataset_checksum_mismatch_fails_closed(tmp_path: Path) -> None:
    manifest = json.loads((ROOT / "benchmarks/datasets/synthetic.manifest.json").read_text())
    manifest["items"][0]["fixture"]["frequencyHz"] += 1
    path = tmp_path / "dataset.json"
    path.write_text(json.dumps(manifest))
    with pytest.raises(ChecksumError, match="checksum mismatch"):
        verify_dataset(path, ROOT)


def test_model_checksum_and_missing_file_fail_closed(tmp_path: Path) -> None:
    model = tmp_path / "model.bin"
    model.write_bytes(b"pinned")
    relative = model.relative_to(ROOT) if ROOT in model.parents else None
    if relative is None:
        model = ROOT / ".pytest-model-fixture.bin"
        model.write_bytes(b"pinned")
        relative = model.relative_to(ROOT)
    try:
        manifest = tmp_path / "models.json"
        manifest.write_text(
            json.dumps(
                {
                    "models": [
                        {
                            "id": "null",
                            "path": str(relative),
                            "sha256": hashlib.sha256(b"pinned").hexdigest(),
                        }
                    ]
                }
            )
        )
        assert len(verify_models(manifest, ROOT)) == 1
        manifest.write_text(
            json.dumps({"models": [{"id": "null", "path": str(relative), "sha256": "0" * 64}]})
        )
        with pytest.raises(ChecksumError, match="checksum mismatch"):
            verify_models(manifest, ROOT)
    finally:
        (ROOT / relative).unlink(missing_ok=True)


def test_verify_models_script_runs_from_project_root(tmp_path: Path) -> None:
    model = ROOT / ".pytest-model-script-fixture.bin"
    model.write_bytes(b"pinned")
    manifest = tmp_path / "models.json"
    manifest.write_text(
        json.dumps(
            {
                "models": [
                    {
                        "id": "null",
                        "path": str(model.relative_to(ROOT)),
                        "sha256": hashlib.sha256(b"pinned").hexdigest(),
                    }
                ]
            }
        )
    )
    try:
        result = subprocess.run(
            [sys.executable, "scripts/verify-models.py", str(manifest)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout == "verified 1 model file(s)\n"
    finally:
        model.unlink(missing_ok=True)


def test_blind_mapping_is_seeded_and_manual_rating_edit_cannot_reveal(tmp_path: Path) -> None:
    first = run_synthetic(CONFIG, tmp_path)
    assert blind_mapping(["one", "two"], 42) == blind_mapping(["one", "two"], 42)
    with pytest.raises(RevealLockedError, match="ratings must be submitted"):
        reveal_mapping(first)
    (first / "ratings.jsonl").write_text(
        json.dumps({"submittedAt": "2026-08-07T00:00:00Z", "revealLocked": True}) + "\n"
    )
    with pytest.raises(RevealLockedError, match="not locked"):
        reveal_mapping(first)


def test_listening_projection_submission_lock_and_reveal(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "run.json").write_text(json.dumps({"seed": 42}))
    items = []
    for prompt in ("prompt-1", "prompt-2"):
        for candidate, label in (("candidate-secret-one", "A"), ("candidate-secret-two", "B")):
            audio_path = Path("audio") / candidate / f"{prompt}.wav"
            (run_dir / audio_path).parent.mkdir(parents=True, exist_ok=True)
            (run_dir / audio_path).write_bytes(f"{candidate}-{prompt}".encode())
            items.append(
                {
                    "candidateId": candidate,
                    "sourceId": prompt,
                    "status": "passed",
                    "audioPath": str(audio_path),
                    "blindLabel": label,
                }
            )
    (run_dir / "items.jsonl").write_text("".join(json.dumps(item) + "\n" for item in items))
    (run_dir / "ratings.jsonl").write_text("")
    write_sealed_mapping(run_dir, {"A": "candidate-secret-one", "B": "candidate-secret-two"})
    view_path = prepare_listening(run_dir, "listener-1")
    view_text = view_path.read_text()
    assert "candidate-secret" not in view_text
    assert '"seed"' not in view_text
    assert '"metrics"' not in view_text
    view = json.loads(view_text)
    responses = {
        "ratings": [
            {
                "promptLabel": prompt["promptLabel"],
                "samples": [
                    {
                        "label": sample["label"],
                        "naturalness": 4,
                        "intelligibility": 5,
                        "listenability": 4,
                    }
                    for sample in prompt["samples"]
                ],
                "preference": prompt["order"][0],
                "replayCount": 1,
            }
            for prompt in view["prompts"]
        ]
    }
    responses_path = tmp_path / "responses.json"
    forged_view = json.loads(json.dumps(view))
    forged_view["prompts"] = forged_view["prompts"][:1]
    forged_payload = dict(forged_view)
    forged_payload.pop("viewCommitment")
    forged_bytes = (
        json.dumps(forged_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode()
    forged_view["viewCommitment"] = hashlib.sha256(forged_bytes).hexdigest()
    forged_path = tmp_path / "forged-listening.json"
    forged_path.write_text(json.dumps(forged_view, sort_keys=True, separators=(",", ":")) + "\n")
    responses_path.write_text(json.dumps({"ratings": responses["ratings"][:1]}))
    with pytest.raises(RevealLockedError, match="trusted generated view"):
        submit_ratings(run_dir, forged_path, responses_path)
    incomplete = json.loads(json.dumps(responses))
    incomplete["ratings"][0]["samples"] = incomplete["ratings"][0]["samples"][:1]
    responses_path.write_text(json.dumps(incomplete))
    with pytest.raises(RevealLockedError, match="every sample label exactly once"):
        submit_ratings(run_dir, view_path, responses_path)
    responses_path.write_text(json.dumps(responses))
    submit_ratings(run_dir, view_path, responses_path)
    assert reveal_mapping(run_dir) == {
        "A": "candidate-secret-one",
        "B": "candidate-secret-two",
    }
    (run_dir / "ratings.jsonl").chmod(0o644)
    (run_dir / "ratings.jsonl").write_text((run_dir / "ratings.jsonl").read_text() + "\n")
    with pytest.raises(RevealLockedError, match="modified"):
        reveal_mapping(run_dir)


def test_warmups_repetitions_and_verified_pcm_reach_adapter(tmp_path: Path) -> None:
    class RecordingAdapter(SyntheticNullAdapter):
        streams: list[list[bytes]] = []

        def transcribe(self, stream, cancel):  # type: ignore[no-untyped-def]
            chunks = list(stream)
            self.streams.append(chunks)
            return super().transcribe(chunks, cancel)

    RecordingAdapter.streams = []
    run_dir = run_synthetic(CONFIG, tmp_path, adapter_factory=RecordingAdapter)
    items = [json.loads(line) for line in (run_dir / "items.jsonl").read_text().splitlines()]
    assert len(items) == 3 * 2
    assert len(RecordingAdapter.streams) == 1 + 4  # warmup, passed and cancelled repetitions
    manifest = json.loads((ROOT / "benchmarks/datasets/synthetic.manifest.json").read_text())
    expected = pcm_chunks(manifest["items"][0]["fixture"])
    assert RecordingAdapter.streams[0] == expected
    assert RecordingAdapter.streams[0][0] != b"0" * len(RecordingAdapter.streams[0][0])


def test_prepare_and_close_failures_are_both_preserved(tmp_path: Path) -> None:
    class FailingAdapter(SyntheticNullAdapter):
        def prepare(self, config):  # type: ignore[no-untyped-def]
            raise RuntimeError("prepare secret detail")

        def close(self) -> None:
            raise RuntimeError("close secret detail")

    run_dir = run_synthetic(CONFIG, tmp_path, adapter_factory=FailingAdapter)
    assert validate_run(run_dir)["items"] == 8
    run = json.loads((run_dir / "run.json").read_text())
    summary = json.loads((run_dir / "summary.json").read_text())
    assert run["status"] == "failed"
    assert run["endedAt"]
    stages = [failure["stage"] for failure in summary["failures"]]
    assert stages.count("prepare") == 7
    assert stages.count("close") == 1
    assert "secret detail" not in json.dumps(summary)


def test_validation_recomputes_summary_and_correlates_events(tmp_path: Path) -> None:
    run_dir = run_synthetic(CONFIG, tmp_path)
    summary = json.loads((run_dir / "summary.json").read_text())
    summary["counts"]["passed"] += 1
    (run_dir / "summary.json").write_text(json.dumps(summary))
    with pytest.raises(ValidationError, match="recomputed"):
        validate_run(run_dir)


def test_validation_rejects_deleted_source_and_wrong_blind_label(tmp_path: Path) -> None:
    run_dir = run_synthetic(CONFIG, tmp_path)
    items_path = run_dir / "items.jsonl"
    items = [json.loads(line) for line in items_path.read_text().splitlines()]
    remaining = items[2:]
    items_path.write_text("".join(json.dumps(item) + "\n" for item in remaining))
    (run_dir / "summary.json").write_text(json.dumps(_summary(remaining)))
    with pytest.raises(ValidationError, match="expectedItems"):
        validate_run(run_dir)

    run_dir = run_synthetic(CONFIG, tmp_path / "blind")
    items = [json.loads(line) for line in (run_dir / "items.jsonl").read_text().splitlines()]
    items[0]["blindLabel"] = "Z"
    (run_dir / "items.jsonl").write_text("".join(json.dumps(item) + "\n" for item in items))
    with pytest.raises(ValidationError, match="blindLabel"):
        validate_run(run_dir)


def test_constructor_and_missing_warmup_finalize_failed_artifacts(tmp_path: Path) -> None:
    def explode():
        raise RuntimeError("constructor secret")

    constructed = run_synthetic(CONFIG, tmp_path / "construct", adapter_factory=explode)
    assert validate_run(constructed)["items"] == 7
    constructed_run = json.loads((constructed / "run.json").read_text())
    constructed_summary = json.loads((constructed / "summary.json").read_text())
    assert constructed_run["status"] == "failed"
    assert constructed_run["endedAt"]
    assert constructed_summary["failures"][0]["stage"] == "construct"
    assert "constructor secret" not in json.dumps(constructed_summary)

    manifest_path = ROOT / "benchmarks/datasets/.pytest-no-warmup.manifest.json"
    config_path = ROOT / "benchmarks/configs/.pytest-no-warmup.yaml"
    manifest = json.loads((ROOT / "benchmarks/datasets/synthetic.manifest.json").read_text())
    for item in manifest["items"]:
        item["behavior"] = "cancelled"
    manifest_path.write_text(json.dumps(manifest))
    config = json.loads(CONFIG.read_text())
    config["datasetManifest"] = str(manifest_path.relative_to(ROOT))
    config_path.write_text(json.dumps(config))
    try:
        missing = run_synthetic(config_path, tmp_path / "warmup")
        assert validate_run(missing)["items"] == 7
        missing_run = json.loads((missing / "run.json").read_text())
        missing_summary = json.loads((missing / "summary.json").read_text())
        assert missing_run["status"] == "failed"
        assert missing_summary["failures"][0]["stage"] == "warmup"
    finally:
        manifest_path.unlink(missing_ok=True)
        config_path.unlink(missing_ok=True)


def test_listen_rejects_mismatched_candidate_precision(tmp_path: Path) -> None:
    first_config = json.loads(CONFIG.read_text())
    second_config = json.loads(CONFIG.read_text())
    first_config["candidate"]["precision"] = "fp16"
    second_config["candidate"]["precision"] = "int8"
    first_path = tmp_path / "first.yaml"
    second_path = tmp_path / "second.yaml"
    first_path.write_text(json.dumps(first_config))
    second_path.write_text(json.dumps(second_config))
    first = run_synthetic(first_path, tmp_path / "runs")
    second = run_synthetic(second_path, tmp_path / "runs")
    with pytest.raises(RevealLockedError, match="matched dataset/config semantics"):
        prepare_listening_runs([first, second], "listener")


def test_two_normal_runs_cli_listen_submit_reveal(tmp_path: Path) -> None:
    first = run_synthetic(CONFIG, tmp_path / "runs")
    second = run_synthetic(CONFIG, tmp_path / "runs")
    listen = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.harness",
            "listen",
            "--runs",
            str(first),
            str(second),
            "--assessor",
            "listener-opaque",
            "--attempt",
            "1",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    view_path = Path(listen.stdout.strip())
    view_text = view_path.read_text()
    assert "synthetic-null" not in view_text
    assert '"seed"' not in view_text
    assert '"metrics"' not in view_text
    view = json.loads(view_text)
    assert all(len(prompt["samples"]) == 2 for prompt in view["prompts"])
    responses = {
        "ratings": [
            {
                "promptLabel": prompt["promptLabel"],
                "samples": [
                    {"label": sample["label"]}
                    for sample in prompt["samples"]
                ],
                "preference": "tie",
                "replayCount": 0,
            }
            for prompt in view["prompts"]
        ]
    }
    responses_path = tmp_path / "responses.json"
    responses_path.write_text(json.dumps(responses))
    workspace = view_path.parent
    subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.harness",
            "submit-ratings",
            "--run",
            str(workspace),
            "--view",
            str(view_path),
            "--responses",
            str(responses_path),
        ],
        cwd=ROOT,
        check=True,
    )
    before = json.loads((workspace / "ratings.lock.json").read_text())
    reveal = subprocess.run(
        [sys.executable, "-m", "benchmarks.harness", "reveal", "--run", str(workspace)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    assert "synthetic-null" in reveal.stdout
    after = json.loads((workspace / "ratings.lock.json").read_text())
    ratings = [json.loads(line) for line in (workspace / "ratings.jsonl").read_text().splitlines()]
    assert after["submittedRatingsSha256"] == before["submittedRatingsSha256"]
    assert after["ratingsSha256"] != before["ratingsSha256"]
    assert after["phase"] == "revealed"
    assert all(rating["revealedAt"] == after["revealedAt"] for rating in ratings)
    assert all(rating["revealLocked"] is False for rating in ratings)
    assert all(
        [sample["label"] for sample in rating["sampleRatings"]] == rating["sampleLabels"]
        for rating in ratings
    )
    ratings[0]["sampleRatings"][0]["naturalness"] = 1
    tampered_bytes = b"".join(
        (json.dumps(rating, sort_keys=True, separators=(",", ":")) + "\n").encode()
        for rating in ratings
    )
    (workspace / "ratings.jsonl").chmod(0o600)
    (workspace / "ratings.jsonl").write_bytes(tampered_bytes)
    lock = json.loads((workspace / "ratings.lock.json").read_text())
    lock["ratingsSha256"] = hashlib.sha256(tampered_bytes).hexdigest()
    (workspace / "ratings.lock.json").chmod(0o600)
    (workspace / "ratings.lock.json").write_text(
        json.dumps(lock, sort_keys=True, separators=(",", ":")) + "\n"
    )
    with pytest.raises(RevealLockedError, match="immutable submitted scores"):
        verify_ratings_lock(workspace)

    (workspace / "ratings.jsonl").chmod(0o644)
    (workspace / "ratings.jsonl").write_text((workspace / "ratings.jsonl").read_text() + "\n")
    tampered = subprocess.run(
        [sys.executable, "-m", "benchmarks.harness", "reveal", "--run", str(workspace)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert tampered.returncode == 2
    assert "modified" in tampered.stderr


def test_adapter_protocol_cancellation_reset_and_close() -> None:
    adapter = SyntheticNullAdapter()
    adapter.prepare({"candidate": {"id": "synthetic-null"}})
    token = CancelToken()
    token.cancel()
    with pytest.raises(Cancelled):
        adapter.transcribe([b"frame"], token)
    adapter.reset()
    assert adapter.reset_count == 1
    adapter.close()
    with pytest.raises(RuntimeError, match="closed"):
        adapter.reset()


def test_tracked_generator_produces_identical_wav(tmp_path: Path) -> None:
    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"
    script = ROOT / "packages/test-fixtures/audio/generate.py"
    for target in (first, second):
        subprocess.run(
            [sys.executable, str(script), str(target), "--frequency-hz", "440", "--chunks", "2"],
            check=True,
        )
    assert first.read_bytes() == second.read_bytes()
    assert first.read_bytes()[:4] == b"RIFF"
