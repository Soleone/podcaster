## User flows (step-by-step, incl. branches)

### 1. First-run readiness
1. Open the app to a single readiness sequence; do not begin listening automatically.
2. Show the privacy boundary before any permission prompt: **speech recognition and voice playback run locally; the transcript/context used for reasoning is sent through Pi/Codex to a cloud provider; history and persona remain local by default.** Require an explicit “Continue” acknowledgement, with a link to fuller provider/current-retention details.
3. Check local speech readiness and Pi/Codex authentication availability. Present plain-language rows—**Voice input**, **Voice output**, **Cloud reasoning**—with `checking`, `ready`, or `needs attention`; technical details stay behind “Details.”
4. Request microphone permission only after the user chooses “Enable microphone.”
   - Granted: run a short input-level check and mark ready.
   - Denied/dismissed: explain how to retry; allow settings/history/persona/benchmark access, but disable session start.
5. If Pi is available but login is required, offer “Sign in with Pi/Codex,” then recheck. Never request an ordinary OpenAI API key or imply silent metered fallback.
6. If a speech model is missing/unavailable, offer the supported local preparation action and progress; if preparation cannot proceed, preserve the diagnosis and retry path.
7. When all required capabilities are ready, focus “Start session.” On later visits, skip the sequence unless readiness changed; retain a compact preflight summary near the start control.

**Recommendation after alternatives:** use one progressive readiness sequence, not a technical setup dashboard or a permission-heavy modal stack. It gives a newcomer one next action while keeping diagnoses available.

### 2. Explicit voice session
1. **Idle:** user activates “Start session.” The app rechecks microphone, local speech, and Pi availability; transient checks show “Getting ready,” not a false listening state.
2. **Listening:** a persistent session region says “Listening,” shows a restrained input activity cue plus elapsed session time, and exposes “Stop session.” Live transcript text may appear as tentative (visually and semantically labeled), then stabilize.
3. **Transcribing:** after an utterance endpoint, label the latest text “Finishing transcript.” The user may resume speaking immediately; this returns to Listening and cancels superseded work.
4. **Deciding:** show a calm, user-facing “Considering whether to respond…” state. Do not expose model/chunk/token telemetry in the main flow.
   - **Silent posture:** resolve to “Giving you space” briefly, then return to Listening. Silence must be distinguishable from stalled/error behavior and must not play audio.
   - **Riff/question/challenge:** continue to cloud reasoning.
5. **Cloud reasoning:** show “Forming a response…” and a cancel action. Continue listening for barge-in.
6. **Local speech playback:** show the stable assistant transcript with “Speaking,” plus pause/stop playback. When playback completes, return to Listening without requiring another action.
7. User activates “Stop session” from any state: cancel recognition/reasoning/playback, finalize any already-stable local transcript, and show a session summary with “Return to idle,” “Export,” and “Delete.” Never keep listening after stop.

### 3. Barge-in and interruption
1. When user speech is detected during deciding, reasoning, or playback, immediately cancel current and queued assistant work/audio and switch the dominant state to “Listening—go ahead.”
2. Preserve any assistant text already spoken as interrupted; do not present unspoken generated text as delivered. The new user utterance becomes the current turn.
3. If speech detection is uncertain during playback (likely speaker echo), duck/pause output and show “Did you start speaking?” with keyboard-accessible **Yes, listen** / **No, continue**. Automatically resume only after a short, clearly indicated window and only when confidence recovers.
4. If cancellation is still pending, show “Stopping response…” while continuing to prioritize captured user audio. If cancellation fails, silence local playback anyway, mark the response interrupted, and allow the session to continue in degraded mode or be stopped.
5. If the user interrupts and then stops before a meaningful utterance, return to Listening; optionally offer “Resume response” only when the prior response remains valid and no new stable transcript was committed. Default is not to resume.

**Recommendation after alternatives:** speech-driven interruption is primary; an always-visible Stop speaking control and `Esc` are necessary fallbacks. Push-to-talk would reduce echo ambiguity but changes the core natural conversation promise, so it is a diagnostic fallback only.

### 4. Local history and persona
**History**
1. From Idle, open History to a newest-first list of local sessions with date/time, duration, and a short user-derived preview.
2. Select a session to read its transcript with user/companion turns, posture (including silence), interruption markers, and failures relevant to understanding the record.
3. Export one session or all local history. Before writing, show scope and format; on success provide the resulting file action. Export failure leaves data unchanged and offers retry.
4. Delete one or all: show scope and irreversibility, require confirmation, then return focus to the logical next item/empty state. No cloud deletion claim is implied.

