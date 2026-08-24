# Decision 013: Tool activity visibility during turns

**Date:** 2026-08-23
**Status:** Accepted

## Context

Decision 012 let the research Pi child inherit the user's web-search
extensions, so live turns and preparation passes now genuinely browse. While
that research runs, the user waits with no signal about what is happening:
the only evidence was a host-side log line that deliberately excluded
arguments and results. The ask (task 218) was an optional area showing what
the agent is doing during a turn, grouped so a past turn's activity can be
reviewed at any point, concise enough to see at a glance that, say, a web
search for a particular topic ran.

## Decision

1. A new bounded host event, `tool.activity`, reports one read-only tool call
   at a time. Its payload carries `scope` (`planning` or `turn`), turn and
   response identity for turn scope, the tool name and call id, a lifecycle
   status (`started`, `ended`, `failed`), an optional duration, and an
   optional short `summary`. It joins the canonical contracts with schemas,
   fixtures, and mutation-tested validation like every other event.
2. The event stays sanitized by construction. Tool output and results never
   enter it. The `summary` is a display hint derived from a small allowlist of
   request fields (`query`, `url`, `prompt`, `pattern`, `path`, `command`),
   whitespace-collapsed and truncated to 120 characters. Host logging keeps its
   existing no-arguments rule; the observer is the only visibility path.
3. Visibility is per request, not per client. `requestBody` and `requestPlan`
   accept an optional `onToolActivity` observer, so the multi-part machine
   tags live calls with its turn/response identity and `BrowserSession` tags
   preparation calls with `planning` scope. A cancelled turn stops emitting
   activity; the web reducer settles still-running entries as interrupted when
   the epoch advances.
4. The web shows an optional, collapsible "Agent activity" card that appears
   only once activity exists. Entries are grouped by preparation pass and by
   turn (labeled with the user's own utterance when known), bounded to the
   most recent 16 groups and 24 calls per group, and render status, tool
   name, summary, and duration. The browser's strict transport validator
   accepts the event shape in parity with the canonical schema; unknown
   events would otherwise fail the session socket. Activity is presentation
   state only: it is never spoken, never injected into model context, and
   never persisted as turn data.

## Consequences

Waiting users can see that a search is running and roughly for what, and any
turn's tool calls stay reviewable for the rest of the session. Because the
summary is derived from tool arguments, search queries chosen by the model are
visible in the browser; that content is already grounded in the user's own
conversation, is display-only, and stays out of prompts and exports. Tools
without a recognized hint field appear without a summary rather than exposing
arbitrary arguments. Every new host event must be added to the browser's
hand-rolled transport validator as well as the canonical contracts, or the
session socket rejects it.
