# Podcaster — Milestone 0 readiness skeleton

## Fresh-machine setup

Requirements: Linux, Node `22.22.3`, Corepack, Python `3.12`, and `uv 0.8.8`.

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
uv sync --frozen
corepack pnpm install --frozen-lockfile
pnpm dev
```

Qwen CustomVoice is an optional CUDA backend. Its pinned Transformers 4.57.3 runtime is isolated from the host's Nemotron Transformers 5.x environment:

```bash
./scripts/setup-qwen-runtime.sh
pnpm dev
```

`pnpm dev` starts the host-owned selected audio runtime and Vite's HMR server at `http://127.0.0.1:5173`. Edit the web source or `apps/web/index.html` and the browser updates without restarting. Vite proxies `/api` and `/ws` to the host, while the internal Python sidecar still uses an OS-assigned IPv4 loopback port. The frontend port can be changed with `PODCASTER_WEB_PORT`, and the host port with `PODCASTER_PORT`; startup fails safely if a selected port is already occupied. Press `Ctrl-C` to stop the host, Vite, and the owned sidecar.

For the production-like build-first workflow, use `pnpm dev:build`. It builds the web app and host, then serves the generated bundle from the host at `http://127.0.0.1:43127`. `pnpm build` creates both build artifacts without starting a server. Keeping either browser origin stable preserves microphone permission across restarts.

This milestone is readiness infrastructure only. It does not request microphone permission, capture audio, load speech models, connect Pi, or retain history. After disclosure acknowledgement the page reports **Voice input**, **Voice output**, and **Cloud reasoning**, with corrective actions.

## Validation

```bash
pnpm test --filter @app/host
uv run pytest services/audio/tests/test_server_security.py
pnpm exec playwright install chromium # once per machine
pnpm exec playwright test readiness.spec.ts
pnpm check
```

For a manual host-boundary check, keep `pnpm dev:build` running, use the exact printed host/port and Origin header for `/api/readiness`, and inspect listeners:

```bash
ORIGIN=http://127.0.0.1:43127 # or your PODCASTER_PORT override
COOKIE_JAR=$(mktemp); trap 'rm -f "$COOKIE_JAR"' EXIT
BOOTSTRAP=$(curl -fsS -c "$COOKIE_JAR" -X POST -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' --data '{"disclosureAcknowledged":true}' \
  "$ORIGIN/api/bootstrap")
CAPABILITY=$(printf '%s' "$BOOTSTRAP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["capability"])')
curl -fsS -b "$COOKIE_JAR" -X POST -H "Origin: $ORIGIN" \
  -H "X-Podcaster-Capability: $CAPABILITY" "$ORIGIN/api/readiness"
ss -ltnp | grep -E 'node|python'
```

Only the processes started by this checkout should be terminated; do not use broad `pkill` commands.