**Persona**
1. From Idle, open Persona. Show a supported default, editable plain text, and “Import file.” Explain that it influences personality, interests, and posture tendencies but cannot execute instructions or edit itself.
2. Import an AGENTS.md-like file into a preview first; do not overwrite the current draft until the user confirms.
3. Validate on import and save. Mark issues inline with line references and a summary linked to each issue.
   - Valid: enable Save and show a concise interpretation preview.
   - Warnings only: allow Save with an explicit warning acknowledgement.
   - Invalid/unsupported or unreadable: do not replace the last saved valid persona; offer fix, cancel, or restore default.
4. Unsaved edits require discard confirmation when leaving. Conversation never rewrites the persona automatically.

### 5. Internal speech benchmark/listening flow
1. Enter **Speech benchmark** from a clearly labeled internal/tools destination, separate from normal sessions. Choose STT or TTS and a predefined comparison set; show local model readiness before starting.
2. **TTS blinded listening:** for each fixed prompt, present samples as randomized neutral labels (for example A/B), with model identity and machine metrics hidden. User can replay, then rate each sample on the predefined small set of qualities and select a preference/tie. Require ratings only at the sample/prompt level—not hidden system facts. Save progress between prompts. Reveal identities and attached machine metrics only after submission or explicit early finish, preventing rating edits after reveal.
3. **STT comparison:** play/reference the same source audio and show candidate transcripts side by side under randomized neutral labels, with aligned aggregate metrics (such as errors, latency, stability) and expandable revision traces. Permit a concise optional note or “best transcript/tie”; do not ask users to score timing events individually.
4. Completion shows coverage, incomplete/skipped items, and export. Failed candidates remain visible as failures rather than disappearing from comparison.

## Information architecture (navigable structure)

- **Idle / Home** — readiness summary, Start session, recent local session shortcut.
- **Active session** — one persistent surface whose state changes through listening, transcribing, deciding, reasoning, speaking, interruption, and degraded recovery.
- **Session summary** — transcript outcome, export, delete, return to idle.
- **History** — local session list → session detail; export/delete actions.
- **Persona** — current/default editor, import preview, validation summary.
- **Settings / Readiness** — microphone, local speech, Pi/Codex authentication, privacy boundary, expandable diagnostics.
- **Internal tools** — speech benchmark → STT comparison or TTS blinded listening → results/export.

Persistent navigation is available only outside an active session. During a session, prioritize session status and Stop; prevent accidental navigation with a stop-session confirmation.

## Key screens & states (empty / loading / error / success)

| Surface | Empty / initial | Loading / active | Error / degraded | Success |
|---|---|---|---|---|
| Readiness | Disclosure not acknowledged; no permission requested | Checking capabilities; model preparation progress; auth handoff | Login required, Pi unavailable/rate-limited, mic blocked, local model missing, GPU/VRAM failure; each names impact and next action | All three capability rows ready; Start session enabled |
| Session | Idle, no listening | Listening; tentative/finalizing transcript; deciding; cloud reasoning; local speaking; stopping | Connection/process failure, rate limit, login expiry, speech model failure, GPU/VRAM exhaustion, mic loss, echo ambiguity, cancellation timeout; preserve Stop and captured stable history | Intentional silence or completed speech returns to Listening; Stop produces summary |
| History list/detail | “No local sessions yet” with Start shortcut | Reading/exporting/deleting | Local read/export/delete failure; never imply deletion succeeded | Sessions visible; export destination available; deletion confirmation announced |
| Persona | Supported default when none saved | Import preview; validating; saving | Parse/unsupported-section issues, unreadable file, save failure; last valid version retained | Saved, with interpretation summary and last-saved status |
| TTS benchmark | No run/results; choose set | Generating/loading local samples; rating progress | One/all candidates fail, playback fails, GPU/VRAM issue; retry/skip without unblinding | Submitted ratings locked; identities/metrics revealed; export available |
| STT benchmark | No run/results; choose set | Transcribing; comparable progress per candidate | Candidate failure, invalid audio, GPU/VRAM issue; keep comparison honest | Comparable transcripts/aggregate metrics shown; export available |

