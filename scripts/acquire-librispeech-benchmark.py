#!/usr/bin/env python3
"""Acquire a lawful, ignored 55-item LibriSpeech test-clean T3 corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import shutil
import subprocess
import tarfile
import urllib.request
import wave
from pathlib import Path

URL = "https://www.openslr.org/resources/12/test-clean.tar.gz"
PUBLISHED_MD5 = "32fa31d27d2e1cad72775fee3f4849a9"
ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "benchmarks/datasets/librispeech-t3/media"
MANIFEST = ROOT / "benchmarks/datasets/librispeech-t3.manifest.json"


def digest(path: Path, algorithm: str = "sha256") -> str:
    value = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def add_noise(path: Path, seed: int) -> None:
    with wave.open(str(path), "rb") as source:
        params = source.getparams()
        frames = bytearray(source.readframes(source.getnframes()))
    randomizer = random.Random(seed)
    for offset in range(0, len(frames), 2):
        sample = int.from_bytes(frames[offset : offset + 2], "little", signed=True)
        sample = max(-32768, min(32767, sample + randomizer.randint(-220, 220)))
        frames[offset : offset + 2] = sample.to_bytes(2, "little", signed=True)
    with wave.open(str(path), "wb") as output:
        output.setparams(params)
        output.writeframes(frames)


def add_pause(path: Path) -> None:
    with wave.open(str(path), "rb") as source:
        params = source.getparams()
        frames = source.readframes(source.getnframes())
    midpoint = len(frames) // 4 * 2
    silence = b"\0\0" * 8_000
    with wave.open(str(path), "wb") as output:
        output.setparams(params)
        output.writeframes(frames[:midpoint] + silence + frames[midpoint:])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, default=MEDIA.parent / "test-clean.tar.gz")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    MEDIA.mkdir(parents=True, exist_ok=True)
    if not args.archive.exists():
        print(f"downloading {URL}")
        urllib.request.urlretrieve(URL, args.archive)
    if digest(args.archive, "md5") != PUBLISHED_MD5:
        raise SystemExit("LibriSpeech archive MD5 mismatch")
    extracted = MEDIA.parent / "source"
    if args.force and extracted.exists():
        shutil.rmtree(extracted)
    if not extracted.exists():
        with tarfile.open(args.archive) as archive:
            for member in archive.getmembers():
                destination = (extracted / member.name).resolve()
                if extracted.resolve() not in destination.parents:
                    raise SystemExit("unsafe archive path")
            archive.extractall(extracted, filter="data")
    transcripts: dict[str, str] = {}
    for path in extracted.rglob("*.trans.txt"):
        for line in path.read_text().splitlines():
            source_id, text = line.split(" ", 1)
            transcripts[source_id] = text
    flacs = sorted(extracted.rglob("*.flac"))
    per_speaker: dict[str, Path] = {}
    for path in flacs:
        per_speaker.setdefault(path.stem.split("-")[0], path)
    selected = list(per_speaker.values())[:35]
    if len(selected) < 35:
        raise SystemExit("LibriSpeech extraction did not contain 35 speakers")
    items = []
    variants = [(path, "clean") for path in selected]
    variants += [(path, "noise") for path in selected[:10]]
    variants += [(path, "pause") for path in selected[10:20]]
    for index, (source, variant) in enumerate(variants, start=1):
        output = MEDIA / f"item-{index:03d}-{variant}.wav"
        subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(source),
             "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output)],
            check=True,
        )
        if variant == "noise":
            add_noise(output, index)
        elif variant == "pause":
            add_pause(output)
        original_id = source.stem
        items.append(
            {
                "sourceId": f"{original_id}-{variant}",
                "path": str(output.relative_to(ROOT)),
                "sha256": digest(output),
                "reference": transcripts[original_id],
                "coverage": [variant, "read-speech", "multi-speaker"],
            }
        )
    manifest = {
        "schemaVersion": 1,
        "id": "librispeech-test-clean-t3-v1",
        "source": URL,
        "license": "CC BY 4.0",
        "licenseUrl": "https://www.openslr.org/12",
        "acquisitionCommand": "uv run python scripts/acquire-librispeech-benchmark.py",
        "archiveMd5": PUBLISHED_MD5,
        "archiveSha256": digest(args.archive),
        "audio": {"sampleRate": 16000, "channels": 1, "sampleFormat": "pcm16le"},
        "notes": "35 speakers; 10 deterministic low-noise and 10 inserted-pause variants. Read speech does not represent conversational accents or podcast acoustics.",
        "items": items,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {MANIFEST} with {len(items)} items")


if __name__ == "__main__":
    main()
