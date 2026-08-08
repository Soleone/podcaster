"""Generate deterministic PCM16 WAV fixtures; WAV output is intentionally ignored."""

from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from benchmarks.harness.fixtures import pcm_chunks  # noqa: E402


def generate(
    path: Path,
    frequency_hz: int,
    chunks: int,
    sample_rate: int = 16_000,
    samples_per_chunk: int = 160,
) -> None:
    spec = {
        "sampleRate": sample_rate,
        "channels": 1,
        "sampleFormat": "pcm16le",
        "frequencyHz": frequency_hz,
        "chunks": chunks,
        "samplesPerChunk": samples_per_chunk,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(b"".join(pcm_chunks(spec)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--frequency-hz", type=int, required=True)
    parser.add_argument("--chunks", type=int, required=True)
    args = parser.parse_args()
    generate(args.output, args.frequency_hz, args.chunks)


if __name__ == "__main__":
    main()
