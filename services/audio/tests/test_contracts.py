from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from jsonschema import FormatChecker
from pydantic import ValidationError
from referencing import Registry, Resource

from services.audio.src import generated
from services.audio.src.binary_framing import BinaryAudioFrame, decode_frame, encode_frame
from services.audio.src.generated import contracts

ROOT = Path(__file__).resolve().parents[3]
SCHEMAS = ROOT / "packages/contracts/schema"
FIXTURES = ROOT / "packages/contracts/fixtures"


def load(path: Path):
    return json.loads(path.read_text())


schema_files = sorted(SCHEMAS.rglob("*.json"))
registry = Registry().with_resources(
    (schema["$id"], Resource.from_contents(schema))
    for schema in (load(path) for path in schema_files)
)
CASES = [
    ("protocol-envelope.json", "core-event", "protocol-envelope"),
    ("events/core-events.json", "core-event", "core-events"),
    ("events/barge-in.json", "barge-in", "barge-in"),
    ("events/browser-command.json", "browser-command", "browser-command"),
    ("events/failure.json", "failure", "failure"),
    ("events/playback-progress.json", "playback-progress", "playback-progress"),
    ("events/playback-stopped.json", "playback-stopped", "playback-stopped"),
    ("events/policy-decision.json", "policy-decision", "policy-decision"),
    ("events/reasoning-final.json", "reasoning-final", "reasoning-final"),
    ("events/session-state.json", "session-state", "session-state"),
    ("events/sidecar-message.json", "sidecar-message", "sidecar-message"),
    ("events/transcript-final.json", "transcript-final", "transcript-final"),
    ("events/transcript-partial.json", "transcript-partial", "transcript-partial"),
    ("events/tts-ended.json", "tts-ended", "tts-ended"),
    ("events/tts-started.json", "tts-started", "tts-started"),
    ("persona.json", "persona", "persona"),
    ("history-export.json", "history-export", "history-export"),
    ("benchmarks/run.json", "benchmark-run", "benchmark-run"),
    ("benchmarks/item.json", "benchmark-item", "benchmark-item"),
    ("benchmarks/event.json", "benchmark-event", "benchmark-event"),
    ("benchmarks/summary.json", "benchmark-summary", "benchmark-summary"),
    ("benchmarks/rating.json", "benchmark-rating", "benchmark-rating"),
]


def validate(schema_path: str, value: object) -> None:
    schema = load(SCHEMAS / schema_path)
    validator = contracts.Utf8Draft202012Validator(
        schema, registry=registry, format_checker=FormatChecker()
    )
    validator.validate(value)


@pytest.mark.parametrize("schema_path,valid_name,invalid_name", CASES)
def test_canonical_and_generated_model_parity(
    schema_path: str, valid_name: str, invalid_name: str
) -> None:
    schema = load(SCHEMAS / schema_path)
    model = getattr(contracts, schema["title"])
    positive = load(FIXTURES / "valid" / f"{valid_name}.json")
    negative = load(FIXTURES / "invalid" / f"{invalid_name}.json")
    validate(schema_path, positive)
    model.model_validate(positive)
    with pytest.raises(Exception):
        validate(schema_path, negative)
    with pytest.raises(ValidationError):
        model.model_validate(negative)


SCHEMAS_BY_ID = {load(path)["$id"]: load(path) for path in schema_files}


