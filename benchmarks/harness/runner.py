from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from .adapter import BenchmarkAdapter, CancelToken, Cancelled, SyntheticNullAdapter
from .checksums import verify_dataset
from .fixtures import pcm_chunks
from .nvml import RepeatedGpuSampler
from .randomization import (
    RevealLockedError,
    blind_mapping,
    verify_ratings_lock,
    write_sealed_mapping,
)
from .util import (
    canonical_json,
    distribution,
    environment_metadata,
    load_yaml_subset,
    machine_metadata,
    percentile,
    runtime_metadata,
    sha256_bytes,
    sha256_file,
    source_state,
    utc_now,
)

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = ROOT / "benchmarks/results/schema"


class ValidationError(ValueError):
    pass


class SyntheticInjectedFailure(RuntimeError):
    pass


ACCEPTED_LEGACY_CORE_HASHES: dict[str, dict[str, str]] = {
    "a517e378-78f2-43c6-9d2c-7826effe5c8e": {"run.json": "550664bfe1f26e061aa7901a9ee11cfec0bb3434edcb1d8a7896e1ec2eceae01", "summary.json": "e7e73967abd06d63a379f97da441aed4b790c59babc3237dbdcdf041b603a50a", "events.jsonl": "1527490b6184dc125aef95973ba2052b45760f05ccc31165464fa34f0071428e", "items.jsonl": "9c80b381ce8442178837c92122fddf97b79e181c58e7b7ea874b90386e132447"},
    "e388e755-5491-427e-ad58-33857e5a8ca3": {"run.json": "5b4d7e52308dc9d8e76ac66963574e45d494a874740b92e2503a9e73e7c74678", "summary.json": "e7e73967abd06d63a379f97da441aed4b790c59babc3237dbdcdf041b603a50a", "events.jsonl": "1527490b6184dc125aef95973ba2052b45760f05ccc31165464fa34f0071428e", "items.jsonl": "9c80b381ce8442178837c92122fddf97b79e181c58e7b7ea874b90386e132447"},
}


def _exact_legacy(run_dir: Path, run: dict[str, Any]) -> bool:
    expected = ACCEPTED_LEGACY_CORE_HASHES.get(run.get("runId", ""))
    return bool(expected) and all(sha256_file(run_dir / name) == digest for name, digest in expected.items())


def _schema(name: str) -> dict[str, Any]:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


def _write_json(path: Path, value: Any) -> None:
    path.write_bytes(canonical_json(value))


def _write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.write_bytes(b"".join(canonical_json(record) for record in records))


def _event(sequence: int, time_ms: float, kind: str, detail: dict[str, Any]) -> dict[str, Any]:
    return {
        "monotonicMs": time_ms,
        "type": kind,
        "sequence": sequence,
        "epoch": 0,
        "detail": detail,
    }


def _metrics(base: int) -> dict[str, Any]:
    return {
        "speechStartToFirstPartialMs": float(80 + base),
        "endpointToFinalMs": float(120 + base),
        "ttsTimeToFirstAudioMs": None,
        "rtf": 0.1 + base / 1000,
        "wer": 0.0,
        "cer": 0.0,
        "partialRevisionCount": 1,
        "partialChurnCharacters": 3,
        "underruns": 0,
        "droppedFrames": 0,
        "peakVramBytes": None,
        "steadyVramBytes": None,
    }


def _empty_metrics() -> dict[str, Any]:
    return {
        "speechStartToFirstPartialMs": None,
        "endpointToFinalMs": None,
        "ttsTimeToFirstAudioMs": None,
        "rtf": None,
        "wer": None,
        "cer": None,
        "partialRevisionCount": 0,
        "partialChurnCharacters": 0,
        "underruns": 0,
        "droppedFrames": 0,
        "peakVramBytes": None,
        "steadyVramBytes": None,
    }


def _failure_item(
    candidate_id: str,
    config_id: str,
    source_id: str,
    blind_label: str,
    attempt: int,
    stage: str,
    code: str,
    message: str,
) -> dict[str, Any]:
    return {
        "candidateId": candidate_id,
        "configId": config_id,
        "sourceId": source_id,
        "blindLabel": blind_label,
        "attempt": attempt,
        "status": "failed",
        "failure": {"code": code, "message": message, "stage": stage, "recoverable": False},
        "transcript": None,
        "audioPath": None,
        "normalizationVersion": "synthetic-v1",
        "revisionTrace": [],
        "metrics": _empty_metrics(),
    }


def _summary(
    items: list[dict[str, Any]], timing: dict[str, Any] | None = None
) -> dict[str, Any]:
    passed = [item for item in items if item["status"] == "passed"]

    def values(key: str) -> list[float]:
        return [float(item["metrics"][key]) for item in passed if item["metrics"][key] is not None]

    failures = [
        {
            "sourceId": item["sourceId"],
            "code": item["failure"]["code"],
            "stage": item["failure"]["stage"],
            "message": item["failure"]["message"],
        }
        for item in items
        if item["failure"] is not None
    ]
    result = {
        "counts": {
            "total": len(items),
            "passed": len(passed),
            "failed": sum(item["status"] == "failed" for item in items),
            "cancelled": sum(item["status"] == "cancelled" for item in items),
        },
        "speechStartToFirstPartialMs": distribution(values("speechStartToFirstPartialMs")),
        "endpointToFinalMs": distribution(values("endpointToFinalMs")),
        "ttsTimeToFirstAudioMs": distribution(values("ttsTimeToFirstAudioMs")),
        "rtf": distribution(values("rtf")),
        "wer": sum(values("wer")) / len(values("wer")) if values("wer") else None,
        "cer": sum(values("cer")) / len(values("cer")) if values("cer") else None,
        "partialRevisionCount": sum(item["metrics"]["partialRevisionCount"] for item in items),
        "partialChurnCharacters": sum(item["metrics"]["partialChurnCharacters"] for item in items),
        "underruns": sum(item["metrics"]["underruns"] for item in items),
        "droppedFrames": sum(item["metrics"]["droppedFrames"] for item in items),
        "peakVramBytes": max(
            (
                item["metrics"]["peakVramBytes"]
                for item in items
                if item["metrics"]["peakVramBytes"] is not None
            ),
            default=None,
        ),
        "steadyVramBytes": max(
            (
                item["metrics"]["steadyVramBytes"]
                for item in items
                if item["metrics"]["steadyVramBytes"] is not None
            ),
            default=None,
        ),
        "failures": failures,
        "soak": {
            "durationSeconds": 0.0,
            "passed": not any(
                not item["failure"]["recoverable"] for item in items if item["failure"]
            ),
            "severeFailures": sum(
                not item["failure"]["recoverable"] for item in items if item["failure"]
            ),
            "underruns": sum(item["metrics"]["underruns"] for item in items),
            "droppedFrames": sum(item["metrics"]["droppedFrames"] for item in items),
            "expectedFrames": 0,
            "consumedFrames": 0,
            "expectedChunks": 0,
            "consumedChunks": 0,
            "deadlineOverruns": 0,
            "deadlineLatenessP95Ms": 0.0,
            "deadlineLatenessMaxMs": 0.0,
            "timingConformance": True,
            "resetCount": 0,
            "workerLeaks": 0,
        },
    }
    if any("totalSamples" in item["metrics"] for item in items):
        has_scoped_rss = any(
            "synthesisWindowWholeProcessPeakRssBytes" in item["metrics"] for item in items
        )
        result.update(
            {
                "totalAudioDurationSeconds": sum(
                    float(item["metrics"].get("totalAudioDurationSeconds", 0)) for item in passed
                ),
                "totalSamples": sum(int(item["metrics"].get("totalSamples", 0)) for item in passed),
                "droppedOutputChunks": sum(
                    int(item["metrics"].get("droppedOutputChunks", 0)) for item in items
                ),
                "synthesisWindowWholeProcessPeakRssBytes": max(
                    (
                        item["metrics"].get("synthesisWindowWholeProcessPeakRssBytes")
                        for item in items
                        if item["metrics"].get("synthesisWindowWholeProcessPeakRssBytes")
                        is not None
                    ),
                    default=None,
                ),
            }
        )
        item_peak_rss = max(
            (
                item["metrics"].get("peakRssBytes")
                for item in items
                if item["metrics"].get("peakRssBytes") is not None
            ),
            default=None,
        )
        if item_peak_rss is not None:
            result["peakRssBytes"] = item_peak_rss
        if not has_scoped_rss:
            result.pop("synthesisWindowWholeProcessPeakRssBytes")
    if timing is not None:
        result["prepareSeconds"] = timing.get("prepareSeconds")
        result["cold"] = timing.get("cold")
        result["peakRssBytes"] = timing.get("peakRssBytes")
        result["peakVramBytes"] = timing.get("peakVramBytes")
    return result


