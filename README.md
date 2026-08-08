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

`pnpm dev` builds the web app, starts the host-owned selected audio runtime, and opens the host at `http://127.0.0.1:43127`. Keeping this browser origin stable preserves microphone permission across restarts. The internal Python sidecar still uses an OS-assigned IPv4 loopback port. Override the host port with `PODCASTER_PORT` when necessary; startup fails safely if the selected port is already occupied. Press `Ctrl-C` to stop the host and its owned sidecar.

This milestone is readiness infrastructure only. It does not request microphone permission, capture audio, load speech models, connect Pi, or retain history. After disclosure acknowledgement the page reports **Voice input**, **Voice output**, and **Cloud reasoning**, with corrective actions.

## Validation

```bash
pnpm test --filter @app/host
uv run pytest services/audio/tests/test_server_security.py
pnpm exec playwright install chromium # once per machine
pnpm exec playwright test readiness.spec.ts
pnpm check
```

For a manual boundary check, keep `pnpm dev` running, use the exact printed host/port and Origin header for `/api/readiness`, and inspect listeners:

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
