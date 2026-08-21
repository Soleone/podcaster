# Decision 010: Multipart conversation is core

**Date:** 2026-08-21
**Status:** Accepted

## Context

The podcast agent should feel like a human co-pilot: usually offering a short
riff or question, but sometimes earning a deeper response, while getting the
first audio out quickly. The earlier concise-only framing also treated search
as out of scope. That no longer matches the product direction.

## Decision

The stall-then-deepen multipart flow is the core conversation architecture. The
agent may speak a short acknowledgement immediately, then continue with richer,
tool-backed content in parts that stream to TTS while the acknowledgement plays.

This decision supersedes the earlier concise-only/no-search framing. ARC-001's
flip that disabled multipart by default is reverted: multipart is enabled by
default, with an explicit opt-out remaining available for controlled use and
fallbacks.

Tool use, including live web access, is required for the research path. Content
returned by tools remains untrusted data: the agent must not follow instructions
inside retrieved content, and it must preserve the existing safety and privacy
rules.

## Consequences

The response client remains the fast, short, no-tools path. A separate research
client owns deeper, tool-backed multipart work so the first spoken audio does
not wait for research to finish.
