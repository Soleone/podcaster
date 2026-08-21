#!/usr/bin/env python3
"""Validate faster-qwen3-tts Base voice cloning on the pinned WSL RTX 4090.

This is an evaluation-only experiment. It uses the official Qwen3-TTS Base
model, the pinned faster-qwen3-tts Torch backend, a licensed LibriSpeech
reference recording, and the pinned CUDA 13 / torch 2.12.1 environment. It
records prompt extraction and serialization, x-vector and ICL cloning, native
streaming packets, a bounded realtime consumer, PCM validity, resource peaks,
and every failure in one JSON artifact.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import queue
import resource
import subprocess
import sys
import threading
import time
import traceback
from typing import Any
import wave

ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODEL_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
MODEL_DIR = ROOT / "models/qwen3-tts-12hz-0.6b-base"
MANIFEST_PATH = ROOT / "services/audio/config/model-manifest.json"
QWEN_LOCK = ROOT / "services/audio/qwen-requirements.lock"
REFERENCE_MANIFEST_PATH = ROOT / "benchmarks/datasets/librispeech-t3.manifest.json"
REFERENCE_SOURCE_ID = "1284-1180-0000-clean"
REFERENCE_PATH = ROOT / "benchmarks/datasets/librispeech-t3/media/item-005-clean.wav"
FASTER_REPO_COMMIT = "a70afc0f81f7f5f8801c3227968f1102f43f211c"
QWEN_LOCK_SHA256 = "1855d1a144fdde4fb026a16302e73203d832fccae8155a6f77d40196d40142ab"
PINNED_MODEL_ASSETS = {
    ".gitattributes": "11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361",
    "README.md": "181187b6057906bd960bc7f938d0b7a16652509776a0d52c4885b4ae5ccda0ea",
    "config.json": "2e714c787c8edb98b05432685cddb634add2de4d4e645f653d68251ef72ba011",
    "generation_config.json": "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa",
    "merges.txt": "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3",
    "model.safetensors": "180b3b10eb1c9f1b4db7806d5475bae3071c0243c299d49926bab1da3b6946f6",
    "preprocessor_config.json": "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119",
    "speech_tokenizer/config.json": "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167",
    "speech_tokenizer/configuration.json": "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd",
    "speech_tokenizer/model.safetensors": "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
    "speech_tokenizer/preprocessor_config.json": "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb",
    "tokenizer_config.json": "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670",
    "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
}
SAMPLE_RATE = 24_000
LANGUAGE = "English"
DTYPE_NAME = "bfloat16"
ATTENTION = "eager"
DEVICE = "cuda"
CHUNK_SIZE = 8
MAX_NEW_TOKENS = 160
MIN_NEW_TOKENS = 128
SEED = 4090
RESPONSE_TEXT = (
    "This local voice cloning benchmark measures whether a queue-backed stream can stay "
    "ahead of real-time playback for ten seconds without dropping audio or falling behind. "
    "The result is recorded as signed PCM sixteen little-endian mono audio at twenty-four "
    "kilohertz, with the prompt, timing, resource, and failure evidence kept together."
)


class BenchmarkFailure(RuntimeError):
    """A failure with a stable category for the artifact."""

    def __init__(self, category: str, message: str) -> None:
        super().__init__(message)
        self.category = category


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
        raise BenchmarkFailure("source", f"faster-qwen3-tts source is not a git checkout: {repo}")
    commit = run_command(["git", "rev-parse", "HEAD"], cwd=repo)
    if not commit:
        raise BenchmarkFailure("source", f"could not resolve faster-qwen3-tts commit: {repo}")
    status = run_command(["git", "status", "--porcelain"], cwd=repo) or ""
    identity = {
        "path": str(repo),
        "remoteOrigin": run_command(["git", "remote", "get-url", "origin"], cwd=repo),
        "commit": commit,
        "expectedCommit": FASTER_REPO_COMMIT,
        "describe": run_command(["git", "describe", "--tags", "--always", "--dirty"], cwd=repo),
        "statusPorcelain": status,
        "packageVersion": package_version("faster-qwen3-tts"),
        "license": "MIT",
        "licensePath": str(repo / "LICENSE"),
        "licenseSha256": sha256_file(repo / "LICENSE"),
    }
    if commit != FASTER_REPO_COMMIT:
        raise BenchmarkFailure("source_revision", f"expected faster-qwen3-tts {FASTER_REPO_COMMIT}, got {commit}")
    if status:
        raise BenchmarkFailure("source_dirty", f"faster-qwen3-tts checkout is dirty: {status!r}")
    return identity


def verify_manifest_assets() -> dict[str, Any]:
    manifest = json.loads(MANIFEST_PATH.read_text())
    entries = [entry for entry in manifest["models"] if entry.get("id") == MODEL_ID]
    if len(entries) != 1:
        raise BenchmarkFailure("model_manifest", "manifest does not contain exactly one pinned Base entry")
    entry = entries[0]
    expected_model_path = "models/qwen3-tts-12hz-0.6b-base/model.safetensors"
    expected_runtime_path = "models/qwen3-tts-12hz-0.6b-base"
    expected_license_url = (
        "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/"
        f"blob/{MODEL_REVISION}/README.md"
    )
    expected_upstream_url = (
        "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/"
        f"tree/{MODEL_REVISION}"
    )
    if entry.get("revision") != MODEL_REVISION:
        raise BenchmarkFailure("model_revision", "Base model revision does not match the pinned spike revision")
    if entry.get("license") != "Apache-2.0":
        raise BenchmarkFailure("model_license", f"unexpected Base model license: {entry.get('license')!r}")
    if entry.get("path") != expected_model_path or entry.get("runtimePath") != expected_runtime_path:
        raise BenchmarkFailure("model_path", "manifest Base paths do not match the canonical local snapshot")
    if entry.get("sha256") != PINNED_MODEL_ASSETS["model.safetensors"]:
        raise BenchmarkFailure("model_hash", "manifest Base primary model hash is not the pinned digest")
    if entry.get("licenseUrl") != expected_license_url or entry.get("upstreamUrl") != expected_upstream_url:
        raise BenchmarkFailure("model_provenance", "manifest Base provenance URLs are not pinned")
    actual_lock_hash = sha256_file(QWEN_LOCK)
    if entry.get("runtimeLockSha256") != QWEN_LOCK_SHA256 or actual_lock_hash != QWEN_LOCK_SHA256:
        raise BenchmarkFailure("runtime_lock", "Qwen runtime lock hash does not match the pinned digest")

    if len(entry.get("files", [])) != len(PINNED_MODEL_ASSETS):
        raise BenchmarkFailure("model_manifest", "manifest Base asset count differs from the pinned set")
    manifest_assets = {
        asset.get("path"): asset.get("sha256") for asset in entry.get("files", [])
    }
    expected_manifest_assets = {
        f"models/qwen3-tts-12hz-0.6b-base/{relative}": digest
        for relative, digest in PINNED_MODEL_ASSETS.items()
    }
    if manifest_assets != expected_manifest_assets:
        raise BenchmarkFailure("model_manifest", "manifest Base asset set or digest differs from the pinned set")

    checked: list[dict[str, Any]] = []
    for relative, expected in PINNED_MODEL_ASSETS.items():
        path = (MODEL_DIR / relative).resolve()
        if not path.is_file():
            raise BenchmarkFailure("model_asset", f"missing pinned Base asset: {path}")
        actual = sha256_file(path)
        if actual != expected:
            raise BenchmarkFailure("model_hash", f"pinned Base asset hash mismatch: {path}")
        checked.append({"path": str(path), "sha256": actual, "bytes": path.stat().st_size})
    return {
        "manifestSha256": sha256_file(MANIFEST_PATH),
        "entry": entry,
        "assets": checked,
        "runtimeLockSha256": actual_lock_hash,
    }


def verify_reference() -> dict[str, Any]:
    manifest = json.loads(REFERENCE_MANIFEST_PATH.read_text())
    matches = [item for item in manifest["items"] if item.get("sourceId") == REFERENCE_SOURCE_ID]
    if len(matches) != 1:
        raise BenchmarkFailure("reference_manifest", "reference source ID is not unique")
    item = matches[0]
    path = (ROOT / item["path"]).resolve()
    if path != REFERENCE_PATH.resolve():
        raise BenchmarkFailure("reference_manifest", f"reference path mismatch: {path}")
    if not path.is_file():
        raise BenchmarkFailure("reference_asset", f"missing licensed reference recording: {path}")
    actual_hash = sha256_file(path)
    if actual_hash != item["sha256"]:
        raise BenchmarkFailure("reference_hash", f"reference SHA-256 mismatch: {path}")
    with wave.open(str(path), "rb") as source:
        params = source.getparams()
        pcm = source.readframes(source.getnframes())
    if params.nchannels != 1 or params.sampwidth != 2 or params.framerate != 16_000:
        raise BenchmarkFailure("reference_format", f"reference is not 16 kHz mono PCM16LE: {params}")
    return {
        "manifestPath": str(REFERENCE_MANIFEST_PATH.resolve()),
        "manifestSha256": sha256_file(REFERENCE_MANIFEST_PATH),
        "source": manifest["source"],
        "license": manifest["license"],
        "licenseUrl": manifest["licenseUrl"],
        "acquisitionCommand": manifest["acquisitionCommand"],
        "archiveSha256": manifest["archiveSha256"],
        "sourceId": item["sourceId"],
        "path": str(path),
        "sha256": actual_hash,
        "bytes": len(pcm),
        "sampleRate": params.framerate,
        "channels": params.nchannels,
        "sampleWidthBytes": params.sampwidth,
        "samples": params.nframes,
        "durationSeconds": params.nframes / params.framerate,
        "transcript": item["reference"],
        "coverage": item.get("coverage", []),
    }


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
            name="faster-qwen3-tts-base-resource-sampler",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            if self._thread.is_alive():
                raise BenchmarkFailure("resource_sampler", "resource sampler did not stop")
        self.sample()

    def phase_peak(self, allocated: int = 0, reserved: int = 0) -> dict[str, int]:
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


def safe_end_phase(torch_module: Any, sampler: ResourceSampler) -> dict[str, int]:
    try:
        return end_phase(torch_module, sampler)
    except (RuntimeError, AssertionError):
        return sampler.phase_peak()


def set_seed(torch_module: Any, numpy_module: Any) -> None:
    torch_module.manual_seed(SEED)
    torch_module.cuda.manual_seed_all(SEED)
    numpy_module.random.seed(SEED)


def to_cpu(value: Any, torch_module: Any) -> Any:
    if isinstance(value, torch_module.Tensor):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {key: to_cpu(item, torch_module) for key, item in value.items()}
    if isinstance(value, list):
        return [to_cpu(item, torch_module) for item in value]
    if isinstance(value, tuple):
        return tuple(to_cpu(item, torch_module) for item in value)
    return value


def to_device(value: Any, torch_module: Any, device: str) -> Any:
    if isinstance(value, torch_module.Tensor):
        return value.to(device)
    if isinstance(value, dict):
        return {key: to_device(item, torch_module, device) for key, item in value.items()}
    if isinstance(value, list):
        return [to_device(item, torch_module, device) for item in value]
    if isinstance(value, tuple):
        return tuple(to_device(item, torch_module, device) for item in value)
    return value


def tensor_descriptor(value: Any, torch_module: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, torch_module.Tensor):
        return {"type": type(value).__name__, "value": str(value)}
    cpu = value.detach().cpu().contiguous()
    raw = cpu.view(torch_module.uint8).numpy().tobytes()
    return {
        "type": "torch.Tensor",
        "shape": list(cpu.shape),
        "dtype": str(cpu.dtype),
        "numel": int(cpu.numel()),
        "bytes": len(raw),
        "sha256": sha256_bytes(raw),
        "deviceAtCapture": str(value.device),
    }


def prompt_descriptor(prompt: dict[str, Any], torch_module: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in prompt.items():
        if isinstance(value, list):
            result[key] = [tensor_descriptor(item, torch_module) for item in value]
        else:
            result[key] = tensor_descriptor(value, torch_module)
    return result


def audio_array(value: Any, numpy_module: Any) -> Any:
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    values = numpy_module.asarray(value, dtype=numpy_module.float32).reshape(-1)
    if values.size == 0:
        raise BenchmarkFailure("audio_empty", "faster-qwen3-tts returned an empty audio chunk")
    if not numpy_module.isfinite(values).all():
        raise BenchmarkFailure("audio_nonfinite", "faster-qwen3-tts returned non-finite audio")
    peak = float(numpy_module.max(numpy_module.abs(values)))
    if peak > 1.0:
        raise BenchmarkFailure("audio_range", f"audio chunk exceeds PCM range: peak={peak}")
    return values


def pcm16le(values: Any, numpy_module: Any) -> bytes:
    values = audio_array(values, numpy_module)
    return numpy_module.rint(numpy_module.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def write_wav(
    output_dir: Path,
    label: str,
    values: Any,
    numpy_module: Any,
    sample_rate: int,
) -> dict[str, Any]:
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
        raise BenchmarkFailure("pcm_format", f"invalid output WAV format: {params}")
    if reopened_pcm != pcm or len(pcm) == 0 or len(pcm) % 2:
        raise BenchmarkFailure("pcm_payload", "WAV payload does not match PCM16LE bytes")
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
        raise BenchmarkFailure("audio_empty", "cannot calculate RTF for empty audio")
    if processing_seconds <= 0:
        raise BenchmarkFailure("timing", "processing time was not positive")
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
    steps = int(timing.get("chunk_steps", 0))
    return {
        "index": index,
        "codecSteps": steps,
        "samples": int(len(values)),
        "durationSeconds": float(len(values) / sample_rate),
        "sampleRate": sample_rate,
        "pcmBytes": len(pcm),
        "pcmSha256": sha256_bytes(pcm),
        "observedSeconds": float(observed_seconds),
        "timing": timing,
    }


def native_chunk_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    durations = [float(item["durationSeconds"]) for item in records]
    samples_per_step = [
        item["samples"] / item["codecSteps"]
        for item in records
        if item["codecSteps"] > 0
    ]
    durations_sorted = sorted(durations)
    middle = durations_sorted[len(durations_sorted) // 2]
    return {
        "chunkCount": len(records),
        "durationsSeconds": durations,
        "medianDurationSeconds": middle,
        "minDurationSeconds": min(durations),
        "maxDurationSeconds": max(durations),
        "samplesPerCodecStep": sum(samples_per_step) / len(samples_per_step),
        "codecFrameRateHz": SAMPLE_RATE / (sum(samples_per_step) / len(samples_per_step)),
        "contractChunkSizeCodecSteps": CHUNK_SIZE,
    }


def make_generation_kwargs(
    *,
    text: str,
    language: str,
    xvec_only: bool,
    ref_audio: str | None,
    ref_text: str,
    voice_clone_prompt: dict[str, Any] | None,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "text": text,
        "language": language,
        "ref_audio": ref_audio,
        "ref_text": ref_text,
        "max_new_tokens": MAX_NEW_TOKENS,
        "min_new_tokens": MIN_NEW_TOKENS,
        "temperature": 0.9,
        "top_k": 50,
        "top_p": 1.0,
        "do_sample": True,
        "repetition_penalty": 1.05,
        "xvec_only": xvec_only,
        "non_streaming_mode": False,
        "voice_clone_prompt": voice_clone_prompt,
    }
    return kwargs


def run_streaming(
    *,
    label: str,
    model: Any,
    torch_module: Any,
    numpy_module: Any,
    sampler: ResourceSampler,
    output_dir: Path,
    phases: list[dict[str, Any]],
    kwargs: dict[str, Any],
    chunk_size: int = CHUNK_SIZE,
) -> dict[str, Any]:
    begin_phase(torch_module, sampler)
    set_seed(torch_module, numpy_module)
    torch_module.cuda.synchronize()
    started = time.perf_counter()
    generator = model.generate_voice_clone_streaming(**kwargs, chunk_size=chunk_size)
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
                raise BenchmarkFailure(
                    "pcm_format", f"stream changed sample rate from {sample_rate} to {current_rate}"
                )
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
        raise BenchmarkFailure("stream_empty", "voice-clone stream produced no non-empty audio packet")
    audio = numpy_module.concatenate(chunks)
    audio_info = write_wav(output_dir, label, audio, numpy_module, sample_rate)
    processing_seconds = finished - started
    phase_memory = end_phase(torch_module, sampler)
    phases.append({"label": label, "status": "passed", **phase_memory})
    total_samples = sum(record["samples"] for record in records)
    if total_samples != len(audio):
        raise BenchmarkFailure("chunk_accounting", "stream chunk samples do not equal concatenated audio")
    if sample_rate != SAMPLE_RATE:
        raise BenchmarkFailure("pcm_format", f"stream returned {sample_rate} Hz, expected {SAMPLE_RATE}")
    return {
        "label": label,
        "mode": "x-vector" if kwargs["xvec_only"] else "icl",
        "promptRoute": "serialized" if kwargs["voice_clone_prompt"] is not None else "reference_audio",
        "text": kwargs["text"],
        "referenceTranscriptUsed": kwargs["ref_text"] if not kwargs["xvec_only"] else None,
        "language": kwargs["language"],
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
        "nativeChunks": native_chunk_summary(records),
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
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    begin_phase(torch_module, sampler)
    set_seed(torch_module, numpy_module)
    torch_module.cuda.synchronize()
    started = time.perf_counter()
    audio_list, sample_rate = model.generate_voice_clone(**kwargs)
    torch_module.cuda.synchronize()
    finished = time.perf_counter()
    if not audio_list:
        raise BenchmarkFailure("stream_empty", "buffered generation returned no waveform")
    audio = audio_array(audio_list[0], numpy_module)
    audio_info = write_wav(output_dir, label, audio, numpy_module, int(sample_rate))
    phase_memory = end_phase(torch_module, sampler)
    phases.append({"label": label, "status": "passed", **phase_memory})
    processing_seconds = finished - started
    return {
        "label": label,
        "mode": "x-vector" if kwargs["xvec_only"] else "icl",
        "promptRoute": "serialized" if kwargs["voice_clone_prompt"] is not None else "reference_audio",
        "text": kwargs["text"],
        "referenceTranscriptUsed": kwargs["ref_text"] if not kwargs["xvec_only"] else None,
        "language": kwargs["language"],
        "requestToFirstAudioSeconds": processing_seconds,
        "firstAudioObservation": "generate_voice_clone_return",
        "totalProcessingSeconds": processing_seconds,
        "streaming": False,
        "trueChunkedStreaming": False,
        "audio": audio_info,
        "timing": timing_summary(processing_seconds, audio_info["durationSeconds"]),
        "memory": phase_memory,
    }


def run_ttfa_probe(
    *,
    label: str,
    model: Any,
    torch_module: Any,
    numpy_module: Any,
    sampler: ResourceSampler,
    phases: list[dict[str, Any]],
    kwargs: dict[str, Any],
    chunk_size: int,
) -> dict[str, Any]:
    begin_phase(torch_module, sampler)
    set_seed(torch_module, numpy_module)
    torch_module.cuda.synchronize()
    started = time.perf_counter()
    generator = model.generate_voice_clone_streaming(**kwargs, chunk_size=chunk_size)
    try:
        chunk, sample_rate, timing = next(generator)
    finally:
        generator.close()
    torch_module.cuda.synchronize()
    elapsed = time.perf_counter() - started
    values = audio_array(chunk, numpy_module)
    if int(sample_rate) != SAMPLE_RATE:
        raise BenchmarkFailure("pcm_format", f"TTFA probe returned {sample_rate} Hz, expected {SAMPLE_RATE}")
    phase_memory = end_phase(torch_module, sampler)
    phases.append({"label": label, "status": "passed", **phase_memory})
    return {
        "chunkSizeCodecSteps": chunk_size,
        "ttfaSeconds": elapsed,
        "ttfaMilliseconds": elapsed * 1000,
        "firstPacketSamples": int(values.size),
        "firstPacketDurationSeconds": float(values.size / int(sample_rate)),
        "sampleRate": int(sample_rate),
        "timing": dict(timing),
        "memory": phase_memory,
    }


def run_queue_stream(
    *,
    label: str,
    model: Any,
    torch_module: Any,
    numpy_module: Any,
    sampler: ResourceSampler,
    output_dir: Path,
    phases: list[dict[str, Any]],
    kwargs: dict[str, Any],
    queue_capacity: int,
) -> dict[str, Any]:
    """Run a pull-based generator behind a bounded producer/consumer queue."""
    begin_phase(torch_module, sampler)
    set_seed(torch_module, numpy_module)
    torch_module.cuda.synchronize()
    started = time.perf_counter()
    packets: queue.Queue[Any] = queue.Queue(maxsize=queue_capacity)
    sentinel = object()
    producer_error: list[BaseException] = []
    produced_records: list[dict[str, Any]] = []
    packet_values: list[Any] = []
    producer_finished_at: float | None = None
    generator_processing_seconds = 0.0
    enqueue_backpressure_seconds = 0.0
    producer_generated_samples = 0
    high_water_chunks = 0
    state_lock = threading.Lock()
    playback_state: dict[str, Any] = {
        "startedAt": None,
        "consumedSamples": 0,
        "underrunCount": 0,
        "underrunSeconds": 0.0,
        "maxAheadSeconds": 0.0,
        "minAheadSeconds": None,
        "deadlineLatenessSeconds": [],
        "consumedPackets": 0,
    }

    def producer() -> None:
        nonlocal enqueue_backpressure_seconds, generator_processing_seconds
        nonlocal producer_finished_at, producer_generated_samples, high_water_chunks
        generator = None
        index = 0
        try:
            generator = model.generate_voice_clone_streaming(**kwargs, chunk_size=CHUNK_SIZE)
            while True:
                next_started = time.perf_counter()
                try:
                    chunk, current_rate, timing = next(generator)
                except StopIteration:
                    break
                generator_processing_seconds += time.perf_counter() - next_started
                observed = time.perf_counter() - started
                if int(current_rate) != SAMPLE_RATE:
                    raise BenchmarkFailure("pcm_format", f"queue stream returned {current_rate} Hz")
                values = audio_array(chunk, numpy_module)
                record = chunk_record(index, values, SAMPLE_RATE, observed, dict(timing), numpy_module)
                with state_lock:
                    producer_generated_samples += int(values.size)
                    produced_records.append(record)
                    packet_values.append(values)
                put_started = time.perf_counter()
                packet = {
                    "values": values,
                    "record": record,
                    "enqueuedAt": 0.0,
                    "ready": threading.Event(),
                }
                packets.put(packet)
                packet["enqueuedAt"] = time.perf_counter()
                packet["ready"].set()
                enqueue_backpressure_seconds += time.perf_counter() - put_started
                with state_lock:
                    high_water_chunks = max(high_water_chunks, packets.qsize())
                index += 1
        except BaseException as error:
            producer_error.append(error)
        finally:
            if generator is not None:
                try:
                    generator.close()
                except BaseException as error:
                    producer_error.append(error)
            producer_finished_at = time.perf_counter()
            packets.put(sentinel)

    def consumer() -> None:
        playback_cursor: float | None = None
        while True:
            item = packets.get()
            if item is sentinel:
                packets.task_done()
                break
            item["ready"].wait()
            values = item["values"]
            available_at = float(item["enqueuedAt"])
            now = time.perf_counter()
            if playback_cursor is None:
                playback_cursor = now
                playback_state["startedAt"] = now
            gap = max(0.0, available_at - playback_cursor)
            if gap > 0:
                playback_state["underrunCount"] += 1
                playback_state["underrunSeconds"] += gap
            duration = float(len(values) / SAMPLE_RATE)
            with state_lock:
                ahead_seconds = (producer_generated_samples - playback_state["consumedSamples"]) / SAMPLE_RATE
            playback_state["maxAheadSeconds"] = max(playback_state["maxAheadSeconds"], ahead_seconds)
            if playback_state["minAheadSeconds"] is None:
                playback_state["minAheadSeconds"] = ahead_seconds
            else:
                playback_state["minAheadSeconds"] = min(playback_state["minAheadSeconds"], ahead_seconds)
            playback_end = playback_cursor + duration
            time.sleep(duration)
            finished = time.perf_counter()
            playback_state["deadlineLatenessSeconds"].append(
                max(0.0, finished - playback_end)
            )
            playback_cursor = playback_end
            playback_state["consumedSamples"] += len(values)
            playback_state["consumedPackets"] += 1
            packets.task_done()

    consumer_thread = threading.Thread(target=consumer, name="base-clone-realtime-consumer")
    consumer_thread.start()
    producer()
    consumer_thread.join(timeout=max(60.0, MAX_NEW_TOKENS / 12.0 + 30.0))
    if consumer_thread.is_alive():
        raise BenchmarkFailure("queue_consumer", "queue consumer did not finish")
    torch_module.cuda.synchronize()
    finished = time.perf_counter()
    if producer_error:
        error = producer_error[0]
        if isinstance(error, BaseException):
            raise error
    if not produced_records:
        raise BenchmarkFailure("stream_empty", "queue producer yielded no audio packets")
    if producer_finished_at is None:
        raise BenchmarkFailure("queue_accounting", "queue producer did not record its completion time")
    producer_wall_seconds = producer_finished_at - started
    playback_wall_seconds = finished - started
    # The producer validates each native packet before enqueueing it and retains
    # the same arrays only long enough to write the checked full-response WAV.
    audio = numpy_module.concatenate(packet_values)
    audio_info = write_wav(output_dir, label, audio, numpy_module, SAMPLE_RATE)
    phase_memory = end_phase(torch_module, sampler)
    phases.append({"label": label, "status": "passed", **phase_memory})
    lateness = playback_state["deadlineLatenessSeconds"]
    total_audio_seconds = audio_info["durationSeconds"]
    produced_seconds = producer_generated_samples / SAMPLE_RATE
    packet_count_match = len(produced_records) == playback_state["consumedPackets"]
    sample_count_match = producer_generated_samples == playback_state["consumedSamples"]
    realtime_conformant = (
        total_audio_seconds >= 10.0
        and playback_state["underrunCount"] == 0
        and packet_count_match
        and sample_count_match
    )
    queue_result = {
        "queueCapacityChunks": queue_capacity,
        "producerWallSeconds": producer_wall_seconds,
        "generatorProcessingSeconds": generator_processing_seconds,
        "enqueueBackpressureSeconds": enqueue_backpressure_seconds,
        "playbackWallSeconds": playback_wall_seconds,
        "playbackStartDelaySeconds": (
            (playback_state["startedAt"] - started) if playback_state["startedAt"] is not None else None
        ),
        "producerGeneratedAudioSeconds": produced_seconds,
        "playbackConsumedAudioSeconds": playback_state["consumedSamples"] / SAMPLE_RATE,
        "queueHighWaterChunks": high_water_chunks,
        "queueMinAheadSeconds": playback_state["minAheadSeconds"],
        "queueMaxAheadSeconds": playback_state["maxAheadSeconds"],
        "underrunCount": playback_state["underrunCount"],
        "underrunSeconds": playback_state["underrunSeconds"],
        "droppedPackets": 0,
        "producedPackets": len(produced_records),
        "consumedPackets": playback_state["consumedPackets"],
        "packetCountMatch": packet_count_match,
        "sampleCountMatch": sample_count_match,
        "deadlineLatenessMaxSeconds": max(lateness) if lateness else 0.0,
        "deadlineLatenessP95Seconds": percentile(lateness, 0.95) if lateness else 0.0,
        "realtimeConformant": realtime_conformant,
    }
    return {
        "label": label,
        "mode": "x-vector",
        "promptRoute": "serialized",
        "text": kwargs["text"],
        "streaming": True,
        "trueChunkedStreaming": len(produced_records) > 1,
        "requestToFirstAudioSeconds": (
            produced_records[0]["observedSeconds"] if produced_records else None
        ),
        "firstPacketDurationSeconds": produced_records[0]["durationSeconds"],
        "totalProcessingSeconds": generator_processing_seconds,
        "nativeChunks": native_chunk_summary(produced_records),
        "chunks": produced_records,
        "queue": queue_result,
        "audio": audio_info,
        "timing": timing_summary(generator_processing_seconds, total_audio_seconds),
        "memory": phase_memory,
    }


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))
    return float(ordered[index])


def serialize_prompt(
    *,
    label: str,
    prompt: dict[str, Any],
    torch_module: Any,
    sampler: ResourceSampler,
    output_dir: Path,
    phases: list[dict[str, Any]],
    device: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    path = output_dir / f"{label}-prompt.pt"
    cpu_prompt = to_cpu(prompt, torch_module)
    binding = {
        "schemaVersion": 1,
        "promptMode": label,
        "modelId": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "referenceSourceId": REFERENCE_SOURCE_ID,
        "referenceSha256": sha256_file(REFERENCE_PATH),
        "fasterQwen3TtsCommit": FASTER_REPO_COMMIT,
        "qwenRequirementsLockSha256": QWEN_LOCK_SHA256,
    }
    payload = {"binding": binding, "prompt": cpu_prompt}
    phase_label = f"serialize-{label}"
    begin_phase(torch_module, sampler)
    save_started = time.perf_counter()
    torch_module.save(payload, path)
    save_seconds = time.perf_counter() - save_started
    load_started = time.perf_counter()
    loaded_payload = torch_module.load(path, map_location="cpu", weights_only=True)
    load_seconds = time.perf_counter() - load_started
    if loaded_payload.get("binding") != binding:
        raise BenchmarkFailure("prompt_serialization", f"prompt cache binding mismatch for {label}")
    loaded = loaded_payload["prompt"]
    transfer_started = time.perf_counter()
    device_prompt = to_device(loaded, torch_module, device)
    torch_module.cuda.synchronize()
    transfer_seconds = time.perf_counter() - transfer_started
    phase_memory = end_phase(torch_module, sampler)
    phases.append({"label": phase_label, "status": "passed", **phase_memory})
    loaded_cpu = to_cpu(device_prompt, torch_module)
    original_desc = prompt_descriptor(cpu_prompt, torch_module)
    loaded_desc = prompt_descriptor(loaded_cpu, torch_module)
    if original_desc != loaded_desc:
        raise BenchmarkFailure("prompt_serialization", f"prompt round-trip descriptor mismatch for {label}")
    details = {
        "label": label,
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "saveSeconds": save_seconds,
        "loadSeconds": load_seconds,
        "deviceTransferSeconds": transfer_seconds,
        "roundTripDescriptorMatch": True,
        "binding": binding,
        "prompt": original_desc,
        "memory": phase_memory,
    }
    return device_prompt, details


def extract_prompt(
    *,
    label: str,
    model: Any,
    torch_module: Any,
    numpy_module: Any,
    sampler: ResourceSampler,
    phases: list[dict[str, Any]],
    reference: dict[str, Any],
    xvec_only: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    begin_phase(torch_module, sampler)
    set_seed(torch_module, numpy_module)
    torch_module.cuda.synchronize()
    started = time.perf_counter()
    if xvec_only:
        prompt_items = model.model.create_voice_clone_prompt(
            ref_audio=str(REFERENCE_PATH),
            ref_text="",
            x_vector_only_mode=True,
        )
        effective_reference = {
            "kind": "original_wav_path",
            "path": str(REFERENCE_PATH),
            "sha256": reference["sha256"],
            "durationSeconds": reference["durationSeconds"],
        }
    else:
        audio, sample_rate = model._load_ref_audio_with_silence(
            str(REFERENCE_PATH), silence_secs=0.5
        )
        prompt_items = model.model.create_voice_clone_prompt(
            ref_audio=(audio, sample_rate),
            ref_text=reference["transcript"],
            x_vector_only_mode=False,
        )
        effective_reference = {
            "kind": "reference_plus_wrapper_silence",
            "originalSha256": reference["sha256"],
            "originalDurationSeconds": reference["durationSeconds"],
            "sampleRate": int(sample_rate),
            "samples": int(len(audio)),
            "durationSeconds": float(len(audio) / sample_rate),
            "float32PcmSha256": sha256_bytes(audio.astype("<f4").tobytes()),
            "appendedSilenceSeconds": 0.5,
        }
    prompt = model.model._prompt_items_to_voice_clone_prompt(prompt_items)
    torch_module.cuda.synchronize()
    extraction_seconds = time.perf_counter() - started
    phase_memory = end_phase(torch_module, sampler)
    phases.append({"label": f"extract-{label}", "status": "passed", **phase_memory})
    details = {
        "label": label,
        "mode": "x-vector" if xvec_only else "icl",
        "extractionSeconds": extraction_seconds,
        "reference": effective_reference,
        "prompt": prompt_descriptor(prompt, torch_module),
        "memory": phase_memory,
    }
    return prompt, details


def failure_record(label: str, error: BaseException) -> dict[str, Any]:
    return {
        "label": label,
        "type": type(error).__name__,
        "category": getattr(error, "category", "runtime"),
        "message": str(error),
        "traceback": traceback.format_exc(),
    }


def default_output_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return ROOT / "benchmarks/results" / f"faster-qwen3-tts-base-clone-{stamp}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument(
        "--faster-repo",
        type=Path,
        default=Path(os.environ.get("FASTER_QWEN3_TTS_REPO", "/tmp/faster-qwen3-tts")),
    )
    parser.add_argument("--ttfa-repetitions", type=int, default=2)
    parser.add_argument("--queue-capacity", type=int, default=4)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.ttfa_repetitions < 1:
        raise SystemExit("--ttfa-repetitions must be positive")
    if args.queue_capacity < 1:
        raise SystemExit("--queue-capacity must be positive")
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
        "reference": {},
        "contract": {
            "device": DEVICE,
            "dtype": DTYPE_NAME,
            "attnImplementation": ATTENTION,
            "sampleRate": SAMPLE_RATE,
            "outputFormat": "pcm_s16le_mono",
            "channels": 1,
            "sampleWidthBytes": 2,
            "language": LANGUAGE,
            "responseText": RESPONSE_TEXT,
            "referenceSourceId": REFERENCE_SOURCE_ID,
            "chunkSizeCodecSteps": CHUNK_SIZE,
            "maxNewTokens": MAX_NEW_TOKENS,
            "minNewTokens": MIN_NEW_TOKENS,
            "seed": SEED,
            "rtfConvention": "processing seconds / generated audio seconds; reciprocal is generated audio seconds / processing seconds",
            "realtimeGate": "at least 10 seconds generated audio, bounded queue, zero underrun packets, zero dropped packets",
        },
        "compatibility": {
            "pinnedRuntimeAttempted": True,
            "compatibilityDeviation": None,
            "deviationReason": None,
        },
        "observations": {},
        "promptExtraction": {},
        "promptSerialization": {},
        "ttfaSweep": {},
        "failures": [],
        "sourceManifestVerifiedBeforeModelLoad": False,
        "referenceManifestVerifiedBeforeModelLoad": False,
        "notes": [
            "Official Qwen/Qwen3-TTS-12Hz-0.6B-Base was used; no CustomVoice substitution was used for this task.",
            "The Torch backend of the pinned faster-qwen3-tts commit was used; the optional GGML/qwentts.cpp backend was not installed or used.",
            "No franken_tts code, runtime, or subprocess was used.",
            "The generator is pull-based, so the queue probe runs generation in a producer and consumes native packets on a bounded realtime playback clock.",
            "Kokoro remains the production fallback; this artifact is evaluation evidence only.",
        ],
    }
    sampler: ResourceSampler | None = None
    phases: list[dict[str, Any]] = []
    model: Any = None

    def attempt(label: str, callback: Callable[[], dict[str, Any]]) -> dict[str, Any] | None:
        try:
            observation = callback()
            observation["status"] = "passed"
            result["observations"][label] = observation
            return observation
        except BaseException as error:
            result["failures"].append(failure_record(label, error))
            result["observations"][label] = {
                "status": "failed",
                "label": label,
                "failure": result["failures"][-1],
            }
            return None

    try:
        result["source"] = git_identity(args.faster_repo)
        verified_model = verify_manifest_assets()
        result["sourceManifestVerifiedBeforeModelLoad"] = True
        result["model"]["manifestPath"] = str(MANIFEST_PATH.resolve())
        result["model"]["manifestSha256"] = verified_model["manifestSha256"]
        result["model"]["manifestAssets"] = verified_model["assets"]
        result["model"]["manifestEntry"] = {
            "license": verified_model["entry"].get("license"),
            "licenseUrl": verified_model["entry"].get("licenseUrl"),
            "licenseTextUrl": verified_model["entry"].get("licenseTextUrl"),
            "upstreamUrl": verified_model["entry"].get("upstreamUrl"),
        }
        reference = verify_reference()
        result["referenceManifestVerifiedBeforeModelLoad"] = True
        result["reference"] = reference

        import faster_qwen3_tts
        import numpy as np
        import qwen_tts
        import soundfile as sf  # noqa: F401  # verifies the installed audio writer
        import torch
        from faster_qwen3_tts import FasterQwen3TTS

        faster_package_path = Path(faster_qwen3_tts.__file__).resolve()
        try:
            faster_package_path.relative_to(args.faster_repo.resolve())
        except ValueError as error:
            raise BenchmarkFailure(
                "source_import",
                f"imported faster-qwen3-tts package is outside the pinned checkout: {faster_package_path}",
            ) from error
        result["source"]["importedPackagePath"] = str(faster_package_path)
        result["runtime"] = {
            "python": sys.version,
            "pythonExecutable": sys.executable,
            "platform": platform.platform(),
            "kernel": platform.release(),
            "fasterQwen3Tts": package_version("faster-qwen3-tts"),
            "fasterQwen3TtsPath": str(faster_package_path),
            "qwenTts": package_version("qwen-tts"),
            "qwenTtsPath": str(Path(qwen_tts.__file__).resolve()),
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
        expected_runtime = {
            "fasterQwen3Tts": "0.3.2",
            "qwenTts": "0.1.1",
            "transformers": "4.57.3",
            "accelerate": "1.12.0",
            "torch": "2.12.1+cu130",
            "torchCuda": "13.0",
        }
        for key, expected in expected_runtime.items():
            if result["runtime"].get(key) != expected:
                raise BenchmarkFailure(
                    "runtime_version",
                    f"expected {key}={expected}, got {result['runtime'].get(key)}",
                )
        result["hardware"] = {
            "nvidiaSmiBefore": run_nvidia_query(
                "name,driver_version,memory.total,memory.used,memory.free"
            ),
        }
        if not torch.cuda.is_available():
            raise BenchmarkFailure("runtime", "CUDA is unavailable in the pinned runtime")
        properties = torch.cuda.get_device_properties(0)
        capability = tuple(torch.cuda.get_device_capability(0))
        if capability != (8, 9):
            raise BenchmarkFailure("hardware", f"expected RTX 4090 sm_89, got {capability}")
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
            local_files_only=True,
        )
        torch.cuda.synchronize()
        prepare_finished = time.perf_counter()
        prepare_memory = end_phase(torch, sampler)
        phases.append({"label": "prepare", "status": "passed", **prepare_memory})
        result["model"]["loadedModelType"] = getattr(model.model.model, "tts_model_type", "unavailable")
        result["model"]["loadedModelSize"] = getattr(model.model.model, "tts_model_size", "unavailable")
        if result["model"]["loadedModelType"] != "base" or result["model"]["loadedModelSize"] != "0b6":
            raise BenchmarkFailure(
                "model_type",
                "loaded model is not the pinned Qwen3-TTS 0.6B Base model: "
                f"type={result['model']['loadedModelType']}, size={result['model']['loadedModelSize']}",
            )
        result["timing"] = {
            "processStartToPrepareReadySeconds": prepare_finished - process_started,
            "prepareSeconds": prepare_finished - prepare_started,
            "prepareEnd": utc_now(),
        }
        result["prepareMemory"] = prepare_memory

        xvec_prompt: dict[str, Any] | None = None
        icl_prompt: dict[str, Any] | None = None
        xvec_serialized: dict[str, Any] | None = None
        icl_serialized: dict[str, Any] | None = None

        try:
            xvec_prompt, xvec_extraction = extract_prompt(
                label="xvector",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                phases=phases,
                reference=reference,
                xvec_only=True,
            )
            result["promptExtraction"]["xvector"] = xvec_extraction
            xvec_serialized, xvec_serialization = serialize_prompt(
                label="xvector",
                prompt=xvec_prompt,
                torch_module=torch,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                device=DEVICE,
            )
            result["promptSerialization"]["xvector"] = xvec_serialization
        except BaseException as error:
            result["failures"].append(failure_record("prompt-xvector", error))

        try:
            icl_prompt, icl_extraction = extract_prompt(
                label="icl",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                phases=phases,
                reference=reference,
                xvec_only=False,
            )
            result["promptExtraction"]["icl"] = icl_extraction
            icl_serialized, icl_serialization = serialize_prompt(
                label="icl",
                prompt=icl_prompt,
                torch_module=torch,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                device=DEVICE,
            )
            result["promptSerialization"]["icl"] = icl_serialization
        except BaseException as error:
            result["failures"].append(failure_record("prompt-icl", error))

        if xvec_serialized is None:
            raise BenchmarkFailure("prompt_dependency", "x-vector prompt extraction/serialization did not complete")
        if icl_serialized is None:
            raise BenchmarkFailure("prompt_dependency", "ICL prompt extraction/serialization did not complete")

        def clone_kwargs(*, xvec: bool, prompt: dict[str, Any] | None, ref_audio: str | None) -> dict[str, Any]:
            return make_generation_kwargs(
                text=RESPONSE_TEXT,
                language=LANGUAGE,
                xvec_only=xvec,
                ref_audio=ref_audio,
                ref_text=reference["transcript"],
                voice_clone_prompt=prompt,
            )

        # The first reference-audio call exercises the wrapper's uncached path;
        # the immediately repeated path exercises its in-process prompt cache.
        model._voice_prompt_cache.clear()
        attempt(
            "xvectorUncachedStreaming",
            lambda: run_streaming(
                label="xvector-uncached-streaming",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=True, prompt=None, ref_audio=str(REFERENCE_PATH)),
            ),
        )
        attempt(
            "xvectorCachedPathStreaming",
            lambda: run_streaming(
                label="xvector-cached-path-streaming",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=True, prompt=None, ref_audio=str(REFERENCE_PATH)),
            ),
        )
        attempt(
            "xvectorSerializedStreaming",
            lambda: run_streaming(
                label="xvector-serialized-streaming",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=True, prompt=xvec_serialized, ref_audio=None),
            ),
        )
        attempt(
            "xvectorBufferedSerialized",
            lambda: run_buffered(
                label="xvector-buffered-serialized",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=True, prompt=xvec_serialized, ref_audio=None),
            ),
        )
        for repetition in range(1, 3):
            attempt(
                f"xvectorRepeatedSerialized{repetition}",
                lambda repetition=repetition: run_streaming(
                    label=f"xvector-repeated-serialized-{repetition}",
                    model=model,
                    torch_module=torch,
                    numpy_module=np,
                    sampler=sampler,
                    output_dir=output_dir,
                    phases=phases,
                    kwargs=clone_kwargs(xvec=True, prompt=xvec_serialized, ref_audio=None),
                ),
            )

        model._voice_prompt_cache.clear()
        attempt(
            "iclUncachedStreaming",
            lambda: run_streaming(
                label="icl-uncached-streaming",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=False, prompt=None, ref_audio=str(REFERENCE_PATH)),
            ),
        )
        attempt(
            "iclCachedPathStreaming",
            lambda: run_streaming(
                label="icl-cached-path-streaming",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=False, prompt=None, ref_audio=str(REFERENCE_PATH)),
            ),
        )
        attempt(
            "iclSerializedStreaming",
            lambda: run_streaming(
                label="icl-serialized-streaming",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=False, prompt=icl_serialized, ref_audio=None),
            ),
        )
        attempt(
            "iclBufferedSerialized",
            lambda: run_buffered(
                label="icl-buffered-serialized",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=False, prompt=icl_serialized, ref_audio=None),
            ),
        )

        for chunk_size in (1, 4, 8):
            observations: list[dict[str, Any]] = []
            for repetition in range(args.ttfa_repetitions):
                probe = attempt(
                    f"ttfaChunk{chunk_size}Run{repetition + 1}",
                    lambda chunk_size=chunk_size, repetition=repetition: run_ttfa_probe(
                        label=f"ttfa-xvector-chunk-{chunk_size}-run-{repetition + 1}",
                        model=model,
                        torch_module=torch,
                        numpy_module=np,
                        sampler=sampler,
                        phases=phases,
                        kwargs=clone_kwargs(xvec=True, prompt=xvec_serialized, ref_audio=None),
                        chunk_size=chunk_size,
                    ),
                )
                if probe is not None:
                    observations.append(probe)
            if observations:
                values = [item["ttfaMilliseconds"] for item in observations]
                result["ttfaSweep"][str(chunk_size)] = {
                    "chunkSizeCodecSteps": chunk_size,
                    "runs": observations,
                    "meanMilliseconds": sum(values) / len(values),
                    "stddevMilliseconds": (
                        sum((value - sum(values) / len(values)) ** 2 for value in values) / len(values)
                    )
                    ** 0.5,
                }

        queue_attempt = attempt(
            "xvectorQueueRealtime10s",
            lambda: run_queue_stream(
                label="xvector-queue-realtime-10s",
                model=model,
                torch_module=torch,
                numpy_module=np,
                sampler=sampler,
                output_dir=output_dir,
                phases=phases,
                kwargs=clone_kwargs(xvec=True, prompt=xvec_serialized, ref_audio=None),
                queue_capacity=args.queue_capacity,
            ),
        )
        if queue_attempt is not None and not queue_attempt["queue"]["realtimeConformant"]:
            result["failures"].append(
                {
                    "label": "xvectorQueueRealtime10s",
                    "type": "RealtimeGateFailure",
                    "category": "realtime_gate",
                    "message": "bounded queue did not sustain at least 10 seconds with zero underruns",
                    "traceback": "",
                }
            )

        result["hardware"]["nvidiaSmiAfter"] = run_nvidia_query(
            "name,driver_version,memory.total,memory.used,memory.free"
        )
        result["resources"] = {
            "phasePeaks": phases,
            "peakVramBytes": max(item["torchCudaMaxMemoryReservedBytes"] for item in phases),
            "peakVramSource": "max(torch.cuda.max_memory_reserved) across prepare, prompt, synthesis, TTFA, and queue phases",
            "peakVramAllocatedBytes": max(
                item["torchCudaMaxMemoryAllocatedBytes"] for item in phases
            ),
            "peakRssBytes": max(
                resource_max_rss_bytes(), *(item["rssSamplerPeakBytes"] for item in phases)
            ),
            "peakRssSource": "max(/proc VmRSS sampler, resource.RUSAGE_SELF.ru_maxrss)",
            "rssScope": "whole spike process including imports, model prepare, prompt extraction, graph capture, synthesis, and queue playback",
        }
        required_observations = (
            "xvectorUncachedStreaming",
            "xvectorCachedPathStreaming",
            "xvectorSerializedStreaming",
            "xvectorBufferedSerialized",
            "xvectorRepeatedSerialized1",
            "xvectorRepeatedSerialized2",
            "iclUncachedStreaming",
            "iclCachedPathStreaming",
            "iclSerializedStreaming",
            "iclBufferedSerialized",
            "xvectorQueueRealtime10s",
        )
        failed_required = [
            label
            for label in required_observations
            if result["observations"].get(label, {}).get("status") != "passed"
        ]
        if failed_required:
            raise BenchmarkFailure("required_observation", f"required observations failed: {failed_required}")
        if result["failures"]:
            result["status"] = "passed_with_failures"
            result["compatibility"]["deviationReason"] = "non-required TTFA or prompt diagnostic failure recorded"
        else:
            result["status"] = "passed"
        result["finishedAt"] = utc_now()
    except BaseException as error:
        result["status"] = "infeasible"
        result["finishedAt"] = utc_now()
        result["failure"] = failure_record("top_level", error)
        result["failures"].append(result["failure"])
        if phases and "resources" not in result:
            result["resources"] = {"phasePeaks": phases}
    finally:
        if sampler is not None:
            try:
                sampler.close()
            except BaseException as error:
                result["failures"].append(failure_record("sampler-close", error))
                result["status"] = "infeasible"
            if "resources" in result:
                result["resources"]["peakRssBytes"] = max(
                    result["resources"].get("peakRssBytes", 0),
                    sampler.max_rss,
                    resource_max_rss_bytes(),
                )
        result["finishedAt"] = result.get("finishedAt", utc_now())
        result["compatibility"]["failureCount"] = len(result["failures"])
        (output_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
