from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .checksums import ChecksumError, verify_dataset, verify_models
from .randomization import (
    RevealLockedError,
    prepare_listening,
    prepare_listening_runs,
    reveal_mapping,
    submit_ratings,
)
from .runner import ROOT, ValidationError, normalize_summary, run_synthetic, validate_run
from .stt_runner import compare_stt_runs, run_stt
from .tts_runner import compare_tts_runs, probe_tts_cancellation, run_tts
from .util import canonical_json


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="python -m benchmarks.harness")
    commands = root.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="run a benchmark")
    run.add_argument("--kind", choices=["synthetic", "stt", "tts"], required=True)
    run.add_argument("--config", type=Path)
    run.add_argument("--candidate", choices=["nemotron", "parakeet", "kokoro", "qwen3-1.7b"])
    run.add_argument("--dataset", type=Path)
    run.add_argument("--prompts", type=Path)
    run.add_argument("--output-root", type=Path)
    run.add_argument("--soak-minutes", type=float, default=0)

    compare = commands.add_parser("compare", help="compare matched STT or TTS runs")
    compare.add_argument("--runs", type=Path, nargs="+", required=True)

    validate = commands.add_parser("validate", help="validate one run directory")
    validate.add_argument("run_dir", type=Path)

    verify = commands.add_parser("verify", help="verify fail-closed checksums")
    group = verify.add_mutually_exclusive_group(required=True)
    group.add_argument("--dataset", type=Path)
    group.add_argument("--models", type=Path)

    normalize = commands.add_parser("normalize", help="print deterministic normalized summary")
    normalize.add_argument("run_dir", type=Path)

    listen = commands.add_parser("listen", help="create an assessor-safe blinded comparison")
    listen.add_argument("--runs", type=Path, nargs="+", required=True)
    listen.add_argument("--assessor", required=True)
    listen.add_argument("--attempt", type=int, default=1)

    submit = commands.add_parser("submit-ratings", help="validate and lock blinded ratings")
    submit.add_argument("--run", type=Path, required=True)
    submit.add_argument("--view", type=Path, required=True)
    submit.add_argument("--responses", type=Path, required=True)

    reveal = commands.add_parser("reveal", help="reveal identities after ratings lock")
    reveal.add_argument("--run", type=Path, required=True)

    cancel = commands.add_parser("probe-cancel", help="run a real TTS cancellation probe")
    cancel.add_argument("--candidate", choices=["kokoro", "qwen3-1.7b"], required=True)
    cancel.add_argument("--config", type=Path, required=True)
    cancel.add_argument("--prompts", type=Path, required=True)
    cancel.add_argument("--run", type=Path, required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "run":
            # Persist the interpreter that actually dispatched the run. This is
            # important for Qwen's isolated runtime and for reproducible reruns.
            command = [sys.executable, "-m", "benchmarks.harness", *sys.argv[1:]]
            if args.kind == "synthetic":
                if (
                    args.config is None
                    or args.candidate is not None
                    or args.dataset is not None
                    or args.prompts is not None
                    or args.soak_minutes != 0
                ):
                    raise ValueError("synthetic run requires --config only")
                run_dir = run_synthetic(args.config, args.output_root, command)
            elif args.kind == "stt":
                if (
                    args.candidate not in {"nemotron", "parakeet"}
                    or args.dataset is None
                    or args.config is None
                    or args.prompts is not None
                ):
                    raise ValueError("stt run requires --candidate, --config, and --dataset")
                run_dir = run_stt(
                    args.candidate,
                    args.dataset,
                    args.output_root,
                    command,
                    args.soak_minutes,
                    config_path=args.config,
                )
            else:
                if (
                    args.candidate not in {"kokoro", "qwen3-1.7b"}
                    or args.prompts is None
                    or args.config is None
                    or args.dataset is not None
                ):
                    raise ValueError("tts run requires --candidate, --config, and --prompts")
                run_dir = run_tts(
                    args.candidate,
                    args.config,
                    args.prompts,
                    args.output_root,
                    command,
                    args.soak_minutes,
                )
            print(run_dir)
        elif args.command == "compare":
            kinds = {
                json.loads((path.resolve() / "run.json").read_text()).get("kind")
                for path in args.runs
            }
            if kinds == {"stt"}:
                comparison = compare_stt_runs(args.runs)
            elif kinds == {"tts"}:
                comparison = compare_tts_runs(args.runs)
            else:
                raise ValueError("compare runs must all be STT or all be TTS")
            print(json.dumps(comparison, indent=2, sort_keys=True))
        elif args.command == "validate":
            counts = validate_run(args.run_dir)
            print(
                f"valid: items={counts['items']} events={counts['events']} ratings={counts['ratings']}"
            )
        elif args.command == "verify":
            if args.dataset:
                _, digest = verify_dataset(args.dataset.resolve(), ROOT)
                print(f"valid dataset: sha256={digest}")
            else:
                models = verify_models(args.models.resolve(), ROOT)
                print(f"valid models: count={len(models)}")
        elif args.command == "normalize":
            sys.stdout.buffer.write(canonical_json(normalize_summary(args.run_dir)))
        elif args.command == "listen":
            if len(args.runs) == 1:
                if args.attempt != 1:
                    raise ValueError("single-run listening baseline supports attempt 1 only")
                print(prepare_listening(args.runs[0].resolve(), args.assessor))
            else:
                print(
                    prepare_listening_runs(
                        [run.resolve() for run in args.runs], args.assessor, args.attempt
                    )
                )
        elif args.command == "submit-ratings":
            submit_ratings(args.run.resolve(), args.view.resolve(), args.responses.resolve())
            print("ratings submitted and locked")
        elif args.command == "reveal":
            mapping = reveal_mapping(args.run.resolve())
            print(json.dumps(mapping, sort_keys=True))
        elif args.command == "probe-cancel":
            print(
                json.dumps(
                    probe_tts_cancellation(args.candidate, args.config, args.prompts, args.run),
                    indent=2,
                    sort_keys=True,
                )
            )
        return 0
    except (
        ChecksumError,
        RevealLockedError,
        ValidationError,
        ValueError,
        OSError,
        json.JSONDecodeError,
    ) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
