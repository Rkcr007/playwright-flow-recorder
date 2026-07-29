# Event format

One JSON object per line (JSONL). Append-only, written as it happens, so the file is
readable and tailable while recording. Every event has `seq` (monotonic), `t` (ISO
timestamp) and `kind`.

```json
{"seq":14,"t":"2026-07-18T09:12:33.101Z","kind":"click","tag":"button","text":"Submit order",
 "label":null,"inDialog":true,"dialogTitle":"New order","url":"https://app.example.com/orders",
 "state":{"enabled":true,"visible":true},
 "candidates":[{"by":"data-testid","sel":"[data-testid=\"submit-order\"]"},
               {"by":"text","sel":"//button[normalize-space(.)=\"Submit order\"]"},
               {"by":"css-path","sel":"div#root > main > button"}]}
```

## Event kinds

| `kind` | Emitted when | Key fields |
|---|---|---|
| `click` | any click on an actionable element | `candidates`, `state`, `row?` |
| `type` | typing pauses in a field (debounced, final value only) | `value` (or `***masked***`) |
| `select` | a `<select>` changes | `value` = selected option text |
| `checkbox` / `radio` | toggled | `value` = `"true"` / `"false"` |
| `upload` | a file input changes | `value` = file **names** only, never contents |
| `key` | Enter or Escape pressed | `value` = `"Enter"` / `"Escape"` |
| `assert` | ⌥/Alt+Click, predicate chosen from the palette | `predicate`, `expected` |
| `note` | the ✎ button — free text from the user | `note` |
| `nav` | full page load or SPA route change | `how`, `value` = URL |
| `net` | XHR/fetch completed **during a segment** | `value` = `"POST /api/orders"`, `status` |
| `warning` | `idle-activity` — 15+ clicks while not recording | `note` |
| `marker` | segment/session boundaries | `value`, `note?`, `snapshot?` |

## Markers

`marker` events are the skeleton of the stream:

| `value` | Meaning |
|---|---|
| `session-start` | recorder attached; still idle |
| `recording-start` | ⏺ — `note` is the scenario name, `url` is where the flow begins, `snapshot` describes the page |
| `recording-stop` | ⏹ — segment ends; `snapshot` includes final field values |
| `create-scenario` | ⚡ — the user handed the finished segment(s) to the agent |
| `session-end` | Ctrl+C or browser closed |

**Only markers and notes are written while idle.** Interaction events appear exclusively
between a `recording-start` and its `recording-stop`. That is the whole point of the design:
the logging-in and navigating you do beforehand never pollutes the stream.

## Selector candidates

Every interaction event carries `candidates`, best-first:

| `by` | Example |
|---|---|
| `data-testid` / `data-test` / `data-qa` / `data-cy` / `data-test-id` | `[data-testid="submit-order"]` |
| `id` (auto-generated ids filtered out) | `#order-form` |
| `aria-label` | `button[aria-label="Close"]` |
| `placeholder` | `input[placeholder="Merchant name"]` |
| `name` | `select[name="team"]` |
| `text` (XPath) | `//button[normalize-space(.)="Save"]` |
| `css-path` | `div#root > main > button:nth-of-type(2)` |

This redundancy is the reason conversion is reliable. A recorder that emits one selector
per element forces the fragile choice on you; here the converter can prefer a `data-testid`
and fall back deliberately, and can tell you when an element offers nothing but text and a
CSS path — which is a signal to go ask for a test id.

Ids matching `/\d{3,}|^radix|^:|^ember|^react|^headlessui/` are dropped as auto-generated.

## Assert predicates

`assert` events come from ⌥/Alt+Click, which opens a palette **without triggering the
element**. The chosen predicate decides what the generated assertion checks:

| `predicate` | `expected` | Meaning |
|---|---|---|
| `text` | the string (editable in the palette) | element contains this text |
| `visible` | `null` | element is visible |
| `enabled` / `disabled` | `null` | interactive state |
| `editable` / `readonly` | `null` | input accepts typing |
| `checked` | `true`/`false` | checkbox/radio/switch state |
| `row` | array of the row's cell texts | the whole table row matches |
| `absent-later` | `null` | element should disappear after a later action |

Dismissing the palette (Escape, click away, or 12s) falls back to `predicate:"text"`.

**Never downgrade a predicate.** `visible` on a disabled button is not the same test as
`text`, and a converter that flattens them produces a test that passes for the wrong reason.

## Row context

Clicks and asserts inside tables carry:

```json
"row": { "rowIndex": 1, "rowCount": 2, "cells": ["Starbucks", "42.00"], "colHeader": "Merchant" }
```

Enough to express "the first row of results shows X" or "the row containing Starbucks shows
42.00" — but which one the user *meant* is ambiguous, so ask.

### Grids without row semantics

`row` requires a real `<tr>`/`<td>` or `role="row"`/`role="cell"`. **Many modern React data
grids render rows as plain `<div>`s with no row roles**, so no `row` context appears and the
palette hides the "check this row" option. Two workarounds:

1. ⌥/Alt+Click each cell separately → one assert per cell.
2. Often better: such grids frequently give each cell an id sharing a per-row key —
   `{uuid}_name`, `{uuid}_amount`, `{uuid}_status`. Look at the `candidates` of two adjacent
   cell clicks; if you see a shared prefix, you can anchor a whole-row assertion to that key
   even without native row support. One assert plus a ✎ note listing the other expected
   column values is enough for the converter to build it.

## Snapshots

`recording-start` and `recording-stop` markers carry a `snapshot`:

```json
"snapshot": { "title": "Orders · Example", "headings": ["Orders"], "dialog": "New order",
              "fields": [ { "label": "Merchant name", "value": "Starbucks" },
                          { "label": "Password", "value": "***masked***" } ] }
```

`fields` (stop marker only) is the final state of every visible input — which catches values
that arrived by autofill or paste without firing the input events the recorder listens for.

## Masking

Values are replaced with `***masked***` when the field is `type="password"` or when its
`type`/`name`/`id`/`placeholder`/accessible-name matches `maskPattern` (default:
`pass|pwd|otp|pin|secret|token|cvv|card.?number`). Extend it in your config:

```json
{ "maskPattern": "pass|pwd|otp|pin|secret|token|cvv|card.?number|ssn|iban|national.?id" }
```

Masking covers typed values **and** the field values in stop-marker snapshots.

Two things it does not do, so check before sharing a recording:
- URLs are recorded in full — a session token in a query string would be captured.
- Visible on-screen text is recorded (button labels, table cells). A customer name in a
  table cell lands in the stream.

Recordings are gitignored by default for exactly this reason. Skim one before committing it.

## What is not captured

- **Hover-only menus and drag-and-drop** — not first-class events. Add a ✎ note.
- **Cross-origin iframes** — not injected (payment widgets, embedded SSO). The widget does
  not appear inside them and clicks there are invisible to the recorder.
- **Request/response bodies** — `net` events carry method, path and status only.
- **Scroll, mouse movement, focus changes** — deliberately dropped as noise.
