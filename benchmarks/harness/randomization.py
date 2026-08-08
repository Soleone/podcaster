from __future__ import annotations

import json
import os
import random
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from .util import canonical_json, sha256_bytes


class RevealLockedError(RuntimeError):
    pass


def blind_mapping(candidate_ids: list[str], seed: int) -> dict[str, str]:
    shuffled = sorted(candidate_ids)
    random.Random(seed).shuffle(shuffled)
    labels = [chr(ord("A") + index) for index in range(len(shuffled))]
    return dict(zip(labels, shuffled, strict=True))


def _private_path(run_dir: Path) -> Path:
    return run_dir.parent / ".reveal-private" / f"{run_dir.name}.json"


def _trusted_view_path(run_dir: Path) -> Path:
    return run_dir.parent / ".reveal-private" / f"{run_dir.name}.view.sha256"


def write_sealed_mapping(
    run_dir: Path,
    mapping: dict[str, str],
    prompt_orders: dict[str, list[str]] | None = None,
    identity_details: dict[str, dict[str, str]] | None = None,
) -> None:
    private_dir = run_dir.parent / ".reveal-private"
    private_dir.mkdir(mode=0o700, exist_ok=True)
    payload = {
        "candidateMapping": mapping,
        "promptOrders": prompt_orders or {},
        "identityDetails": identity_details or {},
    }
    private_path = _private_path(run_dir)
    private_path.write_bytes(canonical_json(payload))
    os.chmod(private_path, 0o600)
    public = {
        "schemaVersion": 1,
        "algorithm": "sha256-canonical-json",
        "commitment": sha256_bytes(canonical_json(payload)),
        "locked": True,
    }
    (run_dir / "reveal.sealed.json").write_bytes(canonical_json(public))


def _load_private(run_dir: Path) -> dict[str, Any]:
    return json.loads(_private_path(run_dir).read_text(encoding="utf-8"))


