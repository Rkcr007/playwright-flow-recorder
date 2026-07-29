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

```
    ⠿  ●  [ approve first order    ]  ⏺ record   ✎ note   ⚡ create    ⏳ 1 queued · ✓ 2
    ▲  ▲   ▲                          ▲          ▲        ▲            ▲
    │  │   scenario name              start/     free-    hand to      live agent
    │  │                              stop       text     the agent    progress
    │  └─ red = idle · green pulse = recording
    └─ drag the widget anywhere
```

| Control | What it does |
|---|---|
| **⏺ / ⏹** | One click starts a named segment; the same button ends it. One segment = one scenario. |
| **✎ note** | Free text: *"verify the count increments"*, *"this dropdown is flaky, add a wait"*. Becomes an assertion or a comment. |
| **⌥/Alt+Click** | Assert an element **without triggering it**. A palette asks *what* to verify: has text / visible / enabled / editable / checked / this row / disappears later. |
| **⚡ create** | Queue the finished segment(s) for the agent. Durable — clicking it while the agent is busy never loses work. Queuing is not delivery: without an [`onCreate`](#making--actually-reach-an-agent) hook an agent has to come and read the queue. |
| **⠿** | Drag the widget out of the way. |

The name and note box stays typeable **even while a modal or drawer is open** — the widget escapes
the focus trap that Radix/MUI/Headless UI style dialogs install. That took a capture-phase guard and
has its own regression test, because notes silently vanishing is worse than no notes at all.

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
| `maskPattern` | `pass\|pwd\|otp\|pin\|secret\|token\|cvv\|card.?number` | fields recorded as `***masked***` |
| `typeDebounceMs` | `900` | how long a typing pause ends a `type` event |
| `captureNetwork` | `true` | record XHR/fetch during segments |
| `userMode` | `expert` | `guided` = plain-language mode for manual testers |
| `agentName` | `the AI agent` | shown in the widget |
| `onCreate` | `''` (nothing spawned) | command run when you click ⚡ — see [below](#making--actually-reach-an-agent) |
| `conventions` | — | **your framework** — see [docs/INTEGRATION.md](docs/INTEGRATION.md) |

See [flow-recorder.config.example.json](flow-recorder.config.example.json) for a full annotated file.

### Making ⚡ actually reach an agent

By default, ⚡ **writes a file and nothing more**. The request lands in
`<session>.jsonl.queue.json` and stays there until an agent reads it — which happens
promptly if a session is tailing the recording, and never if one isn't. That's why the
widget says *"awaiting pickup"* rather than implying delivery.

`onCreate` closes the gap by running a command on every ⚡:

```json
{ "onCreate": "claude -p \"Drain the flow-recorder queue at $FLOW_QUEUE_FILE\"" }
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

Three suites, no mocks of the thing under test:

- **`config-test.js`** — 25 checks on config discovery, upward search, deep-merged local
  overrides, precedence, `~` expansion, malformed-JSON handling, path validation.
- **`smoke-test.js`** — drives the real CLI against a headless Chromium and asserts the stream
  contains *exactly* the segment: idle clicks dropped, passwords masked, palette predicates
  recorded, row context attached, the durable queue accumulating two scenarios, and agent ack
  statuses merging into the widget state.
- **`focus-trap-test.js`** — mounts a Radix-style capture-phase focus trap and proves
  *differentially* that a plain outside input gets its focus stolen (the trap is real) while the
  widget's note box does not (the guard works).

## Docs

- [docs/INTEGRATION.md](docs/INTEGRATION.md) — per-framework config: Cucumber, Playwright Test, CodeceptJS, Cypress, non-JS
- [docs/EVENT-FORMAT.md](docs/EVENT-FORMAT.md) — every event kind, predicate, and field
- [docs/AI-CONVERSION-PROMPT.md](docs/AI-CONVERSION-PROMPT.md) — use it with any AI assistant
- [skills/record-flow/SKILL.md](skills/record-flow/SKILL.md) — the Claude Code skill

## License

MIT © Rakesh Barik
