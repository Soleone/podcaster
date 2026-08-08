# Decision 001: Pi 0.84.0 stdio RPC is viable

**Status:** accepted — Milestone 1 gate passed 2026-08-07  
**Observed:** 2026-08-07  
**Executable:** `/home/soleone/.local/share/pnpm/bin/pi` (canonical executable regular file)  
**Version/model:** `0.84.0`, `openai-codex/gpt-5.6-sol`

## Decision

Use Pi as an owned stdio RPC subprocess. Spawn the pinned executable directly
with an argv array, no shell option, ephemeral sessions, all tools and resource
discovery disabled, and version-check/telemetry disabled. Pi owns its existing
authentication; the application must neither read its credential store nor read
credential/token environment values.

The executable is a pnpm-generated executable shim. The host validates the shim
it invokes (regular file, executable bit, canonical path), then validates its
reported version before starting RPC. Any path or version mismatch is
`incompatible` and fails closed.

## Observed 0.84.0 contract

RPC uses one JSON object per LF-delimited line. Commands accept an `id`; their
`response` repeats that id and command. Events are asynchronous and generally
uncorrelated. The successful probe observed:

- `get_state` selected provider `openai-codex`, model `gpt-5.6-sol`, and idle state.
- `get_available_models` included that exact provider/model.
- A bounded no-tool prompt returned the exact `RPC_READY` marker and produced
  `agent_start`, turn/message lifecycle events, placeholder-sanitized
  `text_delta` shapes, assistant `stopReason: stop`, `agent_end`, then
  `agent_settled`.
- Mid-stream `abort` produced an assistant message/turn with
  `stopReason: aborted`, `agent_end`, and `agent_settled`. The correlated abort
  response was successful; in this run it arrived after settled. A subsequent
  `get_state` was authoritative with `isStreaming: false`.
- No text delta was accepted after the cancellation cutoff. Cleanup checked the
  owned detached process group independently of leader exit and confirmed group
  disappearance after TERM/KILL handling in all three commands.

Therefore production cancellation must establish its local cutoff before
sending `abort`, suppress every later delta regardless of wire ordering, and
wait for both the successful abort response and authoritative settled/idle
state when diagnosing remote completion. Local playback silence must not wait
for either.

## Readiness mapping

The adapter vocabulary remains exactly `ready | login_required | unavailable |
incompatible | rate_limited`.

- `ready`: exact executable/version/model passes and a bounded live call returns
  the exact expected marker with normal assistant stop and settlement.
- `login_required`: provider reports missing, expired, unauthorized, forbidden,
  login, or sign-in state. Recovery is Pi's interactive `/login` flow only.
- `rate_limited`: HTTP 429, quota, or provider rate-limit response.
- `incompatible`: executable/version/protocol/options mismatch or pinned model
  absence.
- `unavailable`: spawn, timeout, malformed/bounded framing, network, child-exit,
  or otherwise unclassified provider failure.

There is no alternate provider or metered fallback.

## Security and fixture policy

The client uses strict LF parsing rather than `readline` (CRLF/trailing CR is
rejected) and fatal UTF-8 decoding, bounded records, queues, responses and
buffers, startup/operation timeouts, fixed classified errors that never print
raw provider stderr/error text, and process-group
termination escalating from TERM to KILL. Its child environment is an allowlist
of non-secret operational variables; it is never dumped. Sanitized fixtures
contain only event/response shapes, placeholder model text, stop state, and
cleanup evidence. They exclude actual assistant text, thinking content, raw
provider errors, credentials, cookies, and request headers.

## Evidence

- `spikes/pi-rpc/fixtures/probe.json`
- `spikes/pi-rpc/fixtures/request.json`
- `spikes/pi-rpc/fixtures/cancel.json`

All three prescribed live commands passed again under the user's existing Pi
subscription authentication after strict framing was enabled. The probe now
performs its own bounded live call and requires normal assistant completion;
the sanitized cancellation evidence again shows `agent_settled` before the
correlated successful abort response. The Milestone 1 production adapter and
fake RPC race suite are implemented separately under `apps/host`.

## Gate evidence

Independent security/correctness review approved the final implementation after
two focused fix/re-review rounds. On 2026-08-07, the three live spike commands,
the literal plan host Pi test command (28 tests), the literal cancellation-race
command (8 tests), and `pnpm check` all passed. The full check included 376
contract tests, 29 Python tests, and 46 host tests. Live cancellation confirmed
`stopReason: aborted`, zero accepted text after the local cutoff, authoritative
idle state, and disappearance of the owned process group. Secret scanning found
only intentional source comments and redaction field names; sanitized fixtures
contained no matching credential material.

The workspace has no Git repository, so native diff and staging checks remain
unavailable.