def _create_output_dir(output_root: Path, source_id: str, run_id: str) -> Path:
    stem = f"{utc_now().replace(':', '').replace('.', '')}-{source_id[:12]}-{run_id[:8]}"
    output_root.mkdir(parents=True, exist_ok=True)
    run_dir = output_root / stem
    run_dir.mkdir()
    return run_dir


def _initialize_artifacts(run_dir: Path, run: dict[str, Any], mapping: dict[str, str]) -> None:
    _write_json(run_dir / "run.json", run)
    for name in ("items.jsonl", "events.jsonl", "ratings.jsonl"):
        (run_dir / name).write_text("", encoding="utf-8")
    _write_json(run_dir / "summary.json", _summary([]))
    (run_dir / "README.md").write_text("Run initialized; finalization pending.\n")
    write_sealed_mapping(run_dir, mapping)


def run_synthetic(
    config_path: Path,
    output_root: Path | None = None,
    command: list[str] | None = None,
    adapter_factory: Callable[[], BenchmarkAdapter] = SyntheticNullAdapter,
) -> Path:
    config_path = config_path.resolve()
    config = load_yaml_subset(config_path)
    if config.get("schemaVersion") != 1 or config.get("kind") != "synthetic":
        raise ValueError("T2.1 runner accepts only schemaVersion 1 synthetic config")
    dataset_path = (ROOT / str(config["datasetManifest"])).resolve()
    if ROOT.resolve() not in dataset_path.parents:
        raise ValueError("dataset manifest path escapes project root")
    dataset, dataset_hash = verify_dataset(dataset_path, ROOT)
    config_hash = sha256_file(config_path)
    comparison_config = {
        key: value for key, value in config.items() if key not in {"id", "candidate"}
    }
    comparison_config["candidateSettings"] = {
        key: value for key, value in config["candidate"].items() if key != "id"
    }
    comparison_semantics_hash = sha256_bytes(canonical_json(comparison_config))
    source_id, dirty = source_state(ROOT)
    run_id = str(uuid.uuid4())
    run_dir = _create_output_dir(output_root or ROOT / "benchmarks/results", source_id, run_id)
    ambient = RepeatedGpuSampler().collect(1)[0]
    gpu_metadata = {"name": ambient.name, "driver": ambient.driver, "cuda": ambient.cuda}
    candidate_id = str(config["candidate"]["id"])
    labels = blind_mapping([candidate_id], int(config["seed"]))
    blind_label = next(label for label, candidate in labels.items() if candidate == candidate_id)
    try:
        config_display = str(config_path.relative_to(ROOT))
    except ValueError:
        config_display = str(config_path)
    expected_items = [
        {"sourceId": str(item["sourceId"]), "candidateId": candidate_id, "attempt": attempt}
        for item in dataset["items"]
        for attempt in range(1, int(config["repetitions"]) + 1)
    ]
    run = {
        "schemaVersion": 1,
        "runId": run_id,
        "kind": "synthetic",
        "startedAt": utc_now(),
        "endedAt": None,
        "sourceId": source_id,
        "dirty": dirty,
        "machine": machine_metadata(gpu_metadata),
        "runtimes": runtime_metadata(gpu_metadata),
        "models": [
            {
                "id": candidate_id,
                "revision": "t2.1-v1",
                "sha256": sha256_file(Path(__file__).with_name("adapter.py")),
                "runtime": str(config["candidate"]["runtime"]),
                "precision": str(config["candidate"]["precision"]),
            }
        ],
        "configId": str(config["id"]),
        "configSha256": config_hash,
        "comparisonSemanticsSha256": comparison_semantics_hash,
        "datasetId": str(dataset["id"]),
        "datasetSha256": dataset_hash,
        "seed": int(config["seed"]),
        "command": command
        or [
            "uv",
            "run",
            "python",
            "-m",
            "benchmarks.harness",
            "run",
            "--kind",
            "synthetic",
            "--config",
            config_display,
        ],
        "environment": environment_metadata(),
        "warmups": int(config["warmups"]),
        "repetitions": int(config["repetitions"]),
        "expectedItems": expected_items,
        "randomization": {
            "method": "python-random-seeded-shuffle-v1",
            "blind": True,
            "revealLocked": True,
        },
        "status": "running",
    }
    _initialize_artifacts(run_dir, run, labels)
    items: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    sequence = 0
    virtual_ms = 0.0
    primary_failed = False
    failure_stage = "finalize"
    adapter: BenchmarkAdapter | None = None

    def record_run_failure(stage: str, error: Exception) -> None:
        nonlocal sequence, virtual_ms, primary_failed, failure_stage
        was_failed = primary_failed
        code = f"{stage}_failure"
        message = f"{stage} failed: {type(error).__name__}"
        item = _failure_item(
            candidate_id,
            str(config["id"]),
            f"__run__:{stage}",
            blind_label,
            1,
            stage,
            code,
            message,
        )
        items.append(item)
        events.append(
            _event(
                sequence,
                virtual_ms,
                "failure",
                {
                    "sourceId": item["sourceId"],
                    "candidateId": candidate_id,
                    "attempt": 1,
                    "stage": stage,
                    "failureCode": code,
                },
            )
        )
        sequence += 1
        virtual_ms += 1
        primary_failed = True
        if not was_failed:
            failure_stage = stage

    def fill_missing_expected(stage: str) -> None:
        nonlocal sequence, virtual_ms
        present = {
            (item["sourceId"], item["candidateId"], item["attempt"])
            for item in items
            if not item["sourceId"].startswith("__run__:")
        }
        for expected in expected_items:
            key = (expected["sourceId"], expected["candidateId"], expected["attempt"])
            if key in present:
                continue
            code = f"not_run_after_{stage}_failure"
            message = f"item not run after {stage} failure"
            item = _failure_item(
                candidate_id,
                str(config["id"]),
                expected["sourceId"],
                blind_label,
                expected["attempt"],
                stage,
                code,
                message,
            )
            items.append(item)
            events.append(
                _event(
                    sequence,
                    virtual_ms,
                    "failure",
                    {
                        "sourceId": expected["sourceId"],
                        "candidateId": candidate_id,
                        "attempt": expected["attempt"],
                        "stage": stage,
                        "failureCode": code,
                    },
                )
            )
            sequence += 1
            virtual_ms += 1

    try:
        clean_item = next(
            (item for item in dataset["items"] if item.get("behavior", "passed") == "passed"),
            None,
        )
        if clean_item is None:
            record_run_failure("warmup", ValueError("dataset has no passed warmup item"))
        if not primary_failed:
            try:
                adapter = adapter_factory()
            except Exception as error:
                record_run_failure("construct", error)
        if not primary_failed and adapter is not None:
            try:
                adapter.prepare(config)
            except Exception as error:
                record_run_failure("prepare", error)
        if not primary_failed and adapter is not None and clean_item is not None:
            for _ in range(int(config["warmups"])):
                try:
                    adapter.reset()
                    adapter.transcribe(pcm_chunks(clean_item["fixture"]), CancelToken())
                except Exception as error:
                    record_run_failure("warmup", error)
                    break
        if not primary_failed and adapter is not None:
            for dataset_item in dataset["items"]:
                source = str(dataset_item["sourceId"])
                for attempt in range(1, int(config["repetitions"]) + 1):
                    context = {"sourceId": source, "candidateId": candidate_id, "attempt": attempt}
                    try:
                        adapter.reset()
                    except Exception as error:
                        code = "reset_failure"
                        message = f"reset failed: {type(error).__name__}"
                        items.append(
                            _failure_item(
                                candidate_id,
                                str(config["id"]),
                                source,
                                blind_label,
                                attempt,
                                "reset",
                                code,
                                message,
                            )
                        )
                        events.append(
                            _event(
                                sequence,
                                virtual_ms,
                                "failure",
                                {**context, "stage": "reset", "failureCode": code},
                            )
                        )
                        sequence += 1
                        primary_failed = True
                        failure_stage = "reset"
                        virtual_ms += 250
                        continue
                    behavior = str(dataset_item.get("behavior", "passed"))
                    events.append(_event(sequence, virtual_ms, "audio_received", context))
                    sequence += 1
                    token = CancelToken()
                    failure = None
                    transcript: str | None = None
                    status = "passed"
                    metrics = _metrics(attempt)
                    trace: list[dict[str, Any]] = []
                    try:
                        if behavior == "cancelled":
                            token.cancel()
                            events.append(
                                _event(
                                    sequence,
                                    virtual_ms + 2,
                                    "cancel_requested",
                                    {**context, "reason": "synthetic_fixture"},
                                )
                            )
                            sequence += 1
                        if behavior == "failed":
                            raise SyntheticInjectedFailure("synthetic injected failure")
                        events.append(_event(sequence, virtual_ms + 3, "speech_start", context))
                        sequence += 1
                        transcript = adapter.transcribe(pcm_chunks(dataset_item["fixture"]), token)
                        partial = transcript[:-3]
                        trace = [
                            {
                                "sequence": 0,
                                "monotonicMs": virtual_ms + 80 + attempt,
                                "text": partial,
                                "replacedCharacters": 0,
                            },
                            {
                                "sequence": 1,
                                "monotonicMs": virtual_ms + 90 + attempt,
                                "text": transcript,
                                "replacedCharacters": 3,
                            },
                        ]
                        events.append(
                            _event(
                                sequence,
                                virtual_ms + 80 + attempt,
                                "partial",
                                {**context, "text": partial},
                            )
                        )
                        sequence += 1
                        events.append(
                            _event(
                                sequence,
                                virtual_ms + 90 + attempt,
                                "revision",
                                {
                                    **context,
                                    "text": transcript,
                                    "previousText": partial,
                                    "replacedCharacters": 3,
                                },
                            )
                        )
                        sequence += 1
                        events.append(_event(sequence, virtual_ms + 100, "endpoint", context))
                        sequence += 1
                        events.append(
                            _event(
                                sequence,
                                virtual_ms + 120 + attempt,
                                "final",
                                {**context, "text": transcript},
                            )
                        )
                        sequence += 1
                    except Cancelled:
                        status = "cancelled"
                        metrics = _empty_metrics()
                        failure = {
                            "code": "cancelled",
                            "message": "synthetic cancellation requested",
                            "stage": "transcribe",
                            "recoverable": True,
                        }
                        events.append(
                            _event(
                                sequence,
                                virtual_ms + 3,
                                "silence_observed",
                                {**context, "reason": "cancelled"},
                            )
                        )
                        sequence += 1
                    except SyntheticInjectedFailure:
                        status = "failed"
                        metrics = _empty_metrics()
                        failure = {
                            "code": "synthetic_failure",
                            "message": "synthetic injected failure",
                            "stage": "transcribe",
                            "recoverable": True,
                        }
                        events.append(
                            _event(
                                sequence,
                                virtual_ms + 3,
                                "failure",
                                {
                                    **context,
                                    "stage": "transcribe",
                                    "failureCode": "synthetic_failure",
                                },
                            )
                        )
                        sequence += 1
                    except Exception as error:
                        status = "failed"
                        metrics = _empty_metrics()
                        failure = {
                            "code": "transcribe_failure",
                            "message": f"transcribe failed: {type(error).__name__}",
                            "stage": "transcribe",
                            "recoverable": False,
                        }
                        events.append(
                            _event(
                                sequence,
                                virtual_ms + 3,
                                "failure",
                                {
                                    **context,
                                    "stage": "transcribe",
                                    "failureCode": "transcribe_failure",
                                },
                            )
                        )
                        sequence += 1
                        primary_failed = True
                        failure_stage = "transcribe"
                    items.append(
                        {
                            "candidateId": candidate_id,
                            "configId": str(config["id"]),
                            "sourceId": source,
                            "blindLabel": blind_label,
                            "attempt": attempt,
                            "status": status,
                            "failure": failure,
                            "transcript": transcript,
                            "audioPath": None,
                            "normalizationVersion": "synthetic-v1",
                            "revisionTrace": trace,
                            "metrics": metrics,
                        }
                    )
                    virtual_ms += 250.0
    except Exception as error:
        record_run_failure("finalize", error)
    finally:
        if adapter is not None:
            try:
                adapter.close()
            except Exception as error:
                record_run_failure("close", error)

    fill_missing_expected(failure_stage)
    run["endedAt"] = utc_now()
    run["status"] = (
        "passed"
        if not primary_failed and all(item["status"] == "passed" for item in items)
        else "failed"
    )
    try:
        _write_jsonl(run_dir / "items.jsonl", items)
        _write_jsonl(run_dir / "events.jsonl", events)
        _write_json(run_dir / "summary.json", _summary(items))
        _write_json(run_dir / "run.json", run)
        (run_dir / "ratings.jsonl").write_text("", encoding="utf-8")
        _write_readme(run_dir, config_path, dataset_path, ambient)
        validate_run(run_dir)
    except Exception as error:
        record_run_failure("finalize", error)
        run["status"] = "failed"
        run["endedAt"] = utc_now()
        try:
            _write_jsonl(run_dir / "items.jsonl", items)
            _write_jsonl(run_dir / "events.jsonl", events)
            _write_json(run_dir / "summary.json", _summary(items))
            _write_json(run_dir / "run.json", run)
            with (run_dir / "README.md").open("a", encoding="utf-8") as handle:
                handle.write(f"\nArtifact finalization failed closed: {type(error).__name__}.\n")
        finally:
            raise
    return run_dir


