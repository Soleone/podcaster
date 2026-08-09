## User flows (step-by-step, incl. branches)

### Resume after an interruption
1. User speech pauses the current companion response; the existing echo-confirmation controls remain available.
2. If the speech is a meaningful new turn, keep the user transcript, mark the existing companion response **Interrupted**, and continue with the new turn.
3. If the speech is control-only and the response resumes, keep the control-only user transcript and its existing **Control only** badge, update the same companion row from **Paused** to **Playing**, and announce “Continuing the response” once.
4. Do **not** add a “Continued previous response” separator or a separate “Continuing the response” transcript notice. Multiple resume decisions repeat step 3 without adding continuation rows.
5. On completion, the single companion row becomes **Completed**. The response text is never split solely because playback paused/resumed.

**Decision:** the inserts have modest diagnostic value, but are not useful in the main transcript. The same facts are already conveyed by the control-only user turn and companion playback state. In the screenshot they dominate the conversation and duplicate one state change. Preserve resume events in study/export records, not as standalone conversation content.

### Compact session status
1. Replace the large State card with one compact status bar immediately below the session header.
2. Its leading group contains a non-color-only state icon/cue and the current label: **Session stopped**, **Listening**, **Finishing transcript**, **Considering what you meant…**, **Giving you space**, **Forming a response…**, **Speaking**, **Stopping response…**, or **Session needs attention**.
3. Its trailing group contains the elapsed time in a quiet Badge and, only while reasoning/speaking/echo-confirming, **Stop speaking**. Keep the existing **Stop session** in the header.
4. Degraded detail remains in the existing Alert below the bar. Echo-confirmation choices remain below the conversation; they are not squeezed into the bar.

## Information architecture (navigable structure)

- **Active voice session header** — session identity and Stop session.
- **Compact status bar** — one current session state, elapsed time, contextual Stop speaking.
- **Conversation** — meaningful user/companion transcript plus compact control-only user turns; no continuation separators.
- **Interruption confirmation** — existing conditional recovery controls.
- **Degraded alert** — actionable detail when the compact status says the session needs attention.

## Key screens & states (empty / loading / error / success)

| Surface | Empty / initial | Loading / active | Error | Success |
|---|---|---|---|---|
| Compact status | Session stopped | Listening, transcribing, deciding, reasoning, speaking, or stopping; label changes in place without layout growth | “Session needs attention” plus existing Alert detail | Giving you space or return to Listening |
| Conversation | Existing empty hint | Stable/tentative turns; companion row updates playback state in place | Existing notice/error treatment only when action is required | One companion row per response; resumed playback adds no row |
| Repeated interruptions | None | Each control-only user utterance may remain as its existing compact user turn; zero continuation markers | Failed resume leaves response Interrupted and surfaces the actionable failure | Existing companion row returns to Playing; announcement occurs once per actual transition |

## Interaction notes (affordances, transitions, edge behavior)

- Anchor to current source: `apps/web/src/session/state.ts:94` creates a continuation item and `apps/web/src/session/state.ts:103–106` creates additional playback notices; both currently render as separators in `apps/web/src/session/SessionScreen.tsx`. Remove these from the perceived conversation while retaining the underlying event/state.
- Keep the existing response identity model: `apps/web/src/session/state.ts:83–93` already updates the matching assistant item by `responseId`; that row is the canonical place to show Paused, Playing, Interrupted, or Completed.
- Build the compact bar from existing shadcn-style primitives already present: Card as the container, Badge for elapsed time, Button for Stop speaking, and Alert for degraded detail. Use the installed icon set for a semantic cue; do not add a new component family.
- Target one dense row (about 40–48 px content height; wrapping to two logical rows on narrow screens), rather than the current large headline card. Remove the “Current state” kicker and oversized state typography.
- A resume changes content in place; it must not move scroll position or create a new auto-scroll anchor. Only genuine user turns continue to anchor transcript scrolling.
- The elapsed timer must not be in the live region. Announce a state only when its semantic label changes; deduplicate identical consecutive announcements.
- Preserve existing `Esc` behavior and visible Stop speaking. Focus does not move when the state changes or playback resumes.

## Data contract the UI needs (entities, relationships, states) — for architecture

- **Session status:** dominant state, elapsed seconds, degraded detail, assistant-active boolean.
- **Response presentation:** stable `responseId`, transcript text, playback state (`preparing`, `playing`, `paused`, `completed`, `interrupted`). Exactly one visible companion row per `responseId`.
- **Interruption outcome:** related `responseId`, action (`resume` or `interrupt`), control-only flag, user transcript, timestamp/sequence. Resume events remain available to persistence/export/study records even though they add no continuation row.
- **Announcement:** semantic status message plus an event/change identity sufficient to suppress duplicate announcements.

