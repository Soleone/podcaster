from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class GpuSample:
    available: bool
    name: str = "unavailable"
    driver: str = "unavailable"
    cuda: str = "unavailable"
    used_bytes: int = 0
    reason: str = "nvidia-smi unavailable"


def sample_gpu() -> GpuSample:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return GpuSample(False)
    query = [
        executable,
        "--query-gpu=name,driver_version,memory.used",
        "--format=csv,noheader,nounits",
    ]
    try:
        result = subprocess.run(query, capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return GpuSample(False, reason=f"nvidia-smi query failed: {type(error).__name__}")
    if result.returncode != 0 or not result.stdout.strip():
        return GpuSample(False, reason="nvidia-smi query returned no GPU")
    try:
        name, driver, used_mib = [
            field.strip() for field in result.stdout.splitlines()[0].split(",", 2)
        ]
        used_bytes = int(used_mib) * 1024 * 1024
    except (ValueError, IndexError):
        return GpuSample(False, reason="nvidia-smi query output was malformed")
    return GpuSample(True, name=name, driver=driver, used_bytes=used_bytes, reason="")


@dataclass
class RepeatedGpuSampler:
    """Reusable sampler for later candidate runners; samples are ambient unless bracketed."""

    sample: Callable[[], GpuSample] = sample_gpu

    def collect(self, count: int) -> list[GpuSample]:
        if count < 1:
            raise ValueError("sample count must be positive")
        return [self.sample() for _ in range(count)]