def _write_readme(run_dir: Path, config_path: Path, dataset_path: Path, gpu: Any) -> None:
    availability = (
        f"available: {gpu.name}, driver {gpu.driver}"
        if gpu.available
        else f"unavailable: {gpu.reason}"
    )
    try:
        config_display = config_path.relative_to(ROOT)
    except ValueError:
        config_display = config_path
    content = f"""# Synthetic benchmark run

Rerun from the project root:

```sh
uv run python -m benchmarks.harness run --kind synthetic --config {config_display}
```

Validate this run:

```sh
uv run python -m benchmarks.harness validate {run_dir}
```

Dataset manifest: `{dataset_path.relative_to(ROOT)}`. Verify it with `uv run python -m benchmarks.harness verify --dataset {dataset_path.relative_to(ROOT)}`.

nvidia-smi metadata query: {availability}. Its machine-wide memory value was ambient and is deliberately not reported as candidate peak/steady VRAM; synthetic candidate VRAM metrics are null/unmeasured, never numeric zero. Synthetic timings use a deterministic virtual monotonic clock. No CUDA model, speech model, or 30-minute soak ran.
"""
    (run_dir / "README.md").write_text(content, encoding="utf-8")


def _validate_json(schema_name: str, value: Any, label: str) -> None:
    validator = Draft202012Validator(_schema(schema_name), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(value), key=lambda error: list(error.path))
    if errors:
        raise ValidationError(f"{label}: {errors[0].message}")


def _read_jsonl(path: Path, schema_name: str) -> list[dict[str, Any]]:
    records = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValidationError(f"{path.name}:{index}: invalid JSON") from error
        _validate_json(schema_name, value, f"{path.name}:{index}")
        records.append(value)
    return records


