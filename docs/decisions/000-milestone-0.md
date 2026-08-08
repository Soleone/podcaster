# Decision 000: Milestone 0 secure skeleton

Status: accepted 2026-08-07

## Decision

The runnable skeleton has one Fastify host and one host-owned Python audio sidecar. Each binds `127.0.0.1` with port `0`; the operating system chooses both ports. The host serves the built React UI. The browser never connects directly to the sidecar.

The first UI action acknowledges the local-speech/cloud-reasoning disclosure. Only then does bootstrap issue an in-memory 256-bit capability and an `HttpOnly; SameSite=Strict` session cookie. Mutation requests require both plus the exact host Origin. WebSockets authenticate in their first message, never a URL query, and that WebSocket authentication is one-use. Session material expires after twelve hours and disappears on stop or process restart.

The sidecar health endpoint requires a per-process host boot secret, exact Host, and no Origin header. Browser-origin requests fail closed. HTTP bodies and WebSocket frames are bounded. CSP permits only same-origin code and the application sends no permissive CORS header.

## Scope evidence

This decision covers stubs only: readiness, lifecycle, and trust boundaries. There is no microphone request/capture, speech model, Pi integration, API-key path, or history implementation. Readiness names Voice input, Voice output, and Cloud reasoning with plain next actions.

Automated evidence is in `apps/host/test/security/host-security.test.ts`, `services/audio/tests/test_server_security.py`, `apps/web/e2e/readiness.spec.ts`, and the contract/process-lifecycle suites run by `pnpm check`. Fresh-machine and manual listener instructions are in the root README.

## Gate evidence

Accepted after independent security/correctness review and four focused fix/re-review rounds. Final review found no actionable findings. On 2026-08-07, frozen pnpm and uv installs, deterministic contract generation, 376 TypeScript contract tests, 29 Python tests, 18 host security tests, the Playwright readiness test, typechecks, Ruff, web builds, and process cleanup tests passed. A manual authenticated bootstrap/readiness smoke returned a 32-byte capability and a ready sidecar; `ss` showed only OS-assigned `127.0.0.1` Node/Python listeners, and no owned processes remained after shutdown.

The workspace has no Git repository, so staged-file and native diff checks were unavailable. Provider links and disclosure wording remain time-sensitive and must be reverified before a pilot.
