# Pi RPC contract probe

This spike targets only Pi **0.84.0** at the pinned canonical executable path
`/home/soleone/.local/share/pnpm/bin/pi` and model
`openai-codex/gpt-5.6-sol`.

## Run

```sh
pnpm tsx spikes/pi-rpc/probe.ts probe
pnpm tsx spikes/pi-rpc/probe.ts request
pnpm tsx spikes/pi-rpc/probe.ts cancel
rg -n -i 'authorization|bearer|oauth|api[_-]?key|token' spikes/pi-rpc --glob '!README.md'
```

Each command validates that the pinned path is a canonical executable regular
file and that `--version` is exactly `0.84.0`. It uses Node `spawn` with an argv
array and `shell: false`. RPC starts with:

```text
--mode rpc --no-session --no-tools --no-extensions --no-skills
--no-prompt-templates --no-context-files --no-approve
--model openai-codex/gpt-5.6-sol
```

The child receives an allowlisted operational environment plus
`PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0`. The probe does not inspect or
copy Pi's credential file, does not read credential-bearing environment
variables, and never prints the process environment. Pi remains the sole owner
of authentication.

`probe` correlates `get_state` and `get_available_models`, then requires a
bounded live prompt to return the exact `RPC_READY` marker with a normal
assistant `stop` and `agent_settled`. Model presence or unrelated normally
settled text is not authentication readiness. `cancel` aborts after the first text delta, cuts off acceptance before
issuing abort, requires the correlated successful abort response, an assistant
`stopReason` of `aborted`, `agent_settled`, and a final non-streaming state, then
terminates the owned process group. Cleanup probes group disappearance independently
of leader exit and escalates surviving descendants from TERM to KILL.

Live fixtures are rewritten by successful commands; `framing.json` records the
strict framing cases covered by the fake RPC tests. They contain protocol shapes,
placeholder text and counts only. Assistant reasoning, raw provider errors,
credentials, headers, and actual generated text are excluded.

## Readiness and recovery

The probe maps failures to `login_required`, `rate_limited`, `incompatible`, or
`unavailable`; successful model selection plus a live request maps to `ready`.
There is no provider fallback. If login is required, launch Pi interactively and
use its supported `/login` flow, then rerun the probe. Do not extract or pass
credentials to this script.

## Bounds

Input is parsed as strict LF-delimited JSONL without `readline`; CRLF/trailing
CR is rejected, and UTF-8 decoding is fatal. Individual records are limited to
256 KiB, the unframed stdout buffer to 1 MiB, stderr to 64 KiB, startup to 8
seconds, and live operations to 60 seconds. Raw provider stderr and error text
is never printed; failures expose only a fixed classification and corrective
action.

Canonical workspace test commands are `pnpm --filter @app/host test -- pi` and
`pnpm --filter @app/host exec vitest run test/pi/cancellation-races.test.ts`.
The milestone plan's literal root-dispatch forms are also supported.
