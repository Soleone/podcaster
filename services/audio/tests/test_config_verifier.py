from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from services.audio.src.config_verifier import AudioConfigVerifier


def _write_manifest(root: Path, models: list[dict[str, object]]) -> Path:
    manifest = root / "manifest.json"
    manifest.write_text(json.dumps({"schemaVersion": 1, "models": models}))
    return manifest


def test_verifier_loads_one_model_and_checks_attested_files(tmp_path: Path) -> None:
    payload = tmp_path / "model.bin"
    payload.write_bytes(b"model")
    digest = hashlib.sha256(payload.read_bytes()).hexdigest()
    manifest = _write_manifest(
        tmp_path,
        [{"id": "model", "files": [{"path": "model.bin", "sha256": digest}]}],
    )
    verifier = AudioConfigVerifier(tmp_path, manifest)

    model = verifier.model("model", "selected")
    assert verifier.verify_files(model, "selected") == {payload}

    payload.write_bytes(b"drift")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        verifier.verify_files(model, "selected")


def test_verifier_rejects_duplicate_models_and_unsafe_paths(tmp_path: Path) -> None:
    manifest = _write_manifest(
        tmp_path,
        [{"id": "duplicate", "files": []}, {"id": "duplicate", "files": []}],
    )
    verifier = AudioConfigVerifier(tmp_path, manifest)

    with pytest.raises(RuntimeError, match="identity mismatch"):
        verifier.model("duplicate", "selected")
    with pytest.raises(RuntimeError, match="unsafe"):
        verifier.safe_path("../outside")