def prepare_listening_runs(
    run_dirs: list[Path], assessor_id: str, attempt: int = 1
) -> Path:
    if len(run_dirs) < 2:
        raise RevealLockedError("listening comparison requires at least two runs")
    if attempt < 1:
        raise RevealLockedError("comparison attempt must be positive")
    from .runner import validate_run  # Avoid a module initialization cycle.

    loaded: list[tuple[Path, dict[str, Any], list[dict[str, Any]]]] = []
    for raw_dir in run_dirs:
        run_dir = raw_dir.resolve()
        validate_run(run_dir)
        run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
        items = [
            json.loads(line)
            for line in (run_dir / "items.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        loaded.append((run_dir, run, items))
    first = loaded[0][1]
    compatibility = (
        first["kind"],
        first["datasetId"],
        first["datasetSha256"],
        first["comparisonSemanticsSha256"],
        first["repetitions"],
        {entry["sourceId"] for entry in first["expectedItems"]},
    )
    for _, run, _ in loaded[1:]:
        current = (
            run["kind"],
            run["datasetId"],
            run["datasetSha256"],
            run["comparisonSemanticsSha256"],
            run["repetitions"],
            {entry["sourceId"] for entry in run["expectedItems"]},
        )
        if current != compatibility:
            raise RevealLockedError("runs do not have matched dataset/config semantics")
    if attempt > int(first["repetitions"]):
        raise RevealLockedError("comparison attempt exceeds configured repetitions")

    workspace = run_dirs[0].resolve().parent / f"comparison-{uuid.uuid4()}"
    workspace.mkdir()
    identities: list[str] = []
    identity_details: dict[str, dict[str, str]] = {}
    comparison_items: list[dict[str, Any]] = []
    source_ids = sorted(compatibility[-1])
    for run_index, (run_dir, run, items) in enumerate(loaded, start=1):
        identity = f"run-{run_index}-{run['runId']}"
        identities.append(identity)
        candidate_ids = sorted({item["candidateId"] for item in items if not item["sourceId"].startswith("__run__:")})
        if len(candidate_ids) != 1:
            raise RevealLockedError("each comparison run must contain exactly one candidate")
        identity_details[identity] = {
            "runId": run["runId"],
            "candidateId": candidate_ids[0],
            "configId": run["configId"],
        }
        for source_index, source_id in enumerate(source_ids, start=1):
            matches = [
                item for item in items
                if item["sourceId"] == source_id and item["attempt"] == attempt
            ]
            if len(matches) != 1:
                raise RevealLockedError(
                    f"run {run['runId']} lacks one unambiguous item for {source_id}/attempt {attempt}"
                )
            source_item = matches[0]
            audio_path = None
            if source_item["audioPath"] is not None:
                source_audio = (run_dir / source_item["audioPath"]).resolve()
                if run_dir not in source_audio.parents or not source_audio.is_file():
                    raise RevealLockedError("comparison source audio is missing or unsafe")
                imported = workspace / "source-media" / f"run-{run_index}" / f"source-{source_index}{source_audio.suffix}"
                imported.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source_audio, imported)
                audio_path = str(imported.relative_to(workspace))
            comparison_items.append(
                {
                    "candidateId": identity,
                    "sourceId": source_id,
                    "status": source_item["status"],
                    "audioPath": audio_path,
                    "blindLabel": "pending",
                }
            )
    seed_material = "|".join(run["runId"] for _, run, _ in loaded).encode()
    seed = int.from_bytes(bytes.fromhex(sha256_bytes(seed_material))[:8], "big")
    (workspace / "run.json").write_bytes(canonical_json({"seed": seed}))
    (workspace / "items.jsonl").write_bytes(
        b"".join(canonical_json(item) for item in comparison_items)
    )
    (workspace / "ratings.jsonl").write_text("", encoding="utf-8")
    mapping = blind_mapping(identities, seed)
    write_sealed_mapping(workspace, mapping, identity_details=identity_details)
    return prepare_listening(workspace, assessor_id)


def prepare_listening(run_dir: Path, assessor_id: str) -> Path:
    if not assessor_id:
        raise RevealLockedError("assessor ID is required")
    lock_path = run_dir / "ratings.lock.json"
    if lock_path.exists():
        raise RevealLockedError("ratings are already submitted and locked")
    items = [json.loads(line) for line in (run_dir / "items.jsonl").read_text().splitlines()]
    private = _load_private(run_dir)
    mapping = private["candidateMapping"]
    inverse = {candidate: label for label, candidate in mapping.items()}
    candidate_ids = set(inverse)
    if {item["candidateId"] for item in items} != candidate_ids:
        raise RevealLockedError("private candidate mapping does not match run items")
    run = json.loads((run_dir / "run.json").read_text())
    prompts: list[dict[str, Any]] = []
    prompt_orders: dict[str, list[str]] = {}
    for prompt_index, source_id in enumerate(sorted({item["sourceId"] for item in items})):
        by_candidate = {item["candidateId"]: item for item in items if item["sourceId"] == source_id}
        if set(by_candidate) != candidate_ids:
            raise RevealLockedError(f"prompt {source_id} does not contain every candidate")
        order = sorted(mapping)
        random.Random(int(run["seed"]) + prompt_index + 1).shuffle(order)
        prompt_orders[source_id] = order
        samples = []
        for label in order:
            item = by_candidate[mapping[label]]
            public_audio_path = None
            if item["audioPath"] is not None:
                source_path = (run_dir / item["audioPath"]).resolve()
                if run_dir.resolve() not in source_path.parents or not source_path.is_file():
                    raise RevealLockedError(f"missing or unsafe audio for {source_id}/{label}")
                media_dir = run_dir / "listening-media" / f"prompt-{prompt_index + 1}"
                media_dir.mkdir(parents=True, exist_ok=True)
                target = media_dir / f"sample-{label}{source_path.suffix}"
                shutil.copyfile(source_path, target)
                public_audio_path = str(target.relative_to(run_dir))
            samples.append(
                {"label": label, "status": item["status"], "audioPath": public_audio_path}
            )
        prompts.append(
            {
                "promptLabel": f"Prompt {prompt_index + 1}",
                "order": order,
                "samples": samples,
            }
        )
    private["promptOrders"] = prompt_orders
    _private_path(run_dir).write_bytes(canonical_json(private))
    os.chmod(_private_path(run_dir), 0o600)
    sealed = json.loads((run_dir / "reveal.sealed.json").read_text())
    sealed["commitment"] = sha256_bytes(canonical_json(private))
    (run_dir / "reveal.sealed.json").write_bytes(canonical_json(sealed))
    single_candidate = len(candidate_ids) == 1
    view = {
        "schemaVersion": 1,
        "workflow": (
            "unrevealed-single-candidate-baseline-projection-v1"
            if single_candidate
            else "rateable-paired-comparison-v1"
        ),
        "rateable": not single_candidate,
        "sessionId": str(uuid.uuid4()),
        "assessorId": assessor_id,
        "prompts": prompts,
        "revealCommitment": sealed["commitment"],
    }
    view["viewCommitment"] = sha256_bytes(canonical_json(view))
    path = run_dir / "listening.json"
    view_bytes = canonical_json(view)
    path.write_bytes(view_bytes)
    trusted_view = _trusted_view_path(run_dir)
    trusted_view.write_text(sha256_bytes(view_bytes) + "\n", encoding="ascii")
    os.chmod(trusted_view, 0o600)
    return path


def _rating_validator(run_dir: Path) -> Draft202012Validator:
    root = Path(__file__).resolve().parents[2]
    schema = json.loads((root / "benchmarks/results/schema/rating.json").read_text())
    return Draft202012Validator(schema, format_checker=FormatChecker())


def submit_ratings(run_dir: Path, view_path: Path, responses_path: Path) -> None:
    lock_path = run_dir / "ratings.lock.json"
    if lock_path.exists():
        raise RevealLockedError("ratings are already submitted and locked")
    view_bytes = view_path.read_bytes()
    trusted_view = _trusted_view_path(run_dir)
    if not trusted_view.is_file() or trusted_view.read_text(encoding="ascii").strip() != sha256_bytes(view_bytes):
        raise RevealLockedError("listening projection does not match the trusted generated view")
    view = json.loads(view_bytes)
    expected_commitment = view.pop("viewCommitment", None)
    if view.get("rateable") is not True or view.get("workflow") != "rateable-paired-comparison-v1":
        raise RevealLockedError(
            "single-candidate baseline projections are not rateable; defer submission to paired comparison"
        )
    if expected_commitment != sha256_bytes(canonical_json(view)):
        raise RevealLockedError("listening projection was modified")
    sealed = json.loads((run_dir / "reveal.sealed.json").read_text())
    if view.get("revealCommitment") != sealed.get("commitment") or not sealed.get("locked"):
        raise RevealLockedError("listening projection does not match locked run")
    response_data = json.loads(responses_path.read_text())
    responses = response_data.get("ratings") if isinstance(response_data, dict) else None
    if not isinstance(responses, list):
        raise RevealLockedError("responses must contain a ratings array")
    by_prompt = {entry.get("promptLabel"): entry for entry in responses if isinstance(entry, dict)}
    expected_prompts = {prompt["promptLabel"] for prompt in view["prompts"]}
    if set(by_prompt) != expected_prompts or len(responses) != len(expected_prompts):
        raise RevealLockedError("responses must contain every prompt exactly once")
    now = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    records = []
    validator = _rating_validator(run_dir)
    for prompt in view["prompts"]:
        response = by_prompt[prompt["promptLabel"]]
        labels = [sample["label"] for sample in prompt["samples"]]
        preference = response.get("preference")
        if preference not in {*labels, "tie"}:
            raise RevealLockedError(f"invalid preference for {prompt['promptLabel']}")
        response_samples = response.get("samples")
        if not isinstance(response_samples, list):
            raise RevealLockedError(
                f"ratings for {prompt['promptLabel']} must contain a samples array"
            )
        by_label = {
            sample.get("label"): sample for sample in response_samples if isinstance(sample, dict)
        }
        if len(response_samples) != len(labels) or set(by_label) != set(labels):
            raise RevealLockedError(
                f"ratings for {prompt['promptLabel']} must cover every sample label exactly once"
            )
        sample_ratings = [
            {
                "label": label,
                "naturalness": by_label[label].get("naturalness"),
                "intelligibility": by_label[label].get("intelligibility"),
                "listenability": by_label[label].get("listenability"),
            }
            for label in labels
        ]
        record = {
            "assessorId": view["assessorId"],
            "sessionId": view["sessionId"],
            "order": prompt["order"],
            "promptLabel": prompt["promptLabel"],
            "sampleLabels": labels,
            "sampleRatings": sample_ratings,
            "preference": preference,
            "replayCount": response.get("replayCount", 0),
            "submittedAt": now,
            "revealLocked": True,
            "revealedAt": None,
        }
        if "note" in response:
            record["note"] = response["note"]
        errors = list(validator.iter_errors(record))
        if errors:
            raise RevealLockedError(f"invalid rating for {prompt['promptLabel']}: {errors[0].message}")
        records.append(record)
    ratings_bytes = b"".join(canonical_json(record) for record in records)
    ratings_path = run_dir / "ratings.jsonl"
    ratings_path.write_bytes(ratings_bytes)
    os.chmod(ratings_path, 0o444)
    submitted_hash = sha256_bytes(ratings_bytes)
    lock = {
        "schemaVersion": 1,
        "algorithm": "sha256",
        "phase": "submitted",
        "submittedRatingsSha256": submitted_hash,
        "ratingsSha256": submitted_hash,
        "viewCommitment": expected_commitment,
        "submittedAt": now,
        "revealedAt": None,
    }
    lock_path.write_bytes(canonical_json(lock))
    os.chmod(lock_path, 0o444)


def verify_ratings_lock(run_dir: Path) -> bool:
    ratings = run_dir / "ratings.jsonl"
    lock_path = run_dir / "ratings.lock.json"
    if not ratings.read_bytes():
        if lock_path.exists():
            raise RevealLockedError("empty ratings cannot be locked")
        return False
    if not lock_path.is_file():
        raise RevealLockedError("submitted ratings are not locked")
    lock = json.loads(lock_path.read_text())
    current_hash = sha256_bytes(ratings.read_bytes())
    if lock.get("ratingsSha256") != current_hash:
        raise RevealLockedError("locked ratings were modified")
    if not isinstance(lock.get("submittedRatingsSha256"), str):
        raise RevealLockedError("ratings lock lacks immutable submission evidence")
    phase = lock.get("phase")
    if phase not in {"submitted", "revealed"}:
        raise RevealLockedError("ratings lock phase is invalid")
    records = [json.loads(line) for line in ratings.read_text().splitlines()]
    if phase == "submitted":
        if any(not record.get("revealLocked") or record.get("revealedAt") is not None for record in records):
            raise RevealLockedError("submitted ratings have inconsistent reveal state")
        if current_hash != lock["submittedRatingsSha256"]:
            raise RevealLockedError("submitted ratings do not match immutable submission evidence")
    else:
        revealed_at = lock.get("revealedAt")
        if not isinstance(revealed_at, str) or any(
            record.get("revealLocked") is not False or record.get("revealedAt") != revealed_at
            for record in records
        ):
            raise RevealLockedError("revealed ratings have inconsistent reveal state")
        reconstructed = []
        for record in records:
            submitted = dict(record)
            submitted["revealLocked"] = True
            submitted["revealedAt"] = None
            reconstructed.append(submitted)
        reconstructed_bytes = b"".join(canonical_json(record) for record in reconstructed)
        if sha256_bytes(reconstructed_bytes) != lock["submittedRatingsSha256"]:
            raise RevealLockedError("revealed ratings differ from immutable submitted scores")
    return True


def reveal_mapping(run_dir: Path) -> dict[str, Any]:
    if not verify_ratings_lock(run_dir):
        raise RevealLockedError("ratings must be submitted and locked before reveal")
    lock_path = run_dir / "ratings.lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("phase") == "revealed":
        raise RevealLockedError("ratings were already revealed")
    private = _load_private(run_dir)
    sealed_path = run_dir / "reveal.sealed.json"
    sealed = json.loads(sealed_path.read_text(encoding="utf-8"))
    if sha256_bytes(canonical_json(private)) != sealed.get("commitment"):
        raise RevealLockedError("sealed reveal commitment mismatch")
    revealed_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    ratings_path = run_dir / "ratings.jsonl"
    records = [json.loads(line) for line in ratings_path.read_text().splitlines()]
    for record in records:
        record["revealLocked"] = False
        record["revealedAt"] = revealed_at
    revealed_bytes = b"".join(canonical_json(record) for record in records)
    os.chmod(ratings_path, 0o600)
    ratings_path.write_bytes(revealed_bytes)
    os.chmod(ratings_path, 0o444)
    os.chmod(lock_path, 0o600)
    lock["phase"] = "revealed"
    lock["revealedAt"] = revealed_at
    lock["ratingsSha256"] = sha256_bytes(revealed_bytes)
    lock_path.write_bytes(canonical_json(lock))
    os.chmod(lock_path, 0o444)
    verify_ratings_lock(run_dir)
    details = private.get("identityDetails", {})
    revealed_mapping: dict[str, Any] = {
        label: details.get(identity, identity)
        for label, identity in private["candidateMapping"].items()
    }
    sealed["locked"] = False
    sealed["mapping"] = private["candidateMapping"]
    sealed["identities"] = revealed_mapping
    sealed["revealedAt"] = revealed_at
    sealed_path.write_bytes(canonical_json(sealed))
    run_path = run_dir / "run.json"
    run = json.loads(run_path.read_text())
    if "randomization" in run:
        run["randomization"]["revealLocked"] = False
        run_path.write_bytes(canonical_json(run))
    return revealed_mapping
