# Converting a flow-recorder recording (for any AI assistant)

This file was generated into this repository by `npx flow-recorder init`. It is
deliberately vendor-neutral: Claude Code, Cursor, GitHub Copilot, Windsurf, Cody,
Aider, Continue, ChatGPT — or a human — can all work from it. Paths below are the
real ones for **this** project.

## Where things are

| What | Path |
|---|---|
| Config (`conventions` block) | `{{CONFIG}}` |
| Recordings (JSONL) | `{{OUTDIR}}` |
| Newest recording pointer | `{{OUTDIR}}/latest.txt` |
| Reuse index (existing steps/locators) | `{{INDEX}}` |
| Generated specs go to | `{{FEATUREDIR}}` |
| Framework | `{{FRAMEWORK}}` |
| Dry-run one spec | `{{DRYRUN}}` |

Rebuild the reuse index with `npx flow-recorder index` before converting — a stale
index is the usual reason an agent writes a step that already existed.

## The recording format

One JSON object per line. Read `docs/EVENT-FORMAT.md` in the
`playwright-flow-recorder` package for the full schema. What matters most:

- Interaction events exist **only** between a `recording-start` and a
  `recording-stop` marker. Everything before ⏺ was login and navigation.
- Each element carries several `candidates` — ranked selector options, not one guess.
- `assert` events carry a `predicate`; `note` events carry the user's stated intent.
- `net` events list the XHR/fetch calls the flow triggered.
- Values shown as `***masked***` are secrets. URL parameters shown as `***` were
  redacted. Neither is recoverable — resolve them from this project's fixtures.

## Rules — follow all of them

1. **Only convert what is inside a segment.** Express the pre-⏺ preamble with the
   project's existing opener and navigation steps, inferred from the `url` on the
   `recording-start` marker. Never generate steps for pre-⏺ actions.
2. **Reuse before you write.** For every action search the reuse index for a step
   that already covers it, and for every element a locator key that already targets
   it. Author something new only when nothing fits. A duplicate of an existing step
   is a defect, not a convenience.
3. **Show your work before creating files.** Produce a reconciliation report first:
   the draft scenario with each line marked `[existing]` or `[NEW]`, then new step
   definitions, then locator changes split into additions and modifications
   (old → new). Wait for approval on the NEW and modified items.
4. **Pick stable selectors.** Prefer, in order: `data-testid`-style attribute →
   stable `id` → `aria-label` → `placeholder`/`name` → text XPath → `css-path`. Flag
   any element whose only candidates are text or css-path as fragile. Use
   `normalize-space()` in text XPaths, and `contains`/`starts-with` for amounts and
   currency (rendered pages carry non-breaking spaces where the source has normal ones).
5. **Honour assertion predicates exactly** — `text`, `visible`, `enabled`,
   `disabled`, `editable`, `readonly`, `checked`, `row`, `absent-later`. Never
   downgrade `visible`/`enabled`/`checked` into a text check. A `note` that reads
   like a verification becomes an assertion too.
6. **Make it re-runnable.** Classify every literal as *literal*, *fixture*,
   *generated* (unique per run) or *precondition* (needs seeding). Then answer
   explicitly: "will this pass twice in a row on a clean account?" If the flow
   consumes state, add the setup.
7. **Bind dynamic values.** If an asserted string contains something typed earlier
   in the same segment, bind the assertion to that input rather than hardcoding it.
8. **Never invent a secret.** Do not guess a masked value, do not ask for it in
   chat, do not put it in the spec. Resolve it from the fixture files by reference.
9. **Prefer response waits over sleeps**, using the `net` events.
10. **Tag it and gate it.** Apply every tag in `conventions.tags` ({{TAGS}}) plus the
    relevant suite tag. `@wip` stays until a human reviews it — **a passing dry-run
    does not remove it.**
11. **Report honestly.** After the dry run, state which scenarios pass and which do
    not, with the real error. Never describe a failing test as done.

`conventions.notes` in the config overrides anything here.

## Reporting progress back to the browser widget (optional)

The person who recorded the flow is looking at the browser, not at your chat. The
recorder's on-page widget renders whatever you write to the **ack file** beside the
recording, so writing it is how they see progress at all.

Given a recording at `<session>.jsonl`, the queue is `<session>.jsonl.queue.json`
(written by the recorder, read by you) and the ack is `<session>.jsonl.ack`
(written by you, read by the widget). When the recorder was started with an
`onCreate` hook these arrive as `$FLOW_QUEUE_FILE` and `$FLOW_ACK_FILE`.

Queue entries look like:

```json
[{ "id": "q1", "scenario": "add item to cart", "segment": 1, "status": "queued" }]
```

Write the ack keyed by the same `id`, updating it as you go:

```json
{
  "current": "q1",
  "items": {
    "q1": {
      "status": "working",
      "message": "reconciling against 42 existing steps",
      "detail": ["3 steps reused", "1 new step needed"],
      "file": "features/cart.feature",
      "steps": { "reuse": 3, "new": 1, "healed": 0 }
    }
  }
}
```

`status` is one of `queued`, `working`, `done`, `error`. Only `status` is required;
everything else enriches the widget's detail panel. Drain one scenario at a time and
re-read the queue before finishing — more may have been added while you worked.
