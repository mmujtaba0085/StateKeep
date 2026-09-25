"""
AI agent session backed by StateKeep — the model and the tools, in Python.

StateKeep holds the session (state, transcript, pending approval) durably; this
service is stateless. Each step is a remote action:

  callModel     → decides the next step: reply, or request a tool
  callModelV2   → same, with the v2 prompt (the prompt version is part of the flow version)
  runTool       → executes the requested tool (lookup_order, issue_refund)

Run:  STATEKEEP_REMOTE_SECRET=... PORT=8099 python3 agent_service.py
Then: STATEKEEP_REMOTE_URL=http://127.0.0.1:8099/statekeep on the StateKeep server.

The model here is a deterministic stand-in so the example runs offline and in CI.
Replace `model()` with a call to your LLM (your LLM provider, etc.): give it PROMPTS[version],
the transcript and the tool list, and map its answer to {"reply": ...} or
{"tool": ..., "args": {...}}. Nothing else changes.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdks", "python"))
from statekeep import ImplementationService  # noqa: E402

# job_store: a file that remembers every tool call, so after a crash StateKeep can ask
# "did this happen?" instead of guessing (docs/side-effects.md)
svc = ImplementationService(os.environ.get("STATEKEEP_REMOTE_SECRET", "change-me"),
                            job_store=os.environ.get("AGENT_JOB_STORE", "agent-jobs.sqlite"))
SIDE_EFFECTS = os.environ.get("AGENT_LOG")      # append-only record of real side effects (tests read it)

PROMPTS = {
    "v1": "You are a support agent. Use tools to look up orders and issue refunds.",
    "v2": "You are a support agent. Be brief. Always quote the order id. Refunds need a reason.",
}
TOOLS = {"lookup_order", "issue_refund"}


def record(kind, **fields):
    if SIDE_EFFECTS:
        with open(SIDE_EFFECTS, "a") as f:
            f.write(json.dumps({"kind": kind, **fields}) + "\n")


# ── The "model" ──────────────────────────────────────────────────────────────
def model(version, transcript, ctx, trigger):
    """Return {"reply": str} or {"tool": name, "args": {...}}. `trigger` is the event that woke the model."""
    tag = "" if version == "v1" else "[v2] "
    if trigger == "DENY":
        return {"reply": f"{tag}Sorry — the refund was not approved ({ctx.get('reason') or 'no reason given'})."}
    if trigger == "TOOL_RESULT":
        return {"reply": f"{tag}Done: {ctx['toolResult']}"}
    last = next((m["text"] for m in reversed(transcript) if m["role"] == "user"), "")
    order = (re.search(r"#(\d+)", last) or [None, "unknown"])[1]
    if "refund" in last.lower():
        amount = int((re.search(r"\$(\d+)", last) or [None, "0"])[1])
        return {"tool": "issue_refund", "args": {"orderId": order, "amount": amount}}
    if "where" in last.lower() or "status" in last.lower():
        return {"tool": "lookup_order", "args": {"orderId": order}}
    return {"reply": f"{tag}How can I help with your order?"}


def step(version, req):
    ctx = req.get("context") or {}
    transcript = list(ctx.get("transcript") or [])
    trigger = (req.get("event") or {}).get("type")
    if trigger == "USER_MESSAGE" and ctx.get("message"):
        transcript.append({"role": "user", "text": ctx["message"]})
    decision = model(version, transcript, ctx, trigger)
    record("model", version=version, actorId=req.get("actorId"))
    clear = {"toolResult": None, "reason": None, "message": None}
    if "tool" in decision:
        transcript.append({"role": "assistant", "tool": decision["tool"], "args": decision["args"]})
        return {"send": {"type": "TOOL_REQUEST", "tool": decision["tool"], "args": decision["args"],
                         "transcript": transcript, **clear}}
    transcript.append({"role": "assistant", "text": decision["reply"]})
    return {"send": {"type": "REPLY", "lastReply": decision["reply"], "transcript": transcript,
                     "tool": None, "args": None, **clear}}


@svc.action("callModel")
def call_model(req):
    return step("v1", req)


@svc.action("callModelV2")
def call_model_v2(req):
    return step("v2", req)


@svc.action("runTool")
def run_tool(req):
    ctx = req.get("context") or {}
    tool, args = ctx.get("tool"), ctx.get("args") or {}
    record("tool_call", actorId=req.get("actorId"), jobId=req.get("jobId"), tool=tool)
    if tool not in TOOLS:
        return {"send": {"type": "TOOL_RESULT", "toolResult": f"unknown tool {tool}"}}
    if tool == "issue_refund":
        record("refund", actorId=req.get("actorId"), jobId=req.get("jobId"), **args)
        result = f"refunded ${args.get('amount')} on order {args.get('orderId')}"
    else:
        if args.get("orderId") == os.environ.get("AGENT_SLOW_ORDER"):   # test hook: a slow tool
            time.sleep(2)
        result = f"order {args.get('orderId')} is in transit"
    return {"send": {"type": "TOOL_RESULT", "toolResult": result}}


if __name__ == "__main__":
    svc.serve(port=int(os.environ.get("PORT", "8099")))
