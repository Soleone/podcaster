# Podcaster: local voice podcast companion

A local-first podcast companion: speak to it with a microphone and it answers
out loud. Speech runs on this machine (local STT and TTS models), while the
conversation intelligence comes from the `pi` command-line agent you configure.

## What it does

- Live voice sessions: capture from the browser microphone, transcribe with the
  selected local STT model (Nemotron 3.5 streaming 320 ms by default), reason
  with a separate `pi` child process, and reply through the selected local TTS
  model (Kokoro `af_heart` by default).
- Interruptible playback: speaking during a response barge-in cancels it;
  sessions return to listening after each turn.
- Recordings and transcripts are exported from the browser session UI.
- Settings for the agent name, persona, voice/catalog, TTS backend, Pi model
  and thinking level, and custom voice enrollment (consent-gated; reference
  recordings stay in browser local storage and are used only by the local
  audio sidecar).
- An optional "Agent activity" panel that shows, grouped by preparation and
  turn, which read-only research tools (for example web search) the agent
  used while forming a response, with a short summary and duration per call.
- Optional CUDA evaluation runtimes: Qwen CustomVoice (1.7B) voice cloning and
  the 0.6B Base clone spike, isolated in their own Python environments.

## Prerequisites

- Linux (WSL2 works; the CUDA paths were developed on WSL2 with an RTX 4090).
- Node `22.22.3`, Corepack (comes with Node), and pnpm `9.15.9`.
- Python `3.12` and `uv` `0.8.8`.

Local speech models are required for voice features and are **not** part of
`pnpm install`: they are downloaded and verified against
`services/audio/config/model-manifest.json` as described in `docs/benchmarking.md`. Checklist:

- STT model (Nemotron 3.5 ASR streaming 0.6B) and TTS model (Kokoro-82M ONNX)
  under `models/`, matching `services/audio/config/model-manifest.json`.
- Optional: Qwen evaluation runtimes, including the custom-voice clone route
  (see `scripts/setup-qwen-runtime.sh`).
- Optional: the Parakeet challenger and the benchmark corpus, for the
  reproducible harness described in `docs/benchmarking.md`.

Pi is a mandatory runtime dependency: the host spawns an executable named `pi`
for every response. It is resolved from `PODCASTER_PI_EXECUTABLE` (absolute
path) or from `PATH`, and must be a Pi 0.84+ CLI already configured for your
model provider. Podcaster only sets the provider/model identifier and thinking
level (editable in the UI; default `openai-codex/gpt-5.6-sol`, `medium`);
authentication and credentials are handled by Pi itself. Reasoning goes to
whatever model provider the installed Pi CLI is configured to use, so there is
no claim that the full loop is offline or private.

## Setup (fresh machine)

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
uv sync --frozen
corepack pnpm install --frozen-lockfile
```

Then acquire and verify the local speech models per `docs/benchmarking.md` and
confirm the manifest checks out:

```bash
uv run python scripts/verify-models.py services/audio/config/model-manifest.json
```

Optional Qwen runtime (isolated, pinned Transformers 4.57.3; does not touch the
host Python environment):

```bash
./scripts/setup-qwen-runtime.sh
```

## Running

Two workflows, selected with one script:

- `pnpm dev`: HMR development (`scripts/dev-hmr.mjs`). Builds the host and its
  dependencies first, then serves the web app through Vite's dev server at
  `http://127.0.0.1:5173`; the browser bundle is not prebuilt, so source edits
  hot-reload. Vite proxies `/api` and `/ws` to the host.
- `pnpm dev:build`: production-like build-first workflow. Builds the web app
  and host, then serves the generated bundle from the host at
  `http://127.0.0.1:43127`.
- `pnpm build`: creates both build artifacts without starting a server.

The frontend port can be changed with `PODCASTER_WEB_PORT`, and the host port
with `PODCASTER_PORT`; startup fails safely if a selected port is already
occupied. Press `Ctrl-C` to stop the host, the dev server, and the owned
sidecar. Keeping a browser origin stable preserves microphone permission across
restarts. Only the processes started by this checkout should be terminated; do
not use broad `pkill` commands.

## Validation

```bash
corepack pnpm build
bash scripts/check.sh
corepack pnpm test:e2e   # requires: pnpm exec playwright install chromium (once per machine)
```

`scripts/check.sh` is the authoritative gate: it regenerates the contracts
(including the benchmark publication schemas under `benchmarks/results/schema`),
typechecks and tests the host/policy/web/contracts packages, runs the Python
suites (audio sidecar, benchmark harness), checks that generated outputs are
fresh, and asserts the required `.gitignore` rules. Playwright output is
ignored, so `git status` stays clean after E2E runs.

The reproducible speech benchmark harness (synthetic gate, model acquisition and
verification, matched comparisons, blinded listening) is documented in
`docs/benchmarking.md`; run it from there rather than duplicating the commands.

Accepted engineering decisions and their statuses live in `docs/decisions/`;
setup of tracked build outputs and generated files is covered by
`scripts/check.sh` and `scripts/generate_contracts.py`.