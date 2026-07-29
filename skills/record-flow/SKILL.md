---
name: record-flow
description: Start a browser session with playwright-flow-recorder, follow the user's segment-based walkthrough live, and convert each recorded segment into a test that reuses this project's existing step library. Recording is idle until the user hits ⏺ in the on-page widget — login/navigation preambles are never captured; they come from existing steps. Use when the user says "record a flow", "/record-flow <name>", "start a recording session", "follow along while I click", "convert this recording", or points at a recordings/*.jsonl file.
---

# record-flow

Turn targeted manual walkthrough **segments** into passing tests. Two entry modes:

- **Live mode** (default): start the browser + recorder, follow the stream while the user demonstrates, convert when segments complete.
- **Convert-only mode**: the user hands you an existing `*.jsonl` recording — skip to the Convert phase.

## Read the project's conventions FIRST

Everything project-specific comes from the config file, never from assumptions. Before anything else, read it:

```bash
npx playwright-flow-recorder doctor      # resolved config + paths, all in one output
```

The `conventions` block is your contract with this repo:

| Key | What it tells you |
|---|---|
| `framework` | `cucumber-playwright`, `playwright-test`, `codeceptjs`, `cypress`, `generic` — decides the output format |
| `featureDir` | where generated spec/feature files go |
| `stepLibrary` | directories/files holding reusable step definitions |
| `primaryStepFile` | the shared catch-all library — always check here first for reuse |
| `locatorFiles` | selector maps, keyed by environment. Empty = this project keeps selectors in page objects |
| `testDataFiles` | fixtures / user-data files that literal values should resolve from |
| `scenarioOpener` | the standard first step of every scenario (e.g. `Given user is on web app`) |
| `dryRunCommand` | how to run a single spec to verify your output |
| `tags` | tags every generated scenario must carry (default `@recorded @wip`) |
| `notes` | freeform repo rules — read these, they override your defaults |

If `conventions.notes` conflicts with anything in this skill, **the project's notes win**.

## The segment model (core concept)

The recorder attaches to the browser but stays **idle** — nothing is captured while the user logs in and navigates to wherever they want to start. When they hit **⏺ record** in the on-page widget and name the scenario, capture begins; **⏹ stop** ends the segment. One segment = one scenario; a session can contain many.

The `recording-start` marker carries the scenario name (`note`) and the starting `url`. That URL tells you which module the flow begins in, and therefore which *existing* login + navigation steps to prepend as the preamble. **Never generate steps for actions before ⏺.**

Other inputs the user gives you mid-recording:

- **✎ note** events — free-text guidance, verbatim intent ("verify the count increments", "this dropdown is flaky, add a wait"). Feed these directly into how you write the scenario; assertion-shaped notes become assertions.
- **`assert` events** (⌥ Option+Click on macOS / Alt+Click elsewhere) — the user picked a verification target and a palette let them choose the `predicate`: `text` (with `expected`), `visible`, `enabled`/`disabled`, `editable`/`readonly`, `checked`, `row` (expected = the row's cell texts), `absent-later` (should disappear after a subsequent action). A dismissed palette defaults to `predicate:"text"`. Each becomes an assertion matching the predicate — **never reduce a non-text predicate to a text check**.
- **`row` context** — clicks/asserts inside tables carry `row: {rowIndex, rowCount, cells, colHeader}`. When an assert has row context, ask at debrief which semantics they meant: literally row #N / the row containing a specific value / all rows match the filter. Three different tests — only the user knows which.
- **Value provenance (make scenarios dynamic)** — correlate values across the stream: if an asserted/row text contains a value the user typed earlier (search term, amount, name), bind the assertion to that input (fixture reference or step parameter) instead of hardcoding it, and say so in the reconciliation ("first result contains the searched term"). Same for typed value → later summary/confirmation text.
- **`net` events** — XHR/fetch calls fired during the segment (method, path, status). Use them to (a) generate response-based waits for slow operations instead of sleeps, and (b) spot seeding/precondition needs (a POST during the flow often means state was consumed).
- **`snapshot`** on recording-start/stop markers — page title/headings/dialog, plus final field values on stop (catching autofill/paste the input events missed). Use for preamble context and postcondition assertions.
- **`warning` events** (`idle-activity`) — the user has been clicking while NOT recording; ping them immediately: "are you demonstrating right now? You may have forgotten ⏺."
- **Chat narration** — anything they type to you during recording counts the same as a note; correlate by timestamp/seq.

## User mode (read first)

`userMode` in the config (a local override file wins): **expert** (terse, technical — reconciliation reports, fixture names) or **guided** (manual-QA-friendly).

In guided mode: phrase every question in plain language with zero automation jargon (not "map this to a fixture token" but "would this exact value work every time the test runs?"), pick safe defaults instead of asking when the user seems unsure (and say what you picked in one sentence), and after generating, explain the scenario back in plain English ("this test now: logs in, opens Orders, approves the first pending one, checks the badge says Approved") so they can verify your understanding without reading code.

## Phase 0 — Context gathering (lazy: infer > observe > ask, and NEVER block the session start)

**Starting the session requires zero answers.** Fill gaps in this priority order, each answered at the latest moment it's actually needed:

1. **Infer** from what's in front of you: invocation arguments, the spec file open in the editor, chat context, the config's `conventions`.
2. **Observe** from the recording itself: the `recording-start` URL gives environment AND module. Build the scoped reuse index at the first ⏺ if it couldn't be built earlier. If an observation contradicts an earlier inference (they said Orders, ⏺ happened on Products), ask — don't assume.
3. **Ask** only what's still unknown, at the moment it's needed:
   - *Needed at ⏺/live-follow*: nothing — env + module come from the URL.
   - *Needed at ⚡/conversion*: destination (append to an existing file vs a new one), which test-data/account the scenario should run as, tag if not implied by the destination, deliverable type (new scenario / extend an existing one / locator refresh).

**If a spec file is already open in the editor**, use it: infer domain, tag, and target data from it, and confirm in ONE sentence — *"You have `<file>` open — I'll append new scenarios at the end of it. Correct?"* — while the session is already starting (the confirmation must never delay the browser/recorder). On yes, all segments append to that file (end-of-file, non-destructive).

**Cold start (bare `/record-flow`, no file, no context)**: launch everything immediately, tell the user to go ahead, and gather context via observation + the ⚡-time questions. This is a fully supported path, not an error — someone who types `/record-flow` with nothing else must have a working session in seconds.

## Phase 1 — Start the session

1. **Session name**: from the argument if given; otherwise omit `--name` and let the recorder default to `session-<timestamp>`. NEVER ask for a session name — it only names the file on disk. The names that matter are the per-scenario names typed into the widget's ⏺ box.
2. **Check the browser**: `npx playwright-flow-recorder doctor` reports whether a CDP browser is live. If not, start one and let the user log in:
   ```bash
   npx playwright-flow-recorder chrome
   ```
   (Cross-platform, uses a dedicated profile so logins persist. A dedicated profile is mandatory: Chrome 136+ ignores `--remote-debugging-port` on the default profile.)
3. **Start the recorder** in the background:
   ```bash
   npx playwright-flow-recorder record --name <session>
   ```
4. **Build the SCOPED reuse index** — narrow it to the relevant domain, because a focused index converts far more accurately than a huge one:
   ```bash
   npx playwright-flow-recorder index --steps <domain>[,<domain>] --env <locatorKey>
   ```
   Grep/read the output file selectively; do not load the whole thing into context. If the flow wanders into another domain mid-session, rebuild with the extra `--steps` entry rather than falling back to an unscoped index.
5. **Arm a watcher** so you wake without being pinged. Read `<outDir>/latest.txt` for the JSONL path, then:
   ```bash
   tail -n +1 -F "$FILE" | grep -m1 -E '"value":"(create-scenario|session-end|idle-activity)"'   # FIRST arm only
   ```
   **Every RE-arm must use `tail -n 0`, not `tail -n +1`.** `-n +1` replays the file from line 1, instantly re-matches the marker you just handled, and `grep -m1` exits on it — the watcher is dead within milliseconds and the user's next ⚡ wakes nobody:
   ```bash
   tail -n 0 -F "$FILE" | grep -m1 -E '"value":"(create-scenario|session-end|idle-activity)"'    # every re-arm
   ```
   A dead watcher costs a wake, never a request — the queue file still holds it, so drain on the next wake and apologise for the lag rather than telling the user the click was lost.

   (`idle-activity` wakes you to warn a user who forgot ⏺ — re-arm afterwards.) `recording-stop` alone means a segment finished but the user may record more; note it, but conversion starts on ⚡, "done" in chat, or session end.
6. **Tell the user**: session is idle — log in and navigate freely; hit ⏺ where the scenario starts; ✎ / Alt+Click for assertions; ⏹ when done; ⚡ to hand it over.

### THE QUEUE (durable — a ⚡ click is never lost)

The recorder maintains `<jsonl-path>.queue.json`, an append-only list of conversion requests:

```json
[{ "id": "q1", "scenario": "approve first pending order", "segment": 1, "status": "queued", "enqueuedAt": "…" }]
```

Every ⚡ appends the stopped-but-not-yet-queued segment(s). Because it's a file, a click survives even if your watcher wake lags or you're mid-conversion.

**DRAIN LOOP (mandatory — never leave the user blind after ⚡).** The moment you register a `create-scenario` (watcher wake OR the user saying they clicked ⚡):

1. Read `<jsonl-path>.queue.json`. Process `status:"queued"` items **in order, one at a time**.
2. Before touching an item, write the ack sidecar `<jsonl-path>.ack` marking it `working`, so the widget flips from "waiting…" to live status:
   ```json
   { "items": { "q1": { "status": "done", "message": "added to orders.feature" },
                "q2": { "status": "working", "message": "reconciling steps" } },
     "current": "q2" }
   ```
   Keep prior items' final statuses when you rewrite it (you own this file; the recorder only reads it) so the widget shows "✓ 1 · ⏳ …". Statuses: `working` → `done` | `error`; update `message` as you progress.
3. After finishing an item, **re-read the queue file** — the user may have clicked ⚡ again while you worked; late additions drain in the same loop.
4. When no `queued`/`working` items remain, **re-arm the watcher** and tell the user.

**Two ways you arrive at a drain.** Either you were already watching (the watcher above), or the project set `onCreate` in its config and the ⚡ click **spawned you** — in which case `FLOW_QUEUE_FILE`, `FLOW_SESSION_FILE`, `FLOW_ACK_FILE`, `FLOW_SCENARIOS` and `FLOW_PROJECT_ROOT` are already in your environment and there was no live session to follow. Prefer those env vars over re-deriving paths from `latest.txt` when they are set, and go straight to the drain loop: nobody is reading chat, so the ack file is your only channel. Only one hook runs at a time, so anything queued while you worked is waiting for *this* run — re-read the queue before you finish.

Writing the first `working` ack is the FIRST thing you do on wake — before debriefing — because it's the user's only signal you received the request. In queue mode the user has usually moved on, so favour best-effort inference from notes/asserts/provenance, leave `TODO(data):` comments where a decision is uncertain, and surface one consolidated data debrief after the drain rather than blocking per item (everything is `@wip` and human-reviewed anyway).

## Phase 2 — Follow along (live mode)

Poll the JSONL for new lines (track the last `seq` read) whenever the user messages you, and via the watcher at segment boundaries. While following:

- Narrate progress briefly at natural checkpoints ("got the drawer open + the category selection").
- **Annotate reuse live**: match each incoming event against the reuse index — tell the user when an action maps to an existing step + locator ("that's `user clicks on "ordersTab"` — already covered") and when it looks genuinely new. By ⏹ the reconciliation report should be nearly done.
- **Flag selector-quality problems immediately** — if an element's only candidates are `text`/`css-path` (no testid/id/aria), say so while the user is still on that page. That's a chance for them to ask a developer for a `data-testid` before the test gets written around a fragile selector.
- If a segment ends with zero `assert`/`note` events, tell the user — a scenario that only clicks proves nothing; ask what they visually verified.

## Phase 3 — Data debrief (per segment, BEFORE generating anything)

Demo data is not test data. The moment a segment ends, run a short structured interview — never silently decide data semantics yourself:

1. **List every literal value captured** (typed values, selected options, searched entities, uploaded file names, the account used) and classify each:
   - **literal** — this exact value is the point of the test;
   - **fixture** — maps to an existing entry in `conventions.testDataFiles` (credentials, ids, accounts). Check how this project layers its fixtures: if there is a base file that is always loaded plus per-account overrides, then **anything that must always resolve — especially credentials — belongs in the base file**. A namespace living only in a per-account override resolves only when that exact account is selected at runtime, and many frameworks fail *silently* on an unresolved token (the raw token string gets typed into the field);
   - **generated** — must be unique per run (fresh email, timestamp alias, random amount);
   - **precondition** — the entity won't exist on a clean run and must be created by earlier steps or API seeding before the recorded flow starts.
2. **Ask the re-runnability question**: "Will this pass twice in a row, on a clean day, on the account the suite runs as?" If the flow consumes state (approves the only pending item, uses up the only voucher), add seeding/setup steps — reuse existing simulation/seeding steps where they exist.
3. Notes given during recording that pre-answer these questions take precedence — don't re-ask what the user already told you.
4. **Never ask the user to paste a secret into chat.** `***masked***` values must be resolved from the project's fixture files by reference, never guessed and never echoed.

Only after the debrief, convert.

## Phase 3.5 — Convert (per segment)

1. **Preamble**: from the `recording-start` URL, pick *existing* login + navigation steps — start with `conventions.scenarioOpener`, then the navigation steps that reach that URL's module. Grep the step library for them; do not invent new ones for navigation that existing steps already cover.
2. **Collapse noise**: merge repeated `type` events on one field (keep the last), reduce click+select pairs on comboboxes to one step, ignore stray `nav` events inside a segment.
3. **Reconcile against the index — reuse first, and show your work.** Classify every action and element:
   - **Step: reuse** — an existing pattern covers it; the line uses it verbatim.
   - **Step: new** — nothing in the library fits; a new definition is genuinely needed.
   - **Locator: reuse** — an existing key already targets this element (search the index for the recorded testid/text/aria) and its selector still matches → use the key as-is.
   - **Locator: drift** — an existing key clearly targets this element but its stored selector no longer matches what was recorded → propose a *heal*, old → new.
   - **Locator: new** — nothing covers it → propose an *addition*.

   Then present the **reconciliation report** before creating anything: the draft scenario with each line marked `[existing]`/`[NEW]`, the list of new step definitions, and locator changes split into add vs modify with old→new diffs. **Get explicit confirmation on the NEW/modified items — never bulk-create silently.** This is the step that keeps the suite from growing a duplicate of every step it already had.
4. **Locator candidate quality** (for new/healed entries), best first: `data-testid`-style attribute > stable `id` > `aria-label` > `placeholder`/`name` > text XPath > `css-path` (last resort — flag it as fragile). Two traps worth knowing:
   - **Non-breaking spaces.** Text captured from a rendered page may contain NBSP (char 160) where the source has a normal space. A `text()="..."` XPath then silently fails. Use `normalize-space()` and prefer `contains`/`starts-with` for amount and currency cells.
   - **Auto-generated ids.** Radix/React/Ember ids are already filtered from candidates, but double-check any `id` that looks generated.
5. **Assertions**: every `assert` event and assertion-shaped `note` becomes an assertion, matching its predicate exactly.
6. **Output file**: scenario named from the `recording-start` note. Destination is the session's confirmed target file (**append at end** — never reorder or touch existing scenarios), or a new file under `conventions.featureDir`. Tags: the suite tag(s) **plus everything in `conventions.tags`** — `@recorded` permanently marks recorder origin; `@wip` keeps it out of CI until a human reviews it. **A green dry-run does NOT remove `@wip`** — that's the human review gate, not a test outcome.
7. **New step definitions** only where nothing in the library fits. Put them in the matching domain file within `conventions.stepLibrary`, following the patterns already used there (how selectors are read, how state is shared between steps) — match the surrounding code, don't introduce a new style.

## Phase 4 — Iterate to green

0. **Session-conflict check first**: many staging environments allow only ONE session per account. If the recording browser is logged in as the same account the test runs as, the dry-run **will** kick that session. Before dry-running: if recording is over, fine; if the user is still recording, either wait, use a different account, or get their OK to be logged out.
1. **Dry-run** with `conventions.dryRunCommand`, scoped to the new file or tag.
2. **Triage failures** and fix — usually a timing wait or a fragile locator needing a heal against the live DOM.
3. Repeat until green or blocked. **Report honestly** which scenarios pass and what remains.
4. **Guided-mode failure handoff**: if the dry-run still fails and healing can't fix it, do NOT keep grinding a manual tester. Keep the scenario `@wip`, add a `# HANDOFF:` comment above it (plain language: what the flow does, what failed, suspected cause), and tell the user their recording is saved and an automation engineer will finish it. The recording effort is never discarded.

## Gotchas

- **Native dialogs** (`prompt()`/`alert()`) don't work on Playwright-attached pages — the widget uses an inline input instead. Don't "fix" that back.
- **One `type` event per typing pause** — use the last value for a field.
- **Recordings are gitignored** by default (they may contain application data). Commit one only as a deliberate example, after skimming it.
- **Hover-only menus and drag-and-drop aren't captured** as first-class events — expect a ✎ note, or ask the user what happened there.
- **Cross-origin iframes are not injected** (payment widgets, embedded SSO). The widget won't appear inside them and clicks there aren't captured.
- **"check this row" only appears for semantic rows.** The assert palette offers the `row` predicate only when the ⌥/Alt+Clicked element sits inside a real `<tr>` or `role="row"` with cell children. **Many modern React data grids are pure `<div>` grids with no row/cell roles** — there the `row` predicate is unavailable. Two fallbacks:
  1. ⌥/Alt+Click each cell → separate asserts.
  2. Better on such grids: cells often carry per-row ids sharing a row key (e.g. `{uuid}_name`, `{uuid}_amount`, `{uuid}_status`). One assert on a single cell plus a ✎ note listing the other expected column values lets you build a whole-row check anchored to that shared key, even without the native `row` predicate. Look for that pattern in the `candidates` of adjacent cell clicks before falling back to per-cell asserts.
