# Decision 008 — Keep Qwen evaluation-only after operator preference review

**Date:** 2026-08-16  
**Milestone:** 6  
**Task:** QW-7 / `qfz`  
**Outcome:** **Keep Qwen evaluation-only; retain Kokoro as the production TTS selection.**

## Decision

The operator preferred the Qwen sample during an informal review and requested that
Qwen remain available for continued evaluation. Qwen is **not promoted to the
production TTS contract** by this decision. Kokoro remains the production fallback
and selected implementation.

This is an operator-preference decision, not a claim that Qwen is objectively
better or superior.

## Evidence and waiver

The matched machine comparison is recorded in
`artifacts/evidence/2026-08-16-qw5-matched-qwen-kokoro-comparison.md`:

- Kokoro CPU run: `96e9a47e-8cc2-4182-ade3-3fac3f4b4d9f`
- Qwen CUDA run: `ed93b67e-0fb2-42f3-8227-ee1d36b3720a`
- 24 shared prompts, both runs passed all prompts

A blinded comparison package was generated, but the required three independent
listener ratings were not completed. At the operator's request, the sealed mapping
was inspected before ratings were submitted; the package mapping was `A = Kokoro`
and `B = Qwen`. The package therefore does not count as blinded-listening evidence,
and no paired preference count or statistical claim is reported.

The Qwen reliability evidence in
`artifacts/evidence/2026-08-16-qw6-qwen-reliability.md` also records a failed
five-minute soak with one underrun and 2,391 missed samples. This is an additional
reason not to promote Qwen to production.

The listening gate is explicitly **waived/incomplete**, not passed. The interactive
preference-only reviewer remains available at
`scripts/review-tts-listening.py` if a later independent listening gate is desired.

## Contract impact

- Production TTS remains `kokoro-82m-onnx-fp32-af-heart-cuda-v1`.
- Qwen remains an evaluation candidate only: `qwen3-tts-0.6b-customvoice-cuda-v1`.
- No superiority claim is authorized.
- A future production switch requires a fresh blinded paired review with at least
  three listeners and a passing reliability gate.

## Validation

- `pnpm check` — passed
- `uv run pytest benchmarks/harness/tests/test_harness.py -q` — 21 passed
- Preference-only rating records are accepted by the harness without fabricated
  quality dimensions.
