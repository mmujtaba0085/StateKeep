"""
Side-effect delivery modes, one action each (docs/side-effects.md).

  chargeCard     idempotent    the "bank" dedupes on the job id (like Stripe's Idempotency-Key)
  refundOrder    verify        after a crash StateKeep asks; @verifier checks the bank's records
  notifyPartner  verify        default with a durable job store: the SDK's store answers
  sendSms        at-most-once  the SMS gateway has no dedupe and no lookup: never repeated

The "bank" and "SMS gateway" are JSON-lines files so the test can count real effects:
BANK_FILE (charges/refunds by key) and EFFECTS_FILE (every effect performed).
Test hooks in the actor context: slowMs, crashAfterEffect, hangFirstAttempt.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdks", "python"))
from statekeep import ImplementationService  # noqa: E402

svc = ImplementationService(os.environ.get("STATEKEEP_REMOTE_SECRET", "change-me"),
                            job_store=os.environ.get("PAY_JOB_STORE", "payments-jobs.sqlite"))
BANK = os.environ.get("BANK_FILE", "bank.jsonl")
EFFECTS = os.environ.get("EFFECTS_FILE", "effects.jsonl")
_seen_attempts = set()


def _lines(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def _append(path, obj):
    with open(path, "a") as f:
        f.write(json.dumps(obj) + "\n")
        f.flush()
        os.fsync(f.fileno())


def effect(kind, req):
    _append(EFFECTS, {"kind": kind, "actorId": req.get("actorId"), "jobId": req.get("jobId")})


def hooks(req):
    ctx = req.get("context") or {}
    if ctx.get("crashFirstAttempt") and not req.get("rerunApproved"):
        os._exit(5)                                           # dies mid-call: the job store says "started"
    if ctx.get("hangFirstAttempt") and req.get("jobId") not in _seen_attempts:
        _seen_attempts.add(req.get("jobId"))
        time.sleep(ctx["hangFirstAttempt"] / 1000)          # simulate a lost request: no effect, no answer
        raise TimeoutError("hung")
    time.sleep((ctx.get("slowMs") or 0) / 1000)
    return ctx


# ── The "bank": an external system that dedupes on an idempotency key ────────
def bank(op, key, amount):
    if any(r["key"] == key for r in _lines(BANK)):
        return "duplicate ignored"
    _append(BANK, {"op": op, "key": key, "amount": amount})
    return "ok"


@svc.action("chargeCard", delivery="idempotent")
def charge_card(req):
    ctx = hooks(req)
    if bank("charge", req["jobId"], ctx.get("amount", 0)) == "ok":   # the job id IS the idempotency key
        effect("charge", req)
    return {"send": {"type": "CHARGED"}}


@svc.action("refundOrder", delivery="verify")
def refund_order(req):
    ctx = hooks(req)
    bank("refund", req["jobId"], ctx.get("amount", 0))
    effect("refund", req)
    if ctx.get("crashAfterEffect"):
        os._exit(1)                                            # the service dies before answering
    return {"send": {"type": "REFUNDED"}}


@svc.verifier("refundOrder")
def refund_happened(req):
    done = any(r["op"] == "refund" and r["key"] == req["jobId"] for r in _lines(BANK))
    return {"send": {"type": "REFUNDED"}} if done else False


@svc.action("notifyPartner")                                   # verify via the SDK's job store
def notify_partner(req):
    hooks(req)
    effect("notify", req)
    return {"send": {"type": "NOTIFIED"}}


@svc.action("sendSms", delivery="at-most-once")
def send_sms(req):
    hooks(req)
    effect("sms", req)
    return {"send": {"type": "SMS_SENT"}}


if __name__ == "__main__":
    svc.serve(port=int(os.environ.get("PORT", "8120")))