def _validate_reveal_and_ratings(
    run_dir: Path,
    run: dict[str, Any],
    items: list[dict[str, Any]],
    ratings: list[dict[str, Any]],
) -> None:
    sealed = json.loads((run_dir / "reveal.sealed.json").read_text())
    if (
        sealed.get("algorithm") != "sha256-canonical-json"
        or not isinstance(sealed.get("commitment"), str)
        or len(sealed["commitment"]) != 64
    ):
        raise ValidationError("invalid reveal commitment")
    private_path = run_dir.parent / ".reveal-private" / f"{run_dir.name}.json"
    if private_path.is_file():
        private = json.loads(private_path.read_text())
        if sha256_bytes(canonical_json(private)) != sealed["commitment"]:
            raise ValidationError("private reveal mapping commitment mismatch")
        if not sealed.get("locked") and sealed.get("mapping") != private.get("candidateMapping"):
            raise ValidationError("revealed mapping does not match commitment")
        candidate_mapping = private.get("candidateMapping", {})
        for item in items:
            if candidate_mapping.get(item["blindLabel"]) != item["candidateId"]:
                raise ValidationError("item blindLabel does not match committed mapping")
    try:
        locked = verify_ratings_lock(run_dir)
    except RevealLockedError as error:
        raise ValidationError(str(error)) from error
    if bool(ratings) != locked:
        raise ValidationError("ratings lock state mismatch")
    if run["randomization"]["revealLocked"] != sealed.get("locked"):
        raise ValidationError("run reveal-lock state does not match sealed mapping")
    if not sealed.get("locked") and not locked:
        raise ValidationError("identities revealed without locked ratings")
    if ratings:
        lock = json.loads((run_dir / "ratings.lock.json").read_text())
        revealed_values = {rating["revealedAt"] for rating in ratings}
        reveal_lock_values = {rating["revealLocked"] for rating in ratings}
        if sealed.get("locked"):
            if (
                revealed_values != {None}
                or reveal_lock_values != {True}
                or lock.get("phase") != "submitted"
            ):
                raise ValidationError("locked ratings contain an invalid reveal transition")
        elif (
            None in revealed_values
            or len(revealed_values) != 1
            or reveal_lock_values != {False}
            or lock.get("phase") != "revealed"
            or lock.get("revealedAt") not in revealed_values
            or sealed.get("revealedAt") not in revealed_values
        ):
            raise ValidationError("revealed ratings lack a consistent reveal timestamp")
    view_path = run_dir / "listening.json"
    if ratings and view_path.is_file():
        view = json.loads(view_path.read_text())
        prompts = {prompt["promptLabel"]: prompt for prompt in view["prompts"]}
        if {rating["promptLabel"] for rating in ratings} != set(prompts):
            raise ValidationError("ratings do not cover listening prompts")
        for rating in ratings:
            prompt = prompts[rating["promptLabel"]]
            labels = [sample["label"] for sample in prompt["samples"]]
            rating_labels = [sample["label"] for sample in rating["sampleRatings"]]
            if (
                rating["order"] != prompt["order"]
                or rating["sampleLabels"] != labels
                or rating_labels != labels
            ):
                raise ValidationError(
                    "rating labels/order do not exactly match listening projection"
                )
            if rating["preference"] not in {*labels, "tie"}:
                raise ValidationError("rating preference is not a presented label or tie")


def _stt_error_counts(reference: str, hypothesis: str) -> tuple[int, int, int, int]:
    def normalize(text: str) -> list[str]:
        return re.findall(r"[a-z0-9']+", text.lower())

    def distance(left: list[str], right: list[str]) -> int:
        previous = list(range(len(right) + 1))
        for row, left_value in enumerate(left, start=1):
            current = [row]
            for column, right_value in enumerate(right, start=1):
                current.append(
                    min(
                        current[-1] + 1,
                        previous[column] + 1,
                        previous[column - 1] + (left_value != right_value),
                    )
                )
            previous = current
        return previous[-1]

    reference_words = normalize(reference)
    hypothesis_words = normalize(hypothesis)
    reference_chars = list(" ".join(reference_words))
    hypothesis_chars = list(" ".join(hypothesis_words))
    return (
        distance(reference_words, hypothesis_words),
        len(reference_words),
        distance(reference_chars, hypothesis_chars),
        len(reference_chars),
    )


def _tracked_stt_references(run: dict[str, Any]) -> dict[str, str]:
    matches: list[dict[str, Any]] = []
    for path in (ROOT / "benchmarks/datasets").rglob("*.manifest.json"):
        try:
            manifest, digest = verify_dataset(path, ROOT)
        except (OSError, ValueError):
            continue
        if manifest.get("id") == run["datasetId"] and digest == run["datasetSha256"]:
            matches.append(manifest)
    if len(matches) != 1:
        raise ValidationError(
            "STT dataset hash/id does not resolve to one tracked verified manifest"
        )
    references = {
        str(item["sourceId"]): str(item["reference"])
        for item in matches[0]["items"]
        if "reference" in item
    }
    if not references:
        raise ValidationError("tracked STT dataset has no references")
    return references


def _recompute_stt_rates(
    items: list[dict[str, Any]], references: dict[str, str]
) -> tuple[float | None, float | None]:
    word_errors = word_units = char_errors = char_units = 0
    for item in items:
        if item["status"] != "passed" or item["sourceId"] not in references:
            continue
        counts = _stt_error_counts(references[item["sourceId"]], item["transcript"])
        word_errors += counts[0]
        word_units += counts[1]
        char_errors += counts[2]
        char_units += counts[3]
    return (
        word_errors / word_units if word_units else None,
        char_errors / char_units if char_units else None,
    )


def _recompute_stt_soak(
    run_dir: Path,
    run: dict[str, Any],
    events: list[dict[str, Any]],
    submitted: dict[str, Any],
) -> dict[str, Any]:
    if "--soak-minutes" not in run["command"]:
        return {
            "durationSeconds": 0.0,
            "passed": True,
            "severeFailures": 0,
            "underruns": 0,
            "droppedFrames": 0,
            "expectedFrames": 0,
            "consumedFrames": 0,
            "expectedChunks": 0,
            "consumedChunks": 0,
            "deadlineOverruns": 0,
            "deadlineLatenessP95Ms": 0.0,
            "deadlineLatenessMaxMs": 0.0,
            "timingConformance": True,
            "resetCount": 0,
            "workerLeaks": 0,
        }

    iterations = [event for event in events if event["type"] == "soak_iteration"]
    if not iterations:
        # T3.1's accepted soak predates raw per-iteration telemetry. Its four core
        # artifacts are admitted only by exact run identity and byte hashes; there is
        # no broad fallback that trusts an arbitrary legacy summary.
        accepted = {
            "runId": "b65ea6b2-8c86-4707-bee8-94935ea3a37a",
            "run.json": "330286e989c07707c1456a7f4d96b94055e286c90dc838ea2bbc2a14569270ce",
            "summary.json": "3e68eea4083a314cf40eb21cec0632ba92408cd743ff7949589f35ae9b4fe8e6",
            "events.jsonl": "4db73ea858f3b65c8959755fd9a52892e186a7ce75ff1aa7f81f247a8fd2ef38",
            "items.jsonl": "622e1fdffa800548f95a037d0b65770c8ca3b100dbe45868d7f5e49ee4cbea10",
        }
        if run.get("runId") != accepted["runId"] or any(
            sha256_file(run_dir / name) != digest
            for name, digest in accepted.items()
            if name != "runId"
        ):
            raise ValidationError("soak run lacks independently recomputable raw iterations")
        return submitted

    starts = [event for event in events if event["type"] == "soak_started"]
    completions = [event for event in events if event["type"] == "soak_completed"]
    if len(starts) != 1 or len(completions) != 1:
        raise ValidationError("paced soak requires exactly one start and completion event")
    ordered = sorted(iterations, key=lambda event: event["detail"].get("iteration", 0))
    if [event["detail"].get("iteration") for event in ordered] != list(range(1, len(ordered) + 1)):
        raise ValidationError("soak iteration evidence must be contiguous from one")

    required = {
        "expectedFrames",
        "consumedFrames",
        "expectedChunks",
        "consumedChunks",
        "deadlineOverruns",
        "droppedFrames",
        "workerLeaks",
        "resetCount",
        "deadlineLatenessMs",
    }
    if any(not required.issubset(event["detail"]) for event in ordered):
        raise ValidationError("soak iteration evidence is incomplete")
    details = [event["detail"] for event in ordered]
    lateness = [float(value) for detail in details for value in detail["deadlineLatenessMs"]]
    expected_frames = sum(detail["expectedFrames"] for detail in details)
    consumed_frames = sum(detail["consumedFrames"] for detail in details)
    expected_chunks = sum(detail["expectedChunks"] for detail in details)
    consumed_chunks = sum(detail["consumedChunks"] for detail in details)
    dropped = sum(detail["droppedFrames"] for detail in details) + max(
        0, expected_frames - consumed_frames
    )
    underruns = max(0, expected_chunks - consumed_chunks)
    worker_leaks = sum(detail["workerLeaks"] for detail in details)
    reset_count = sum(detail["resetCount"] for detail in details)
    deadline_overruns = sum(detail["deadlineOverruns"] for detail in details)
    lateness_p95 = percentile(lateness, 0.95) if lateness else 0.0
    lateness_max = max(lateness, default=0.0)
    timing = lateness_p95 <= 20.0 and lateness_max <= 100.0
    observed_duration = (completions[0]["monotonicMs"] - starts[0]["monotonicMs"]) / 1000
    duration = float(submitted["durationSeconds"])
    if duration > observed_duration + 0.1 or observed_duration - duration > 1.0:
        raise ValidationError("soak duration disagrees with monotonic raw events")
    severe_failures = sum(
        event["type"] == "failure"
        and event["detail"].get("stage") in {"soak", "close"}
        and starts[0]["monotonicMs"] <= event["monotonicMs"] <= completions[0]["monotonicMs"]
        for event in events
    )
    completion_leaks = completions[0]["detail"].get("workerLeaks")
    completion_failures = completions[0]["detail"].get("severeFailures")
    if completion_leaks != worker_leaks or completion_failures != severe_failures:
        raise ValidationError("soak cleanup evidence disagrees with raw events")

    index = run["command"].index("--soak-minutes")
    requested_seconds = float(run["command"][index + 1]) * 60
    passed = bool(
        duration >= requested_seconds
        and not severe_failures
        and not dropped
        and not underruns
        and not worker_leaks
        and timing
    )
    return {
        "durationSeconds": duration,
        "passed": passed,
        "severeFailures": severe_failures,
        "underruns": underruns,
        "droppedFrames": dropped,
        "expectedFrames": expected_frames,
        "consumedFrames": consumed_frames,
        "expectedChunks": expected_chunks,
        "consumedChunks": consumed_chunks,
        "deadlineOverruns": deadline_overruns,
        "deadlineLatenessP95Ms": lateness_p95,
        "deadlineLatenessMaxMs": lateness_max,
        "timingConformance": timing,
        "resetCount": reset_count,
        "workerLeaks": worker_leaks,
    }


