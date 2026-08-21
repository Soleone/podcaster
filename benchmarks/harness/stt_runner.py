from __future__ import annotations

import json
import queue
import re
import threading
import time
import uuid
import wave
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from benchmarks.harness.adapter import CancelToken
from services.audio.src.stt.nemotron import NemotronStreamingAdapter
from services.audio.src.stt.parakeet import ParakeetStreamingAdapter
from services.audio.src.vad import DeterministicEndpointer, EndpointerConfig

from .checksums import verify_dataset, verify_models
from .randomization import blind_mapping
from .runner import (
    ROOT,
    _event,
    _failure_item,
    _initialize_artifacts,
    _summary,
    _write_json,
    _write_jsonl,
    validate_run,
)
from .util import (
    canonical_json,
    environment_metadata,
    load_yaml_subset,
    machine_metadata,
    runtime_metadata,
    sha256_bytes,
    sha256_file,
    percentile,
    source_state,
    utc_now,
)
from .nvml import sample_gpu
from .timing import SOAK_MAX_DEADLINE_MS, SOAK_P95_DEADLINE_MS

NORMALIZATION_VERSION = "english-basic-v1"
SUPPORTED_PARTIAL_CONTRACTS = {"append-only-rnnt-v1", "cumulative-revising-rnnt-v1"}
FRAME_MS = 20
SAMPLE_RATE = 16_000
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2


def normalize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def edit_distance(left: list[str], right: list[str]) -> int:
    previous = list(range(len(right) + 1))
    for row, lvalue in enumerate(left, start=1):
        current = [row]
        for column, rvalue in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1, previous[column] + 1, previous[column - 1] + (lvalue != rvalue)
                )
            )
        previous = current
    return previous[-1]


def error_counts(reference: str, hypothesis: str) -> tuple[int, int, int, int]:
    reference_words = normalize(reference)
    hypothesis_words = normalize(hypothesis)
    reference_chars = list(" ".join(reference_words))
    hypothesis_chars = list(" ".join(hypothesis_words))
    return (
        edit_distance(reference_words, hypothesis_words),
        len(reference_words),
        edit_distance(reference_chars, hypothesis_chars),
        len(reference_chars),
    )


def error_rates(reference: str, hypothesis: str) -> tuple[float, float]:
    word_errors, word_units, char_errors, char_units = error_counts(reference, hypothesis)
    return word_errors / max(1, word_units), char_errors / max(1, char_units)


def read_wav_frames(path: Path) -> tuple[list[bytes], float]:
    with wave.open(str(path), "rb") as source:
        if (
            source.getnchannels() != 1
            or source.getframerate() != SAMPLE_RATE
            or source.getsampwidth() != 2
        ):
            raise ValueError(f"{path}: expected mono 16 kHz PCM16 WAV")
        raw = source.readframes(source.getnframes())
        duration = source.getnframes() / source.getframerate()
    frames = [raw[offset : offset + FRAME_BYTES] for offset in range(0, len(raw), FRAME_BYTES)]
    if frames and len(frames[-1]) < FRAME_BYTES:
        frames[-1] += b"\0" * (FRAME_BYTES - len(frames[-1]))
    return frames, duration


def _endpointer_config(config: dict[str, Any]) -> EndpointerConfig:
    vad = config["vad"]
    return EndpointerConfig(
        frame_ms=int(vad["frameMs"]),
        speech_threshold_rms=int(vad["speechThresholdRms"]),
        speech_start_frames=int(vad["speechStartFrames"]),
        speech_end_frames=int(vad["speechEndFrames"]),
    )


def _terminal_frames(
    frames: list[bytes], config: EndpointerConfig, frames_per_chunk: int
) -> list[bytes]:
    preview = DeterministicEndpointer(config)
    for frame in frames:
        preview.accept(frame)
    result = list(frames)
    silence = b"\0" * FRAME_BYTES
    if preview.in_speech:
        while preview.in_speech:
            result.append(silence)
            preview.accept(silence)
    while len(result) % frames_per_chunk:
        result.append(silence)
    return result


