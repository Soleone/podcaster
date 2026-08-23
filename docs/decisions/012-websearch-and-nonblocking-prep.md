# Decision 012: Inherited web tools and non-blocking preparation

**Date:** 2026-08-23
**Status:** Accepted

## Context

Decision 011 gave the research Pi child only a podcaster-owned `webfetch`,
which fetches one known URL. With no discovery tool, the research child
improvised search by fetching search-engine result pages that return JS or
consent shells, so the preparation pass burned its whole 60 s deadline and
every prepared start hung on "Starting..." before failing. The live multi-part
flow (decision 007) also never produced grounded body parts, and the no-tool
stall hook sometimes claimed it could not browse. Meanwhile users already
install web search extensions into Pi itself, and a hardcoded `--tools`
allowlist silently disabled all of them in the research child.

## Decision

1. The research child no longer forces a tool allowlist and no longer passes
   `--no-extensions`. It inherits the user's installed Pi extensions, including
   whatever web search the user chose, and only denies the write and shell
   built-ins via `--exclude-tools bash,edit,write`. The podcaster-owned
   `webfetch` extension stays loaded as a bounded page reader. No podcaster
   shipped search tool; users keep their own provider, keys, and preferences.
2. The research prompts (preparation notes and live body) cap research at
   three tool calls and prefer search snippets over full-page fetches.
   Extended thinking stays user-configured; the call budget, not a thinking
   cap, bounds the research pass.
3. Preparation no longer blocks `session.start`. The host launches the research
   pass in the background, brings up audio immediately, and emits a ready-phase
   state with planning status `planning`. The web start handshake resolves on
   the first terminal planning status or the first non-planning phase. Late
   notes join future turns through `SessionOrchestrator.setPlanningContext`,
   and `planning.retry` is allowed whenever no pass is running, including after
   audio start.
4. The stall hook (multi-part part 0) must never claim an inability to browse
   or ask the user for facts the research pass could look up; a lookup may
   already be running behind it.

## Consequences

Prepared sessions go live in the time of the plain audio warmup; preparation
shows as a live banner and either joins the conversation or fails soft without
delaying the first utterance. Inheriting user extensions means extension tools
with side effects (memory, tasks, subagents) are technically available to the
research child; the prompts restrict it to read-only research tools, and the
denied built-ins remove shell and writes. Search quality now depends on the
user's installed extension instead of podcaster-owned parsers.
