#!/usr/bin/env python3
"""Validate the faster-qwen3-tts Torch CUDA-graph path on pinned Qwen CustomVoice.

This is a standalone feasibility experiment, not a production adapter. It keeps
source provenance, the pinned model/runtime identity, streaming packet timing,
PCM validation, and process-attributed resource evidence in one JSON artifact.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterable
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import threading
import time
import traceback
from typing import Any
import wave

ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
MODEL_REVISION = "85e237c12c027371202489a0ec509ded67b5e4b5"
MODEL_DIR = ROOT / "models/qwen3-tts-12hz-1.7b-customvoice"
MANIFEST_PATH = ROOT / "services/audio/config/model-manifest.json"
QWEN_LOCK = ROOT / "services/audio/qwen-requirements.lock"
SAMPLE_RATE = 24_000
SPEAKER = "Ryan"
LANGUAGE = "English"
TEXT = "Signed PCM sixteen, mono, at twenty-four kilohertz must remain correctly framed."
DTYPE_NAME = "bfloat16"
ATTENTION = "eager"
DEVICE = "cuda"
CHUNK_SIZE = 8
MAX_NEW_TOKENS = 512
SEED = 4090


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unavailable"


def resource_max_rss_bytes() -> int:
    # Linux/WSL reports ru_maxrss in KiB.
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


def rss_bytes() -> int:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def run_command(argv: list[str], *, cwd: Path | None = None) -> str | None:
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip()


def run_nvidia_query(query: str) -> dict[str, str] | None:
    output = run_command(
        ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"]
    )
    if not output:
        return None
    values = [part.strip() for part in output.splitlines()[0].split(",")]
    fields = [part.strip() for part in query.split(",")]
    if len(values) != len(fields):
        return None
    return dict(zip(fields, values, strict=True))


def git_identity(repo: Path) -> dict[str, Any]:
    repo = repo.resolve()
    if not (repo / ".git").exists():
        raise RuntimeError(f"faster-qwen3-tts source is not a git checkout: {repo}")
    commit = run_command(["git", "rev-parse", "HEAD"], cwd=repo)
    if not commit:
        raise RuntimeError(f"could not resolve faster-qwen3-tts commit: {repo}")
    return {
        "path": str(repo),
        "remoteOrigin": run_command(["git", "remote", "get-url", "origin"], cwd=repo),
        "commit": commit,
        "describe": run_command(["git", "describe", "--tags", "--always", "--dirty"], cwd=repo),
        "statusPorcelain": run_command(["git", "status", "--porcelain"], cwd=repo) or "",
        "packageVersion": package_version("faster-qwen3-tts"),
        "license": "MIT",
        "licensePath": str(repo / "LICENSE"),
        "licenseSha256": sha256_file(repo / "LICENSE"),
    }


def verify_manifest_assets() -> dict[str, Any]:
    manifest = json.loads(MANIFEST_PATH.read_text())
    entries = [entry for entry in manifest["models"] if entry.get("id") == MODEL_ID]
    if len(entries) != 1:
        raise RuntimeError("manifest does not contain exactly one pinned Qwen entry")
    entry = entries[0]
    if entry.get("revision") != MODEL_REVISION:
        raise RuntimeError("Qwen model revision does not match the pinned spike revision")
    checked: list[dict[str, Any]] = []
    for asset in entry.get("files", []):
        path = (ROOT / asset["path"]).resolve()
        expected = asset["sha256"]
        if not path.is_file():
            raise RuntimeError(f"missing pinned Qwen asset: {path}")
        actual = sha256_file(path)
        if actual != expected:
            raise RuntimeError(f"pinned Qwen asset hash mismatch: {path}")
        checked.append({"path": str(path), "sha256": actual, "bytes": path.stat().st_size})
    if not checked:
        raise RuntimeError("manifest has no Qwen assets to verify")
    return {"entry": entry, "assets": checked}


class ResourceSampler:
    def __init__(self, torch_module: Any) -> None:
        self.torch = torch_module
        self.max_rss = 0
        self.max_allocated = 0
        self.max_reserved = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def sample(self) -> None:
        self.max_rss = max(self.max_rss, rss_bytes())
        try:
            if self.torch.cuda.is_available():
                self.max_allocated = max(
                    self.max_allocated, int(self.torch.cuda.memory_allocated())
                )
                self.max_reserved = max(
                    self.max_reserved, int(self.torch.cuda.memory_reserved())
                )
        except (RuntimeError, AssertionError):
            pass

    def reset(self) -> None:
        self.max_rss = 0
        self.max_allocated = 0
        self.max_reserved = 0
        self.sample()

    def start(self) -> None:
        self.sample()

        def loop() -> None:
            while not self._stop.wait(0.01):
                self.sample()

        self._thread = threading.Thread(
            target=loop,
            name="faster-qwen3-tts-resource-sampler",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            if self._thread.is_alive():
                raise RuntimeError("resource sampler did not stop")
        self.sample()

    def phase_peak(self, allocated: int, reserved: int) -> dict[str, int]:
        return {
            "torchCudaMaxMemoryAllocatedBytes": max(allocated, self.max_allocated),
            "torchCudaMaxMemoryReservedBytes": max(reserved, self.max_reserved),
            "rssSamplerPeakBytes": self.max_rss,
        }


def begin_phase(torch_module: Any, sampler: ResourceSampler) -> None:
    torch_module.cuda.synchronize()
    torch_module.cuda.reset_peak_memory_stats()
    sampler.reset()


def end_phase(torch_module: Any, sampler: ResourceSampler) -> dict[str, int]:
    torch_module.cuda.synchronize()
    sampler.sample()
    return sampler.phase_peak(
        int(torch_module.cuda.max_memory_allocated()),
        int(torch_module.cuda.max_memory_reserved()),
    )


def set_seed(torch_module: Any) -> None:
    torch_module.manual_seed(SEED)
    torch_module.cuda.manual_seed_all(SEED)


def audio_array(value: Any, numpy_module: Any) -> Any:
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    values = numpy_module.asarray(value, dtype=numpy_module.float32).reshape(-1)
    if values.size == 0:
        raise ValueError("faster-qwen3-tts returned an empty audio chunk")
    if not numpy_module.isfinite(values).all():
        raise ValueError("faster-qwen3-tts returned non-finite audio")
    peak = float(numpy_module.max(numpy_module.abs(values)))
    if peak > 1.0:
        raise ValueError(f"audio chunk exceeds PCM range: peak={peak}")
    return values


def pcm16le(values: Any, numpy_module: Any) -> bytes:
    values = audio_array(values, numpy_module)
    return numpy_module.rint(numpy_module.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def write_wav(output_dir: Path, label: str, values: Any, numpy_module: Any, sample_rate: int) -> dict[str, Any]:
    pcm = pcm16le(values, numpy_module)
    wav_path = output_dir / f"{label}.wav"
    pcm_path = output_dir / f"{label}.pcm"
    with wave.open(str(wav_path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(pcm)
    pcm_path.write_bytes(pcm)
    with wave.open(str(wav_path), "rb") as source:
        params = source.getparams()
        reopened_pcm = source.readframes(source.getnframes())
    if params.nchannels != 1 or params.sampwidth != 2 or params.framerate != SAMPLE_RATE:
        raise ValueError(f"invalid WAV format: {params}")
    if reopened_pcm != pcm or len(pcm) == 0 or len(pcm) % 2:
        raise ValueError("WAV payload does not match the expected PCM16LE bytes")
    samples = len(pcm) // 2
    return {
        "sampleRate": params.framerate,
        "channels": params.nchannels,
        "sampleWidthBytes": params.sampwidth,
        "samples": samples,
        "durationSeconds": samples / params.framerate,
        "pcmBytes": len(pcm),
        "pcmSha256": sha256_bytes(pcm),
        "wavSha256": sha256_file(wav_path),
        "wavPath": str(wav_path),
        "pcmPath": str(pcm_path),
    }


def timing_summary(processing_seconds: float, audio_seconds: float) -> dict[str, float]:
    if audio_seconds <= 0:
        raise ValueError("cannot calculate RTF for empty audio")
    # Match the project's existing QW-2 convention: processing/audio. Values
    # below 1.0 are faster than real time. Also expose its reciprocal because
    # faster-qwen3-tts's README labels audio/processing as RTF.
    return {
        "processingSeconds": processing_seconds,
        "audioSeconds": audio_seconds,
        "rtfProcessingOverAudio": processing_seconds / audio_seconds,
        "audioOverProcessingRealtimeFactor": audio_seconds / processing_seconds,
    }


def chunk_record(
    index: int,
    values: Any,
    sample_rate: int,
    observed_seconds: float,
    timing: dict[str, Any],
    numpy_module: Any,
) -> dict[str, Any]:
    pcm = pcm16le(values, numpy_module)
    return {
        "index": index,
        "samples": len(values),
        "durationSeconds": len(values) / sample_rate,
        "sampleRate": sample_rate,
        "pcmBytes": len(pcm),
        "pcmSha256": sha256_bytes(pcm),
        "observedSeconds": observed_seconds,
        "timing": timing,
    }


def run_streaming(
    *,
    label: str,
    model: Any,
    torch_module: Any,
    numpy_module: Any,
    sampler: ResourceSampler,
    output_dir: Path,
    chunk_size: int,
    phases: list[dict[str, Any]],
) -> dict[str, Any]:
    begin_phase(torch_module, sampler)
    set_seed(torch_module)
    torch_module.cuda.synchronize()
    started = time.perf_counter()
    generator = model.generate_custom_voice_streaming(
        text=TEXT,
        speaker=SPEAKER,
        language=LANGUAGE,
        non_streaming_mode=True,
        max_new_tokens=MAX_NEW_TOKENS,
        min_new_tokens=2,
        temperature=0.9,
        top_k=50,
        top_p=1.0,
        do_sample=True,
        repetition_penalty=1.05,
        chunk_size=chunk_size,
    )
    chunks: list[Any] = []
    records: list[dict[str, Any]] = []
    sample_rate: int | None = None
    first_audio_seconds: float | None = None
    try:
        for index, (chunk, current_rate, timing) in enumerate(generator):
            observed = time.perf_counter() - started
            if sample_rate is None:
                sample_rate = int(current_rate)
            elif int(current_rate) != sample_rate:
                raise ValueError(f"stream changed sample rate from {sample_rate} to {current_rate}")
            values = audio_array(chunk, numpy_module)
            if first_audio_seconds is None:
                first_audio_seconds = observed
            chunks.append(values)
            records.append(
                chunk_record(index, values, sample_rate, observed, dict(timing), numpy_module)
            )
    finally:
        generator.close()
    torch_module.cuda.synchronize()
    finished = time.perf_counter()
    if not chunks or sample_rate is None or first_audio_seconds is None:
        raise ValueError("stream produced no non-empty audio packet")
    audio = numpy_module.concatenate(chunks)
    audio_info = write_wav(output_dir, label, audio, numpy_module, sample_rate)
    processing_seconds = finished - started
    phase_memory = end_phase(torch_module, sampler)
    phases.append({"label": label, **phase_memory})
    total_samples = sum(record["samples"] for record in records)
    if total_samples != len(audio):
        raise ValueError("stream chunk sample count does not equal concatenated audio")
    return {
        "label": label,
        "text": TEXT,
        "speaker": SPEAKER,
        "language": LANGUAGE,
        "chunkSizeCodecSteps": chunk_size,
        "chunkCount": len(records),
        "nonEmptyChunkCount": sum(record["samples"] > 0 for record in records),
        "firstPacketSamples": records[0]["samples"],
        "firstPacketDurationSeconds": records[0]["durationSeconds"],
        "requestToFirstAudioSeconds": first_audio_seconds,
        "firstAudioObservation": "first_non_empty_generator_yield",
        "totalProcessingSeconds": processing_seconds,
        "streaming": True,
        "trueChunkedStreaming": len(records) > 1 and first_audio_seconds < processing_seconds,
        "chunks": records,
        "audio": audio_info,
        "timing": timing_summary(processing_seconds, audio_info["durationSeconds"]),
        "memory": phase_memory,
    }


def run_buffered(
    *,
    label: str,
    model: Any,
    torch_module: Any,
    numpy_module: Any,
    sampler: ResourceSampler,
    output_dir: Path,
    phases: list[dict[str, Any]],
) -> dict[str, Any]:
    begin_phase(torch_module, sampler)
    set_seed(torch_module)
    torch_module.cuda.synchronize()
    started = time.perf_counter()
    audio_list, sample_rate = model.generate_custom_voice(
        text=TEXT,
        speaker=SPEAKER,
        language=LANGUAGE,
        non_streaming_mode=True,
        max_new_tokens=MAX_NEW_TOKENS,
        min_new_tokens=2,
        temperature=0.9,
        top_k=50,
        top_p=1.0,
        do_sample=True,
        repetition_penalty=1.05,
    )
    torch_module.cuda.synchronize()
    finished = time.perf_counter()
    if not audio_list:
        raise ValueError("buffered generation returned no waveform")
    audio = audio_array(audio_list[0], numpy_module)
    audio_info = write_wav(output_dir, label, audio, numpy_module, int(sample_rate))
    phase_memory = end_phase(torch_module, sampler)
    phases.append({"label": label, **phase_memory})
    processing_seconds = finished - started
    return {
        "label": label,
        "text": TEXT,
        "speaker": SPEAKER,
        "language": LANGUAGE,
        "requestToFirstAudioSeconds": processing_seconds,
        "firstAudioObservation": "generate_custom_voice_return",
        "totalProcessingSeconds": processing_seconds,
        "streaming": False,
        "trueChunkedStreaming": False,
        "audio": audio_info,
        "timing": timing_summary(processing_seconds, audio_info["durationSeconds"]),
        "memory": phase_memory,
    }


def run_ttfa_sweep(
    *,
    model: Any,
    torch_module: Any,
    numpy_module: Any,
    sampler: ResourceSampler,
    chunk_sizes: Iterable[int],
    repetitions: int,
    phases: list[dict[str, Any]],
) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for chunk_size in chunk_sizes:
        observations: list[dict[str, Any]] = []
        for repetition in range(repetitions):
            begin_phase(torch_module, sampler)
            set_seed(torch_module)
            torch_module.cuda.synchronize()
            started = time.perf_counter()
            generator = model.generate_custom_voice_streaming(
                text=TEXT,
                speaker=SPEAKER,
                language=LANGUAGE,
                non_streaming_mode=True,
                max_new_tokens=MAX_NEW_TOKENS,
                min_new_tokens=2,
                temperature=0.9,
                top_k=50,
                top_p=1.0,
                do_sample=True,
                repetition_penalty=1.05,
                chunk_size=chunk_size,
            )
            try:
                chunk, sample_rate, timing = next(generator)
            finally:
                generator.close()
            torch_module.cuda.synchronize()
            elapsed = time.perf_counter() - started
            values = audio_array(chunk, numpy_module)
            if int(sample_rate) != SAMPLE_RATE:
                raise ValueError(f"stream returned sample rate {sample_rate}, expected {SAMPLE_RATE}")
            if values.size == 0:
                raise ValueError("TTFA probe returned an empty first packet")
            phase_memory = end_phase(torch_module, sampler)
            phases.append({
                "label": f"ttfa-chunk-{chunk_size}-run-{repetition + 1}",
                **phase_memory,
            })
            observations.append(
                {
                    "run": repetition + 1,
                    "ttfaSeconds": elapsed,
                    "ttfaMilliseconds": elapsed * 1000,
                    "firstPacketSamples": int(values.size),
                    "firstPacketDurationSeconds": values.size / int(sample_rate),
                    "sampleRate": int(sample_rate),
                    "timing": dict(timing),
                }
            )
        values_ms = [item["ttfaMilliseconds"] for item in observations]
        mean_ms = sum(values_ms) / len(values_ms)
        variance = sum((value - mean_ms) ** 2 for value in values_ms) / len(values_ms)
        results[str(chunk_size)] = {
            "chunkSizeCodecSteps": chunk_size,
            "runs": observations,
            "meanMilliseconds": mean_ms,
            "stddevMilliseconds": variance**0.5,
        }
    return results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument(
        "--faster-repo",
        type=Path,
        default=Path(os.environ.get("FASTER_QWEN3_TTS_REPO", "/tmp/faster-qwen3-tts")),
    )
    parser.add_argument("--ttfa-repetitions", type=int, default=3)
    return parser.parse_args()


def default_output_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return ROOT / "benchmarks/results" / f"faster-qwen3-tts-cuda-spike-{stamp}"


def main() -> int:
    args = parse_args()
    if args.ttfa_repetitions < 1:
        raise SystemExit("--ttfa-repetitions must be positive")
    output_dir = (args.output_dir or default_output_dir()).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    process_started = time.perf_counter()
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "in_progress",
        "startedAt": utc_now(),
        "outputDir": str(output_dir),
        "source": {},
        "model": {
            "id": MODEL_ID,
            "revision": MODEL_REVISION,
            "path": str(MODEL_DIR.resolve()),
        },
        "contract": {
            "device": DEVICE,
            "dtype": DTYPE_NAME,
            "attnImplementation": ATTENTION,
            "sampleRate": SAMPLE_RATE,
            "outputFormat": "pcm_s16le_mono",
            "channels": 1,
            "sampleWidthBytes": 2,
            "speaker": SPEAKER,
            "language": LANGUAGE,
            "text": TEXT,
            "chunkSizeCodecSteps": CHUNK_SIZE,
            "maxNewTokens": MAX_NEW_TOKENS,
            "seed": SEED,
            "rtfConvention": "processing seconds / generated audio seconds; below 1.0 is faster than real time",
        },
        "compatibility": {
            "pinnedRuntimeAttempted": True,
            "compatibilityDeviation": None,
            "deviationReason": None,
        },
        "notes": [
            "Torch backend only; the optional GGML/qwentts.cpp backend was not installed or used.",
            "No franken_tts code, runtime, or subprocess was used.",
            "The source implementation uses StaticCache-style fixed CUDA-graph buffers for the talker and predictor, then yields decoded PCM chunks from a Python generator.",
            "The upstream API's README reports audio/processing as RTF; this artifact reports processing/audio to match the project QW-2 convention and includes the reciprocal.",
        ],
    }
    sampler: ResourceSampler | None = None
    phases: list[dict[str, Any]] = []
    try:
        result["source"] = git_identity(args.faster_repo)
        verified = verify_manifest_assets()
        result["model"]["manifestPath"] = str(MANIFEST_PATH.resolve())
        result["model"]["manifestAssets"] = verified["assets"]
        result["model"]["manifestEntry"] = {
            "license": verified["entry"].get("license"),
            "licenseUrl": verified["entry"].get("licenseUrl"),
            "upstreamUrl": verified["entry"].get("upstreamUrl"),
        }

        import numpy as np
        import soundfile as sf  # noqa: F401  # verifies the installed audio writer
        import torch
        from faster_qwen3_tts import FasterQwen3TTS

        result["runtime"] = {
            "python": sys.version,
            "pythonExecutable": sys.executable,
            "platform": platform.platform(),
            "kernel": platform.release(),
            "fasterQwen3Tts": package_version("faster-qwen3-tts"),
            "qwenTts": package_version("qwen-tts"),
            "transformers": package_version("transformers"),
            "accelerate": package_version("accelerate"),
            "torch": torch.__version__,
            "torchCuda": torch.version.cuda,
            "cudnn": torch.backends.cudnn.version(),
            "numpy": np.__version__,
            "soundfile": package_version("soundfile"),
            "qwenRequirementsLock": str(QWEN_LOCK.resolve()),
            "qwenRequirementsLockSha256": sha256_file(QWEN_LOCK),
            "pid": os.getpid(),
        }
        result["hardware"] = {
            "nvidiaSmiBefore": run_nvidia_query(
                "name,driver_version,memory.total,memory.used,memory.free"
            ),
        }
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable in the pinned runtime")
        properties = torch.cuda.get_device_properties(0)
        capability = tuple(torch.cuda.get_device_capability(0))
        if capability != (8, 9):
            raise RuntimeError(f"expected RTX 4090 sm_89, got {capability}")
        result["hardware"].update(
            {
                "torchDevice": torch.cuda.get_device_name(0),
                "computeCapability": list(capability),
                "totalMemoryBytes": int(properties.total_memory),
            }
        )

        sampler = ResourceSampler(torch)
        sampler.start()
        torch.cuda.empty_cache()
        begin_phase(torch, sampler)
        prepare_started = time.perf_counter()
        model = FasterQwen3TTS.from_pretrained(
            str(MODEL_DIR.resolve()),
            device=DEVICE,
            dtype=torch.bfloat16,
            attn_implementation=ATTENTION,
            max_seq_len=2048,
        )
        torch.cuda.synchronize()
        prepare_finished = time.perf_counter()
        prepare_memory = end_phase(torch, sampler)
        phases.append({"label": "prepare", **prepare_memory})
        result["timing"] = {
            "processStartToPrepareReadySeconds": prepare_finished - process_started,
            "prepareSeconds": prepare_finished - prepare_started,
            "prepareEnd": utc_now(),
        }
        result["prepareMemory"] = prepare_memory

        result["observations"] = {}
        result["observations"]["coldStreaming"] = run_streaming(
            label="cold-streaming",
            model=model,
            torch_module=torch,
            numpy_module=np,
            sampler=sampler,
            output_dir=output_dir,
            chunk_size=CHUNK_SIZE,
            phases=phases,
        )
        result["observations"]["warmStreaming"] = run_streaming(
            label="warm-streaming",
            model=model,
            torch_module=torch,
            numpy_module=np,
            sampler=sampler,
            output_dir=output_dir,
            chunk_size=CHUNK_SIZE,
            phases=phases,
        )
        result["observations"]["warmBuffered"] = run_buffered(
            label="warm-buffered",
            model=model,
            torch_module=torch,
            numpy_module=np,
            sampler=sampler,
            output_dir=output_dir,
            phases=phases,
        )
        result["observations"]["warmTtfaSweep"] = run_ttfa_sweep(
            model=model,
            torch_module=torch,
            numpy_module=np,
            sampler=sampler,
            chunk_sizes=(1, 4, 8, 12),
            repetitions=args.ttfa_repetitions,
            phases=phases,
        )
        result["resources"] = {
            "phasePeaks": phases,
            "peakVramBytes": max(item["torchCudaMaxMemoryReservedBytes"] for item in phases),
            "peakVramSource": "max(torch.cuda.max_memory_reserved) across prepare and measured phases",
            "peakVramAllocatedBytes": max(
                item["torchCudaMaxMemoryAllocatedBytes"] for item in phases
            ),
            "peakRssBytes": max(
                resource_max_rss_bytes(), *(item["rssSamplerPeakBytes"] for item in phases)
            ),
            "peakRssSource": "max(/proc VmRSS sampler, resource.RUSAGE_SELF.ru_maxrss)",
            "rssScope": "whole spike process including imports, model prepare, graph capture, and synthesis",
        }
        result["hardware"]["nvidiaSmiAfter"] = run_nvidia_query(
            "name,driver_version,memory.total,memory.used,memory.free"
        )
        result["status"] = "passed"
        result["finishedAt"] = utc_now()
    except BaseException as error:
        result["status"] = "infeasible"
        result["finishedAt"] = utc_now()
        result["failure"] = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
            "fallback": "Keep Kokoro as production fallback; do not use franken_tts.",
        }
        if phases and "resources" not in result:
            result["resources"] = {"phasePeaks": phases}
        print(json.dumps(result, indent=2), file=sys.stderr)
    finally:
        if sampler is not None:
            try:
                sampler.close()
            except BaseException as error:
                result.setdefault("failure", {})["samplerCloseError"] = repr(error)
                result["status"] = "infeasible"
            if "resources" in result:
                result["resources"]["peakRssBytes"] = max(
                    result["resources"].get("peakRssBytes", 0),
                    sampler.max_rss,
                    resource_max_rss_bytes(),
                )
        (output_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    if result["status"] == "passed":
        print(json.dumps(result, indent=2))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
