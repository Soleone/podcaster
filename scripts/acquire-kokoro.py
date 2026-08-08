#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "models/kokoro-82m-onnx"
ASSETS = {
    "kokoro-v1.0.onnx": (
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
        "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    ),
    "voices-v1.0.bin": (
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    ),
}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def acquire(name: str, url: str, expected: str) -> None:
    target = DESTINATION / name
    if target.is_file():
        if digest(target) != expected:
            raise RuntimeError(f"existing {name} does not match the pinned SHA-256")
        print(f"verified existing {target.relative_to(ROOT)}")
        return
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{name}.", dir=DESTINATION)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if digest(temporary) != expected:
            raise RuntimeError(f"downloaded {name} does not match the pinned SHA-256")
        temporary.replace(target)
        print(f"acquired {target.relative_to(ROOT)}")
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for name, (url, expected) in ASSETS.items():
        acquire(name, url, expected)


if __name__ == "__main__":
    main()
