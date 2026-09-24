# AI agent sessions

An agent session (chat → model → tool call → human approval → tool → reply) is a
long-running workflow. Run it as a StateKeep actor and you get, without extra code:

| Need | How StateKeep covers it |
|---|---|
| Session survives crashes and deploys | State, transcript and the pending step are committed before an event is acknowledged |
| Tool calls with retries | Tools are remote *actions*: queued in the same transaction as the transition, retried with backoff |
| No double side effects | Each action call carries a `jobId`; the Python SDK replays the first result on a retry |
| Human in the loop | A normal state (`awaiting_approval`) — the session waits days if needed, costs nothing |
| Policy as data | "Refunds ≥ $50 need approval" is a `cond:` guard in the definition, reviewable in a PR |
| Upgrading prompts/policies for sessions already running | Deploy a new version with `parentId`; live sessions move, keeping their place and transcript. `historyPath` can target only sessions that took a particular path |
| Audit | Every model step, tool request, approval and denial is an event in the actor's history |

## Example: `examples/agent/`

- `agent_service.py` — the model and the tools (Python, via the SDK's `ImplementationService`).
  The model is a deterministic stand-in so the example runs offline; replace `model()`
  with your LLM call.
- `support-agent.v1.json` — every refund needs approval.
- `support-agent.v2.json` — new prompt (`callModelV2`), the approval state renamed to
  `pending_approval`, and refunds under $50 are automatic.

```
idle ──USER_MESSAGE──▶ thinking (callModel)
                         │ REPLY ─────────────▶ idle
                         │ TOOL_REQUEST (refund) ▶ awaiting_approval ─APPROVE─▶ running_tool (runTool) ─TOOL_RESULT─▶ thinking
                         │ TOOL_REQUEST (other)  ▶ running_tool                └DENY─▶ thinking
```

```bash
STATEKEEP_REMOTE_SECRET=s PORT=8099 python3 examples/agent/agent_service.py &
STATEKEEP_REMOTE_URL=http://127.0.0.1:8099/statekeep STATEKEEP_REMOTE_SECRET=s npm start &
npm run migrate-worker &

sk() { curl -s -H 'content-type: application/json' "$@"; }
sk -X PUT localhost:3001/v1/definitions -d "{\"id\":\"support-agent-v1\",\"definition\":$(cat examples/agent/support-agent.v1.json)}"
ID=$(sk -X POST localhost:3001/v1/actors -d '{"definitionId":"support-agent-v1"}' | jq -r .id)
sk -X POST localhost:3001/v1/actors/$ID/event -d '{"type":"USER_MESSAGE","payload":{"message":"refund $80 on order #1234"}}'
sk localhost:3001/v1/actors/$ID | jq .stateValue          # "awaiting_approval"
sk -X POST localhost:3001/v1/actors/$ID/event -d '{"type":"APPROVE"}'
sk localhost:3001/v1/actors/$ID | jq .context.lastReply   # "Done: refunded $80 on order 1234"

# Roll out the new prompt and policy to every live session, including ones waiting for approval:
sk -X PUT localhost:3001/v1/definitions -d "{\"id\":\"support-agent-v2\",\"parentId\":\"support-agent-v1\",
  \"stateMapping\":{\"awaiting_approval\":\"pending_approval\"},\"definition\":$(cat examples/agent/support-agent.v2.json)}"
```

Tested in `test/test_agent_sessions.js`: approval then exactly one refund; lookups skip
approval; denial; a session waiting for approval survives `kill -9` of the server;
live sessions (one waiting for approval, one mid-conversation) move to v2 and continue
with the new prompt, and new sessions get the new policy.

## Limits

- Actions are at-least-once. The SDK's dedupe is in memory; if the implementation
  service itself can restart mid-call, store `jobId` results in your database.
- The model's output is carried as event payloads merged into context — keep large
  artifacts (documents, embeddings) elsewhere and store references.
- Token streaming to the end user is outside StateKeep; stream from your service and
  report the final message as the `REPLY` event.