## UX acceptance criteria (testable, including accessibility)

1. For any `interruption.decision` with action `resume`, the visible conversation contains zero “Continued previous response” markers and zero standalone “Continuing the response” notices.
2. After 1, 3, or 10 resume decisions for the same `responseId`, exactly one companion transcript row exists for that response; its text is not duplicated or split and its playback badge reflects the latest state.
3. A control-only user transcript remains visible with the existing **Control only** badge; a meaningful interruption remains a normal user turn and marks the prior response **Interrupted**.
4. Resume/interruption facts remain present in persisted/exportable study records even though resume separators are absent from the main conversation.
5. A resume updates in place without changing the transcript’s scroll anchor or forcing scroll when the user has scrolled upward.
6. The large `status-card` presentation and “Current state” kicker are absent. The replacement compact bar contains one state label, a non-color-only cue, elapsed time, and contextual Stop speaking; Stop session remains visible in the header.
7. All nine existing dominant states map to distinct text labels in the compact bar. Degraded state also exposes the existing actionable Alert detail.
8. At 320 CSS px, the bar wraps without horizontal scrolling, overlap, truncating the state label, or reducing either action below a 44×44 CSS px target.
9. The bar’s reading/focus order is state label → elapsed time → Stop speaking when present; Stop session retains its header position. All controls are keyboard reachable with visible focus.
10. State changes are announced politely once; duplicate same-state events and the once-per-second elapsed timer are not announced. The cue is `aria-hidden`; meaning is available in text.
11. Reduced motion removes nonessential cue animation; no state, interruption result, or action availability relies on color, motion, sound, or hover alone.
12. Existing echo-confirmation buttons, `Esc` cancellation, tentative transcript handling, and empty/degraded conversation behavior continue unchanged.

## Copy needs (per state: what job the words must do) — for writer

- **Compact state labels:** retain the current concise labels and clearly distinguish listening, thinking, speaking, intentional silence, stopping, and degraded behavior.
- **Resume announcement:** confirm once, without inserting transcript-like content.
- **Control-only badge:** explain that the utterance controlled playback rather than starting a new companion answer.
- **Degraded Alert:** retain the existing job of naming impact and next action.

## Open questions

None blocking. If research later shows control-only utterances themselves are noisy, consider grouping them in history; do not include that broader change in this implementation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete severity-tagged findings cite apps/web/src/session/state.ts and apps/web/src/session/SessionScreen.tsx; the artifact supplies exact, testable replacement behavior and residual risks."
    }
  ],
  "changedFiles": [
    "artifacts/ux/index.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "source and screenshot inspection only",
      "result": "passed",
      "summary": "Inspected the supplied screenshot, PRD, current UX artifact, SessionScreen, state reducer, conversation renderer, CSS, tests/matches, and installed UI dependencies."
    }
  ],
  "validationOutput": [
    "Recommendation is anchored to the continuation creation paths at apps/web/src/session/state.ts:94 and :103-106 and the separator render path in apps/web/src/session/SessionScreen.tsx.",
    "Compact status recommendation reuses Card, Badge, Button, Alert, and the installed lucide-react dependency."
  ],
  "residualRisks": [
    "Low: removing main-transcript continuation markers assumes persisted interruption decisions remain available to export/study tooling; architecture/builder must preserve that nonvisual record.",
    "Low: narrow-screen wrapping and live-region deduplication require manual accessibility validation after implementation."
  ],
  "noStagedFiles": true,
  "diffSummary": "Replaced the prior broad UX artifact with a focused specification for suppressing redundant continuation inserts and introducing a compact shadcn-style session status bar.",
  "reviewFindings": [
    "major: apps/web/src/session/state.ts:94 and apps/web/src/session/state.ts:103-106 - one resume can generate transcript separators/notices that duplicate playback state and repeated events visibly crowd the conversation.",
    "moderate: apps/web/src/session/SessionScreen.tsx:24 - the large status Card repeats context in oversized typography and consumes persistent vertical space; its state label, elapsed time, and contextual cancel action fit one compact bar.",
    "no blockers: existing responseId-based assistant-row updates and current Card/Badge/Button/Alert primitives support the smallest recommended interaction without a broader redesign."
  ],
  "manualNotes": "No implementation or code files were modified."
}
```
