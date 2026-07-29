# Wiring it into your framework

The recorder captures *what the user did*. Your framework decides *what a test looks like*.
The seam between them is one config file — nothing in `src/` knows about any test runner.

```bash
cd your-test-repo
npx playwright-flow-recorder init     # detects and writes flow-recorder.config.json
npx playwright-flow-recorder doctor   # confirms every path resolves
```

`init` reads your `package.json`, probes the usual directory layouts, and finds JSON
selector maps. Review what it wrote — it guesses well but it is guessing.

## The conventions block

Only the `conventions` block is framework-specific, and only the AI converter reads it:

| Key | Purpose | Empty means |
|---|---|---|
| `framework` | output shape | treated as `generic` |
| `featureDir` | where new specs go | `features/` |
| `stepLibrary` | files/dirs of reusable steps (recursed, `.js/.ts/.mjs/.cjs`) | nothing to reuse — everything gets written from scratch |
| `primaryStepFile` | the shared catch-all library, always indexed | no file is pinned |
| `locatorFiles` | JSON selector maps, keyed by env | you keep selectors in page objects — say so in `notes` |
| `testDataFiles` | fixtures literals should resolve from | the agent will ask |
| `scenarioOpener` | mandatory first step | no opener is prepended |
| `dryRunCommand` | how to run one spec | the agent won't self-verify |
| `tags` | tags on every generated scenario | `@recorded @wip` |
| `notes` | freeform repo rules — **these override the skill's defaults** | — |

Then build the reuse index. Scope it: a focused index converts far more accurately than a
huge one, because the agent can actually read all of it.

```bash
npx playwright-flow-recorder index --steps orders,payments --env default
```

---

## Cucumber + Playwright

```json
{
  "conventions": {
    "framework": "cucumber-playwright",
    "featureDir": "features",
    "stepLibrary": ["features/step_definitions"],
    "primaryStepFile": "common_steps.js",
    "locatorFiles": { "default": "resources/locators.json" },
    "testDataFiles": ["fixtures/users.json"],
    "scenarioOpener": "Given user is on web app",
    "dryRunCommand": "npx cucumber-js",
    "tags": ["@recorded", "@wip"]
  }
}
```

The index extracts `Given`/`When`/`Then`/`And`/`But`/`defineStep` patterns in both
Cucumber-expression and regex styles, so a recorded click becomes
`When user clicks on "saveButton"` if that step and locator key already exist.

TypeScript step definitions are indexed too (`.ts`, `.d.ts` excluded).

## Playwright Test

```json
{
  "conventions": {
    "framework": "playwright-test",
    "featureDir": "tests",
    "stepLibrary": ["tests/pages", "tests/helpers"],
    "dryRunCommand": "npx playwright test",
    "tags": ["@recorded"]
  }
}
```

There are no Gherkin step definitions to index here, so the index will report 0 steps —
that is expected, not a failure. Point the agent at your page objects instead:

```json
"notes": "Page objects live in tests/pages/*.page.ts. Add a method there instead of inlining a locator in a spec. Use expect(...).toBeVisible() style assertions. Tag with @recorded; no @wip needed since these don't run in CI until merged."
```

Since `tags` here has no `@wip`, decide your own review gate — a label on the PR, or a
`test.fixme()` until reviewed.

## CodeceptJS

```json
{
  "conventions": {
    "framework": "codeceptjs",
    "featureDir": "features",
    "stepLibrary": ["steps"],
    "dryRunCommand": "npx codeceptjs run",
    "notes": "Use I.click / I.fillField / I.see actor syntax. Custom steps go in steps_file.js."
  }
}
```

## Cypress

```json
{
  "conventions": {
    "framework": "cypress",
    "featureDir": "cypress/e2e",
    "stepLibrary": ["cypress/support"],
    "dryRunCommand": "npx cypress run",
    "notes": "Prefer cy.get('[data-cy=...]'). Custom commands go in cypress/support/commands.js."
  }
}
```

The recorder already collects `data-cy` as a first-class candidate.

## Anything else (Selenium, WebdriverIO, Puppeteer, pytest, Robot Framework…)

Leave `framework: "generic"` and describe the target in `notes`. The recording format is
just JSONL — nothing about it is JavaScript-specific. For a non-JS target:

```json
{
  "conventions": {
    "framework": "generic",
    "featureDir": "tests/e2e",
    "stepLibrary": [],
    "dryRunCommand": "pytest tests/e2e -k recorded",
    "notes": "Python + pytest + Playwright sync API. Page objects in tests/pages/*.py, snake_case methods. Selectors as class constants. Assertions with expect() from playwright.sync_api."
  }
}
```

You still get the recorder, the widget, the assert palette and the queue — you just point
the agent at a different output shape. The `stepLibrary` indexer is Cucumber-shaped, so for
non-JS projects it returns nothing; let the agent read your page objects directly.

## Where things live

```
your-repo/
├── flow-recorder.config.json          # committed: shared conventions
├── flow-recorder.config.local.json    # gitignored: your port, your profile, your userMode
├── .flow-recorder/                    # gitignored working dir
│   ├── recordings/
│   │   ├── latest.txt                 # → newest recording
│   │   ├── session-<ts>.jsonl         # the event stream
│   │   ├── session-<ts>.jsonl.queue.json   # recorder-owned: ⚡ requests
│   │   └── session-<ts>.jsonl.ack          # agent-owned: conversion status
│   └── step-index.json                # the reuse index
└── .claude/skills/record-flow/SKILL.md    # installed by `init`
```

`init` adds `.flow-recorder/` and `flow-recorder.config.local.json` to your `.gitignore`.
Recordings stay out of git because they contain application data.

## Per-user overrides

Anything personal goes in `flow-recorder.config.local.json`, which is gitignored and
deep-merged over the shared config:

```json
{ "attachPort": 9333, "userMode": "guided", "startUrl": "https://staging.example.com" }
```

`userMode: "guided"` is the one to know about: it switches the agent into plain-language
mode for manual testers — no automation jargon in questions, safe defaults instead of
interrogation, and a plain-English readback of what the generated test does.

## CI

Recording is an interactive activity, but two things are worth running in CI:

```bash
npx playwright-flow-recorder doctor    # fails if a stepLibrary path was renamed
npx playwright-flow-recorder index     # keeps the reuse index fresh
```

The `doctor` check earns its place: when someone renames a step directory, the index
silently comes back empty and the agent starts writing duplicate steps instead of reusing
yours. `doctor` exits non-zero on a missing convention path, so you find out on the PR that
renamed it.

Headless recording works (`record --launch --headless`) but nobody can press ⏺, so it is
only useful for testing the recorder itself — see `test/smoke-test.js`.

## Multiple environments

`locatorFiles` is keyed, and `index --env <key>` narrows to one:

```json
"locatorFiles": {
  "default": "resources/locators.json",
  "eu":      "resources/eu-locators.json",
  "staging": "resources/staging-locators.json"
}
```

```bash
npx playwright-flow-recorder index --env eu --steps checkout
```

Scoping matters more than it looks: an index of 140 steps from 3 relevant files produces
noticeably better reuse than 400 steps from 17 files across three environments, because the
agent can hold the whole thing in view.
