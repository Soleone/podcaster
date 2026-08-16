#!/usr/bin/env python3
"""Acquire the immutable official Qwen3-TTS 0.6B Base snapshot.

Weights remain ignored. Every file is downloaded from the pinned Hugging Face
revision into the local model directory and checked by size and SHA-256 before
it is made visible to the runtime.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODEL_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
DESTINATION = ROOT / "models/qwen3-tts-12hz-0.6b-base"

# The safetensors values are the upstream Hugging Face LFS SHA-256 values. The
# remaining values were computed from this immutable revision after acquisition.
ASSETS = (
    (".gitattributes", 1519, "11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361"),
    ("README.md", 3640, "181187b6057906bd960bc7f938d0b7a16652509776a0d52c4885b4ae5ccda0ea"),
    ("config.json", 4494, "2e714c787c8edb98b05432685cddb634add2de4d4e645f653d68251ef72ba011"),
    ("generation_config.json", 245, "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa"),
    ("merges.txt", 1671839, "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3"),
    ("model.safetensors", 1829344272, "180b3b10eb1c9f1b4db7806d5475bae3071c0243c299d49926bab1da3b6946f6"),
    ("preprocessor_config.json", 127, "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119"),
    (
        "speech_tokenizer/config.json",
        2336,
        "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167",
    ),
    (
        "speech_tokenizer/configuration.json",
        76,
        "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd",
    ),
    (
        "speech_tokenizer/model.safetensors",
        682293092,
        "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
    ),
    (
        "speech_tokenizer/preprocessor_config.json",
        234,
        "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb",
    ),
    ("tokenizer_config.json", 7344, "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670"),
    ("vocab.json", 2776833, "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def acquire(relative: str, expected_size: int, expected_sha256: str) -> None:
    target = DESTINATION / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file():
        if target.stat().st_size != expected_size or digest(target) != expected_sha256:
            raise RuntimeError(f"existing {relative} does not match the pinned size/SHA-256")
        print(f"verified existing {target.relative_to(ROOT)}")
        return

    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    url = f"https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{relative}"
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "podcaster-qwen-base-acquirer/1"})
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if temporary.stat().st_size != expected_size or digest(temporary) != expected_sha256:
            raise RuntimeError(f"downloaded {relative} does not match the pinned size/SHA-256")
        temporary.replace(target)
        print(f"acquired {target.relative_to(ROOT)}")
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for relative, expected_size, expected_sha256 in ASSETS:
        acquire(relative, expected_size, expected_sha256)


if __name__ == "__main__":
    main()
