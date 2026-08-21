"""Fail-closed verification primitives for service-owned audio configuration."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class AudioConfigVerifier:
    """Verify selected config identity and its one attested model entry.

    Runtime-specific checks (provider, language, latency, and config fields) remain
    with each selected adapter; this class only owns their shared trust boundary.
    """

    def __init__(self, root: Path, manifest_path: Path) -> None:
        self.root = root.resolve()
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("selected model manifest is invalid") from error
        if (
            not isinstance(manifest, dict)
            or manifest.get("schemaVersion") != 1
            or not isinstance(manifest.get("models"), list)
        ):
            raise RuntimeError("selected model manifest is invalid")
        self.models: list[dict[str, Any]] = [
            entry for entry in manifest["models"] if isinstance(entry, dict)
        ]

    def config(
        self, path: Path, expected_sha256: str, expected_id: str, label: str
    ) -> dict[str, Any]:
        try:
            config_bytes = path.read_bytes()
            config = json.loads(config_bytes)
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"{label} candidate config is invalid") from error
        if hashlib.sha256(config_bytes).hexdigest() != expected_sha256:
            raise RuntimeError(f"{label} config checksum mismatch")
        if not isinstance(config, dict) or config.get("id") != expected_id or config.get("schemaVersion") != 1:
            raise RuntimeError(f"{label} config identity mismatch")
        return config

    def model(self, model_id: object, label: str) -> dict[str, Any]:
        matches = [entry for entry in self.models if entry.get("id") == model_id]
        if len(matches) != 1:
            raise RuntimeError(f"{label} model manifest identity mismatch")
        return matches[0]

    def safe_path(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if path == self.root or self.root not in path.parents:
            raise RuntimeError("selected model path is unsafe")
        return path

    def verify_files(self, model: dict[str, Any], label: str, minimum: int = 1) -> set[Path]:
        files = model.get("files")
        if not isinstance(files, list) or len(files) < minimum:
            suffix = "has no files" if minimum == 1 else "has incomplete files"
            raise RuntimeError(f"{label} model manifest {suffix}")
        verified: set[Path] = set()
        for entry in files:
            if (
                not isinstance(entry, dict)
                or not isinstance(entry.get("path"), str)
                or not isinstance(entry.get("sha256"), str)
            ):
                raise RuntimeError(f"{label} model manifest file is invalid")
            path = self.safe_path(entry["path"])
            if not path.is_file() or _sha256_file(path) != entry["sha256"]:
                raise RuntimeError(f"{label} model file checksum mismatch")
            verified.add(path)
        return verified
