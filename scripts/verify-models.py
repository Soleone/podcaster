#!/usr/bin/env python3
"""Fail-closed verifier for local model files referenced by a manifest."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from benchmarks.harness.checksums import ChecksumError, verify_models  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        models = verify_models(args.manifest.resolve(), ROOT)
    except ChecksumError as error:
        parser.error(str(error))
    print(f"verified {len(models)} model file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
