# playwright-flow-recorder

**Record a browser walkthrough as a semantic event stream, then let an AI agent turn it into a test that reuses the step library you already have.**

Playwright's `codegen` gives you selectors. It doesn't give you tests. This gives an AI agent
enough context to write one that fits your suite: multiple candidate selectors per element,
assertions the user declared explicitly, intent notes in their own words, and a reuse index of
every step and locator your project already has.

```bash
npx playwright-flow-recorder init      # detect your framework, write a config
npx playwright-flow-recorder chrome    # a browser you can log into
npx playwright-flow-recorder record    # attach; press ⏺ when the flow starts
```

MIT licensed. One dependency (`playwright-core`). Works with Cucumber, Playwright Test,
CodeceptJS, Cypress, or anything else — the framework-specific part is one config block.

---

## Why not `codegen`, a DevTools recording, or a screen capture?

|  | Screen recording | DevTools Recorder | `playwright codegen` | **flow-recorder** |
|---|---|---|---|---|
| Selectors | none | one per element | one per element | **5–7 candidates per element** |
| Captures your intent | no | no | no | **✎ notes, in your words** |
| Assertions | no | no | manual afterwards | **⌥Alt+Click, 9 predicates** |
| Skips the login preamble | no | no | no | **idle until you press ⏺** |
| Knows your existing steps | no | no | no | **reuse index** |
| Table row context | no | no | no | **row, cells, column header** |
| API calls during the flow | no | no | no | **`net` events → real waits** |

The difference that matters most is the **redundancy**. A recorder that emits one selector per
element makes the fragile choice for you and hides it. Capturing `data-testid`, `id`,
`aria-label`, `placeholder`, `name`, a text XPath *and* a CSS path means the converter can prefer
a stable one — and can warn you when an element offers nothing but text and a CSS path, which is
your cue to go ask a developer for a test id before a test gets built on sand.

## The recording model

The recorder attaches to your browser and **does nothing**. You log in, navigate, poke around —
none of it is captured. When you reach the flow you actually want automated, you press ⏺.

That inversion is the whole design. Every other recorder starts capturing at the first click, so
you get forty events of logging in before the part you care about. Here, login and navigation come
from steps that already exist in your framework, and the stream contains only signal.

<p align="center">
  <img src="demo/demo.gif" width="820" alt="The recorder sits idle while clicks are ignored, then captures a segment with an assertion and hands it to an agent, which produces a Gherkin scenario reusing five existing steps and writing one new one.">
</p>