@dataclass
class PaceEvidence:
    expected_frames: int = 0
    consumed_frames: int = 0
    expected_chunks: int = 0
    consumed_chunks: int = 0
    deadline_overruns: int = 0
    dropped_frames: int = 0
    wait_seconds: float = 0.0
    consumer_wait_seconds: float = 0.0
    deadline_lateness_ms: list[float] = field(default_factory=list)
    speech_start: float | None = None
    speech_end: float | None = None


class PacedChunks:
    """Independent 20 ms capture producer feeding a bounded chunk queue."""

    def __init__(
        self,
        frames: list[bytes],
        chunk_ms: int,
        vad_config: EndpointerConfig,
        cancel: CancelToken,
        clock: Callable[[], float] = time.perf_counter,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.frames_per_chunk = chunk_ms // FRAME_MS
        self.frames = _terminal_frames(frames, vad_config, self.frames_per_chunk)
        self.cancel = cancel
        self.clock = clock
        self.sleep = sleep
        self.vad = DeterministicEndpointer(vad_config)
        self.started = clock()
        self.evidence = PaceEvidence(
            expected_frames=len(self.frames),
            expected_chunks=len(self.frames) // self.frames_per_chunk,
        )
        self._queue: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=8)
        self._producer: threading.Thread | None = None
        self._stop = threading.Event()

    def _wait_until(self, deadline: float) -> None:
        while True:
            if self._stop.is_set():
                raise RuntimeError("paced capture stopped")
            self.cancel.raise_if_cancelled()
            remaining = deadline - self.clock()
            if remaining <= 0:
                lateness_ms = max(0.0, -remaining * 1000)
                self.evidence.deadline_lateness_ms.append(lateness_ms)
                if lateness_ms > 5.0:
                    self.evidence.deadline_overruns += 1
                return
            amount = min(remaining, 0.01)
            before = self.clock()
            self.sleep(amount)
            self.evidence.wait_seconds += max(0.0, self.clock() - before)

    def _signal(self, value: BaseException | None) -> None:
        while not self._stop.is_set():
            try:
                self._queue.put(value, timeout=0.05)
                return
            except queue.Full:
                continue

    def _capture(self) -> None:
        chunk = bytearray()
        try:
            for index, frame in enumerate(self.frames, start=1):
                self._wait_until(self.started + index * FRAME_MS / 1000)
                transition = self.vad.accept(frame)
                now = self.clock()
                if transition == "speech_start":
                    self.evidence.speech_start = now
                elif transition == "speech_end":
                    self.evidence.speech_end = now
                self.evidence.consumed_frames += 1
                chunk.extend(frame)
                if index % self.frames_per_chunk == 0:
                    try:
                        self._queue.put_nowait(bytes(chunk))
                        self.evidence.consumed_chunks += 1
                    except queue.Full:
                        self.evidence.dropped_frames += self.frames_per_chunk
                    chunk.clear()
        except BaseException as error:
            self._signal(error)
        finally:
            self._signal(None)

    def __iter__(self) -> Iterator[bytes]:
        if self._producer is not None:
            raise RuntimeError("paced capture stream is single-use")
        self._producer = threading.Thread(
            target=self._capture, name="paced-audio-capture", daemon=True
        )
        self._producer.start()
        try:
            while True:
                self.cancel.raise_if_cancelled()
                before_wait = self.clock()
                try:
                    value = self._queue.get(timeout=0.05)
                except queue.Empty:
                    self.evidence.consumer_wait_seconds += max(0.0, self.clock() - before_wait)
                    continue
                self.evidence.consumer_wait_seconds += max(0.0, self.clock() - before_wait)
                if value is None:
                    break
                if isinstance(value, BaseException):
                    raise value
                yield value
        finally:
            self._stop.set()
            while True:
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    break
            self._producer.join(timeout=1)
            if self._producer.is_alive():
                raise RuntimeError("paced capture producer did not stop")


def _process_vram() -> tuple[int | None, int | None]:
    try:
        import torch

        if not torch.cuda.is_available():
            return None, None
        return int(torch.cuda.max_memory_allocated()), int(torch.cuda.memory_allocated())
    except ImportError:
        return None, None


