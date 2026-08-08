#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
UV=$(command -v uv || true)
if [[ -z "$UV" && -x "$HOME/.local/bin/uv" ]]; then UV="$HOME/.local/bin/uv"; fi
[[ -n "$UV" ]] || { echo "uv is required" >&2; exit 1; }

before_ts=$(sha256sum packages/contracts/src/generated/contracts.ts 2>/dev/null | cut -d' ' -f1 || true)
before_py=$(sha256sum services/audio/src/generated/contracts.py 2>/dev/null | cut -d' ' -f1 || true)
corepack pnpm contracts:generate
"$UV" run python scripts/generate_contracts.py
after_ts=$(sha256sum packages/contracts/src/generated/contracts.ts | cut -d' ' -f1)
after_py=$(sha256sum services/audio/src/generated/contracts.py | cut -d' ' -f1)
if [[ -n "$before_ts" && "$before_ts" != "$after_ts" ]] || [[ -n "$before_py" && "$before_py" != "$after_py" ]]; then
  echo "Generated contracts were stale; run generators and commit their output" >&2
  exit 1
fi
corepack pnpm --filter @app/contracts typecheck
corepack pnpm --filter @app/policy typecheck
corepack pnpm --filter @app/host typecheck
corepack pnpm --filter @app/web typecheck
corepack pnpm test --filter @app/contracts
corepack pnpm test --filter @app/policy
"$UV" run pytest services/audio/tests/test_contracts.py services/audio/tests/test_server_security.py
"$UV" run pytest services/audio/tests/stt
"$UV" run pytest benchmarks/harness/tests
"$UV" run ruff check scripts/generate_contracts.py scripts/verify-models.py services/audio/src services/audio/tests benchmarks/harness packages/test-fixtures/audio/generate.py
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
