from __future__ import annotations

import math
import struct
from typing import Any

from .util import canonical_json, sha256_bytes

GENERATOR_VERSION = "pcm16-sine-v1"


def fixture_digest(spec: dict[str, Any], generator_version: str = GENERATOR_VERSION) -> str:
    return sha256_bytes(canonical_json({"generatorVersion": generator_version, "fixture": spec}))


def pcm_chunks(spec: dict[str, Any]) -> list[bytes]:
    if spec.get("channels") != 1 or spec.get("sampleFormat") != "pcm16le":
        raise ValueError("synthetic fixture must be mono PCM16LE")
    sample_rate = int(spec["sampleRate"])
    frequency = int(spec["frequencyHz"])
    chunk_count = int(spec["chunks"])
    samples_per_chunk = int(spec["samplesPerChunk"])
    if min(sample_rate, frequency, chunk_count, samples_per_chunk) <= 0:
        raise ValueError("synthetic fixture dimensions must be positive")
    chunks: list[bytes] = []
    for chunk_index in range(chunk_count):
        frames = bytearray()
        for local_index in range(samples_per_chunk):
            index = chunk_index * samples_per_chunk + local_index
            value = round(2000 * math.sin(2 * math.pi * frequency * index / sample_rate))
            frames.extend(struct.pack("<h", value))
        chunks.append(bytes(frames))
    return chunks