> **[▶ Try it yourself — interactive demo](https://rkcr007.github.io/playwright-flow-recorder/demo/)** — press record, click
> through a fake Orders app, and watch it become a Gherkin scenario that reuses 5 steps you already had.
> Runs in your browser, nothing to install.

```
    ⠿  ●  [ approve first order    ]  ⏺ record   ✎ note   ⚡ create    ⏳ 1 queued · ✓ 2
    ▲  ▲   ▲                          ▲          ▲        ▲            ▲
    │  │   scenario name              start/     free-    hand to      live agent
    │  │                              stop       text     the agent    progress ← click me
    │  └─ grey = idle · red pulse = recording (the bar gains a red rim too)
    └─ drag the widget anywhere

    ┌─ hand-off to the AI agent ───────────────────────────┐
    │ approve first pending order                   DONE   │
    │ segment 1                                            │
    │ Appended to orders.feature as @recorded @wip.        │
    │ · 3 assertions carried over                          │
    │ · steps: 6 reused, 1 new, 1 healed                   │
    │ features/orders.feature                              │
    ├──────────────────────────────────────────────────────┤
    │ reject with reason                          WORKING  │
    │ Reconciling against the step index.                  │
    └──────────────────────────────────────────────────────┘
```

| Control | What it does |
|---|---|
| **⏺ / ⏹** | One click starts a named segment; the same button ends it. One segment = one scenario. |
| **✎ note** | Free text: *"verify the count increments"*, *"this dropdown is flaky, add a wait"*. Becomes an assertion or a comment. |
| **⌥/Alt+Click** | Assert an element **without triggering it**. A palette asks *what* to verify: has text / visible / enabled / editable / checked / this row / disappears later. |
| **⚡ create** | Queue the finished segment(s) for the agent. Durable — clicking it while the agent is busy never loses work. Queuing is not delivery: without an [`onCreate`](#making--actually-reach-an-agent) hook an agent has to come and read the queue. |
| **⠿** | Drag the widget out of the way. |
| **the progress chip** | Click it to open the **hand-off panel** — one card per scenario showing what the agent is doing right now. |

The name and note box stays typeable **even while a modal or drawer is open** — the widget escapes
the focus trap that Radix/MUI/Headless UI style dialogs install. That took a capture-phase guard and
has its own regression test, because notes silently vanishing is worse than no notes at all.

### Watching the hand-off

Clicking ⚡ used to leave you guessing. The panel is the answer: it opens itself when a scenario
starts being worked, finishes, or fails, and shows per scenario —

- the **status** (queued / working / done / failed), colour-coded
- the agent's **message** in full, not truncated
- **detail lines**: what it matched, what it had to invent, what it's unsure about
- **step counts** — `6 reused, 1 new, 1 healed`, the quickest proof reuse actually happened
- the **destination file**, so "where did my scenario go" is never a question

All of it comes from the agent's `<session>.jsonl.ack` sidecar, so this is real progress rather than
a spinner. Dismiss it with ✕ and it stays shut until the next status change; the chip reopens it.
Agents that write only `{status, message}` still render fine — everything else is optional.

## Quick start

### 1. Install and configure

```bash
cd your-test-repo
npx playwright-flow-recorder init
```

Detects your framework from `package.json`, finds your step directories and any JSON selector
maps, writes `flow-recorder.config.json`, installs the Claude Code skill, and updates
`.gitignore`. **Review what it wrote** — it guesses well, but it is guessing.

```bash
npx playwright-flow-recorder doctor
```

Verifies Node, Playwright, the browser binary, and — most usefully — that the paths in your
config still exist. A `stepLibrary` pointing at a renamed directory is the number one reason
conversion quietly stops reusing steps: the index comes back empty and the agent writes
everything from scratch.

### 2. Build the reuse index

```bash
npx playwright-flow-recorder index --steps orders --env default
```

Extracts every existing step pattern and locator key so the converter matches against what you
have. Scope it — 140 steps from 3 relevant files beats 400 from 17, because the agent can read
all of it.

### 3. Record

```bash
npx playwright-flow-recorder chrome    # dedicated profile; log in once, stays logged in
npx playwright-flow-recorder record    # in another terminal
```

Log in, navigate to where the interesting part starts, press ⏺, name it, demonstrate, press ⏹,
press ⚡.

### 4. Convert

**With Claude Code:** type `/record-flow`. The packaged skill starts the browser and recorder,
follows the event stream *while you click* (telling you which actions already map to existing
steps), then converts each segment — presenting a reconciliation report for approval before it
writes anything.

**With any other assistant:** paste the prompt in [docs/AI-CONVERSION-PROMPT.md](docs/AI-CONVERSION-PROMPT.md).

## Reuse, not generation

This is the part that makes recorded tests worth keeping.

The converter doesn't write a test from scratch. It **reconciles** the recording against your
existing suite, and classifies every single action and element:

```
Scenario: approve the first pending order
  Given user is on web app                             [existing]
  When user logs in with "$admin.email" ...            [existing]
  And user clicks on "ordersTab"                       [existing]
  And user clicks on "pendingFilter"                   [existing]
  And user approves the order in row 1                 [NEW step]
  Then user should see "Approved"                      [existing]

New step definitions (1)     → features/step_definitions/orders_steps.js
Locator additions (1)        → approveRowButton: [data-testid="approve-row"]
Locator modifications (1)    → pendingFilter
                                 - //button[text()="Pending"]
                                 + //button[normalize-space(.)="Pending"]
```

Nothing is written until you approve the `[NEW]` and modified items.

The usual failure mode of "AI, write me a test" is a beautiful file that duplicates three steps you
already had, in a style your suite doesn't use. Reuse-first inverts it: **recordings make the suite
denser, not bigger.** And notice the locator *modification* — a recording is also a drift detector,
because it captures what the DOM looks like today versus what your locator file claims.

Every generated scenario is tagged `@recorded @wip`. `@recorded` marks its origin permanently.
`@wip` keeps it out of CI until a human reviews it — **a passing dry-run does not remove `@wip`**.
The agent writes the first draft; it doesn't get commit rights.

## Configuration

Everything has a default; a config file is only needed so the *converter* knows about your project.
Discovery walks up from the current directory: `flow-recorder.config.json`, then
`.flow-recorder.json`, then a `"flow-recorder"` key in `package.json`. Precedence is
**CLI flag > `flow-recorder.config.local.json` (gitignored) > config file > default**.

| Key | Default | |
|---|---|---|
| `attachPort` | `9222` | CDP port to attach to |
| `startUrl` | `""` | opened on connect |
| `outDir` | `.flow-recorder/recordings` | |
| `indexFile` | `.flow-recorder/step-index.json` | |
| `chromeProfileDir` | `~/.flow-recorder-chrome-profile` | persistent login profile |
| `chromePath` | auto-detected | explicit browser binary |
| `maskPattern` | `pass\|pwd\|otp\|pin\|secret\|token\|cvv\|card.?number\|api.?key\|access.?key\|auth(?!or)\|credential\|ssn\|iban` | fields recorded as `***masked***` |
| `maskAllInput` | `false` | mask **every** typed value — see [What ends up in a recording](#what-ends-up-in-a-recording) |
| `redactUrlParams` | `token\|code\|key\|secret\|password\|…\|assertion` | URL parameters whose value is replaced with `***` |
| `typeDebounceMs` | `900` | how long a typing pause ends a `type` event — also flushed early by Enter, blur, a click elsewhere, or navigation, so a submitted value is never lost |
| `captureNetwork` | `true` | record XHR/fetch during segments |
| `userMode` | `expert` | `guided` = plain-language mode for manual testers |
| `agentName` | `the AI agent` | shown in the widget |
| `onCreate` | `''` (nothing spawned) | command run when you click ⚡ — see [below](#making--actually-reach-an-agent) |
| `conventions` | — | **your framework** — see [docs/INTEGRATION.md](docs/INTEGRATION.md) |

See [flow-recorder.config.example.json](flow-recorder.config.example.json) for a full annotated file.

## What ends up in a recording

A recording is written to be handed to an AI agent — often a hosted one — so it is
worth being precise about what it contains.

**Redacted automatically**

- Values typed into `type="password"` fields, and into fields whose type, name, id or
  placeholder matches `maskPattern` — recorded as `***masked***`.
- Credential-bearing URL parameters, replaced with `***`, in the per-event `url` stamp,
  in `nav` events and in `net` query strings. Matching is per name component, so
  `access_token`, `id_token`, `X-Auth-Token` and `apiKey` are all caught while
  `zipcode` and `monkey` are left alone. Fragments are covered too, which is where
  implicit-grant flows put the token. Parameter *names* survive — the agent still sees
  the shape of the request.
- `latest.txt`, the JSONL, the queue and the ack all live in a directory that
  **git-ignores itself**, whether or not you ran `init`.

**Not redacted**

- Ordinary typed values. They are the test data, and conversion needs them.
- Anything in a field whose name reveals nothing — legacy JSF/ASP.NET `j_idt42`, or an
  obfuscated build. No name-based rule can help there. Set `"maskAllInput": true` and
  every typed value becomes `***masked***`; conversion quality drops, because the agent
  then has to resolve every literal from fixtures, which is exactly the trade regulated
  teams want.
- Email addresses and identifiers in URLs. Add them to `redactUrlParams` if your
  threat model needs it.

The recorder prints its posture at startup, so nobody has to infer it.

## Working with any assistant

`init` writes **`.flow-recorder/CONVERT.md`** — the conversion contract, resolved
against your project's real paths, in vendor-neutral Markdown. Claude Code, Cursor,
Copilot, Windsurf, Cody, Aider, Continue, ChatGPT or a human can all work from it.
**Commit it**; it is the one file a teammate's assistant needs.

It also points whichever assistants you already use at that file, appending one line
to the file each tool reads by convention:

| Tool | File |
|---|---|
| Cursor, Copilot coding agent, Zed, Aider, Codex | `AGENTS.md` |
| Cursor rules | `.cursor/rules/flow-recorder.mdc` |
| GitHub Copilot Chat | `.github/copilot-instructions.md` |
| Claude Code | `.claude/skills/record-flow/SKILL.md` (a full skill — it can drive the session live) |

By default only files that already exist are touched. Force them with:

```bash
npx flow-recorder init --agent agents,cursor,copilot     # or --agent all
```

`flow-recorder doctor` reports which assistants are wired up, because "nothing picked
up my ⚡" is nearly always "no agent in this repo was ever told what to do".

Any assistant can also report progress back into the browser widget by writing the ack
file — the protocol is in `CONVERT.md`. Nothing about it is Claude-specific.

### Making ⚡ actually reach an agent

By default, ⚡ **writes a file and nothing more**. The request lands in
`<session>.jsonl.queue.json` and stays there until an agent reads it — which happens
promptly if a session is tailing the recording, and never if one isn't. That's why the
widget says *"awaiting pickup"* rather than implying delivery.

`onCreate` closes the gap by running a command on every ⚡:

```json
{ "onCreate": "claude -p \"Drain the flow-recorder queue at $FLOW_QUEUE_FILE\"" }
```

Any command works — the recorder does not care what is on the other end:

```json
{ "onCreate": "aider --yes --message \"Convert $FLOW_QUEUE_FILE per .flow-recorder/CONVERT.md\"" }
{ "onCreate": "gh copilot suggest -t shell \"convert $FLOW_QUEUE_FILE\"" }
{ "onCreate": ["osascript", "-e", "display notification \"scenario ready to convert\""] }
{ "onCreate": "curl -sX POST $CI_WEBHOOK -d @$FLOW_QUEUE_FILE" }
```

A string runs through the shell; an array (`["notify-send", "flow ready"]`) is spawned
directly with no shell. Context arrives as environment variables, so nothing has to be
quoted into the command:

| Variable | |
|---|---|
| `FLOW_QUEUE_FILE` | the durable queue the agent should drain |
| `FLOW_SESSION_FILE` | the recording JSONL |
| `FLOW_ACK_FILE` | where the agent writes per-item status back |
| `FLOW_PROJECT_ROOT` | resolved project root (also the command's cwd) |
| `FLOW_QUEUE_DEPTH` | items not yet done |
| `FLOW_ENQUEUED` | how many this click added |
| `FLOW_SCENARIOS` | queued scenario names, newline-separated |

Deliberate behaviour worth knowing:

- **Opt-in.** Empty means nothing is ever spawned. This is shell execution driven by a
  config file that may have arrived with a cloned repo, so it is never on by default,
  it is printed at startup and on every fire, and `record --no-hooks` disables it
  without editing the config.
- **One at a time.** A second ⚡ while the hook is still running does *not* start a
  second agent — the queue is durable and the running one re-reads it.
- **Queue first, spawn second.** If the command dies the request is already on disk.

## Commands

| | |
|---|---|
| `record` | attach and record segments (**default** — a bare invocation runs this) |
| `chrome` | start a Chrome the recorder can attach to, on a dedicated profile |
| `init` | detect your framework and write a config |
| `index` | build the reuse index of existing steps/locators |
| `doctor` | diagnose environment, config and browser wiring |

`<command> --help` for options.

## Safety

Values are masked when the field is `type="password"` or its name/id/placeholder matches
`maskPattern`. File **names** are recorded, never contents. `net` events carry method, path and
status — never request or response bodies.

Two things masking does not cover, so **skim a recording before you share it**:

- URLs are recorded in full — a token in a query string would be captured.
- Visible text is recorded — a customer name in a table cell lands in the stream.

Recordings are gitignored by default for that reason.

## Troubleshooting

**The widget doesn't appear.**
Cross-origin iframes are not injected, so it won't show inside an embedded payment or SSO frame
— check the top-level page. Otherwise the recorder isn't attached: run `doctor`.

**`No browser is listening for CDP on port 9222`.**
Run `npx playwright-flow-recorder chrome`. If that port is taken:
`chrome --port 9333` then `record --attach 9333`.

**I ran Chrome with `--remote-debugging-port` myself and nothing attaches.**
Since Chrome 136 that flag is **silently ignored** on your default profile directory. A separate
`--user-data-dir` is mandatory — which is exactly what the `chrome` command does for you.

**`record` opened a browser that isn't logged in.**
It couldn't attach, so it fell back to a fresh browser. Quit it, run `chrome`, log in, then
`record` again.

**My typed value is missing from the stream.**
`type` events are debounced — they fire when you *pause*. Typing and immediately pressing ⏹ can
outrun it; the stop marker's `snapshot.fields` catches the final value as a backstop.

**Nothing was captured at all.**
Recording is idle until ⏺. If you clicked 15+ times without it, the stream contains an
`idle-activity` warning — that's the recorder telling you it noticed.

**The index found 0 steps.**
Expected for Playwright Test / Cypress (no Gherkin steps to extract) — point the agent at your
page objects via `conventions.notes`. For a Cucumber project, run `doctor`: a `stepLibrary` path
was probably renamed.

**Alt+Click triggers the element instead of asserting.**
Some apps bind Alt themselves. Alt+Click is prevented at capture phase and should win; if it
doesn't, use a ✎ note describing what you'd check instead.

## Limitations

- Hover-only menus and drag-and-drop are not captured as first-class events — add a ✎ note.
- Cross-origin iframes are not injected.
- Native `prompt()`/`alert()` can't be used by the widget (Playwright auto-dismisses dialogs on
  attached pages), hence the inline input.
- Assertions are yours to declare. **A segment with zero asserts and zero notes produces a
  scenario that only clicks — which proves nothing.**
- The `row` predicate needs real `<tr>`/`<td>` or ARIA row roles. Many React data grids are plain
  `<div>`s; see [docs/EVENT-FORMAT.md](docs/EVENT-FORMAT.md#grids-without-row-semantics) for the
  per-row-id workaround.
- The step indexer is Cucumber-shaped. Other frameworks record and convert fine, they just get an
  empty reuse index.

## Verify the install

```bash
npm install
npm test
```

Eight suites, 104 checks, no mocks of the thing under test — every browser test drives the real CLI
against a real headless Chromium over CDP:

- **`config-test.js`** — 25 checks on config discovery, upward search, deep-merged local
  overrides, precedence, `~` expansion, malformed-JSON handling, path validation.
- **`smoke-test.js`** — asserts the stream contains *exactly* the segment: idle clicks dropped,
  passwords masked, palette predicates recorded, row context attached, the durable queue
  accumulating two scenarios, and agent ack statuses merging into the widget state.
- **`focus-trap-test.js`** — mounts a Radix-style capture-phase focus trap and proves
  *differentially* that a plain outside input gets its focus stolen (the trap is real) while the
  widget's note box does not (the guard works).
- **`widget-mount-test.js`** — the two ways the HUD could silently fail to appear: a Trusted-Types
  page rejecting `innerHTML`, and a launched browser with zero pages.
- **`type-flush-test.js`** — every typing case interrupted *inside* the debounce window (Enter,
  click elsewhere, blur, navigation). A missing flush means a missing value, which is how a typed
  search term used to vanish from the stream entirely.
- **`reinject-test.js`** — edits `inject.js`, re-attaches to a page that is never reloaded, and
  proves the new build replaces the old one without double-emitting. A config-only change counts too.
- **`oncreate-hook-test.js`** — the ⚡ hook fires with real context in `FLOW_*` env vars,
  `--no-hooks` wins, and a second ⚡ mid-run does not spawn a second agent.
- **`ack-panel-test.js`** — the hand-off panel renders names, messages, detail lines, step counts
  and destination files untruncated, reopens on a status change after a manual dismiss, and still
  understands a legacy single-object ack.

## Docs

- [docs/INTEGRATION.md](docs/INTEGRATION.md) — per-framework config: Cucumber, Playwright Test, CodeceptJS, Cypress, non-JS
- [docs/EVENT-FORMAT.md](docs/EVENT-FORMAT.md) — every event kind, predicate, and field
- [docs/AI-CONVERSION-PROMPT.md](docs/AI-CONVERSION-PROMPT.md) — use it with any AI assistant
- [skills/record-flow/SKILL.md](skills/record-flow/SKILL.md) — the Claude Code skill

## License

MIT © Rakesh Barik
