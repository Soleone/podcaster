"""Build the multi-turn retry audio fixture from LibriSpeech test-clean.

Produces a 16 kHz mono PCM16 raw stream of two real speech utterances
separated by controlled silence, plus a JSON metadata file describing the
utterance sample offsets for the retry driver. Source paths are recorded
relative to the repository root so the metadata is machine-independent, and
the raw stream's SHA-256 and byte length are recorded for integrity checks.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_RATE = 16_000
SILENCE_SECONDS = 1.5

SOURCE_RELS = [
    # U1 baseline: >=4 lexical words so the policy is eligible (not silence)
    "benchmarks/datasets/librispeech-t3/source/LibriSpeech/test-clean/4507/16021/4507-16021-0002.flac",
    # U2 takeover: contains WHY -> interruption classifier accepts as new_request;
    # kept short (2.7s) so its final lands inside U1's synthesis window
    "benchmarks/datasets/librispeech-t3/source/LibriSpeech/test-clean/4507/16021/4507-16021-0012.flac",
    # U3 post-replacement sanity: plain eligible narrative
    "benchmarks/datasets/librispeech-t3/source/LibriSpeech/test-clean/4507/16021/4507-16021-0005.flac",
]
SOURCES = [ROOT / rel for rel in SOURCE_RELS]


def load_16k(path: Path) -> np.ndarray:
    import librosa

    samples, sr = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    return samples


def main() -> None:
    for path in SOURCES:
        if not path.resolve().is_relative_to(ROOT.resolve()):
            raise RuntimeError(f"source escapes repository root: {path}")
    utterances: list[np.ndarray] = []
    metadata: dict[str, object] = {
        "sampleRate": SAMPLE_RATE,
        "sourcePaths": SOURCE_RELS,
        "utterances": [],
    }
    offset = 0
    stream: list[np.ndarray] = []
    for index, path in enumerate(SOURCES):
        if index > 0:
            silence = int(SAMPLE_RATE * SILENCE_SECONDS)
            stream.append(np.zeros(silence, dtype=np.float32))
            offset += silence
        speech = load_16k(path)
        peak_rms = int(np.sqrt(np.mean(speech**2)) * 32768)
        if peak_rms < 180:
            raise RuntimeError(f"utterance {index} RMS {peak_rms} below the VAD speech threshold 180")
        stream.append(speech)
        metadata["utterances"].append(
            {
                "index": index,
                "startSample": offset,
                "samples": int(speech.shape[0]),
                "durationSeconds": round(float(speech.shape[0]) / SAMPLE_RATE, 3),
                "peakRms": peak_rms,
            }
        )
        offset += int(speech.shape[0])

    joined = np.concatenate(stream)
    pcm = (np.clip(joined, -1.0, 1.0) * 32767).astype("<i2")
    raw_bytes = pcm.tobytes()
    metadata["raw"] = {
        "sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "byteLength": len(raw_bytes),
    }
    pcm_path = ROOT / "scripts/fixtures/multi-turn-utterances.raw"
    meta_path = ROOT / "scripts/fixtures/multi-turn-utterances.json"
    pcm_path.write_bytes(raw_bytes)
    meta_path.write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"wrote {pcm_path} ({pcm.shape[0] / SAMPLE_RATE:.2f}s, {pcm.nbytes} bytes)")
    print(f"wrote {meta_path}")


if __name__ == "__main__":
    main()