def _tracked_tts_prompts(run: dict[str, Any]) -> dict[str, dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for path in (ROOT / "benchmarks/datasets").glob("*.manifest.json"):
        try:
            manifest, digest = verify_dataset(path, ROOT)
        except (OSError, ValueError):
            continue
        if (
            manifest.get("kind") == "tts-prompts"
            and manifest.get("id") == run["datasetId"]
            and digest == run["datasetSha256"]
        ):
            matches.append(manifest)
    if len(matches) != 1:
        raise ValidationError("TTS prompt hash/id does not resolve to one tracked manifest")
    if len(matches[0]["items"]) < 20:
        raise ValidationError("tracked TTS prompt manifest contains fewer than 20 prompts")
    return {str(item["sourceId"]): item for item in matches[0]["items"]}


def _validate_tts_semantics(run: dict[str, Any]) -> None:
    semantics = run.get("comparisonSemantics")
    if not isinstance(semantics, dict):
        raise ValidationError("TTS comparison semantics are missing")
    expected = {
        "kind": "tts",
        "promptManifestId": "tts-prompts-v1",
        "promptManifestSha256": run.get("datasetSha256"),
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
        "listeningVersion": "tts-blinded-paired-v1",
    }
    if semantics != expected:
        differing = sorted(
            key for key in set(expected) | set(semantics) if semantics.get(key) != expected.get(key)
        )
        detail = ", ".join(
            f"{key}={semantics.get(key)!r}, expected {expected.get(key)!r}" for key in differing
        )
        raise ValidationError(f"unmatched TTS comparison semantics: {detail}")
    if run.get("comparisonSemanticsSha256") != sha256_bytes(canonical_json(semantics)):
        raise ValidationError("unmatched TTS comparison semantics: hash is missing or invalid")


def _validate_tts_provenance(run: dict[str, Any]) -> None:
    provenance = run.get("provenance")
    models = run.get("models")
    if not isinstance(provenance, dict) or not isinstance(models, list) or len(models) != 1:
        raise ValidationError("TTS run lacks one model and complete provenance")
    model_record = models[0]

    def tracked_path(value: object, root: Path, label: str) -> Path:
        if not isinstance(value, str) or not value:
            raise ValidationError(f"TTS {label} provenance path is invalid")
        path = (ROOT / value).resolve()
        if root not in path.parents:
            raise ValidationError(f"TTS {label} provenance path is unsafe")
        return path

    config_path = tracked_path(
        provenance.get("configPath"), (ROOT / "benchmarks/configs/tts").resolve(), "config"
    )
    prompts_path = tracked_path(
        provenance.get("datasetPath"), (ROOT / "benchmarks/datasets").resolve(), "dataset"
    )
    manifest_path = tracked_path(
        provenance.get("modelManifestPath"), ROOT, "model manifest"
    )
    if manifest_path != (ROOT / "docs/model-manifest.json").resolve():
        raise ValidationError("TTS model manifest provenance path is not canonical")
    if not config_path.is_file() or sha256_file(config_path) != run.get("configSha256"):
        raise ValidationError("TTS config provenance hash does not match run identity")
    if not manifest_path.is_file() or sha256_file(manifest_path) != provenance.get("modelManifestSha256"):
        raise ValidationError("TTS model manifest provenance hash does not match run identity")

    config = load_yaml_subset(config_path)
    candidate = config.get("candidate")
    if (
        config.get("schemaVersion") != 1
        or config.get("kind") != "tts"
        or config.get("id") != run.get("configId")
        or not isinstance(candidate, dict)
        or candidate.get("id") != model_record.get("id")
    ):
        raise ValidationError("TTS config provenance does not match run identity")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_models = manifest.get("models")
    if not isinstance(manifest_models, list):
        raise ValidationError("TTS model manifest provenance is not a model manifest")
    entries = [
        entry
        for entry in manifest_models
        if isinstance(entry, dict) and entry.get("id") == provenance.get("modelManifestId")
    ]
    if len(entries) != 1:
        raise ValidationError("TTS model provenance does not resolve to one manifest entry")
    model = entries[0]
    if candidate.get("id") == "kokoro":
        provider = candidate.get("provider")
        if provider == "CPUExecutionProvider":
            expected_runtime = model.get("cpuRuntime")
            expected_provider = model.get("cpuProvider")
            expected_precision = model.get("cpuPrecision")
        elif provider == "CUDAExecutionProvider":
            expected_runtime = model.get("runtime")
            expected_provider = model.get("provider")
            expected_precision = model.get("precision")
        else:
            raise ValidationError("TTS Kokoro provider is not attested")
        if (
            expected_runtime is None
            or candidate.get("runtime") != expected_runtime
            or candidate.get("provider") != expected_provider
            or candidate.get("precision") != expected_precision
        ):
            raise ValidationError("TTS Kokoro runtime variant does not match model manifest")
    if (
        model.get("revision") != model_record.get("revision")
        or model.get("sha256") != model_record.get("sha256")
        or candidate.get("modelId") != model.get("id")
        or candidate.get("revision") != model.get("revision")
        or candidate.get("modelSha256") != model.get("sha256")
    ):
        raise ValidationError("TTS model provenance does not match config or run identity")
    for key in (
        "runtime",
        "runtimeRevision",
        "voice",
        "provider",
        "precision",
        "onnxReleaseRevision",
        "voicesSha256",
    ):
        if key in model_record and model_record.get(key) != candidate.get(key):
            raise ValidationError(f"TTS model provenance {key} does not match config")
    if model_record.get("nativeSampleRate") != config.get("nativeSampleRate"):
        raise ValidationError("TTS model provenance sample rate does not match config")

    if not prompts_path.is_file():
        raise ValidationError("TTS dataset provenance path is missing")
    prompts, digest = verify_dataset(prompts_path, ROOT)
    if (
        prompts.get("id") != run.get("datasetId")
        or digest != run.get("datasetSha256")
        or prompts.get("id") != config.get("promptManifestId")
    ):
        raise ValidationError("TTS dataset provenance does not match run identity")


def _validate_tts_audio(
    run_dir: Path,
    run: dict[str, Any],
    items: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> None:
    import wave

    prompts = _tracked_tts_prompts(run)
    for item in items:
        if item["sourceId"].startswith("__run__:") or item["status"] != "passed":
            continue
        prompt = prompts.get(item["sourceId"])
        if prompt is None or item.get("promptSha256") != prompt.get("textSha256"):
            raise ValidationError("TTS item prompt checksum does not match tracked exact text")
        metadata = item.get("audioMetadata")
        if not isinstance(metadata, dict) or item.get("audioPath") is None:
            raise ValidationError("passed TTS item lacks audio metadata or path")
        path = (run_dir / item["audioPath"]).resolve()
        if run_dir not in path.parents or not path.is_file():
            raise ValidationError("TTS item audio path is missing or unsafe")
        try:
            with wave.open(str(path), "rb") as source:
                if (
                    source.getnchannels() != 1
                    or source.getsampwidth() != 2
                    or source.getframerate() != metadata["sampleRate"]
                    or source.getnframes() != metadata["totalSamples"]
                    or metadata["sampleRate"]
                    != run["comparisonSemantics"]["comparisonSampleRate"]
                    or metadata["nativeSampleRate"]
                    != run["comparisonSemantics"]["nativeSampleRate"]
                ):
                    raise ValidationError("TTS WAV header disagrees with signed PCM16 mono metadata")
                pcm = source.readframes(source.getnframes())
        except wave.Error as error:
            raise ValidationError("TTS output is not a valid PCM WAV") from error
        if (
            path.stat().st_size != 44 + len(pcm)
            or len(pcm) != metadata["totalSamples"] * 2
            or sha256_bytes(pcm) != metadata["sha256"]
            or metadata["durationSeconds"]
            != metadata["totalSamples"] / metadata["sampleRate"]
            or item["metrics"].get("totalSamples") != metadata["totalSamples"]
            or item["metrics"].get("totalAudioDurationSeconds") != metadata["durationSeconds"]
        ):
            raise ValidationError("TTS PCM content/checksum/duration metadata mismatch")
        correlated = [
            event
            for event in events
            if event["detail"].get("sourceId") == item["sourceId"]
            and event["detail"].get("candidateId") == item["candidateId"]
            and event["detail"].get("attempt") == item["attempt"]
            and event["detail"].get("phase", "measured") == "measured"
        ]
        first = [event for event in correlated if event["type"] == "first_audio"]
        finals = [event for event in correlated if event["type"] == "final"]
        requested = [event for event in correlated if event["type"] == "tts_requested"]
        if len(first) != 1 or len(finals) != 1 or len(requested) != 1:
            raise ValidationError("passed TTS item requires one request, first-audio, and final event")
        measured = first[0]["monotonicMs"] - requested[0]["monotonicMs"]
        processing = (finals[0]["monotonicMs"] - requested[0]["monotonicMs"]) / 1000
        if metadata.get("timingBoundary") is not None and (
            metadata["timingBoundary"] != run["comparisonSemantics"].get("timingBoundary")
            or abs(metadata["processingSeconds"] - processing) > 1e-6
            or abs(finals[0]["detail"].get("processingSeconds", -1) - processing) > 1e-6
            or abs(item["metrics"]["rtf"] - processing / metadata["durationSeconds"]) > 1e-6
            or finals[0]["detail"].get("adapterProcessingSeconds")
            != metadata.get("adapterProcessingSeconds")
        ):
            raise ValidationError("TTS harness timing boundary or RTF arithmetic mismatch")
        if (
            requested[0]["monotonicMs"] > first[0]["monotonicMs"]
            or first[0]["monotonicMs"] > finals[0]["monotonicMs"]
            or abs(measured - item["metrics"]["ttsTimeToFirstAudioMs"]) > 0.01
            or finals[0]["detail"].get("sampleCount") != metadata["totalSamples"]
            or finals[0]["detail"].get("outputSha256") != metadata["sha256"]
        ):
            raise ValidationError("TTS request/first-audio/final ordering or timing mismatch")


def _validate_tts_timing(
    run: dict[str, Any],
    summary: dict[str, Any],
    items: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> None:
    timing = run.get("timing")
    if timing is None:
        # Runs produced before the matched cold/prepare timing contract remain
        # valid historical fixtures. New runs always persist this object.
        return
    if not isinstance(timing, dict):
        raise ValidationError("TTS timing record is invalid")

    prepare_seconds = timing.get("prepareSeconds")
    if not isinstance(prepare_seconds, (int, float)) or isinstance(prepare_seconds, bool):
        raise ValidationError("TTS prepare timing is missing")
    if prepare_seconds < 0 or summary.get("prepareSeconds") != prepare_seconds:
        raise ValidationError("TTS prepare timing does not match summary")

    def optional_peak(value: object, label: str) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValidationError(f"TTS {label} is invalid")
        return value

    prepare_rss = optional_peak(timing.get("preparePeakRssBytes"), "prepare RSS peak")
    prepare_vram = optional_peak(timing.get("preparePeakVramBytes"), "prepare VRAM peak")
    cold = timing.get("cold")
    cold_rss = cold_vram = None
    if cold is None:
        if summary.get("cold") is not None:
            raise ValidationError("TTS cold timing does not match summary")
    elif not isinstance(cold, dict):
        raise ValidationError("TTS cold timing is invalid")
    else:
        required = {
            "sourceId",
            "ttsTimeToFirstAudioMs",
            "processingSeconds",
            "rtf",
            "audioDurationSeconds",
            "totalSamples",
            "peakRssBytes",
            "peakVramBytes",
        }
        if not required.issubset(cold):
            raise ValidationError("TTS cold timing is incomplete")
        if summary.get("cold") != cold:
            raise ValidationError("TTS cold timing does not match summary")
        for key in (
            "ttsTimeToFirstAudioMs",
            "processingSeconds",
            "rtf",
            "audioDurationSeconds",
        ):
            value = cold[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                raise ValidationError(f"TTS cold {key} is invalid")
        if isinstance(cold["totalSamples"], bool) or not isinstance(cold["totalSamples"], int) or cold["totalSamples"] <= 0:
            raise ValidationError("TTS cold sample count is invalid")
        cold_rss = optional_peak(cold["peakRssBytes"], "cold RSS peak")
        cold_vram = optional_peak(cold["peakVramBytes"], "cold VRAM peak")
        cold_id = cold["sourceId"]
        correlated = [
            event
            for event in events
            if event["detail"].get("sourceId") == cold_id
            and event["detail"].get("candidateId") == run["models"][0]["id"]
            and event["detail"].get("attempt") == 1
            and event["detail"].get("phase") == "cold"
        ]
        requested = [event for event in correlated if event["type"] == "tts_requested"]
        first = [event for event in correlated if event["type"] == "first_audio"]
        finals = [event for event in correlated if event["type"] == "final"]
        if len(requested) != 1 or len(first) != 1 or len(finals) != 1:
            raise ValidationError("TTS cold timing requires one request, first-audio, and final event")
        measured_ttfa = first[0]["monotonicMs"] - requested[0]["monotonicMs"]
        measured_processing = (finals[0]["monotonicMs"] - requested[0]["monotonicMs"]) / 1000
        if (
            abs(measured_ttfa - cold["ttsTimeToFirstAudioMs"]) > 0.01
            or abs(measured_processing - cold["processingSeconds"]) > 1e-6
            or abs(cold["rtf"] - measured_processing / cold["audioDurationSeconds"]) > 1e-6
            or finals[0]["detail"].get("sampleCount") != cold["totalSamples"]
        ):
            raise ValidationError("TTS cold timing arithmetic is inconsistent")
        if first[0]["monotonicMs"] < requested[0]["monotonicMs"] or finals[0]["monotonicMs"] < first[0]["monotonicMs"]:
            raise ValidationError("TTS cold timing event order is invalid")

    # Include measured-item resource maxima with the prepare and cold windows,
    # without deriving a number from ambient nvidia-smi state.
    measured_rss_values = [
        item["metrics"].get("peakRssBytes")
        for item in items
        if item["metrics"].get("peakRssBytes") is not None
    ]
    measured_vram_values = [
        item["metrics"].get("peakVramBytes")
        for item in items
        if item["metrics"].get("peakVramBytes") is not None
    ]
    measured_rss = max(measured_rss_values, default=None)
    measured_vram = max(measured_vram_values, default=None)
    rss_values = [value for value in (prepare_rss, cold_rss, measured_rss) if value is not None]
    vram_values = [value for value in (prepare_vram, cold_vram, measured_vram) if value is not None]
    expected_rss = max(rss_values) if rss_values else None
    expected_vram = max(vram_values) if vram_values else None
    if timing.get("peakRssBytes") != expected_rss or summary.get("peakRssBytes") != expected_rss:
        raise ValidationError("TTS whole-run RSS peak does not match phase peaks")
    if timing.get("peakVramBytes") != expected_vram or summary.get("peakVramBytes") != expected_vram:
        raise ValidationError("TTS whole-run VRAM peak does not match phase peaks")


def _recompute_tts_soak(
    run: dict[str, Any], events: list[dict[str, Any]], submitted: dict[str, Any]
) -> dict[str, Any]:
    if "--soak-minutes" not in run["command"]:
        result = {
            "durationSeconds": 0.0,
            "passed": True,
            "severeFailures": 0,
            "underruns": 0,
            "underrunEpisodes": 0,
            "missedSamples": 0,
            "droppedFrames": 0,
            "expectedFrames": 0,
            "consumedFrames": 0,
            "expectedChunks": 0,
            "consumedChunks": 0,
            "deadlineOverruns": 0,
            "deadlineLatenessP95Ms": 0.0,
            "deadlineLatenessMaxMs": 0.0,
            "timingConformance": True,
            "resetCount": 0,
            "workerLeaks": 0,
            "expectedSamples": 0,
            "consumedSamples": 0,
        }
        return result
    starts = [event for event in events if event["type"] == "soak_started"]
    completions = [event for event in events if event["type"] == "soak_completed"]
    iterations = [event for event in events if event["type"] == "soak_iteration"]
    if len(starts) != 1 or len(completions) != 1 or not iterations:
        raise ValidationError("TTS soak lacks one start/completion and raw iterations")
    ordered = sorted(iterations, key=lambda event: event["detail"].get("iteration", 0))
    if [event["detail"].get("iteration") for event in ordered] != list(range(1, len(ordered) + 1)):
        raise ValidationError("TTS soak iterations are not contiguous")
    details = [event["detail"] for event in ordered]
    if not all("chunkTelemetry" in detail for detail in details):
        raise ValidationError("TTS soak raw chunk telemetry is incomplete")
    if all("chunkTelemetry" in detail for detail in details):
        expected_samples = expected_chunks = episodes = missed_samples = 0
        drops = leaks = resets = 0
        lateness: list[float] = []
        for detail in details:
            records = detail["chunkTelemetry"]
            previous_late = False
            offset = local_episodes = local_missed = 0
            for sequence, record in enumerate(records):
                if record["sequence"] != sequence or record["sampleOffset"] != offset:
                    raise ValidationError("TTS soak chunk offsets/sequences are not contiguous")
                if not (record["acceptedMonotonicNs"] <= record["queuedMonotonicNs"] <= record["consumeMonotonicNs"]):
                    raise ValidationError("TTS soak chunk arrival/consume timestamps are invalid")
                expected_deadline = records[0]["deadlineMonotonicNs"] + record["sampleOffset"] * 1_000_000_000 // 24_000
                if record["deadlineMonotonicNs"] != expected_deadline:
                    raise ValidationError("TTS soak sample deadline arithmetic is invalid")
                late_ns = max(0, record["queuedMonotonicNs"] - record["deadlineMonotonicNs"])
                missed = min(record["sampleCount"], (late_ns * 24_000 + 999_999_999) // 1_000_000_000)
                if record["arrivalLatenessNs"] != late_ns or record["missedSamples"] != missed:
                    raise ValidationError("TTS soak persisted arrival telemetry is inconsistent")
                late = missed > 0
                local_episodes += int(late and not previous_late)
                previous_late = late
                local_missed += missed
                lateness.append(late_ns / 1_000_000)
                offset += record["sampleCount"]
            if (detail["expectedSamples"] != offset or detail["consumedSamples"] != offset or detail["expectedChunks"] != len(records) or detail["consumedChunks"] != len(records) or detail["underrunEpisodes"] != local_episodes or detail["underruns"] != local_episodes or detail["missedSamples"] != local_missed):
                raise ValidationError("TTS soak iteration aggregate disagrees with raw chunks")
            expected_samples += offset
            expected_chunks += len(records)
            episodes += local_episodes
            missed_samples += local_missed
            drops += detail["droppedOutputChunks"]
            leaks += detail["workerLeaks"]
            resets += detail["resetCount"]
        observed = (completions[0]["monotonicMs"] - starts[0]["monotonicMs"]) / 1000
        duration = float(submitted["durationSeconds"])
        if duration > observed + 0.1 or observed - duration > 1.0:
            raise ValidationError("TTS soak duration disagrees with monotonic events")
        requested = float(run["command"][run["command"].index("--soak-minutes") + 1]) * 60
        severe = sum(event["type"] == "failure" and event["detail"].get("stage") in {"soak", "close"} and starts[0]["monotonicMs"] <= event["monotonicMs"] <= completions[0]["monotonicMs"] for event in events)
        p95 = percentile(lateness, 0.95) if lateness else 0.0
        maximum = max(lateness, default=0.0)
        timing = p95 <= 20 and maximum <= 100
        completion = completions[0]["detail"]
        if completion.get("workerLeaks") != leaks or completion.get("severeFailures") != severe:
            raise ValidationError("TTS soak cleanup summary disagrees with raw events")
        return {"durationSeconds": duration, "passed": bool(duration >= requested and not severe and not episodes and not missed_samples and not drops and not leaks and timing), "severeFailures": severe, "underruns": episodes, "underrunEpisodes": episodes, "missedSamples": missed_samples, "droppedFrames": drops, "expectedFrames": expected_samples, "consumedFrames": expected_samples, "expectedChunks": expected_chunks, "consumedChunks": expected_chunks, "deadlineOverruns": sum(value > 20 for value in lateness), "deadlineLatenessP95Ms": p95, "deadlineLatenessMaxMs": maximum, "timingConformance": timing, "resetCount": resets, "workerLeaks": leaks, "expectedSamples": expected_samples, "consumedSamples": expected_samples}
    required = {
        "expectedSamples",
        "consumedSamples",
        "expectedChunks",
        "consumedChunks",
        "deadlineOverruns",
        "droppedOutputChunks",
        "underruns",
        "workerLeaks",
        "resetCount",
        "deadlineLatenessMs",
    }
    if any(not required.issubset(detail) for detail in details):
        raise ValidationError("TTS soak raw iteration is incomplete")
    lateness = [float(value) for detail in details for value in detail["deadlineLatenessMs"]]
    expected_samples = sum(detail["expectedSamples"] for detail in details)
    consumed_samples = sum(detail["consumedSamples"] for detail in details)
    expected_chunks = sum(detail["expectedChunks"] for detail in details)
    consumed_chunks = sum(detail["consumedChunks"] for detail in details)
    drops = sum(detail["droppedOutputChunks"] for detail in details)
    worker_leaks = sum(detail["workerLeaks"] for detail in details)
    resets = sum(detail["resetCount"] for detail in details)
    underruns = sum(detail["underruns"] for detail in details) + max(
        0, expected_chunks - consumed_chunks
    )
    p95 = percentile(lateness, 0.95) if lateness else 0.0
    maximum = max(lateness, default=0.0)
    timing = p95 <= 20 and maximum <= 100
    observed_duration = (completions[0]["monotonicMs"] - starts[0]["monotonicMs"]) / 1000
    duration = float(submitted["durationSeconds"])
    if duration > observed_duration + 0.1 or observed_duration - duration > 1.0:
        raise ValidationError("TTS soak duration disagrees with monotonic events")
    index = run["command"].index("--soak-minutes")
    requested = float(run["command"][index + 1]) * 60
    severe = sum(
        event["type"] == "failure"
        and event["detail"].get("stage") in {"soak", "close"}
        and starts[0]["monotonicMs"] <= event["monotonicMs"] <= completions[0]["monotonicMs"]
        for event in events
    )
    completion = completions[0]["detail"]
    if completion.get("workerLeaks") != worker_leaks or completion.get("severeFailures") != severe:
        raise ValidationError("TTS soak cleanup summary disagrees with raw events")
    return {
        "durationSeconds": duration,
        "passed": bool(
            duration >= requested
            and not severe
            and not underruns
            and not drops
            and not worker_leaks
            and expected_samples == consumed_samples
            and timing
        ),
        "severeFailures": severe,
        "underruns": underruns,
        "droppedFrames": drops,
        "expectedFrames": expected_samples,
        "consumedFrames": consumed_samples,
        "expectedChunks": expected_chunks,
        "consumedChunks": consumed_chunks,
        "deadlineOverruns": sum(detail["deadlineOverruns"] for detail in details),
        "deadlineLatenessP95Ms": p95,
        "deadlineLatenessMaxMs": maximum,
        "timingConformance": timing,
        "resetCount": resets,
        "workerLeaks": worker_leaks,
        "expectedSamples": expected_samples,
        "consumedSamples": consumed_samples,
    }


def validate_run(run_dir: Path) -> dict[str, int]:
    run_dir = run_dir.resolve()
    required = [
        "run.json",
        "items.jsonl",
        "events.jsonl",
        "summary.json",
        "ratings.jsonl",
        "README.md",
        "reveal.sealed.json",
    ]
    missing = [name for name in required if not (run_dir / name).is_file()]
    if missing:
        raise ValidationError(f"missing run artifacts: {', '.join(missing)}")
    run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    try:
        _validate_json("run.json", run, "run.json")
    except ValidationError as error:
        if run.get("kind") == "tts":
            raise ValidationError(f"unmatched TTS comparison semantics: {error}") from error
        raise
    _validate_json("summary.json", summary, "summary.json")
    items = _read_jsonl(run_dir / "items.jsonl", "item.json")
    events = _read_jsonl(run_dir / "events.jsonl", "event.json")
    ratings = _read_jsonl(run_dir / "ratings.jsonl", "rating.json")
    timing = run.get("timing") if run["kind"] == "tts" else None
    recomputed = _summary(items, timing if isinstance(timing, dict) else None)
    if run["kind"] == "stt":
        references = _tracked_stt_references(run)
        recomputed["wer"], recomputed["cer"] = _recompute_stt_rates(items, references)
        recomputed["soak"] = _recompute_stt_soak(run_dir, run, events, summary["soak"])
    elif run["kind"] == "tts":
        _validate_tts_provenance(run)
        _validate_tts_semantics(run)
        _validate_tts_audio(run_dir, run, items, events)
        _validate_tts_timing(run, summary, items, events)
        recomputed["soak"] = _recompute_tts_soak(run, events, summary["soak"])
    elif set(summary["soak"]) == {
        "durationSeconds",
        "passed",
        "severeFailures",
        "underruns",
        "droppedFrames",
    }:
        if not _exact_legacy(run_dir, run):
            raise ValidationError("legacy soak summary is not an exact accepted artifact")
        recomputed["soak"] = summary["soak"]
    if summary != recomputed:
        raise ValidationError("summary does not match recomputed item aggregates")
    terminal = "passed" if all(item["status"] == "passed" for item in items) and recomputed["soak"]["passed"] else "failed"
    if run["status"] != terminal and not _exact_legacy(run_dir, run):
        raise ValidationError("run status does not match item/run failures and soak outcome")
    source_manifest_path = run_dir / "source-manifest.json"
    if "sourceManifestSha256" in run:
        if not source_manifest_path.is_file() or sha256_file(source_manifest_path) != run["sourceManifestSha256"]:
            raise ValidationError("source snapshot manifest is missing or does not match run identity")
        snapshot = json.loads(source_manifest_path.read_text())
        if run["sourceId"] != f"source-{sha256_bytes(canonical_json(snapshot))[:16]}":
            raise ValidationError("source snapshot manifest does not reproduce sourceId")
    probe_path = run_dir / "cancellation-probe.json"
    if probe_path.exists():
        checksum_path = run_dir / "cancellation-probe.sha256"
        if not checksum_path.is_file() or checksum_path.read_text().split()[0] != sha256_file(probe_path):
            raise ValidationError("cancellation probe checksum is missing or invalid")
        probe = json.loads(probe_path.read_text())
        if (
            probe.get("runId") != run["runId"]
            or probe.get("sourceId") != run["sourceId"]
            or probe.get("candidateId") != run["models"][0]["id"]
            or probe.get("configId") != run["configId"]
            or probe.get("configSha256") != run["configSha256"]
            or probe.get("promptManifestId") != run["datasetId"]
            or probe.get("promptManifestSha256") != run["datasetSha256"]
            or probe.get("modelRevision") != run["models"][0]["revision"]
            or probe.get("modelSha256") != run["models"][0]["sha256"]
            or probe.get("outcome") != "cancelled"
            or probe.get("acceptedChunks") != 1
            or not isinstance(probe.get("cutoffSamples"), int)
            or probe.get("cutoffSamples", 0) <= 0
            or probe.get("backendPoisoned") is not False
            or probe.get("preCloseSurvivingWorkers") != []
            or probe.get("postCloseSurvivingWorkers") != []
        ):
            raise ValidationError("cancellation probe identity/outcome/cleanup evidence is invalid")
    sequences = [event["sequence"] for event in events]
    times = [event["monotonicMs"] for event in events]
    if sequences != list(range(len(events))):
        raise ValidationError("event sequences must be contiguous from zero")
    if times != sorted(times):
        raise ValidationError("event monotonicMs values moved backwards")
    model_ids = {model["id"] for model in run["models"]}
    if any(item["candidateId"] not in model_ids for item in items):
        raise ValidationError("item candidate absent from run model manifest")
    measured = [item for item in items if not item["sourceId"].startswith("__run__:")]
    actual_expected = {
        (item["sourceId"], item["candidateId"], item["attempt"]) for item in measured
    }
    committed_expected = {
        (item["sourceId"], item["candidateId"], item["attempt"]) for item in run["expectedItems"]
    }
    if (
        len(actual_expected) != len(measured)
        or len(committed_expected) != len(run["expectedItems"])
        or actual_expected != committed_expected
    ):
        raise ValidationError("items do not exactly match committed expectedItems")
    pairs = {(item["sourceId"], item["candidateId"], item["attempt"]): item for item in items}
    event_pairs: dict[tuple[str, str, int], set[str]] = {}
    for event in events:
        detail = event["detail"]
        if all(key in detail for key in ("sourceId", "candidateId", "attempt")):
            pair = (detail["sourceId"], detail["candidateId"], detail["attempt"])
            if pair not in pairs:
                raise ValidationError("event references absent item")
            event_pairs.setdefault(pair, set()).add(event["type"])
    for pair, item in pairs.items():
        kinds = event_pairs.get(pair, set())
        required_kind = {"passed": "final", "failed": "failure", "cancelled": "silence_observed"}[
            item["status"]
        ]
        if required_kind not in kinds:
            raise ValidationError(f"item {pair} lacks correlated {required_kind} event")
    _validate_reveal_and_ratings(run_dir, run, items, ratings)
    return {"items": len(items), "events": len(events), "ratings": len(ratings)}


def normalize_summary(run_dir: Path) -> dict[str, Any]:
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    normalized = json.loads(json.dumps(summary))
    normalized["peakVramBytes"] = 0
    normalized["steadyVramBytes"] = 0
    return normalized
