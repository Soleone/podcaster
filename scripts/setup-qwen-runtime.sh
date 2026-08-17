#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

UV=${UV:-$(command -v uv || true)}
if [[ -z "$UV" && -x "$HOME/.local/bin/uv" ]]; then
  UV="$HOME/.local/bin/uv"
fi
[[ -n "$UV" ]] || { echo "uv is required" >&2; exit 1; }

QWEN_ENV="$ROOT/.venv-qwen"
FASTER_REPO="https://github.com/andimarafioti/faster-qwen3-tts.git"
FASTER_COMMIT="a70afc0f81f7f5f8801c3227968f1102f43f211c"

if [[ ! -x "$QWEN_ENV/bin/python" ]]; then
  "$UV" venv --python 3.12 "$QWEN_ENV"
fi

"$UV" pip install \
  --python "$QWEN_ENV/bin/python" \
  --require-hashes \
  -r services/audio/qwen-requirements.lock
"$UV" pip install \
  --python "$QWEN_ENV/bin/python" \
  --no-deps \
  "faster-qwen3-tts @ git+$FASTER_REPO@$FASTER_COMMIT"

# Downloads and verifies the immutable 0.6B CustomVoice snapshot.
"$UV" run python scripts/acquire-qwen3-tts.py

PYTHONPATH="$ROOT" "$QWEN_ENV/bin/python" - <<'PY'
from services.audio.src.tts.qwen3 import _verify_runtime_distribution

_verify_runtime_distribution()
print("Qwen runtime verified")
PY
