#!/usr/bin/env python3
"""Interactive blinded A/B TTS listening reviewer.

This reads only the assessor-safe listening.json projection, plays its opaque
sample paths with ffplay, and writes a harness-compatible responses.json.
Candidate identities are never loaded or displayed.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def load_view(package: Path) -> dict[str, Any]:
    view_path = package / "listening.json"
    view = json.loads(view_path.read_text(encoding="utf-8"))
    if view.get("rateable") is not True:
        raise ValueError(f"{view_path} is not a rateable paired comparison")
    if view.get("workflow") != "rateable-paired-comparison-v1":
        raise ValueError(f"{view_path} has an unsupported workflow")
    return view


def play(package: Path, sample: dict[str, Any], *, no_audio: bool) -> None:
    audio_path = sample.get("audioPath")
    if not audio_path:
        raise ValueError(f"sample {sample.get('label')} has no audio")
    path = (package / audio_path).resolve()
    if package.resolve() not in path.parents or not path.is_file():
        raise ValueError(f"missing or unsafe audio path: {audio_path}")
    if no_audio:
        return
    print(f"  Playing sample {sample['label']}...", flush=True)
    try:
        subprocess.run(
            ["ffplay", "-nodisp", "-autoexit", "-hide_banner", "-loglevel", "error", str(path)],
            stdin=subprocess.DEVNULL,
            check=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError("ffplay is required; install ffmpeg or use --no-audio") from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"ffplay failed for {audio_path}") from error


def play_pair_with_replay(
    package: Path, samples: list[dict[str, Any]], *, no_audio: bool
) -> None:
    while True:
        for sample in samples:
            play(package, sample, no_audio=no_audio)
        choice = input("  Enter to rate, r to play both again, q to quit: ").strip().lower()
        if choice in {"", "n"}:
            return
        if choice == "q":
            raise KeyboardInterrupt
        if choice != "r":
            print("Enter r to replay both samples, or press Enter to rate them.")


def ask_choice(prompt: str, choices: set[str]) -> str:
    while True:
        value = input(prompt).strip().lower()
        if value == "q":
            raise KeyboardInterrupt
        if value in choices:
            return value
        print(f"Enter one of: {', '.join(sorted(choices))}; q quits and saves progress.")


def response_for_prompt(package: Path, prompt: dict[str, Any], *, no_audio: bool) -> dict[str, Any]:
    print(f"\n{prompt['promptLabel']}  Order: {' then '.join(prompt['order'])}")
    play_pair_with_replay(package, prompt["samples"], no_audio=no_audio)
    print("Choose the sample you preferred overall.")
    preference = ask_choice("  Preference [A/B/tie]: ", {"a", "b", "tie"})
    ratings = [{"label": sample["label"]} for sample in prompt["samples"]]
    replay = input("  Replay count (enter for 0): ").strip()
    if replay.lower() == "q":
        raise KeyboardInterrupt
    try:
        replay_count = int(replay or "0")
    except ValueError:
        print("Invalid replay count; recording 0.")
        replay_count = 0
    if replay_count < 0:
        replay_count = 0
    return {
        "promptLabel": prompt["promptLabel"],
        "samples": ratings,
        "preference": {"a": "A", "b": "B"}.get(preference, "tie"),
        "replayCount": replay_count,
    }


def load_partial(path: Path, prompts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    ratings = data.get("ratings")
    expected = [prompt["promptLabel"] for prompt in prompts]
    if not isinstance(ratings, list) or [item.get("promptLabel") for item in ratings] != expected[: len(ratings)]:
        raise ValueError(f"partial response file has unexpected prompt order: {path}")
    return ratings


def save_partial(path: Path, ratings: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps({"ratings": ratings}, indent=2) + "\n", encoding="utf-8")


def review_package(package: Path, *, no_audio: bool, overwrite: bool) -> None:
    package = package.resolve()
    view = load_view(package)
    prompts = view["prompts"]
    output = package / "responses.json"
    partial = package / "responses.partial.json"
    if output.exists() and not overwrite:
        print(f"Skipping completed package: {package}")
        print("  use --overwrite to review it again")
        return
    ratings = [] if overwrite else load_partial(partial, prompts)
    print(f"\n=== Blinded TTS review: {view['assessorId']} ({len(ratings)}/{len(prompts)} complete) ===")
    print("Only opaque A/B labels are shown. q saves progress and exits.\n")
    try:
        for prompt in prompts[len(ratings) :]:
            ratings.append(response_for_prompt(package, prompt, no_audio=no_audio))
            save_partial(partial, ratings)
    except KeyboardInterrupt:
        save_partial(partial, ratings)
        print(f"\nSaved {len(ratings)}/{len(prompts)} responses to {partial}")
        raise SystemExit(2)
    output.write_text(json.dumps({"ratings": ratings}, indent=2) + "\n", encoding="utf-8")
    partial.unlink(missing_ok=True)
    print(f"Wrote harness responses: {output}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", nargs="+", type=Path, help="comparison package directories")
    parser.add_argument("--no-audio", action="store_true", help="skip ffplay, useful for checking the workflow")
    parser.add_argument("--overwrite", action="store_true", help="discard existing responses and start over")
    args = parser.parse_args()
    for package in args.packages:
        review_package(package, no_audio=args.no_audio, overwrite=args.overwrite)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