**Failure mapping:**
- Pi unavailable: retain local listening/transcript only if the user explicitly chooses “Continue without responses”; otherwise pause session with retry/stop.
- Rate limited: state that cloud responses are temporarily unavailable, show retry timing if known, and offer local transcript-only continuation; no fallback provider.
- Login required/expired: pause cloud reasoning, preserve local session, offer sign-in outside microphone capture, then resume listening.
- Speech input model unavailable or GPU/VRAM failure: stop capture-dependent progression, preserve stable transcript/history, offer retry after corrective action; never silently switch benchmark candidate.
- TTS unavailable: show the response as text and clearly mark voice playback unavailable; session may continue if STT remains healthy.
- Microphone disconnected/permission revoked: stop listening, announce loss, offer reselect/retry/stop.
- Echo issue: pause/duck playback and use the confirmation recovery in the barge-in flow.
- Model cancellation: expected cancellation is marked “Interrupted,” not error; failed/timeout cancellation enters degraded state with local audio forced silent and retry/stop.

## Interaction notes (affordances, transitions, edge behavior)

- One dominant status and one primary action at a time. Secondary technical status sits in expandable Details; familiar labels remain consistent across readiness and session.
- Never use animation/color alone for state. Pair an icon/activity cue with persistent text; state changes use a polite live announcement without repeatedly reading partial transcripts.
- Tentative transcript revisions must not steal focus. Stable text is selectable; speaker, posture, silence, and interruption are represented in text and semantics.
- `Esc` stops current assistant playback/reasoning first; a second `Esc` does not silently stop the whole session. The explicit Stop session control is always reachable.
- A Start/Stop action is never triggered by voice alone. Permission, login, import, export, deletion, and persona save are explicit user actions.
- Disable only actions whose prerequisites are unmet and place the reason adjacent to the disabled control. Prefer a working corrective action over a disabled dead end.
- On rate limit or component failure, preserve the user’s spoken work locally where possible and explain what can still work. Do not blame the user or expose raw stack traces by default.
- Privacy details identify what live context leaves the device and link to current provider terms; avoid broad “private” or “fully local” claims.

## Data contract the UI needs (entities, relationships, states) — for architecture

This is an interaction contract, not a storage design.

- **Readiness snapshot:** capability (`microphone`, `speech_input`, `speech_output`, `pi_auth`, `cloud_reasoning`), state (`checking`, `ready`, `needs_action`, `unavailable`, `degraded`), user-safe reason, corrective action, optional diagnostic details/progress.
- **Session:** stable local identifier, start/end time, state, transcript turns, current capability/degraded state, export/delete status.
- **Turn:** speaker, partial and stable text updates, timestamps, eligibility, posture (`riff`, `question`, `challenge`, `silence`), response lifecycle (`deciding`, `reasoning`, `speaking`, `complete`, `interrupted`, `cancelled`, `failed`), spoken extent/interruption marker. Posture remains inspectable in study records.
- **Persona document:** current draft, last valid saved content, source (`default`, `edited`, `imported`), validation results with severity/line/range/message, interpretation summary, save state.
- **Benchmark run:** kind (`STT`, `TTS`), fixed dataset/version, randomized presentation mapping, candidate readiness/failure, progress, completion/reveal state, export state.
- **TTS benchmark item:** shared prompt, blinded sample labels/audio, replay count, user ratings/preference/tie, submission lock; attached candidate identity and machine metrics inaccessible to the rating view until reveal.
- **STT benchmark item:** shared source audio/reference when available, blinded candidate label, transcript, aggregate quality/latency/stability metrics, optional revision trace and user note/preference.
- **Failure:** affected capability/operation, recoverability, safe user message, retry/sign-in/settings/continue-locally/stop actions, known retry time, diagnostics reference.

## UX acceptance criteria (testable, including accessibility)

