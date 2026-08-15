#!/usr/bin/env python3
"""Run the official Qwen3-TTS CustomVoice CUDA feasibility spike.

This is deliberately a standalone experiment, not a TTS adapter. The official
qwen-tts 0.1.1 API returns a complete waveform from generate_custom_voice(); it
does not yield audio chunks. The spike records that limitation explicitly when
reporting request-to-first-audio.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Any
import wave

ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
MODEL_REVISION = "85e237c12c027371202489a0ec509ded67b5e4b5"
MODEL_DIR = ROOT / "models/qwen3-tts-12hz-0.6b-customvoice"
MANIFEST_PATH = ROOT / "docs/model-manifest.json"
SAMPLE_RATE = 24_000
SPEAKER = "Ryan"
LANGUAGE = "English"
DTYPE_NAME = "bfloat16"
ATTENTION = "eager"
DEVICE = "cuda:0"
DEFAULT_TEXT = (
    "Signed PCM sixteen, mono, at twenty-four kilohertz must remain correctly framed."
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rss_bytes() -> int:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def resource_max_rss_bytes() -> int:
    # Linux reports ru_maxrss in KiB. Keep the conversion local to this
    # Linux/WSL experiment instead of silently treating it as bytes elsewhere.
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value) * 1024


def run_nvidia_query(query: str) -> dict[str, str] | None:
    try:
        completed = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    values = [part.strip() for part in completed.stdout.splitlines()[0].split(",")]
    fields = [part.strip() for part in query.split(",")]
    if len(values) != len(fields):
        return None
    return dict(zip(fields, values, strict=True))


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

    def start(self) -> None:
        self.sample()

        def loop() -> None:
            while not self._stop.wait(0.01):
                self.sample()

        self._thread = threading.Thread(target=loop, name="qwen-cuda-resource-sampler", daemon=True)
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


def pcm16le(wav: Any) -> bytes:
    import numpy as np

    values = np.asarray(wav, dtype=np.float32).reshape(-1)
    if values.size == 0:
        raise ValueError("Qwen returned empty audio")
    if not np.isfinite(values).all():
        raise ValueError("Qwen returned non-finite audio")
    peak = float(np.max(np.abs(values)))
    if peak > 1.0:
        raise ValueError(f"Qwen output exceeds PCM range: peak={peak}")
    return np.rint(np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def validate_wav(path: Path, expected_pcm: bytes) -> dict[str, Any]:
    with wave.open(str(path), "rb") as source:
        params = source.getparams()
        pcm = source.readframes(source.getnframes())
    if params.nchannels != 1 or params.sampwidth != 2 or params.framerate != SAMPLE_RATE:
        raise ValueError(f"invalid WAV format: {params}")
    if pcm != expected_pcm or not pcm or len(pcm) % 2:
        raise ValueError("WAV payload is not the expected non-empty PCM16LE byte sequence")
    return {
        "sampleRate": params.framerate,
        "channels": params.nchannels,
        "sampleWidthBytes": params.sampwidth,
        "samples": params.nframes,
        "durationSeconds": params.nframes / params.framerate,
        "pcmBytes": len(pcm),
    }


def phase_memory(torch_module: Any) -> tuple[int, int]:
    try:
        return (
            int(torch_module.cuda.max_memory_allocated()),
            int(torch_module.cuda.max_memory_reserved()),
        )
    except (RuntimeError, AssertionError):
        return 0, 0


def reset_phase_memory(torch_module: Any) -> None:
    torch_module.cuda.synchronize()
    torch_module.cuda.reset_peak_memory_stats()


def generation(
    *,
    label: str,
    text: str,
    model: Any,
    torch_module: Any,
    sampler: ResourceSampler,
    output_dir: Path,
) -> dict[str, Any]:
    reset_phase_memory(torch_module)
    torch_module.manual_seed(4090)
    torch_module.cuda.manual_seed_all(4090)
    sampler.max_allocated = 0
    sampler.max_reserved = 0
    sampler.sample()
    started = time.perf_counter()
    wavs, sample_rate = model.generate_custom_voice(
        text=text,
        language=LANGUAGE,
        speaker=SPEAKER,
        non_streaming_mode=True,
    )
    # The wrapper returns a CPU numpy waveform, but synchronize explicitly so
    # the timing boundary cannot end before queued CUDA work has completed.
    torch_module.cuda.synchronize()
    finished = time.perf_counter()
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"Qwen returned sample rate {sample_rate}, expected {SAMPLE_RATE}")
    if not wavs:
        raise ValueError("Qwen returned no waveform")
    pcm = pcm16le(wavs[0])
    wav_path = output_dir / f"{label}.wav"
    pcm_path = output_dir / f"{label}.pcm"
    with wave.open(str(wav_path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        target.writeframes(pcm)
    pcm_path.write_bytes(pcm)
    audio = validate_wav(wav_path, pcm)
    processing_seconds = finished - started
    alloc_peak, reserved_peak = phase_memory(torch_module)
    sampler.sample()
    return {
        "label": label,
        "text": text,
        "speaker": SPEAKER,
        "language": LANGUAGE,
        "requestToFirstAudioSeconds": processing_seconds,
        "totalProcessingSeconds": processing_seconds,
        "rtf": processing_seconds / audio["durationSeconds"],
        "firstAudioObservation": "generate_custom_voice_return",
        "streaming": False,
        "audio": audio,
        "wavPath": str(wav_path),
        "pcmPath": str(pcm_path),
        "wavSha256": sha256_file(wav_path),
        "pcmSha256": sha256_file(pcm_path),
        "memory": sampler.phase_peak(alloc_peak, reserved_peak),
    }


def default_output_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return ROOT / "benchmarks/results" / f"qwen-cuda-spike-{stamp}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--warm-repetitions", type=int, default=1)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = (args.output_dir or default_output_dir()).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    process_started = time.perf_counter()
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "in_progress",
        "startedAt": utc_now(),
        "outputDir": str(output_dir),
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
        },
        "notes": [
            "Official qwen-tts 0.1.1 was exercised directly; no franken_tts code or subprocess was used.",
            "The official wrapper exposes complete-waveform generation only, so request-to-first-audio is observed at generate_custom_voice return and equals total processing time.",
            "No latency target is claimed by this spike.",
        ],
    }
    sampler: ResourceSampler | None = None
    try:
        verified = verify_manifest_assets()
        result["model"]["manifestPath"] = str(MANIFEST_PATH.resolve())
        result["model"]["manifestAssets"] = verified["assets"]
        result["hardware"] = {
            "nvidiaSmi": run_nvidia_query(
                "name,driver_version,memory.total,memory.used,memory.free"
            ),
        }

        import numpy as np
        import soundfile as sf  # noqa: F401  # imported to record the runtime
        import torch
        from qwen_tts import Qwen3TTSModel

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable")
        device = torch.cuda.get_device_properties(0)
        if torch.cuda.get_device_capability(0) != (8, 9):
            raise RuntimeError(f"expected RTX 4090 sm_89, got {torch.cuda.get_device_capability(0)}")
        result["runtime"] = {
            "qwenTts": importlib.metadata.version("qwen-tts"),
            "transformers": importlib.metadata.version("transformers"),
            "accelerate": importlib.metadata.version("accelerate"),
            "torch": torch.__version__,
            "torchCuda": torch.version.cuda,
            "numpy": np.__version__,
            "python": sys.version,
            "pid": os.getpid(),
        }
        result["hardware"].update(
            {
                "torchDevice": torch.cuda.get_device_name(0),
                "computeCapability": list(torch.cuda.get_device_capability(0)),
                "totalMemoryBytes": int(device.total_memory),
            }
        )

        sampler = ResourceSampler(torch)
        sampler.start()
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        prepare_started = time.perf_counter()
        model = Qwen3TTSModel.from_pretrained(
            str(MODEL_DIR.resolve()),
            device_map=DEVICE,
            dtype=torch.bfloat16,
            attn_implementation=ATTENTION,
        )
        torch.cuda.synchronize()
        prepare_finished = time.perf_counter()
        sampler.sample()
        prepare_allocated, prepare_reserved = phase_memory(torch)
        result["timing"] = {
            "processStartToPrepareReadySeconds": prepare_finished - process_started,
            "prepareSeconds": prepare_finished - prepare_started,
            "prepareEnd": utc_now(),
        }
        result["prepareMemory"] = sampler.phase_peak(prepare_allocated, prepare_reserved)
        result["supportedSpeakers"] = sorted(model.model.get_supported_speakers())
        result["supportedLanguages"] = list(model.model.get_supported_languages())

        cold = generation(
            label="cold",
            text=args.text,
            model=model,
            torch_module=torch,
            sampler=sampler,
            output_dir=output_dir,
        )
        warm: list[dict[str, Any]] = []
        for index in range(args.warm_repetitions):
            warm.append(
                generation(
                    label=f"warm-{index + 1}",
                    text=args.text,
                    model=model,
                    torch_module=torch,
                    sampler=sampler,
                    output_dir=output_dir,
                )
            )
        result["observations"] = {"cold": cold, "warm": warm}
        all_observations = [cold, *warm]
        peak_allocated = max(
            [result["prepareMemory"]["torchCudaMaxMemoryAllocatedBytes"]]
            + [item["memory"]["torchCudaMaxMemoryAllocatedBytes"] for item in all_observations]
        )
        peak_reserved = max(
            [result["prepareMemory"]["torchCudaMaxMemoryReservedBytes"]]
            + [item["memory"]["torchCudaMaxMemoryReservedBytes"] for item in all_observations]
        )
        peak_rss = max(
            [result["prepareMemory"]["rssSamplerPeakBytes"], resource_max_rss_bytes()]
            + [item["memory"]["rssSamplerPeakBytes"] for item in all_observations]
        )
        result["timing"].update(
            {
                "coldRequestToFirstAudioSeconds": cold["requestToFirstAudioSeconds"],
                "coldTotalProcessingSeconds": cold["totalProcessingSeconds"],
                "coldRtf": cold["rtf"],
                "warmRequestToFirstAudioSeconds": [
                    item["requestToFirstAudioSeconds"] for item in warm
                ],
                "warmTotalProcessingSeconds": [item["totalProcessingSeconds"] for item in warm],
                "warmRtf": [item["rtf"] for item in warm],
            }
        )
        result["resources"] = {
            "peakVramBytes": peak_reserved,
            "peakVramSource": "torch.cuda.max_memory_reserved",
            "peakVramAllocatedBytes": peak_allocated,
            "peakRssBytes": peak_rss,
            "peakRssSource": "max(/proc VmRSS sampler, resource.RUSAGE_SELF.ru_maxrss)",
            "rssScope": "whole spike process including prepare and synthesis",
        }
        result["status"] = "passed"
        result["finishedAt"] = utc_now()
    except BaseException as error:
        result["status"] = "infeasible"
        result["finishedAt"] = utc_now()
        result["failure"] = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
            "fallback": "Keep Kokoro; do not fall back to franken_tts.",
        }
        print(json.dumps(result, indent=2), file=sys.stderr)
        (output_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        return 1
    finally:
        if sampler is not None:
            sampler.close()
            if "resources" in result:
                result["resources"]["peakRssBytes"] = max(
                    result["resources"]["peakRssBytes"],
                    sampler.max_rss,
                    resource_max_rss_bytes(),
                )
        (output_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
