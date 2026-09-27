"""
Fault-injecting implementation service for test/chaos/simulate.mjs.

Each case's context carries `faults`: a list with one fault per attempt of its action
(attempt 1, 2, 3 …; beyond the list → "ok"). Attempt numbers survive service restarts
(ATTEMPTS_FILE), so a crash can't make a fault repeat forever.

Faults
  ok             effect, answer
  slow           sleep 0.3–1.0 s (below StateKeep's timeout), effect, answer
  late_success   sleep past the timeout, THEN effect (StateKeep has given up on the call)
  hang_no_effect sleep past the timeout, raise (nothing happened)
  crash_before   the whole service dies before the effect (os._exit)
  crash_after    the whole service dies right after the effect, before answering
  error_4xx      raise immediately (reported failure, nothing happened)

Ground truth for the checker: BANK_FILE (charge/refund) + EFFECTS_FILE (notify/sms),
one line per real side effect, written in the same write as the effect itself.
"""
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdks", "python"))
from statekeep import ImplementationService  # noqa: E402

svc = ImplementationService(os.environ["STATEKEEP_REMOTE_SECRET"], job_store=os.environ["JOB_STORE"])
EFFECTS = os.environ["EFFECTS_FILE"]
ATTEMPTS = os.environ["ATTEMPTS_FILE"]
BANK = os.environ["BANK_FILE"]
PAST_TIMEOUT = float(os.environ.get("PAST_TIMEOUT_S", "2.2"))


def _append(path, obj):
    with open(path, "a") as f:
        f.write(json.dumps(obj) + "\n")
        f.flush()
        os.fsync(f.fileno())


def _lines(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(x) for x in f if x.strip()]


def attempt_no(job, actor=None, faults=()):
    n = sum(1 for a in _lines(ATTEMPTS) if a["job"] == job) + 1
    fault = faults[n - 1] if n - 1 < len(faults) else "ok"
    _append(ATTEMPTS, {"job": job, "actorId": actor, "n": n, "fault": fault, "at": time.time()})
    return n


def run(kind, req, effect_fn):
    ctx = req.get("context") or {}
    job = req["jobId"]
    faults = ctx.get("faults") or []
    n = attempt_no(job, req.get("actorId"), faults)
    fault = faults[n - 1] if n - 1 < len(faults) else "ok"
    if fault == "error_4xx":
        raise RuntimeError("injected: rejected")
    if fault == "crash_before":
        os._exit(3)
    if fault == "hang_no_effect":
        time.sleep(PAST_TIMEOUT)
        raise TimeoutError("injected: hung, nothing done")
    if fault == "slow":
        time.sleep(random.uniform(0.3, 1.0))
    if fault == "late_success":
        time.sleep(PAST_TIMEOUT)
    # The effect and its ground-truth record are ONE write (a SIGKILL can land anywhere):
    # the bank line for charge/refund, the EFFECTS line for notify/sms.
    effect_fn({"kind": kind, "actorId": req.get("actorId"), "job": job, "attempt": n, "fault": fault})
    if fault == "crash_after":
        os._exit(4)


def bank_once(record):
    """An external system that dedupes on an idempotency key (like Stripe)."""
    if any(r["job"] == record["job"] and r["kind"] == record["kind"] for r in _lines(BANK)):
        return False
    _append(BANK, record)
    return True


def plain_effect(record):
    """A system with no dedupe: every call is a real effect."""
    _append(EFFECTS, record)


@svc.action("chargeCard", delivery="idempotent")
def charge(req):
    run("charge", req, bank_once)
    return {"send": {"type": "CHARGED"}}


# verify with a verifier that asks the "bank"
@svc.action("refundOrder", delivery="verify")
def refund(req):
    run("refund", req, bank_once)
    return {"send": {"type": "REFUNDED"}}


@svc.verifier("refundOrder")
def refund_happened(req):
    done = any(r["kind"] == "refund" and r["job"] == req["jobId"] for r in _lines(BANK))
    return {"send": {"type": "REFUNDED"}} if done else False


# verify answered by the SDK's job store
@svc.action("notifyPartner")
def notify(req):
    run("notify", req, plain_effect)
    return {"send": {"type": "NOTIFIED"}}


# at-most-once: no dedupe, no lookup
@svc.action("sendSms", delivery="at-most-once")
def sms(req):
    run("sms", req, plain_effect)
    return {"send": {"type": "SMS_SENT"}}


# Diagnostics: every request as it arrives, and what the SDK answered.
REQUESTS = os.environ.get("REQUESTS_FILE")
_handle = svc.handle


def _logged_handle(method, path, headers, raw_body, prefix=""):
    t0 = time.time()
    try:
        body = json.loads(raw_body or b"{}")
    except ValueError:
        body = {}
    if REQUESTS and method == "POST":
        _append(REQUESTS, {"arrived": path, "job": body.get("jobId"), "actorId": body.get("actorId"),
                           "rerunApproved": bool(body.get("rerunApproved")), "t0": t0, "pid": os.getpid()})
    status, out = _handle(method, path, headers, raw_body, prefix)
    if REQUESTS and method == "POST":
        _append(REQUESTS, {"path": path, "job": body.get("jobId"), "actorId": body.get("actorId"),
                           "rerunApproved": bool(body.get("rerunApproved")), "status": status,
                           "answer": out if status != 200 else None, "t0": t0, "t1": time.time(), "pid": os.getpid()})
    return status, out


svc.handle = _logged_handle

if __name__ == "__main__":
    svc.serve(port=int(os.environ["PORT"]))