def _worker_count(candidate: str | None = None) -> int:
    names = {"nemotron": "nemotron-stream", "parakeet": "parakeet-stream"}
    expected = {names[candidate]} if candidate in names else set(names.values())
    return sum(thread.name in expected and thread.is_alive() for thread in threading.enumerate())


def _micro_rates(
    items: list[dict[str, Any]], references: dict[str, str]
) -> tuple[float | None, float | None]:
    word_errors = word_units = char_errors = char_units = 0
    for item in items:
        if item["status"] != "passed" or item["sourceId"] not in references:
            continue
        counts = error_counts(references[item["sourceId"]], item["transcript"])
        word_errors += counts[0]
        word_units += counts[1]
        char_errors += counts[2]
        char_units += counts[3]
    return (
        word_errors / word_units if word_units else None,
        char_errors / char_units if char_units else None,
    )


def _verified_model_path(config: dict[str, Any], model_entry: dict[str, Any]) -> Path:
    configured = (ROOT / str(config.get("modelPath", ""))).resolve()
    verified = (ROOT / str(model_entry.get("runtimePath", model_entry.get("path", "")))).resolve()
    if ROOT.resolve() not in configured.parents or configured != verified:
        raise ValueError("config modelPath does not match verified model manifest path")
    return verified


def compare_stt_runs(run_dirs: list[Path]) -> dict[str, Any]:
    if len(run_dirs) < 2:
        raise ValueError("compare requires at least two STT runs")
    loaded: list[tuple[Path, dict[str, Any], dict[str, Any]]] = []
    for path in run_dirs:
        resolved = path.resolve()
        validate_run(resolved)
        run = json.loads((resolved / "run.json").read_text())
        summary = json.loads((resolved / "summary.json").read_text())
        if run.get("kind") != "stt":
            raise ValueError(f"{resolved}: compare supports STT runs only")
        semantics = run.get("comparisonSemantics")
        if not isinstance(semantics, dict):
            raise ValueError(
                f"{resolved}: run predates explicit comparison semantics; rerun required"
            )
        loaded.append((resolved, run, summary))
    baseline = loaded[0][1]["comparisonSemantics"]
    for path, run, _ in loaded[1:]:
        actual = run["comparisonSemantics"]
        differing = sorted(
            key for key in set(baseline) | set(actual) if baseline.get(key) != actual.get(key)
        )
        if differing:
            detail = ", ".join(
                f"{key}={baseline.get(key)!r} vs {actual.get(key)!r}" for key in differing
            )
            raise ValueError(f"unmatched comparison semantics for {path}: {detail}")
        if run.get("comparisonSemanticsSha256") != loaded[0][1].get("comparisonSemanticsSha256"):
            raise ValueError(f"{path}: comparison semantics hash mismatch")
    rows = []
    for path, run, summary in loaded:
        model = run["models"][0]
        rows.append(
            {
                "runDir": str(path),
                "runId": run["runId"],
                "candidateId": model["id"],
                "configId": run["configId"],
                "modelRevision": model["revision"],
                "precision": model["precision"],
                "wer": summary.get("wer"),
                "cer": summary.get("cer"),
                "speechStartToFirstPartialMs": summary.get("speechStartToFirstPartialMs"),
                "endpointToFinalMs": summary.get("endpointToFinalMs"),
                "rtf": summary.get("rtf"),
                "partialRevisionCount": summary.get("partialRevisionCount"),
                "partialChurnCharacters": summary.get("partialChurnCharacters"),
                "peakVramBytes": summary.get("peakVramBytes"),
                "steadyVramBytes": summary.get("steadyVramBytes"),
                "failures": summary.get("failures", []),
                "droppedFrames": summary.get("droppedFrames"),
                "underruns": summary.get("underruns"),
                "soak": summary.get("soak"),
            }
        )
    return {
        "kind": "stt-comparison-v1",
        "comparisonSemantics": baseline,
        "comparisonSemanticsSha256": loaded[0][1]["comparisonSemanticsSha256"],
        "runs": rows,
    }


