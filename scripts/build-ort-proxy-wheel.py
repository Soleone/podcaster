#!/usr/bin/env python3
"""Build the vendored onnxruntime proxy wheel.

uv cannot satisfy kokoro-onnx's `onnxruntime` requirement with the GPU build
because onnxruntime-gpu is a separate package name; installing both wheels
races for the `onnxruntime/` module files and the CPU wheel wins (no CUDA).
This builds a pure-metadata proxy wheel named `onnxruntime` that depends on
`onnxruntime-gpu==1.22.0`, so resolution installs the GPU build only and no
CPU wheel ever enters the graph.

The proxy ships no python files, so there is no module-file conflict.

Output: vendor/onnxruntime-1.22.0-py3-none-any.whl (deterministic content).
"""
from __future__ import annotations

import base64
import hashlib
import zipfile
from pathlib import Path

VERSION = "1.22.0"
# ORT 1.22.0's own [cuda] and [cudnn] extras provide the CUDA 12 runtime,
# cuFFT, cuRAND, and cuDNN 9. cuBLAS is required at load time but not declared
# by any extra, so it is added explicitly (12.1.x is the ORT-tested line).
GPU_BUILD = "onnxruntime-gpu[cuda,cudnn]==1.22.0"
CUBLAS = "nvidia-cublas-cu12==12.1.3.1"
OUT = Path(__file__).resolve().parent.parent / "vendor" / f"onnxruntime-{VERSION}-py3-none-any.whl"

DIST = f"onnxruntime-{VERSION}"
FILES: dict[str, str] = {
    f"{DIST}.dist-info/METADATA": (
        "Metadata-Version: 2.1\n"
        f"Name: onnxruntime\n"
        f"Version: {VERSION}\n"
        "Summary: Proxy for onnxruntime-gpu 1.22.0 (CUDA build); satisfies the onnxruntime requirement without installing the CPU wheel\n"
        "Requires-Python: >=3.8\n"
        f"Requires-Dist: {GPU_BUILD}\n"
        f"Requires-Dist: {CUBLAS}\n"
        "\n"
    ),
    f"{DIST}.dist-info/WHEEL": (
        "Wheel-Version: 1.0\n"
        "Generator: podcaster ort-proxy build\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
        "\n"
    ),
}


def record_line(path: str, data: str) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data.encode()).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(data)}"


def main() -> None:
    record = "\n".join([record_line(path, data) for path, data in FILES.items()]) + "\n"
    FILES[f"{DIST}.dist-info/RECORD"] = record
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in FILES.items():
            archive.writestr(name, data.encode())
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
