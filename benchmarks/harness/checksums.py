from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .fixtures import GENERATOR_VERSION, fixture_digest
from .util import canonical_json, sha256_bytes, sha256_file


class ChecksumError(ValueError):
    pass


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ChecksumError(f"cannot read manifest {path}: {error}") from error
    if not isinstance(manifest, dict):
        raise ChecksumError(f"{path}: manifest must be an object")
    return manifest


def manifest_digest(manifest: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(manifest))


def verify_dataset(path: Path, root: Path) -> tuple[dict[str, Any], str]:
    manifest = load_manifest(path)
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("id"), str):
        raise ChecksumError(f"{path}: unsupported dataset manifest")
    items = manifest.get("items")
    if not isinstance(items, list) or not items:
        raise ChecksumError(f"{path}: dataset must contain items")
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("sourceId"), str):
            raise ChecksumError(f"{path}: invalid dataset item")
        if "fixture" in item:
            fixture = item["fixture"]
            generator_version = item.get("generatorVersion")
            if generator_version != GENERATOR_VERSION:
                raise ChecksumError(
                    f"{path}: unsupported generator for {item['sourceId']}: {generator_version}"
                )
            expected = item.get("fixtureSha256")
            actual = fixture_digest(fixture, generator_version)
        elif "text" in item:
            text = item.get("text")
            expected = item.get("textSha256")
            if (
                manifest.get("kind") != "tts-prompts"
                or not isinstance(text, str)
                or not text.strip()
                or not isinstance(item.get("category"), str)
            ):
                raise ChecksumError(f"{path}: invalid TTS prompt {item['sourceId']}")
            actual = sha256_bytes(text.encode("utf-8"))
        else:
            media = item.get("path")
            expected = item.get("sha256")
            if not isinstance(media, str):
                raise ChecksumError(f"{path}: {item['sourceId']} has no fixture or media path")
            media_path = (root / media).resolve()
            allowed = root.resolve()
            if allowed not in media_path.parents:
                raise ChecksumError(f"{path}: media path escapes project root")
            if not media_path.is_file():
                raise ChecksumError(f"{path}: missing media {media}")
            actual = sha256_file(media_path)
        if not isinstance(expected, str) or actual != expected:
            raise ChecksumError(f"{path}: checksum mismatch for {item['sourceId']}")
    return manifest, manifest_digest(manifest)


def verify_models(path: Path, root: Path) -> list[dict[str, Any]]:
    manifest = load_manifest(path)
    models = manifest.get("models")
    if not isinstance(models, list):
        raise ChecksumError(f"{path}: models must be an array")
    verified: list[dict[str, Any]] = []
    for model in models:
        if not isinstance(model, dict):
            raise ChecksumError(f"{path}: invalid model entry")
        relative = model.get("path")
        expected = model.get("sha256")
        if not isinstance(relative, str) or not isinstance(expected, str):
            raise ChecksumError(f"{path}: model requires path and sha256")
        model_path = (root / relative).resolve()
        if root.resolve() not in model_path.parents or not model_path.is_file():
            raise ChecksumError(f"{path}: missing or unsafe model path {relative}")
        actual = sha256_file(model_path)
        if actual != expected:
            raise ChecksumError(f"{path}: checksum mismatch for model {model.get('id', relative)}")
        files = model.get("files", [])
        if not isinstance(files, list):
            raise ChecksumError(f"{path}: model files must be an array")
        for required_file in files:
            if not isinstance(required_file, dict):
                raise ChecksumError(f"{path}: invalid required model file")
            file_relative = required_file.get("path")
            file_expected = required_file.get("sha256")
            if not isinstance(file_relative, str) or not isinstance(file_expected, str):
                raise ChecksumError(f"{path}: required model file needs path and sha256")
            required_path = (root / file_relative).resolve()
            if root.resolve() not in required_path.parents or not required_path.is_file():
                raise ChecksumError(f"{path}: missing or unsafe model file {file_relative}")
            if sha256_file(required_path) != file_expected:
                raise ChecksumError(f"{path}: checksum mismatch for model file {file_relative}")
        verified.append(model)
    return verified
