from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import shutil
import socket
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_yaml_subset(path: Path) -> dict[str, Any]:
    # T2.1 config is deliberately JSON, which is a strict YAML 1.2 subset. This avoids
    # adding a parser to the pinned runtime while retaining the planned .yaml interface.
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected an object")
    return value


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        raise ValueError("cannot calculate a percentile of no values")
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def distribution(values: list[float]) -> dict[str, float] | None:
    if not values:
        return None
    return {
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
    }


def _command_version(command: list[str]) -> str:
    executable = shutil.which(command[0])
    if not executable:
        return "unavailable"
    try:
        result = subprocess.run(
            [executable, *command[1:]], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"
    text = (result.stdout or result.stderr).strip().splitlines()
    return text[0] if text else "unavailable"


def _mem_total() -> int:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 1


def deterministic_source_manifest(root: Path) -> list[dict[str, str]]:
    """Return the deterministic non-Git source snapshot committed by new runs.

    Dataset manifests are source, but their ignored payloads are not. Hashing the
    LibriSpeech media/source tree here made every synthetic run reread hundreds of
    megabytes even though datasetSha256 already identifies and verifies the payload.
    """
    manifest: list[tuple[str, str]] = []
    roots = [
        root / "benchmarks/harness",
        root / "benchmarks/configs",
        root / "services/audio/config",
        root / "benchmarks/datasets",
        root / "benchmarks/results/schema",
        root / "packages/test-fixtures/audio",
        root / "services/audio/src/stt",
        root / "services/audio/src/tts",
        root / "docs/provenance",
    ]
    files = [
        root / "pyproject.toml",
        root / "uv.lock",
        root / "docs/benchmarking.md",
        root / "services/audio/config/model-manifest.json",
        root / "scripts/verify-models.py",
        root / "scripts/acquire-librispeech-benchmark.py",
        root / "scripts/acquire-kokoro.py",
        root / "services/audio/src/vad/endpointer.py",
        root / "services/audio/kokoro-requirements.in",
        root / "services/audio/kokoro-requirements.lock",
    ]
    for directory in roots:
        if directory.is_dir():
            for path in directory.rglob("*"):
                if not path.is_file():
                    continue
                relative = path.relative_to(root)
                if (
                    relative.parts[:2] == ("benchmarks", "datasets")
                    and ("media" in relative.parts or "source" in relative.parts)
                ) or path.name.endswith(".tar.gz"):
                    continue
                files.append(path)
    for path in sorted(set(files)):
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            manifest.append((str(path.relative_to(root)), sha256_file(path)))
    return [{"path": path, "sha256": digest} for path, digest in manifest]


def source_state(
    root: Path, manifest: list[dict[str, str]] | None = None
) -> tuple[str, bool]:
    manifest = manifest if manifest is not None else deterministic_source_manifest(root)
    source_id = f"source-{sha256_bytes(canonical_json(manifest))[:16]}"
    git = shutil.which("git")
    if git and (root / ".git").exists():
        status = subprocess.run(
            [git, "-C", str(root), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=False,
        )
        if status.returncode == 0:
            return source_id, bool(status.stdout.strip())
    return source_id, True


def machine_metadata(gpu: dict[str, str]) -> dict[str, Any]:
    return {
        "hostname": socket.gethostname(),
        "os": platform.platform(),
        "kernel": platform.release(),
        "cpu": platform.processor() or platform.machine(),
        "ramBytes": _mem_total(),
        "gpu": gpu.get("name", "unavailable"),
        "driverVersion": gpu.get("driver", "unavailable"),
    }


def runtime_metadata(gpu: dict[str, str]) -> dict[str, str]:
    try:
        import torch  # type: ignore[import-not-found]

        torch_version = str(torch.__version__)
        cudnn = str(torch.backends.cudnn.version() or "unavailable")
        cuda = str(torch.version.cuda or gpu.get("cuda", "unavailable"))
    except ImportError:
        torch_version = "unavailable"
        cudnn = "unavailable"
        cuda = gpu.get("cuda", "unavailable")
    return {
        "python": platform.python_version(),
        "node": _command_version(["node", "--version"]),
        "cuda": cuda,
        "cudnn": cudnn,
        "pytorch": torch_version,
    }


def environment_metadata() -> dict[str, str]:
    result: dict[str, str] = {}
    mapping = {
        "CUDA_VISIBLE_DEVICES": "cudaVisibleDevices",
        "OMP_NUM_THREADS": "ompNumThreads",
        "TOKENIZERS_PARALLELISM": "tokenizersParallelism",
    }
    for source, target in mapping.items():
        if source in os.environ:
            value = os.environ[source]
            if source == "TOKENIZERS_PARALLELISM":
                value = value.lower()
                if value not in {"true", "false"}:
                    continue
            result[target] = value
    return result