def systematic_mutations(schema: dict, exemplar: object) -> list[tuple[str, object]]:
    from urllib.parse import urldefrag, urljoin

    mutations = []

    def add(name, path, replacement=None, remove=False):
        value = copy.deepcopy(exemplar)
        parent = value
        for key in path[:-1]:
            parent = parent[key]
        if remove:
            del parent[path[-1]]
        else:
            parent[path[-1]] = copy.deepcopy(replacement)
        mutations.append((name, value))

    def resolve(reference, document):
        base, fragment = urldefrag(urljoin(document["$id"], reference))
        target = SCHEMAS_BY_ID.get(base, document)
        node = target
        if fragment:
            for segment in fragment.removeprefix("/").split("/"):
                node = node[segment]
        return node, target

    def visit(node, current, path, document):
        if "$ref" in node:
            target, target_document = resolve(node["$ref"], document)
            visit(target, current, path, target_document)
            return
        for branch in node.get("allOf", []):
            visit(branch, current, path, document)
        for branch in [*node.get("oneOf", []), *node.get("anyOf", [])]:
            types = branch.get("type", [])
            types = types if isinstance(types, list) else [types]
            matches = (
                "$ref" in branch
                or ("object" in types and isinstance(current, dict))
                or ("array" in types and isinstance(current, list))
                or ("string" in types and isinstance(current, str))
                or ("null" in types and current is None)
            )
            if matches:
                visit(branch, current, path, document)
        label = "/" + "/".join(map(str, path or ["root"]))
        if "const" in node:
            add(label + " const", path, 2 if node["const"] == 1 else "__invalid_const__")
        if "enum" in node:
            add(label + " enum", path, "__invalid_enum__")
        if "format" in node:
            add(label + " format", path, "not-a-valid-format")
        if "pattern" in node:
            add(label + " pattern", path, "INVALID")
        if "minimum" in node:
            add(label + " minimum", path, node["minimum"] - 1)
        if "maximum" in node:
            add(label + " maximum", path, node["maximum"] + 1)
        if "minLength" in node:
            add(label + " minLength", path, "x" * max(0, node["minLength"] - 1))
        if "maxLength" in node:
            add(label + " maxLength", path, "x" * (node["maxLength"] + 1))
        if "minItems" in node:
            add(label + " minItems", path, current[: max(0, node["minItems"] - 1)])
        if "maxItems" in node:
            add(label + " maxItems", path, [f"item-{i}" for i in range(node["maxItems"] + 1)])
        if node.get("uniqueItems") and current:
            add(label + " uniqueItems", path, [current[0], current[0]])
        if isinstance(current, dict):
            for key in node.get("required", []):
                if key in current:
                    add(f"{label} required {key}", [*path, key], remove=True)
            if node.get("additionalProperties") is False:
                add(label + " extra property", [*path, "AWS_SECRET_ACCESS_KEY"], "must-not-pass")
            for key, child in node.get("properties", {}).items():
                if key in current:
                    visit(child, current[key], [*path, key], document)
        if isinstance(current, list) and "items" in node:
            for index, item in enumerate(current):
                visit(node["items"], item, [*path, index], document)

    visit(schema, exemplar, [], schema)
    return mutations


@pytest.mark.parametrize("schema_path,valid_name,_", CASES)
def test_systematic_schema_mutations_rejected_by_schema_and_model(
    schema_path: str, valid_name: str, _: str
) -> None:
    schema = load(SCHEMAS / schema_path)
    model = getattr(contracts, schema["title"])
    exemplar = load(FIXTURES / "valid" / f"{valid_name}.json")
    for _name, negative in systematic_mutations(schema, exemplar):
        with pytest.raises(Exception):
            validate(schema_path, negative)
        with pytest.raises(ValidationError):
            model.model_validate(negative)


def test_benchmark_run_completion_utc_and_environment_allowlist() -> None:
    model = contracts.BenchmarkRun
    valid = load(FIXTURES / "valid/benchmark-run.json")
    for update in [
        {"startedAt": "2026-08-06T12:00:00+01:00"},
        {"endedAt": None, "status": "passed"},
        {"environment": {"AWS_SECRET_ACCESS_KEY": "secret"}},
    ]:
        with pytest.raises(ValidationError):
            model.model_validate({**valid, **update})
    model.model_validate({**valid, "endedAt": None, "status": "running"})


def test_persona_body_utf8_byte_limit_and_well_formed_strings() -> None:
    valid = load(FIXTURES / "valid/persona.json")
    exact = {**valid, "body": "😀" * 4096}
    validate("persona.json", exact)
    contracts.Persona.model_validate(exact)
    for invalid in [
        {**valid, "body": "😀" * 4097},
        {**valid, "body": "\ud800"},
        {**valid, "body": "\udc00"},
    ]:
        with pytest.raises(Exception):
            validate("persona.json", invalid)
        with pytest.raises(ValidationError):
            contracts.Persona.model_validate(invalid)


def test_generated_model_exists_for_every_canonical_schema() -> None:
    assert set(contracts.CONTRACT_SCHEMAS) == {path for path, _, _ in CASES}
    assert generated.contracts is contracts


def test_binary_frame_matches_typescript_fixture() -> None:
    fixture = load(FIXTURES / "valid/binary-frame.json")
    samples = b"".join(
        int(sample).to_bytes(2, "little", signed=True) for sample in fixture["samples"]
    )
    frame = BinaryAudioFrame(
        fixture["channel"],
        fixture["streamId"],
        fixture["sequence"],
        int(fixture["monotonicUs"]),
        samples,
    )
    encoded = encode_frame(frame, 100)
    assert encoded.hex() == fixture["hex"]
    assert decode_frame(encoded, 100) == frame
    with pytest.raises(ValueError, match="negotiated"):
        decode_frame(encoded, 4)
    with pytest.raises(ValueError, match="truncated"):
        decode_frame(encoded[:19], 100)
