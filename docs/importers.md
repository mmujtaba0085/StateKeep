# Importing Step Functions, SCXML and BPMN

Bring existing workflows over — and get history-based version migration for them.

```bash
statekeep import order.scxml --out order.json          # offline conversion
statekeep import loan.asl.json --deploy loan-v1         # convert + deploy
curl -X POST $URL/v1/definitions/import -d '{"source": "<scxml …>"}'   # API: returns definition + warnings
```

The format is detected automatically (`--format asl|scxml|bpmn` to force it).
Samples: `examples/imports/`.

## How constructs map

| Source | StateKeep |
|---|---|
| ASL `Task`, BPMN `serviceTask`/`scriptTask`/`sendTask` | state with an entry action named after the resource/implementation, waiting for `DONE` (or `FAILED` → ASL `Catch`) |
| BPMN `userTask`/`manualTask` | state waiting for `DONE` (a person completes it) |
| ASL `Choice`, BPMN exclusive gateway, SCXML `cond` | eventless (`always`) transitions with `cond:` guards |
| ASL `Wait` (Seconds), BPMN timer (ISO duration) | `after` timer |
| BPMN message catch / receive task | event named after the message |
| ASL `Succeed`/`Fail`, BPMN end event, SCXML `final` | final state |
| SCXML nested `state`/`parallel`/`initial` | nested / parallel states |

Actions can be JavaScript or a remote service in any language (docs/remote-implementations.md);
the service reports completion by replying `{ "send": { "type": "DONE", ... } }` — the fields it
sends are merged into the context before the next Choice/gateway is evaluated.

## `cond:` guards

Built-in expression guards, usable in any definition:
`cond:score >= 700 && amount < 1000000`, `cond:status == "approved"`, `cond:event.retry != true`.
Comparisons, `&& || !`, parentheses, numbers, strings, `true/false/null`; paths read the context
(or `event.` / `context.` explicitly). No function calls, no prototype access. Invalid expressions
are rejected at deploy (422).

## Not imported (reported as warnings)

ASL `Parallel`/`Map` (run as one step), `Retry` (durable actions already retry), non-trivial
conditions (a named guard is generated for you to implement); SCXML `onentry`/`onexit`/`invoke`/
`datamodel`; BPMN parallel gateways and boundary events.