1. A fresh user cannot start capture before acknowledging the local-speech/cloud-reasoning disclosure and intentionally requesting microphone access.
2. Readiness distinguishes microphone, local STT/TTS, and Pi/Codex auth; every non-ready state provides an impact statement and retry or corrective route. No ordinary API-key or silent metered-fallback route appears.
3. During a session, exactly one dominant state is perceivable as Idle, Listening, Transcribing, Deciding, Intentional silence, Cloud reasoning, Speaking, Stopping, or Degraded; internal telemetry is not required to understand it.
4. Intentional silence visibly resolves and returns to Listening; it is not indistinguishable from loading or failure.
5. User speech during deciding/reasoning/playback cancels current and queued assistant output, forces local audio silent, marks delivered output accurately, and restores Listening. Cancel-to-silence timing can be measured against the ≤300 ms guardrail.
6. Stop session is available from every active/degraded state, ends microphone capture, cancels pending work, and retains only already-stable local transcript content.
7. Pi unavailable/rate-limited/login-required states never imply local reasoning or provider fallback; they offer retry/sign-in and, when STT works, explicit transcript-only continuation.
8. STT failure stops misleading Listening/Transcribing progress; TTS failure permits clearly labeled text-only responses; microphone and echo failures have recoverable, non-destructive paths.
9. History can be browsed, exported, and deleted locally; destructive scope is confirmed, success/failure is announced, and a failed operation does not falsely alter the visible record.
10. Persona import previews before replacement; blocking validation prevents save, warnings are explicit, and the last valid persona survives import/validation/save failure.
11. TTS benchmark ordering and labels are randomized/blinded until ratings are submitted; machine metrics and identities are not available in the rating surface. STT shows matched transcripts/aggregate metrics without mandatory per-event scoring.
12. All flows are operable by keyboard with logical focus order and visible focus: `Tab` reaches status actions, Start/Stop, playback controls, transcript/history actions, validation links, and benchmark ratings; no keyboard trap exists.
13. Status updates use appropriate semantic headings/status regions; urgent loss of capture is assertively announced once, normal state changes politely, and streaming partials do not flood assistive technology.
14. Controls have programmatic names and states; waveform/activity, tentative text, error, posture, and benchmark selection do not rely on color, sound, hover, or motion alone.
15. Focus moves predictably after dialogs/actions: to first error on failed validation, logical next history item after delete, result heading after export, and session status after Start; focus is restored on cancel.
16. Playback has visible stop/pause controls and does not prevent screen-reader output; reduced-motion preference removes nonessential activity animation.

## Copy needs (per state: what job the words must do) — for writer

- **Disclosure:** state the local audio/cloud reasoning boundary, what context is sent, local history/persona default, provider control, and the absence of ordinary API-key/silent metered fallback—plainly, before consent.
- **Readiness:** name each capability in user language, explain impact without blame, and give one concrete next step; diagnostics may use technical labels separately.
- **Session states:** short, distinct labels for listening, finishing transcript, deciding, intentional silence, cloud reasoning, speaking, interruption, stopping, and degraded continuation.
- **Barge-in/echo:** reassure that the floor belongs to the user; ask the minimum confirmation needed without suggesting their speech was an error.
- **Failures:** distinguish unavailable, rate-limited, login-required, local model/GPU, microphone, echo, and cancellation outcomes; state what was preserved and whether local transcript-only/text-only continuation is possible.
- **History/export/delete:** clarify local scope, export contents/format, irreversible deletion scope, and success/failure.
- **Persona:** explain supported influence and safety limits; validation messages identify location, problem, and repair without rewriting the user’s intent.
- **Benchmark:** explain blinding, rating task, skips, reveal lock, attached hidden machine metrics, and failed-candidate handling without biasing preference.

## Open questions

- Define the supported persona file grammar, warning-vs-error policy, and interpretation preview contract before implementation.
- Confirm which current provider terms/retention link and exact live context description must appear at pilot time.
- Define the fixed benchmark rating dimensions/scales and export schema before study execution; the flow should remain unchanged.
- Set the echo-ambiguity threshold and auto-resume timeout through prototype testing without weakening immediate barge-in.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "artifacts/ux/index.md specifies only the requested first-run, explicit session, interruption, local history/persona, degraded states, internal speech benchmark, accessibility, and testable interaction contracts."
    }
  ],
  "changedFiles": [
    "artifacts/ux/index.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "python3 heading-presence validation for artifacts/ux/index.md",
      "result": "passed",
      "summary": "All required UX and acceptance-report headings are present."
    },
    {
      "command": "git diff --check -- artifacts/ux/index.md && git status --short && git diff --cached --name-only",
      "result": "failed",
      "summary": "The workspace is not a Git repository, so Git diff/status checks are unavailable."
    },
    {
      "command": "find .. -maxdepth 3 -name .git -type d -print | head",
      "result": "passed",
      "summary": "Confirmed no .git directory for this workspace within the inspected parent depth."
    }
  ],
  "validationOutput": [
    "Required-heading validation: bytes=21204; missing=[]",
    "No repository-local staging area exists in this workspace; therefore no staged files are present."
  ],
  "residualRisks": [
    "Persona grammar and benchmark rating dimensions remain product/implementation inputs, explicitly listed as open questions.",
    "Git whitespace/diff validation could not run because this workspace is not a Git repository."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a compact UX specification for readiness, voice sessions, interruption, local controls, failure recovery, benchmarking, accessibility, and architecture-facing state contracts.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": ""
}
```
