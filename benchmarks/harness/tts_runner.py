from __future__ import annotations

import json
import queue
import threading
import time
import uuid
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from benchmarks.harness.adapter import CancelToken, Cancelled
from services.audio.src.tts.kokoro import KokoroStreamingAdapter
from services.audio.src.tts.qwen3 import Qwen3StreamingAdapter, SPEAKER as QWEN_VOICE

from .checksums import verify_dataset, verify_models
from .nvml import sample_gpu
from .randomization import blind_mapping
from .runner import (
    ROOT,
    _empty_metrics,
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
    deterministic_source_manifest,
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

TTS_NORMALIZATION_VERSION = "tts-exact-text-v1"
TTS_ADAPTER_FACTORIES: dict[str, Callable[[], Any]] = {
    "kokoro": KokoroStreamingAdapter,
    "qwen3-0.6b": Qwen3StreamingAdapter,
}
TTS_WORKER_PREFIXES = (
    "kokoro-inference",
    "kokoro-output",
    "kokoro-runtime-executor",
    "qwen-inference",
    "qwen-output",
    "qwen-runtime-executor",
    "kokoro-playback",
    "tts-rss-sampler",
)
TTS_SHARED_CONTRACT = {
    "schemaVersion": 1,
    "kind": "tts",
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
    "maxTextCharacters": 4_000,
    "promptManifestId": "tts-prompts-v1",
    "seed": 240808,
    "warmups": 1,
    "repetitions": 1,
}
QWEN_TOP_LEVEL_CONTRACT = {
    "language": "English",
    "device": "cuda",
    "dtype": "bfloat16",
    "attnImplementation": "eager",
    "backend": "torch-cuda-graph",
    "chunkSizeCodecSteps": 8,
    "maxNewTokens": 2_048,
    "minNewTokens": 2,
    "temperature": 0.9,
    "topK": 50,
    "topP": 1.0,
    "doSample": True,
    "repetitionPenalty": 1.05,
}
PLAYBACK_BUFFER_MS = 100


def _rss_bytes() -> int:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


@dataclass
class RssSampler:
    peak: int = 0
    _stop: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None

    def start(self) -> None:
        def sample() -> None:
            while not self._stop.wait(0.01):
                self.peak = max(self.peak, _rss_bytes())

        self.peak = _rss_bytes()
        self._thread = threading.Thread(target=sample, name="tts-rss-sampler", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
            if self._thread.is_alive():
                raise RuntimeError("TTS RSS sampler did not stop")
        self.peak = max(self.peak, _rss_bytes())


@dataclass
class VramTracker:
    """Track process-attributed CUDA allocator peaks, never ambient device use."""

    enabled: bool
    peak: int | None = None
    current: int | None = None
    reason: str | None = None
    _torch: Any = None

    @classmethod
    def for_config(cls, config: dict[str, Any]) -> "VramTracker":
        candidate = config.get("candidate")
        provider = candidate.get("provider") if isinstance(candidate, dict) else None
        # Qwen exposes PyTorch allocator counters. Kokoro's CUDA path uses the
        # ONNX Runtime CUDA allocator, which is not process-attributed here, so
        # report VRAM as unmeasured rather than fabricating zero.
        return cls(provider == "CUDA")

    def start(self) -> None:
        if not self.enabled:
            return
        try:
            import torch

            if not torch.cuda.is_available():
                self.reason = "CUDA unavailable"
                self.enabled = False
                return
            self._torch = torch
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
        except BaseException as error:
            self.reason = f"CUDA allocator unavailable: {type(error).__name__}"
            self.enabled = False
            self._torch = None

    def close(self) -> None:
        if not self.enabled or self._torch is None:
            return
        try:
            self._torch.cuda.synchronize()
            self.peak = int(self._torch.cuda.max_memory_reserved())
            self.current = int(self._torch.cuda.memory_reserved())
        except BaseException as error:
            self.reason = f"CUDA allocator sampling failed: {type(error).__name__}"
            self.peak = None
            self.current = None


def _worker_names() -> list[str]:
    return sorted(
        thread.name
        for thread in threading.enumerate()
        if thread.is_alive()
        and any(thread.name.startswith(prefix) for prefix in TTS_WORKER_PREFIXES)
    )


def _verified_tts_config(
    candidate: str, config_path: Path, prompts_path: Path
) -> tuple[dict[str, Any], dict[str, Any], str, dict[str, Any]]:
    if candidate not in TTS_ADAPTER_FACTORIES:
        raise ValueError("unsupported TTS candidate")
    config_path = config_path.resolve()
    prompts_path = prompts_path.resolve()
    configs_root = (ROOT / "benchmarks/configs/tts").resolve()
    datasets_root = (ROOT / "benchmarks/datasets").resolve()
    if configs_root not in config_path.parents:
        raise ValueError("TTS config must be tracked under benchmarks/configs/tts")
    if datasets_root not in prompts_path.parents:
        raise ValueError("TTS prompts must be tracked under benchmarks/datasets")
    config = load_yaml_subset(config_path)
    candidate_config = config.get("candidate")
    if not isinstance(candidate_config, dict) or candidate_config.get("id") != candidate:
        raise ValueError("candidate/config mismatch")
    for key, expected in TTS_SHARED_CONTRACT.items():
        if config.get(key) != expected:
            raise ValueError(f"TTS config {key} does not match the pinned shared contract")

    prompts, prompts_hash = verify_dataset(prompts_path, ROOT)
    prompt_language = prompts.get("language")
    model_language = config.get("language")
    expected_model_language = "en-us" if candidate == "kokoro" else "English"
    # Qwen's generator names the same English input language "English", while
    # the shared prompt manifest uses the locale label "en-us". Keep the model
    # API language candidate-specific, but compare the exact manifest locale.
    language_matches = prompt_language == model_language or (
        candidate == "qwen3-0.6b" and prompt_language == "en-us" and model_language == "English"
    )
    if (
        prompts.get("kind") != "tts-prompts"
        or model_language != expected_model_language
        or not language_matches
        or prompts.get("id") != config.get("promptManifestId")
        or len(prompts.get("items", [])) < 20
    ):
        raise ValueError("TTS prompt manifest contract mismatch or fewer than 20 prompts")
    if candidate == "qwen3-0.6b":
        for key, expected in QWEN_TOP_LEVEL_CONTRACT.items():
            if config.get(key) != expected:
                raise ValueError(f"Qwen config {key} does not match the pinned contract")
    categories = {item["category"] for item in prompts["items"]}
    required_categories = {
        "short-acknowledgement",
        "podcast-response",
        "names",
        "numbers",
        "dates",
        "abbreviations",
        "punctuation",
        "question",
        "emphasis",
        "difficult-phonemes",
    }
    if not required_categories.issubset(categories):
        raise ValueError("TTS prompt manifest lacks required coverage categories")

    models = verify_models(
        ROOT / "docs/model-manifest.json",
        ROOT,
        model_ids={candidate_config.get("modelId")},
    )
    matches = [entry for entry in models if entry.get("id") == candidate_config.get("modelId")]
    if len(matches) != 1:
        raise ValueError("TTS model manifest/config identity mismatch")
    model = matches[0]

    if candidate == "kokoro":
        provider = candidate_config.get("provider")
        if provider == "CPUExecutionProvider":
            runtime = model.get("cpuRuntime")
            expected_provider = model.get("cpuProvider")
            precision = model.get("cpuPrecision")
        elif provider == "CUDAExecutionProvider":
            runtime = model.get("runtime")
            expected_provider = model.get("provider")
            precision = model.get("precision")
        else:
            raise ValueError("unsupported Kokoro execution provider")
        model_pairs = {
            "revision": model.get("revision"),
            "onnxReleaseRevision": model.get("onnxReleaseRevision"),
            "runtimeRevision": model.get("runtimeRevision"),
            "runtime": runtime,
            "modelSha256": model.get("sha256"),
            "voice": model.get("voice"),
            "provider": expected_provider,
            "precision": precision,
        }
        voices_path_value = model.get("voicesPath")
        voices_file = next(
            (entry for entry in model.get("files", []) if entry.get("path") == voices_path_value),
            None,
        )
        model_pairs["voicesSha256"] = voices_file.get("sha256") if voices_file else None
        expected_model_path_value = model.get("path")
    else:
        # Qwen's manifest records the official runtime as ``runtime`` and the
        # exercised streaming wrapper as ``streamingRuntime``. The benchmark
        # candidate must bind to the latter, including its source revision and
        # lockfile, rather than silently measuring the buffered official API.
        model_pairs = {
            "revision": model.get("revision"),
            "runtime": model.get("streamingRuntime"),
            "runtimeRevision": model.get("streamingRuntimeRevision"),
            "fasterRuntimeRevision": model.get("streamingRuntimeRevision"),
            "fasterVersion": model.get("streamingRuntimeVersion"),
            "runtimeLock": model.get("runtimeLock"),
            "runtimeLockSha256": model.get("runtimeLockSha256"),
            "officialRuntime": model.get("runtime"),
            "modelSha256": model.get("sha256"),
            "voice": QWEN_VOICE,
            "provider": model.get("provider"),
            "device": model.get("device"),
            "precision": model.get("precision"),
            "backend": model.get("streamingBackend"),
        }
        expected_model_path_value = model.get("runtimePath")

    for key, expected in model_pairs.items():
        if expected is None or candidate_config.get(key) != expected:
            raise ValueError(f"TTS model/config {key} mismatch")

    expected_model_path = (ROOT / str(expected_model_path_value)).resolve()
    configured_model_path = (ROOT / str(config.get("modelPath", ""))).resolve()
    if configured_model_path != expected_model_path:
        raise ValueError("TTS configured model path does not match verified manifest path")
    if candidate == "qwen3-0.6b" and not expected_model_path.is_dir():
        raise ValueError("TTS configured Qwen model directory is missing")

    config["modelPath"] = str(expected_model_path)
    if candidate == "kokoro":
        expected_voices_path = (ROOT / str(model.get("voicesPath"))).resolve()
        configured_voices_path = (ROOT / str(config.get("voicesPath", ""))).resolve()
        if configured_voices_path != expected_voices_path:
            raise ValueError("TTS configured voices path does not match verified manifest path")
        config["voicesPath"] = str(expected_voices_path)
    return config, prompts, prompts_hash, model


def _comparison_semantics(
    config: dict[str, Any], prompts_hash: str, prompt_language: str | None = None
) -> dict[str, Any]:
    return {
        "kind": "tts",
        "promptManifestId": config["promptManifestId"],
        "promptManifestSha256": prompts_hash,
        "language": prompt_language if prompt_language is not None else config["language"],
        "nativeSampleRate": config["nativeSampleRate"],
        "comparisonSampleRate": config["comparisonSampleRate"],
        "outputFormat": config["outputFormat"],
        "channels": config["channels"],
        "sampleWidthBytes": config["sampleWidthBytes"],
        "chunkMs": config["chunkMs"],
        "gain": config["gain"],
        "speed": config["speed"],
        "resampler": config["resampler"],
        "timingMode": config["timingMode"],
        "timingBoundary": config["timingBoundary"],
        "playbackBufferMs": config["playbackBufferMs"],
        "rssScope": config["rssScope"],
        "listeningVersion": config["listeningVersion"],
    }


def _write_wav(path: Path, pcm: bytes, sample_rate: int) -> None:
    if not pcm or len(pcm) % 2:
        raise ValueError("refusing to write empty or malformed PCM")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(pcm)


def _timed_synthesis(adapter: Any, text: str, config: dict[str, Any]) -> dict[str, Any]:
    """Measure one request using the shared request/20-ms acceptance boundary."""
    pcm_parts: list[bytes] = []
    first_audio_at: list[float] = []
    expected_sequence = 0
    expected_sample_offset = 0
    expected_chunk_samples = (
        int(config["comparisonSampleRate"]) * int(config["chunkMs"]) // 1000
    )
    rss = RssSampler()
    vram = VramTracker.for_config(config)
    rss.start()
    vram.start()
    requested_at = time.perf_counter()

    def audio(chunk: Any) -> None:
        nonlocal expected_sequence, expected_sample_offset
        if chunk.sample_rate != config["comparisonSampleRate"]:
            raise RuntimeError("TTS audio chunk sample rate mismatches comparison contract")
        if chunk.sequence != expected_sequence or chunk.sample_offset != expected_sample_offset:
            raise RuntimeError("TTS audio chunks are not contiguous")
        if chunk.samples <= 0:
            raise RuntimeError("TTS audio chunk is empty")
        if not first_audio_at:
            if chunk.samples != expected_chunk_samples:
                raise RuntimeError("TTS first audio chunk is not one configured transport chunk")
            first_audio_at.append(time.perf_counter())
        pcm_parts.append(chunk.pcm16)
        expected_sequence += 1
        expected_sample_offset += chunk.samples

    try:
        result = adapter.synthesize_stream(text, CancelToken(), audio)
        completed_at = time.perf_counter()
    finally:
        rss.close()
        vram.close()
    if not first_audio_at:
        raise RuntimeError("TTS result lacks first non-empty audio")
    pcm = b"".join(pcm_parts)
    if result.sample_rate != config["comparisonSampleRate"]:
        raise RuntimeError("TTS result sample rate disagrees with comparison contract")
    if result.total_samples <= 0 or result.audio_seconds <= 0:
        raise RuntimeError("TTS result has no positive audio duration")
    if len(pcm) != result.total_samples * 2:
        raise RuntimeError("TTS result sample metadata disagrees with PCM")
    if result.sha256 != sha256_bytes(pcm):
        raise RuntimeError("TTS result checksum disagrees with accepted PCM")
    processing_seconds = completed_at - requested_at
    return {
        "pcm": pcm,
        "result": result,
        "requestedAt": requested_at,
        "firstAudioAt": first_audio_at[0],
        "completedAt": completed_at,
        "ttsTimeToFirstAudioMs": (first_audio_at[0] - requested_at) * 1000,
        "processingSeconds": processing_seconds,
        "rtf": processing_seconds / result.audio_seconds,
        "peakRssBytes": rss.peak,
        "peakVramBytes": vram.peak,
        "steadyVramBytes": vram.current,
    }


def compare_tts_runs(run_dirs: list[Path]) -> dict[str, Any]:
    if len(run_dirs) < 2:
        raise ValueError("compare requires at least two TTS runs")
    loaded = []
    for path in run_dirs:
        resolved = path.resolve()
        validate_run(resolved)
        run = json.loads((resolved / "run.json").read_text())
        summary = json.loads((resolved / "summary.json").read_text())
        semantics = run.get("comparisonSemantics")
        if run.get("kind") != "tts" or not isinstance(semantics, dict):
            raise ValueError(f"{resolved}: compare supports explicit-semantics TTS runs only")
        if run.get("comparisonSemanticsSha256") != sha256_bytes(canonical_json(semantics)):
            raise ValueError(f"{resolved}: TTS comparison semantics hash mismatch")
        loaded.append((resolved, run, summary))
    statuses = {run["status"] for _, run, _ in loaded}
    if len(statuses) != 1:
        raise ValueError("TTS comparison refuses terminal run-status mismatches")
    baseline_run = loaded[0][1]
    baseline = baseline_run["comparisonSemantics"]
    baseline_compatibility = (
        baseline_run.get("datasetId"),
        baseline_run.get("datasetSha256"),
        baseline_run.get("repetitions"),
        frozenset(
            (entry.get("sourceId"), entry.get("attempt"))
            for entry in baseline_run.get("expectedItems", [])
        ),
    )
    for path, run, _ in loaded[1:]:
        actual = run["comparisonSemantics"]
        differing = sorted(
            key for key in set(baseline) | set(actual) if baseline.get(key) != actual.get(key)
        )
        compatibility = (
            run.get("datasetId"),
            run.get("datasetSha256"),
            run.get("repetitions"),
            frozenset(
                (entry.get("sourceId"), entry.get("attempt"))
                for entry in run.get("expectedItems", [])
            ),
        )
        if differing or compatibility != baseline_compatibility:
            detail = ", ".join(
                f"{key}={baseline.get(key)!r} vs {actual.get(key)!r}" for key in differing
            )
            if compatibility != baseline_compatibility:
                detail = f"{detail}; dataset/repetition/source set differs".lstrip("; ")
            raise ValueError(f"unmatched TTS comparison semantics for {path}: {detail}")
    return {
        "kind": "tts-comparison-v1",
        "comparisonSemantics": baseline,
        "comparisonSemanticsSha256": loaded[0][1]["comparisonSemanticsSha256"],
        "runs": [
            {
                "runDir": str(path),
                "runId": run["runId"],
                "candidateId": run["models"][0]["id"],
                "runStatus": run["status"],
                "configId": run["configId"],
                "modelRevision": run["models"][0]["revision"],
                "voice": run["models"][0].get("voice"),
                "provider": run["models"][0].get("provider"),
                "ttsTimeToFirstAudioMs": summary["ttsTimeToFirstAudioMs"],
                "rtf": summary["rtf"],
                "prepareSeconds": summary.get("prepareSeconds"),
                "cold": summary.get("cold"),
                "totalAudioDurationSeconds": summary.get("totalAudioDurationSeconds"),
                "totalSamples": summary.get("totalSamples"),
                "failures": summary["failures"],
                "droppedOutputChunks": summary.get("droppedOutputChunks"),
                "underruns": summary["underruns"],
                "peakVramBytes": summary["peakVramBytes"],
                "steadyVramBytes": summary["steadyVramBytes"],
                "peakRssBytes": summary.get("peakRssBytes"),
                "synthesisWindowWholeProcessPeakRssBytes": summary.get(
                    "synthesisWindowWholeProcessPeakRssBytes"
                ),
                "preparePeakRssBytes": run.get("timing", {}).get("preparePeakRssBytes") if isinstance(run.get("timing"), dict) else None,
                "preparePeakVramBytes": run.get("timing", {}).get("preparePeakVramBytes") if isinstance(run.get("timing"), dict) else None,
                "soak": summary["soak"],
            }
            for path, run, summary in loaded
        ],
    }


def _playback_paced(adapter: Any, text: str, cancel: CancelToken) -> dict[str, Any]:
    """Consume audio by sample deadline and retain independently auditable arrivals.

    Playback begins 100 ms after the first queued chunk. A chunk misses samples
    when its queue-arrival time is after the deadline for its first sample; the
    missed count is the late portion of that chunk capped at its sample count.
    An underrun episode is an on-time-to-late transition. Consumer polling is not
    part of either definition.
    """
    audio_queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=8)
    evidence: dict[str, Any] = {
        "expectedSamples": 0,
        "consumedSamples": 0,
        "expectedChunks": 0,
        "consumedChunks": 0,
        "underrunEpisodes": 0,
        "missedSamples": 0,
        "droppedOutputChunks": 0,
        "chunkTelemetry": [],
    }
    playback_failure: list[BaseException] = []
    playback_start_ns: list[int] = []

    def play() -> None:
        try:
            while True:
                record = audio_queue.get()
                if record is None:
                    return
                ready = record.get("_queuedReady")
                if isinstance(ready, threading.Event):
                    ready.wait()
                deadline_ns = int(record["deadlineMonotonicNs"])
                now_ns = time.perf_counter_ns()
                if now_ns < deadline_ns:
                    time.sleep((deadline_ns - now_ns) / 1_000_000_000)
                record["consumeMonotonicNs"] = time.perf_counter_ns()
                evidence["consumedSamples"] += record["sampleCount"]
                evidence["consumedChunks"] += 1
        except BaseException as error:
            playback_failure.append(error)

    player = threading.Thread(target=play, name="kokoro-playback", daemon=True)
    player.start()

    def enqueue(chunk: Any) -> None:
        accepted_ns = time.perf_counter_ns()
        if chunk.sample_offset != evidence["expectedSamples"]:
            raise RuntimeError("playback received a non-contiguous sample offset")
        record = {
            "sequence": chunk.sequence,
            "sampleOffset": chunk.sample_offset,
            "sampleCount": chunk.samples,
            "acceptedMonotonicNs": accepted_ns,
            "queuedMonotonicNs": 0,
            "deadlineMonotonicNs": 0,
            "consumeMonotonicNs": 0,
            "_queuedReady": threading.Event(),
        }
        if not playback_start_ns:
            playback_start_ns.append(
                time.perf_counter_ns() + PLAYBACK_BUFFER_MS * 1_000_000
            )
        record["deadlineMonotonicNs"] = playback_start_ns[0] + (
            chunk.sample_offset * 1_000_000_000 // 24_000
        )
        while True:
            cancel.raise_if_cancelled()
            if playback_failure:
                raise playback_failure[0]
            try:
                audio_queue.put(record, timeout=0.05)
                # Queue.put() may wait for a consumer. Record the actual
                # successful insertion, and hold the consumer at the event so
                # consumeMonotonicNs cannot race ahead of this timestamp.
                record["queuedMonotonicNs"] = time.perf_counter_ns()
                record["_queuedReady"].set()
                break
            except queue.Full:
                continue
        record.pop("_queuedReady", None)
        evidence["expectedSamples"] += chunk.samples
        evidence["expectedChunks"] += 1
        evidence["chunkTelemetry"].append(record)

    try:
        result = adapter.synthesize_stream(text, cancel, enqueue)
        while True:
            try:
                audio_queue.put(None, timeout=0.05)
                break
            except queue.Full:
                if playback_failure:
                    raise playback_failure[0]
        player.join(timeout=result.audio_seconds + PLAYBACK_BUFFER_MS / 1000 + 5)
        if player.is_alive():
            raise RuntimeError("playback-paced consumer did not stop")
        if playback_failure:
            raise playback_failure[0]
        previous_late = False
        for record in evidence["chunkTelemetry"]:
            lateness_ns = max(
                0, record["queuedMonotonicNs"] - record["deadlineMonotonicNs"]
            )
            missed = min(
                record["sampleCount"],
                (lateness_ns * 24_000 + 999_999_999) // 1_000_000_000,
            )
            record["arrivalLatenessNs"] = lateness_ns
            record["missedSamples"] = missed
            late = missed > 0
            if late and not previous_late:
                evidence["underrunEpisodes"] += 1
            previous_late = late
            evidence["missedSamples"] += missed
        return evidence
    finally:
        if player.is_alive():
            cancel.cancel()
            while True:
                try:
                    audio_queue.get_nowait()
                except queue.Empty:
                    break
            try:
                audio_queue.put_nowait(None)
            except queue.Full:
                pass
            player.join(timeout=2)


def run_tts(
    candidate: str,
    config_path: Path,
    prompts_path: Path,
    output_root: Path | None = None,
    command: list[str] | None = None,
    soak_minutes: float = 0,
    adapter_factory: Callable[[], Any] | None = None,
) -> Path:
    config, prompts, prompts_hash, model = _verified_tts_config(
        candidate, config_path, prompts_path
    )
    factory = adapter_factory or TTS_ADAPTER_FACTORIES[candidate]
    config_path = config_path.resolve()
    prompts_path = prompts_path.resolve()
    source_manifest = deterministic_source_manifest(ROOT)
    source_id, dirty = source_state(ROOT, source_manifest)
    source_manifest_sha256 = sha256_bytes(canonical_json(source_manifest))
    run_id = str(uuid.uuid4())
    stamp = utc_now().replace(":", "").replace(".", "")
    run_dir = (output_root or ROOT / "benchmarks/results") / (
        f"{stamp}-{source_id[:12]}-{run_id[:8]}"
    )
    run_dir.mkdir(parents=True)
    gpu = sample_gpu()
    gpu_metadata = {"name": gpu.name, "driver": gpu.driver, "cuda": gpu.cuda}
    benchmark_prompts = prompts["items"] if soak_minutes <= 0 else prompts["items"][:1]
    expected = [
        {"sourceId": item["sourceId"], "candidateId": candidate, "attempt": 1}
        for item in benchmark_prompts
    ]
    semantics = _comparison_semantics(config, prompts_hash, str(prompts["language"]))
    run = {
        "schemaVersion": 1,
        "runId": run_id,
        "kind": "tts",
        "startedAt": utc_now(),
        "endedAt": None,
        "sourceId": source_id,
        "sourceManifestSha256": source_manifest_sha256,
        "dirty": dirty,
        "machine": machine_metadata(gpu_metadata),
        "runtimes": runtime_metadata(gpu_metadata),
        "models": [
            {
                "id": candidate,
                "revision": model["revision"],
                "sha256": model["sha256"],
                "runtime": config["candidate"]["runtime"],
                "precision": config["candidate"]["precision"],
                "nativeSampleRate": config["nativeSampleRate"],
                "modelSha256": config["candidate"]["modelSha256"],
                **{
                    key: value
                    for key, value in {
                        "voice": config["candidate"].get("voice"),
                        "provider": config["candidate"].get("provider"),
                        "voicesSha256": config["candidate"].get("voicesSha256"),
                        "runtimeRevision": config["candidate"].get("runtimeRevision"),
                        "onnxReleaseRevision": config["candidate"].get("onnxReleaseRevision"),
                        "device": config["candidate"].get("device") or config.get("device"),
                        "backend": config["candidate"].get("backend") or config.get("backend"),
                    }.items()
                    if value is not None
                },
            }
        ],
        "configId": config["id"],
        "configSha256": sha256_file(config_path),
        "comparisonSemantics": semantics,
        "comparisonSemanticsSha256": sha256_bytes(canonical_json(semantics)),
        "datasetId": prompts["id"],
        "datasetSha256": prompts_hash,
        "seed": config["seed"],
        "command": command
        or [
            ".venv-kokoro/bin/python" if candidate == "kokoro" else "/tmp/qwen-env/bin/python",
            "-m",
            "benchmarks.harness",
            "run",
            "--kind",
            "tts",
            "--candidate",
            candidate,
            "--config",
            str(config_path.relative_to(ROOT)),
            "--prompts",
            str(prompts_path.relative_to(ROOT)),
        ],
        "environment": environment_metadata(),
        "warmups": config["warmups"],
        "repetitions": 1,
        "expectedItems": expected,
        "randomization": {"method": "single-candidate-v1", "blind": True, "revealLocked": True},
        "status": "running",
        "timing": {
            "prepareSeconds": 0.0,
            "preparePeakRssBytes": None,
            "preparePeakVramBytes": None,
            "cold": None,
            "peakRssBytes": None,
            "peakVramBytes": None,
        },
        "provenance": {
            "modelManifestPath": "docs/model-manifest.json",
            "modelManifestSha256": sha256_file(ROOT / "docs/model-manifest.json"),
            "modelManifestId": model["id"],
            "configPath": str(config_path.relative_to(ROOT)),
            "datasetPath": str(prompts_path.relative_to(ROOT)),
        },
    }
    _write_json(run_dir / "source-manifest.json", source_manifest)
    mapping = blind_mapping([candidate], int(config["seed"]))
    label = next(iter(mapping))
    _initialize_artifacts(run_dir, run, mapping)
    items: dict[str, dict[str, Any]] = {}
    failures: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    sequence = 0
    run_started = time.perf_counter()
    adapter: Any | None = None
    primary_stage: str | None = None
    timing = run["timing"]
    soak = {
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

    def now_ms() -> float:
        return (time.perf_counter() - run_started) * 1000

    def fail(source: str, stage: str, error: BaseException, run_level: bool = False) -> None:
        nonlocal sequence
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
        item["normalizationVersion"] = TTS_NORMALIZATION_VERSION
        if run_level:
            failures.append(item)
        else:
            items[source] = item
        events.append(
            _event(
                sequence,
                now_ms(),
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
        prepare_started = time.perf_counter()
        prepare_rss = RssSampler()
        prepare_vram = VramTracker.for_config(config)
        prepare_rss.start()
        prepare_vram.start()
        try:
            adapter = factory()
            adapter.prepare(config)
        except BaseException as error:
            primary_stage = "prepare"
            for entry in expected:
                fail(entry["sourceId"], primary_stage, error)
        finally:
            prepare_rss.close()
            prepare_vram.close()
            timing["prepareSeconds"] = time.perf_counter() - prepare_started
            timing["preparePeakRssBytes"] = prepare_rss.peak
            timing["preparePeakVramBytes"] = prepare_vram.peak
            timing["peakRssBytes"] = prepare_rss.peak
            timing["peakVramBytes"] = prepare_vram.peak

        if adapter is not None and primary_stage is None:
            try:
                adapter.reset()
                cold = _timed_synthesis(adapter, prompts["items"][0]["text"], config)
                cold_context = {
                    "sourceId": prompts["items"][0]["sourceId"],
                    "candidateId": candidate,
                    "attempt": 1,
                    "phase": "cold",
                }
                events.append(
                    _event(
                        sequence,
                        (cold["requestedAt"] - run_started) * 1000,
                        "tts_requested",
                        cold_context,
                    )
                )
                sequence += 1
                events.append(
                    _event(
                        sequence,
                        (cold["firstAudioAt"] - run_started) * 1000,
                        "first_audio",
                        {
                            **cold_context,
                            "latencyMs": cold["ttsTimeToFirstAudioMs"],
                            "sampleOffset": 0,
                        },
                    )
                )
                sequence += 1
                cold_result = cold["result"]
                events.append(
                    _event(
                        sequence,
                        (cold["completedAt"] - run_started) * 1000,
                        "final",
                        {
                            **cold_context,
                            "sampleCount": cold_result.total_samples,
                            "outputSha256": cold_result.sha256,
                            "audioDurationSeconds": cold_result.audio_seconds,
                            "processingSeconds": cold["processingSeconds"],
                            "adapterProcessingSeconds": cold_result.processing_seconds,
                            "synthesisWindowWholeProcessPeakRssBytes": cold["peakRssBytes"],
                            "peakVramBytes": cold["peakVramBytes"],
                        },
                    )
                )
                sequence += 1
                timing["cold"] = {
                    "sourceId": prompts["items"][0]["sourceId"],
                    "ttsTimeToFirstAudioMs": cold["ttsTimeToFirstAudioMs"],
                    "processingSeconds": cold["processingSeconds"],
                    "rtf": cold["rtf"],
                    "audioDurationSeconds": cold_result.audio_seconds,
                    "totalSamples": cold_result.total_samples,
                    "peakRssBytes": cold["peakRssBytes"],
                    "peakVramBytes": cold["peakVramBytes"],
                }
                if cold["peakRssBytes"] is not None:
                    timing["peakRssBytes"] = max(timing["peakRssBytes"], cold["peakRssBytes"])
                if cold["peakVramBytes"] is not None:
                    timing["peakVramBytes"] = max(
                        timing["peakVramBytes"] or 0, cold["peakVramBytes"]
                    )
                # The measured run starts after the configured cold probe. Any
                # additional configured warmups remain excluded from aggregates.
                for _ in range(1, max(1, int(config["warmups"]))):
                    adapter.reset()
                    adapter.synthesize_stream(prompts["items"][0]["text"], CancelToken())
            except BaseException as error:
                primary_stage = "warmup"
                for entry in expected:
                    fail(entry["sourceId"], primary_stage, error)
        if adapter is not None and primary_stage is None:
            for prompt in benchmark_prompts:
                source = prompt["sourceId"]
                context = {
                    "sourceId": source,
                    "candidateId": candidate,
                    "attempt": 1,
                    "phase": "measured",
                }
                try:
                    adapter.reset()
                    token = CancelToken()
                    pcm_parts: list[bytes] = []
                    first_audio_at: list[float] = []
                    expected_sequence = 0
                    expected_sample_offset = 0
                    expected_chunk_samples = (
                        int(config["comparisonSampleRate"]) * int(config["chunkMs"]) // 1000
                    )
                    rss = RssSampler()
                    vram = VramTracker.for_config(config)
                    rss.start()
                    vram.start()
                    requested_at = time.perf_counter()
                    events.append(
                        _event(
                            sequence,
                            (requested_at - run_started) * 1000,
                            "tts_requested",
                            context,
                        )
                    )
                    sequence += 1

                    def audio(chunk: Any) -> None:
                        nonlocal expected_sequence, expected_sample_offset
                        if chunk.sample_rate != config["comparisonSampleRate"]:
                            raise RuntimeError("TTS audio chunk sample rate mismatches comparison contract")
                        if chunk.sequence != expected_sequence or chunk.sample_offset != expected_sample_offset:
                            raise RuntimeError("TTS audio chunks are not contiguous")
                        if chunk.samples <= 0:
                            raise RuntimeError("TTS audio chunk is empty")
                        if not first_audio_at:
                            if chunk.samples != expected_chunk_samples:
                                raise RuntimeError("TTS first audio chunk is not one configured transport chunk")
                            first_audio_at.append(time.perf_counter())
                        pcm_parts.append(chunk.pcm16)
                        expected_sequence += 1
                        expected_sample_offset += chunk.samples

                    result = adapter.synthesize_stream(prompt["text"], token, audio)
                    completed_at = time.perf_counter()
                    rss.close()
                    vram.close()
                    if rss.peak is not None:
                        timing["peakRssBytes"] = max(timing["peakRssBytes"], rss.peak)
                    if vram.peak is not None:
                        timing["peakVramBytes"] = max(timing["peakVramBytes"] or 0, vram.peak)
                    if not first_audio_at:
                        raise RuntimeError("TTS result lacks first non-empty audio")
                    pcm = b"".join(pcm_parts)
                    if result.sample_rate != config["comparisonSampleRate"]:
                        raise RuntimeError("TTS result sample rate disagrees with comparison contract")
                    if result.total_samples <= 0 or result.audio_seconds <= 0:
                        raise RuntimeError("TTS result has no positive audio duration")
                    if len(pcm) != result.total_samples * 2:
                        raise RuntimeError("TTS result sample metadata disagrees with PCM")
                    audio_path = Path("audio") / f"{source}.wav"
                    _write_wav(run_dir / audio_path, pcm, result.sample_rate)
                    ttfa = (first_audio_at[0] - requested_at) * 1000
                    events.append(
                        _event(
                            sequence,
                            (first_audio_at[0] - run_started) * 1000,
                            "first_audio",
                            {**context, "latencyMs": ttfa, "sampleOffset": 0},
                        )
                    )
                    sequence += 1
                    harness_processing = completed_at - requested_at
                    events.append(
                        _event(
                            sequence,
                            (completed_at - run_started) * 1000,
                            "final",
                            {
                                **context,
                                "sampleCount": result.total_samples,
                                "outputSha256": result.sha256,
                                "audioDurationSeconds": result.audio_seconds,
                                "processingSeconds": harness_processing,
                                "adapterProcessingSeconds": result.processing_seconds,
                                "synthesisWindowWholeProcessPeakRssBytes": rss.peak,
                                "peakVramBytes": vram.peak,
                            },
                        )
                    )
                    sequence += 1
                    metrics = _empty_metrics()
                    metrics.update(
                        {
                            "ttsTimeToFirstAudioMs": ttfa,
                            "rtf": harness_processing / result.audio_seconds,
                            "totalAudioDurationSeconds": result.audio_seconds,
                            "totalSamples": result.total_samples,
                            "droppedOutputChunks": 0,
                            "synthesisWindowWholeProcessPeakRssBytes": rss.peak,
                            "peakRssBytes": rss.peak,
                            "peakVramBytes": vram.peak,
                            "steadyVramBytes": vram.current,
                        }
                    )
                    items[source] = {
                        "candidateId": candidate,
                        "configId": config["id"],
                        "sourceId": source,
                        "blindLabel": label,
                        "attempt": 1,
                        "status": "passed",
                        "failure": None,
                        "transcript": None,
                        "audioPath": str(audio_path),
                        "normalizationVersion": TTS_NORMALIZATION_VERSION,
                        "revisionTrace": [],
                        "promptSha256": prompt["textSha256"],
                        "audioMetadata": {
                            "sampleRate": result.sample_rate,
                            "nativeSampleRate": config["nativeSampleRate"],
                            "channels": 1,
                            "sampleWidthBytes": 2,
                            "format": config["outputFormat"],
                            "totalSamples": result.total_samples,
                            "durationSeconds": result.audio_seconds,
                            "processingSeconds": harness_processing,
                            "adapterProcessingSeconds": result.processing_seconds,
                            "timingBoundary": config["timingBoundary"],
                            "sha256": result.sha256,
                            "chunkCount": result.chunk_count,
                        },
                        "metrics": metrics,
                    }
                except BaseException as error:
                    try:
                        rss.close()
                    except (NameError, RuntimeError):
                        pass
                    try:
                        vram.close()
                    except (NameError, RuntimeError):
                        pass
                    fail(source, "synthesize", error)
                    if bool(getattr(adapter, "_poisoned", False)):
                        primary_stage = "synthesize"
                        break
    finally:
        if adapter is not None:
            try:
                adapter.close()
            except BaseException as error:
                fail(f"__run__:close:{len(failures) + 1}", "close", error, True)
                primary_stage = primary_stage or "close"

    if adapter is not None and primary_stage is None and soak_minutes > 0:
        soak_adapter: Any | None = None
        soak_started: float | None = None
        iteration = 0
        all_lateness: list[float] = []
        try:
            soak_adapter = factory()
            soak_adapter.prepare(config)
            soak_started = time.perf_counter()
            events.append(
                _event(sequence, now_ms(), "soak_started", {"reason": f"playback-paced;requested_minutes={soak_minutes}"})
            )
            sequence += 1
            while time.perf_counter() - soak_started < soak_minutes * 60:
                prompt = prompts["items"][iteration % len(prompts["items"])]
                before_generation = soak_adapter.generation
                soak_adapter.reset()
                if soak_adapter.generation != before_generation + 1:
                    raise RuntimeError("TTS reset generation did not advance exactly once")
                evidence = _playback_paced(soak_adapter, prompt["text"], CancelToken())
                workers = _worker_names()
                if workers:
                    raise RuntimeError("TTS soak iteration leaked workers")
                iteration += 1
                lateness = [
                    record["arrivalLatenessNs"] / 1_000_000
                    for record in evidence["chunkTelemetry"]
                ]
                all_lateness.extend(lateness)
                events.append(
                    _event(
                        sequence,
                        now_ms(),
                        "soak_iteration",
                        {
                            "iteration": iteration,
                            "expectedFrames": evidence["expectedSamples"],
                            "consumedFrames": evidence["consumedSamples"],
                            "expectedSamples": evidence["expectedSamples"],
                            "consumedSamples": evidence["consumedSamples"],
                            "expectedChunks": evidence["expectedChunks"],
                            "consumedChunks": evidence["consumedChunks"],
                            "deadlineOverruns": sum(value > 20 for value in lateness),
                            "droppedFrames": evidence["droppedOutputChunks"],
                            "droppedOutputChunks": evidence["droppedOutputChunks"],
                            "underruns": evidence["underrunEpisodes"],
                            "underrunEpisodes": evidence["underrunEpisodes"],
                            "missedSamples": evidence["missedSamples"],
                            "workerLeaks": 0,
                            "resetCount": 1,
                            "deadlineLatenessMs": lateness,
                            "chunkTelemetry": evidence["chunkTelemetry"],
                        },
                    )
                )
                sequence += 1
                soak["expectedSamples"] += evidence["expectedSamples"]
                soak["consumedSamples"] += evidence["consumedSamples"]
                soak["expectedFrames"] += evidence["expectedSamples"]
                soak["consumedFrames"] += evidence["consumedSamples"]
                soak["expectedChunks"] += evidence["expectedChunks"]
                soak["consumedChunks"] += evidence["consumedChunks"]
                soak["underruns"] += evidence["underrunEpisodes"]
                soak["underrunEpisodes"] += evidence["underrunEpisodes"]
                soak["missedSamples"] += evidence["missedSamples"]
                soak["droppedFrames"] += evidence["droppedOutputChunks"]
                soak["resetCount"] += 1
        except BaseException as error:
            soak["passed"] = False
            soak["severeFailures"] += 1
            fail(f"__run__:soak:{len(failures) + 1}", "soak", error, True)
        finally:
            if soak_adapter is not None:
                try:
                    soak_adapter.close()
                except BaseException as error:
                    soak["passed"] = False
                    soak["severeFailures"] += 1
                    fail(f"__run__:close:{len(failures) + 1}", "close", error, True)
            soak["workerLeaks"] = len(_worker_names())
            soak["durationSeconds"] = time.perf_counter() - soak_started if soak_started else 0.0
            soak["deadlineOverruns"] = sum(value > 20 for value in all_lateness)
            soak["deadlineLatenessP95Ms"] = percentile(all_lateness, 0.95) if all_lateness else 0.0
            soak["deadlineLatenessMaxMs"] = max(all_lateness, default=0.0)
            soak["timingConformance"] = bool(
                soak["deadlineLatenessP95Ms"] <= 20 and soak["deadlineLatenessMaxMs"] <= 100
            )
            soak["passed"] = bool(
                soak["passed"]
                and soak["durationSeconds"] >= soak_minutes * 60
                and not soak["severeFailures"]
                and not soak["underrunEpisodes"]
                and not soak["missedSamples"]
                and not soak["droppedFrames"]
                and not soak["workerLeaks"]
                and soak["expectedSamples"] == soak["consumedSamples"]
                and soak["expectedChunks"] == soak["consumedChunks"]
                and soak["timingConformance"]
            )
            events.append(
                _event(
                    sequence,
                    now_ms(),
                    "soak_completed",
                    {
                        "reason": f"playbackPaced=true;rawIterations={iteration};passed={soak['passed']}",
                        "workerLeaks": soak["workerLeaks"],
                        "severeFailures": soak["severeFailures"],
                    },
                )
            )
            sequence += 1

    missing_error = RuntimeError(f"not run after {primary_stage or 'finalize'} failure")
    for entry in expected:
        if entry["sourceId"] not in items:
            fail(entry["sourceId"], primary_stage or "finalize", missing_error)
    ordered_items = [items[entry["sourceId"]] for entry in expected] + failures
    run["endedAt"] = utc_now()
    run["status"] = (
        "passed"
        if all(item["status"] == "passed" for item in ordered_items) and soak["passed"]
        else "failed"
    )
    events.sort(key=lambda event: (event["monotonicMs"], event["sequence"]))
    for index, event in enumerate(events):
        event["sequence"] = index
    summary = _summary(ordered_items, timing)
    summary["soak"] = soak
    _write_jsonl(run_dir / "items.jsonl", ordered_items)
    _write_jsonl(run_dir / "events.jsonl", events)
    _write_json(run_dir / "summary.json", summary)
    _write_json(run_dir / "run.json", run)
    (run_dir / "ratings.jsonl").write_text("")
    (run_dir / "README.md").write_text(
        f"# {candidate} TTS benchmark\n\nRerun: `{' '.join(run['command'])}`\n\n"
        f"Validate: `uv run python -m benchmarks.harness validate {run_dir}`\n\n"
        f"Candidate model: `{model['id']}` at revision `{model['revision']}`; "
        f"voice: `{config['candidate'].get('voice', 'n/a')}`; "
        f"provider: `{config['candidate'].get('provider', 'n/a')}`. "
        "The runner verifies the selected model manifest and every attested asset before "
        "adapter preparation. Output is signed little-endian PCM16 mono at 24 kHz in WAV "
        "containers. TTFA begins at tts_requested and ends at the first accepted non-empty "
        "20-ms PCM chunk. RTF is harness processing seconds divided by generated audio "
        "seconds. Prepare time and the first after-prepare cold request are reported "
        "separately from warm item aggregates. RSS is sampled over each whole-process "
        "phase window. VRAM is process-attributed only for the Qwen PyTorch allocator; "
        "CPU and ONNX Runtime CUDA candidates report it as unmeasured. Gain is fixed at "
        "0.9 with no per-item normalization or resampling. Soak mode consumes a bounded "
        "queue at playback pace.\n"
    )
    validate_run(run_dir)
    return run_dir


def probe_tts_cancellation(
    candidate: str,
    config_path: Path,
    prompts_path: Path,
    run_dir: Path | None = None,
    adapter_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    config, prompts, prompts_hash, model = _verified_tts_config(
        candidate, config_path, prompts_path
    )
    factory = adapter_factory or TTS_ADAPTER_FACTORIES[candidate]
    attached_run: dict[str, Any] | None = None
    if run_dir is not None:
        run_dir = run_dir.resolve()
        validate_run(run_dir)
        attached_run = json.loads((run_dir / "run.json").read_text())
        run_model = attached_run.get("models", [{}])[0]
        if (
            attached_run.get("kind") != "tts"
            or attached_run.get("configId") != config["id"]
            or attached_run.get("configSha256") != sha256_file(config_path.resolve())
            or attached_run.get("datasetId") != prompts["id"]
            or attached_run.get("datasetSha256") != prompts_hash
            or run_model.get("id") != candidate
            or run_model.get("revision") != model["revision"]
            or run_model.get("sha256") != model["sha256"]
            or run_model.get("modelSha256") != model["sha256"]
        ):
            raise ValueError("cancellation probe run identity does not match config/model/prompts")
    adapter = factory()
    adapter.prepare(config)
    token = CancelToken()
    accepted = 0
    cutoff_samples = 0
    started_at = utc_now()
    started = time.perf_counter()

    def cancel_after_first(chunk: Any) -> None:
        nonlocal accepted, cutoff_samples
        accepted += 1
        cutoff_samples += chunk.samples
        if accepted == 1:
            token.cancel()

    outcome = "not-cancelled"
    pre_close_survivors: list[str] = []
    poisoned = False
    try:
        adapter.synthesize_stream(prompts["items"][2]["text"], token, cancel_after_first)
    except Cancelled:
        outcome = "cancelled"
    finally:
        pre_close_survivors = _worker_names()
        poisoned = bool(getattr(adapter, "_poisoned", False))
        adapter.close()
    post_close_survivors = _worker_names()
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "probe": f"{candidate}-cancellation-after-first-audio-v2",
        "candidateId": candidate,
        "startedAt": started_at,
        "endedAt": utc_now(),
        "outcome": outcome,
        "elapsedSeconds": time.perf_counter() - started,
        "acceptedChunks": accepted,
        "cutoffSamples": cutoff_samples,
        "checkedWorkerPrefixes": list(TTS_WORKER_PREFIXES),
        "preCloseSurvivingWorkers": pre_close_survivors,
        "postCloseSurvivingWorkers": post_close_survivors,
        "backendPoisoned": poisoned,
        "runId": attached_run.get("runId") if attached_run else None,
        "sourceId": attached_run.get("sourceId") if attached_run else None,
        "configId": config["id"],
        "configSha256": sha256_file(config_path.resolve()),
        "promptManifestId": prompts["id"],
        "promptManifestSha256": prompts_hash,
        "promptSourceId": prompts["items"][2]["sourceId"],
        "promptSha256": prompts["items"][2]["textSha256"],
        "modelId": model["id"],
        "modelRevision": model["revision"],
        "modelSha256": model["sha256"],
        "runtime": config["candidate"]["runtime"],
        "runtimeRevision": config["candidate"].get("runtimeRevision"),
        "voice": config["candidate"].get("voice"),
    }
    for key in ("voicesSha256", "onnxReleaseRevision"):
        value = config["candidate"].get(key)
        if value is not None:
            result[key] = value
    if run_dir is not None:
        payload = canonical_json(result)
        (run_dir / "cancellation-probe.json").write_bytes(payload)
        (run_dir / "cancellation-probe.sha256").write_text(
            sha256_bytes(payload) + "  cancellation-probe.json\n", encoding="ascii"
        )
        validate_run(run_dir)
    return result


def probe_kokoro_cancellation(
    config_path: Path,
    prompts_path: Path,
    run_dir: Path | None = None,
    adapter_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    return probe_tts_cancellation("kokoro", config_path, prompts_path, run_dir, adapter_factory)


def probe_qwen_cancellation(
    config_path: Path,
    prompts_path: Path,
    run_dir: Path | None = None,
    adapter_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    return probe_tts_cancellation(
        "qwen3-0.6b", config_path, prompts_path, run_dir, adapter_factory
    )
