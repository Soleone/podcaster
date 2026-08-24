# Latency observations — measured durations only

Status: superseded. The previous plan (`mtq`) proposed an adaptive stall
target, gap-free part handoffs, and a `RuntimeBudget` that predicted body-part
ETAs and emitted `budget.mitigation` telemetry. That machinery was
measurement-only: it never changed output, and its percent/ETA-style claims
could not guarantee responsiveness. The `RuntimeBudget`/`budget.mitigation`
telemetry was removed; the multipart single-stream response rework it fed is
still pending (see `artifacts/architect/index.md`).

What remains is the raw monotonic milestone log on the host (`[session]` part
events) and the measured benchmark numbers below. Durations are tested
directly with injected clocks; nothing is presented as a predictive mitigation.

| Model      | TTFA p50 / p95 | RTF p50 / p95 |
| ---------- | -------------- | ------------- |
| Kokoro CPU | 978 / 1751 ms  | 0.243 / 0.282 |
| Qwen CUDA  | 299 / 331 ms   | 0.309 / 0.345 |

RTF = processing seconds / audio seconds (project convention); <1 = faster
than realtime. Source:
`artifacts/evidence/2026-08-16-qw5-matched-qwen-kokoro-comparison.md`.

Boundary notes kept for reference:

- Planning attempts are bounded per depth (light 30 s / standard 60 s / deep
  120 s) and report a factual `stage`, not a completion percentage.
- Pi abort settlement is bounded separately (~2 s) from the request deadline
  so interrupted tool work cannot hold the session-owned research child.