def run_stt(
    candidate: str,
    dataset_path: Path,
    output_root: Path | None = None,
    command: list[str] | None = None,
    soak_minutes: float = 0,
    adapter_factory: Callable[[], Any] | None = None,
    config_path: Path | None = None,
) -> Path:
    if candidate not in {"nemotron", "parakeet"}:
        raise ValueError("unsupported STT candidate")
    config_path = (config_path or ROOT / "services/audio/config/nemotron-320ms.yaml").resolve()
    try:
        config_path.relative_to(ROOT / "benchmarks/configs/stt")
    except ValueError:
        try:
            config_path.relative_to(ROOT / "services/audio/config")
        except ValueError as error:
            raise ValueError("STT config must be tracked under benchmarks/configs/stt or services/audio/config") from error
    config = load_yaml_subset(config_path)
    if config.get("candidate", {}).get("id") != candidate:
        raise ValueError("candidate/config mismatch")
    partial_contract = str(config.get("partialContract", ""))
    if (
        config.get("timingMode") != "realtime-paced-20ms-v1"
        or partial_contract not in SUPPORTED_PARTIAL_CONTRACTS
    ):
        raise ValueError("STT requires paced timing and a supported cumulative partial contract")
    dataset_path = dataset_path.resolve()
    dataset, dataset_hash = verify_dataset(dataset_path, ROOT)
    model_entries = verify_models(
        ROOT / "services/audio/config/model-manifest.json",
        ROOT,
        model_ids={config["candidate"]["modelId"]},
    )
    matches = [entry for entry in model_entries if entry["id"] == config["candidate"]["modelId"]]
    if len(matches) != 1:
        raise ValueError("model manifest/config identity mismatch")
    model_entry = matches[0]
    if (
        model_entry["revision"] != config["candidate"]["revision"]
        or model_entry["sha256"] != config["candidate"]["sha256"]
    ):
        raise ValueError("model manifest/config revision or hash mismatch")
    verified_model_path = _verified_model_path(config, model_entry)
    config["modelPath"] = str(verified_model_path)
    if adapter_factory is None:
        adapter_factory = (
            NemotronStreamingAdapter if candidate == "nemotron" else ParakeetStreamingAdapter
        )
    source_state_id, dirty = source_state(ROOT)
    run_id = str(uuid.uuid4())
    stamp = utc_now().replace(":", "").replace(".", "")
    run_dir = (
        output_root or ROOT / "benchmarks/results"
    ) / f"{stamp}-{source_state_id[:12]}-{run_id[:8]}"
    run_dir.mkdir(parents=True)
    gpu = sample_gpu()
    gpu_metadata = {"name": gpu.name, "driver": gpu.driver, "cuda": gpu.cuda}
    benchmark_items = dataset["items"] if soak_minutes <= 0 else dataset["items"][:1]
    expected = [
        {"sourceId": str(item["sourceId"]), "candidateId": candidate, "attempt": 1}
        for item in benchmark_items
    ]
    comparison = {
        "kind": "stt",
        "chunkMs": config["chunkMs"],
        "captureChunkMs": config.get("captureChunkMs", config["chunkMs"]),
        "leftContextMs": config.get("leftContextMs", 0),
        "rightContextMs": config.get("rightContextMs", 0),
        "algorithmicLatencyMs": config.get("algorithmicLatencyMs", config["chunkMs"]),
        "precision": config["candidate"]["precision"],
        "language": config["language"],
        "normalizationVersion": config["normalizationVersion"],
        "partialContract": partial_contract,
        "timingMode": config["timingMode"],
        "vad": config["vad"],
        "datasetSha256": dataset_hash,
    }
    run = {
        "schemaVersion": 1,
        "runId": run_id,
        "kind": "stt",
        "startedAt": utc_now(),
        "endedAt": None,
        "sourceId": source_state_id,
        "dirty": dirty,
        "machine": machine_metadata(gpu_metadata),
        "runtimes": runtime_metadata(gpu_metadata),
        "models": [
            {
                "id": candidate,
                "revision": model_entry["revision"],
                "sha256": model_entry["sha256"],
                "runtime": config["candidate"]["runtime"],
                "precision": config["candidate"]["precision"],
            }
        ],
        "configId": config["id"],
        "configSha256": sha256_file(config_path),
        "comparisonSemantics": comparison,
        "comparisonSemanticsSha256": sha256_bytes(canonical_json(comparison)),
        "datasetId": dataset["id"],
        "datasetSha256": dataset_hash,
        "seed": config["seed"],
        "command": command
        or [
            "uv",
            "run",
            "python",
            "-m",
            "benchmarks.harness",
            "run",
            "--kind",
            "stt",
            "--candidate",
            candidate,
            "--config",
            str(config_path.relative_to(ROOT)),
            "--dataset",
            str(dataset_path.relative_to(ROOT)),
        ],
        "environment": environment_metadata(),
        "warmups": config["warmups"],
        "repetitions": 1,
        "expectedItems": expected,
        "randomization": {"method": "single-candidate-v1", "blind": True, "revealLocked": True},
        "status": "running",
    }
    mapping = blind_mapping([candidate], int(config["seed"]))
    label = next(iter(mapping))
    _initialize_artifacts(run_dir, run, mapping)
    items_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    run_failures: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    sequence = 0
    run_started = time.perf_counter()
    references = {str(item["sourceId"]): str(item["reference"]) for item in dataset["items"]}
    vad_config = _endpointer_config(config)
    adapter: Any | None = None
    primary_stage: str | None = None
    soak = {
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
    soak_lateness_ms: list[float] = []

    def fail_expected(source: str, stage: str, error: BaseException) -> None:
        nonlocal sequence
        key = (source, 1)
        if key in items_by_key:
            return
        code = f"{stage}_failure"
        item = _failure_item(
            candidate,
            config["id"],
            source,
            label,
            1,
            stage,
            code,
            f"{stage} failed: {type(error).__name__}",
        )
        item["normalizationVersion"] = NORMALIZATION_VERSION
        items_by_key[key] = item
        events.append(
            _event(
                sequence,
                (time.perf_counter() - run_started) * 1000,
                "failure",
                {
                    "sourceId": source,
                    "candidateId": candidate,
                    "attempt": 1,
                    "stage": stage,
                    "failureCode": code,
                },
            )
        )
        sequence += 1

    def fill_missing(stage: str, error: BaseException) -> None:
        for entry in expected:
            fail_expected(entry["sourceId"], stage, error)

    def run_failure(stage: str, error: BaseException) -> None:
        nonlocal sequence
        source = f"__run__:{stage}:{len(run_failures) + 1}"
        item = _failure_item(
            candidate,
            config["id"],
            source,
            label,
            1,
            stage,
            f"{stage}_failure",
            f"{stage} failed: {type(error).__name__}",
        )
        item["normalizationVersion"] = NORMALIZATION_VERSION
        run_failures.append(item)
        events.append(
            _event(
                sequence,
                (time.perf_counter() - run_started) * 1000,
                "failure",
                {
                    "sourceId": source,
                    "candidateId": candidate,
                    "attempt": 1,
                    "stage": stage,
                    "failureCode": f"{stage}_failure",
                },
            )
        )
        sequence += 1

    try:
        try:
            adapter = adapter_factory()
        except Exception as error:
            primary_stage = "construct"
            fill_missing(primary_stage, error)
        if adapter is not None and primary_stage is None:
            try:
                adapter.prepare(config)
            except Exception as error:
                primary_stage = "prepare"
                fill_missing(primary_stage, error)
        if adapter is not None and primary_stage is None and config["warmups"]:
            try:
                frames, _ = read_wav_frames(ROOT / dataset["items"][0]["path"])
                frames_per_chunk = int(config.get("captureChunkMs", config["chunkMs"])) // FRAME_MS
                warmup_frames = _terminal_frames(frames, vad_config, frames_per_chunk)
                chunks = [
                    b"".join(warmup_frames[i : i + frames_per_chunk])
                    for i in range(0, len(warmup_frames), frames_per_chunk)
                ]
                adapter.reset()
                adapter.transcribe(chunks, CancelToken())
            except Exception as error:
                primary_stage = "warmup"
                fill_missing(primary_stage, error)
        if adapter is not None and primary_stage is None:
            for dataset_item in benchmark_items:
                source = str(dataset_item["sourceId"])
                context = {"sourceId": source, "candidateId": candidate, "attempt": 1}
                try:
                    adapter.reset()
                except Exception as error:
                    primary_stage = "reset"
                    fail_expected(source, primary_stage, error)
                    fill_missing(primary_stage, error)
                    break
                frames, original_audio_seconds = read_wav_frames(ROOT / dataset_item["path"])
                token = CancelToken()
                pacer = PacedChunks(
                    frames,
                    int(config.get("captureChunkMs", config["chunkMs"])),
                    vad_config,
                    token,
                )
                item_start = pacer.started
                updates = []
                events.append(
                    _event(
                        sequence,
                        0.0 if not events else (item_start - run_started) * 1000,
                        "audio_received",
                        context,
                    )
                )
                sequence += 1
                try:
                    import torch

                    torch.cuda.reset_peak_memory_stats()
                except (ImportError, RuntimeError):
                    pass
                try:
                    result = adapter.transcribe_stream(pacer, token, updates.append)
                    final_at = time.perf_counter()
                    if pacer.evidence.speech_start is None or pacer.evidence.speech_end is None:
                        raise RuntimeError("deterministic endpointer did not produce start and end")
                    for update in updates:
                        events.append(
                            _event(
                                sequence,
                                (item_start - run_started) * 1000 + update.monotonic_ms,
                                "partial",
                                {**context, "text": update.text},
                            )
                        )
                        sequence += 1
                    events.append(
                        _event(
                            sequence,
                            (pacer.evidence.speech_start - run_started) * 1000,
                            "speech_start",
                            context,
                        )
                    )
                    sequence += 1
                    events.append(
                        _event(
                            sequence,
                            (pacer.evidence.speech_end - run_started) * 1000,
                            "endpoint",
                            context,
                        )
                    )
                    sequence += 1
                    events.append(
                        _event(
                            sequence,
                            (final_at - run_started) * 1000,
                            "final",
                            {**context, "text": result.text},
                        )
                    )
                    sequence += 1
                    peak, steady = _process_vram()
                    if peak is not None:
                        events.append(
                            _event(
                                sequence,
                                (final_at - run_started) * 1000,
                                "vram_sample",
                                {**context, "vramBytes": peak},
                            )
                        )
                        sequence += 1
                    wer, cer = error_rates(references[source], result.text)
                    first_partial_at = (
                        item_start + updates[0].monotonic_ms / 1000 if updates else final_at
                    )
                    compute_seconds = max(
                        0.0,
                        result.processing_seconds - pacer.evidence.consumer_wait_seconds,
                    )
                    metrics = {
                        "speechStartToFirstPartialMs": max(
                            0.0, (first_partial_at - pacer.evidence.speech_start) * 1000
                        ),
                        "endpointToFinalMs": max(
                            0.0, (final_at - pacer.evidence.speech_end) * 1000
                        ),
                        "ttsTimeToFirstAudioMs": None,
                        "rtf": compute_seconds / max(original_audio_seconds, 0.001),
                        "wer": wer,
                        "cer": cer,
                        "partialRevisionCount": sum(
                            update.replaced_characters > 0 for update in updates
                        ),
                        "partialChurnCharacters": sum(
                            update.replaced_characters for update in updates
                        ),
                        "underruns": 0,
                        "droppedFrames": pacer.evidence.dropped_frames,
                        "peakVramBytes": peak,
                        "steadyVramBytes": steady,
                    }
                    item = {
                        "candidateId": candidate,
                        "configId": config["id"],
                        "sourceId": source,
                        "blindLabel": label,
                        "attempt": 1,
                        "status": "passed",
                        "failure": None,
                        "transcript": result.text,
                        "audioPath": None,
                        "normalizationVersion": NORMALIZATION_VERSION,
                        "revisionTrace": [
                            {
                                "sequence": update.sequence,
                                "monotonicMs": update.monotonic_ms,
                                "text": update.text,
                                "replacedCharacters": update.replaced_characters,
                            }
                            for update in updates
                        ],
                        "metrics": metrics,
                    }
                except Exception as error:
                    fail_expected(source, "transcribe", error)
                    if adapter.backend is not None and bool(
                        getattr(adapter.backend, "_poisoned", False)
                        or getattr(adapter.backend, "poisoned", False)
                    ):
                        primary_stage = "transcribe"
                        fill_missing(primary_stage, error)
                        break
                    continue
                items_by_key[(source, 1)] = item
    finally:
        if adapter is not None:
            try:
                adapter.close()
            except Exception as error:
                run_failure("close", error)
                if primary_stage is None:
                    primary_stage = "close"
                    fill_missing(primary_stage, error)

    if adapter is not None and primary_stage is None and soak_minutes > 0:
        # A fresh instance avoids measuring post-close state and makes soak lifecycle explicit.
        soak_adapter: Any | None = None
        soak_started: float | None = None
        iteration = 0
        try:
            soak_adapter = adapter_factory()
            soak_adapter.prepare(config)
            soak_started = time.perf_counter()
            events.append(
                _event(
                    sequence,
                    (soak_started - run_started) * 1000,
                    "soak_started",
                    {"reason": f"paced-20ms;requested_minutes={soak_minutes}"},
                )
            )
            sequence += 1
            while time.perf_counter() - soak_started < soak_minutes * 60:
                dataset_item = dataset["items"][iteration % len(dataset["items"])]
                frames, _ = read_wav_frames(ROOT / dataset_item["path"])
                token = CancelToken()
                pacer = PacedChunks(
                    frames,
                    int(config.get("captureChunkMs", config["chunkMs"])),
                    vad_config,
                    token,
                )
                before_generation = soak_adapter.generation
                soak_adapter.reset()
                soak["resetCount"] += 1
                if soak_adapter.generation != before_generation + 1:
                    raise RuntimeError("reset generation did not advance exactly once")
                result = soak_adapter.transcribe_stream(pacer, token)
                worker_leaks = _worker_count(candidate)
                if not result.text or worker_leaks:
                    soak["workerLeaks"] += worker_leaks
                    raise RuntimeError("soak output isolation or worker cleanup failed")
                events.append(
                    _event(
                        sequence,
                        (time.perf_counter() - run_started) * 1000,
                        "soak_iteration",
                        {
                            "iteration": iteration + 1,
                            "expectedFrames": pacer.evidence.expected_frames,
                            "consumedFrames": pacer.evidence.consumed_frames,
                            "expectedChunks": pacer.evidence.expected_chunks,
                            "consumedChunks": pacer.evidence.consumed_chunks,
                            "deadlineOverruns": pacer.evidence.deadline_overruns,
                            "droppedFrames": pacer.evidence.dropped_frames,
                            "workerLeaks": worker_leaks,
                            "resetCount": 1,
                            "deadlineLatenessMs": pacer.evidence.deadline_lateness_ms,
                        },
                    )
                )
                sequence += 1
                soak["expectedFrames"] += pacer.evidence.expected_frames
                soak["consumedFrames"] += pacer.evidence.consumed_frames
                soak["expectedChunks"] += pacer.evidence.expected_chunks
                soak["consumedChunks"] += pacer.evidence.consumed_chunks
                soak["deadlineOverruns"] += pacer.evidence.deadline_overruns
                soak_lateness_ms.extend(pacer.evidence.deadline_lateness_ms)
                soak["droppedFrames"] += pacer.evidence.dropped_frames
                iteration += 1
        except Exception as error:
            soak["passed"] = False
            soak["severeFailures"] += 1
            run_failure("soak", error)
        finally:
            if soak_adapter is not None:
                try:
                    soak_adapter.close()
                except Exception as error:
                    soak["passed"] = False
                    soak["severeFailures"] += 1
                    run_failure("close", error)
            soak["workerLeaks"] += _worker_count(candidate)
            soak["droppedFrames"] += max(0, soak["expectedFrames"] - soak["consumedFrames"])
            soak["underruns"] = max(0, soak["expectedChunks"] - soak["consumedChunks"])
            soak["durationSeconds"] = (
                time.perf_counter() - soak_started if soak_started is not None else 0.0
            )
            if soak_lateness_ms:
                soak["deadlineLatenessP95Ms"] = percentile(soak_lateness_ms, 0.95)
                soak["deadlineLatenessMaxMs"] = max(soak_lateness_ms)
            soak["timingConformance"] = bool(
                soak["deadlineLatenessP95Ms"] <= SOAK_P95_DEADLINE_MS
                and soak["deadlineLatenessMaxMs"] <= SOAK_MAX_DEADLINE_MS
            )
            soak["passed"] = bool(
                soak["passed"]
                and not soak["droppedFrames"]
                and not soak["underruns"]
                and not soak["workerLeaks"]
                and soak["timingConformance"]
                and soak["durationSeconds"] >= soak_minutes * 60
            )
            events.append(
                _event(
                    sequence,
                    (time.perf_counter() - run_started) * 1000,
                    "soak_completed",
                    {
                        "reason": f"paced=true;rawIterations={iteration};passed={soak['passed']}",
                        "workerLeaks": soak["workerLeaks"],
                        "severeFailures": soak["severeFailures"],
                    },
                )
            )
            sequence += 1

    fill_missing(primary_stage or "finalize", RuntimeError("item was not executed"))
    items = [items_by_key[(entry["sourceId"], 1)] for entry in expected] + run_failures
    run["endedAt"] = utc_now()
    run["status"] = (
        "passed"
        if all(item["status"] == "passed" for item in items) and soak["passed"]
        else "failed"
    )
    events.sort(key=lambda event: (event["monotonicMs"], event["sequence"]))
    for index, event in enumerate(events):
        event["sequence"] = index
    summary = _summary(items)
    summary["wer"], summary["cer"] = _micro_rates(items, references)
    summary["soak"] = soak
    try:
        _write_jsonl(run_dir / "items.jsonl", items)
        _write_jsonl(run_dir / "events.jsonl", events)
        _write_json(run_dir / "summary.json", summary)
        _write_json(run_dir / "run.json", run)
        (run_dir / "ratings.jsonl").write_text("")
        streaming_description = (
            "Native Transformers cache-aware streaming with non-overlapping capture chunks"
            if candidate == "nemotron"
            else "Official NeMo stateful buffered RNNT: left context is recomputed and decoder state is retained"
        )
        (run_dir / "README.md").write_text(
            f"# {candidate} STT benchmark\n\nRerun: `{' '.join(run['command'])}`\n\n"
            f"Validate: `uv run python -m benchmarks.harness validate {run_dir}`\n\n"
            f"Config: `{config_path.relative_to(ROOT)}` (`{config['id']}`). {streaming_description}. "
            f"en-US, {config.get('captureChunkMs', config['chunkMs'])} ms capture packets, "
            f"{config['chunkMs']} ms model chunks, {config.get('leftContextMs', 0)} ms left context, "
            f"{config.get('rightContextMs', 0)} ms right context, float32. Audio capture is paced in 20 ms "
            "frames against monotonic wall time. Deterministic RMS VAD emits speech start/end; only required "
            "terminal silence and chunk-alignment silence are appended. RTF subtracts only measured adapter-side "
            "blocking on the paced capture queue; producer sleep that overlaps inference is retained. "
            "latency uses actual speech-start/endpoint/final transitions. Summary WER/CER are corpus micro rates. "
            + (
                "This soak artifact uses one measured preflight item before the declared full-corpus rotation.\n"
                if soak_minutes > 0
                else "\n"
            )
        )
        validate_run(run_dir)
    except Exception as error:
        # Preserve terminal artifacts and a sanitized finalization record where filesystem writes succeeded.
        run["status"] = "failed"
        run["endedAt"] = utc_now()
        run_failure("finalize", error)
        _write_json(run_dir / "run.json", run)
        raise
    return run_dir
