#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
UV=$(command -v uv || true)
if [[ -z "$UV" && -x "$HOME/.local/bin/uv" ]]; then UV="$HOME/.local/bin/uv"; fi
[[ -n "$UV" ]] || { echo "uv is required" >&2; exit 1; }

generated_outputs=(
  packages/contracts/src/generated/contracts.ts
  packages/contracts/test/types-required.generated.compile.ts
  services/audio/src/generated/contracts.py
  services/audio/src/generated/__init__.py
  benchmarks/results/schema/event.json
  benchmarks/results/schema/item.json
  benchmarks/results/schema/rating.json
  benchmarks/results/schema/run.json
  benchmarks/results/schema/summary.json
)
before_hashes=()
for path in "${generated_outputs[@]}"; do
  before_hashes+=("$(sha256sum "$path" 2>/dev/null | cut -d' ' -f1 || true)")
done
corepack pnpm contracts:generate
"$UV" run python scripts/generate_contracts.py
stale_outputs=()
for index in "${!generated_outputs[@]}"; do
  path="${generated_outputs[$index]}"
  after_hash=$(sha256sum "$path" 2>/dev/null | cut -d' ' -f1 || true)
  if [[ -z "${before_hashes[$index]}" || -z "$after_hash" || "${before_hashes[$index]}" != "$after_hash" ]]; then
    stale_outputs+=("$path")
  fi
done
if ((${#stale_outputs[@]} > 0)); then
  echo "Generated outputs were stale; run generators and commit their output:" >&2
  printf '  %s\n' "${stale_outputs[@]}" >&2
  exit 1
fi
# The multi-turn fixture metadata records the committed raw bytes (SHA-256 and
# byte length) and repository-relative source paths; verify it matches the file.
"$UV" run python - scripts/fixtures/multi-turn-utterances.json scripts/fixtures/multi-turn-utterances.raw <<'PY'
import hashlib
import json
import sys
from pathlib import Path

meta_path, raw_path = sys.argv[1:]
meta = json.loads(Path(meta_path).read_text())
raw = Path(raw_path).read_bytes()
recorded = meta["raw"]
actual = {"sha256": hashlib.sha256(raw).hexdigest(), "byteLength": len(raw)}
if recorded != actual:
    raise SystemExit(f"fixture metadata mismatch: recorded {recorded} != actual {actual}")
if any(path.startswith("/") for path in meta["sourcePaths"]):
    raise SystemExit("fixture sourcePaths must be repository-relative")
PY
# Every job below reads the generated contracts after the freshness check. The
# host test builds its own web/contract artifacts, so the independent test jobs can
# run together instead of paying each toolchain's startup cost serially.
run_parallel() {
  local -a pids=()
  local command
  for command in "$@"; do
    bash -c "$command" & pids+=("$!")
  done
  local status=0 pid
  for pid in "${pids[@]}"; do
    wait "$pid" || status=$?
  done
  return "$status"
}

run_parallel \
  'corepack pnpm --filter @app/contracts typecheck' \
  'corepack pnpm --filter @app/policy typecheck' \
  'corepack pnpm --filter @app/host typecheck' \
  'corepack pnpm --filter @app/web typecheck' \
  'corepack pnpm --filter @app/web test' \
  'corepack pnpm test --filter @app/contracts' \
  'corepack pnpm test --filter @app/policy' \
  "$UV run pytest services/audio/tests" \
  "$UV run pytest benchmarks/harness/tests" \
  "$UV run ruff check scripts/generate_contracts.py scripts/verify-models.py services/audio/src services/audio/tests benchmarks/harness packages/test-fixtures/audio/generate.py"
corepack pnpm test --filter @app/host
corepack pnpm test:dev-cleanup
for pattern in '.env' '*.pem' '*.safetensors' '*.onnx' '*.gguf' '*.wav' 'benchmarks/datasets/**/source/' 'benchmarks/datasets/**/*.tar.gz' 'benchmarks/results/*/'; do
  grep -Fqx "$pattern" .gitignore || { echo "missing required ignore: $pattern" >&2; exit 1; }
done
ignore_test=$(mktemp -d)
trap 'rm -rf "$ignore_test"' EXIT
git -C "$ignore_test" init -q
cp .gitignore "$ignore_test/.gitignore"
mkdir -p "$ignore_test/benchmarks/results/run-1" "$ignore_test/benchmarks/datasets/corpus/source"
touch "$ignore_test/.env" "$ignore_test/private.pem" "$ignore_test/model.safetensors" "$ignore_test/model.onnx" "$ignore_test/model.gguf" "$ignore_test/audio.wav" "$ignore_test/benchmarks/datasets/corpus/source/raw.txt" "$ignore_test/benchmarks/datasets/corpus/archive.tar.gz" "$ignore_test/benchmarks/results/run-1/run.json"
for path in .env private.pem model.safetensors model.onnx model.gguf audio.wav benchmarks/datasets/corpus/source/raw.txt benchmarks/datasets/corpus/archive.tar.gz benchmarks/results/run-1/run.json; do
  git -C "$ignore_test" check-ignore -q "$path" || { echo "sensitive/large artifact not ignored: $path" >&2; exit 1; }
done
echo "check: all validations passed"
