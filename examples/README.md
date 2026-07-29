# Example recording

[`example-session.jsonl`](example-session.jsonl) is real recorder output — produced by driving
the actual CLI against a synthetic "Orders" page, not hand-written. Read it to understand the
format before wiring up your own project.

The flow demonstrated: *approve the first pending order.*

```
seq  1  marker  session-start        recorder attached, idle
seq  2  marker  recording-start      ⏺  "approve the first pending order" @ /orders
seq  3  note                         ✎  "the toast is slow — wait for it, do not sleep"
seq  4  click   "Pending"                filter button (data-testid candidate)
seq  5  type    "Starbucks"               search field, debounced final value
seq  6  select  "Pending"                 status dropdown
seq  7  click   "Approve"                 the action under test
seq  8  assert  predicate=row         ⌥  expected ["Starbucks","42.00","Pending"], row 1 of 2
seq  9  assert  predicate=text        ⌥  expected "Pending", with row context
seq 10  marker  recording-stop        ⏹  + snapshot of final field values
seq 11  marker  create-scenario       ⚡  handed to the agent
seq 12  marker  session-end
```

Three things worth noticing:

1. **A click before ⏺ is missing from the stream.** The session began with a click on the
   Orders tab while idle — it isn't there. That navigation is meant to come from a step your
   framework already has, not from capture.
2. **Two different assert predicates.** `seq 8` checks the whole row; `seq 9` checks one cell's
   text. A converter that flattened both into text checks would silently produce a weaker test
   than the one that was demonstrated.
3. **The note is intent, not an action.** *"the toast is slow — wait for it, do not sleep"* is
   the tester telling the converter how to handle timing. That instruction exists nowhere in
   the DOM and no purely mechanical recorder could capture it.

Every interaction event carries 3–7 selector candidates. Inspect one:

```bash
node -e 'const l=require("fs").readFileSync("examples/example-session.jsonl","utf8").trim().split("\n").map(JSON.parse); console.log(JSON.stringify(l.find(e=>e.kind==="click"),null,2))'
```

To regenerate or produce your own, see the recording steps in the [README](../README.md#quick-start).
