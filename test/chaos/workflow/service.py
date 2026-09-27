"""
Generic implementation service for the workflow chaos simulation.

The actions (names, delivery mode, follow-up event) come from ACTIONS_FILE, written by
the simulator for the workflows it generated. Every action performs one side effect and
reports its follow-up event. Faults are injected per attempt from the actor's context:
context._faults[action] = ["crash_after", "ok", ...] (see test/chaos/chaos_service.py).

Ground truth (one line per real effect, written in the same write as the effect):
  idempotent actions   -> LEDGER_FILE, deduplicated on the job id (like Stripe)
  verify actions       -> LEDGER_FILE too; the verifier reads it
  at-most-once actions -> EFFECTS_FILE (no dedupe, no lookup)
"""
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "sdks", "python"))
from statekeep import ImplementationService  # noqa: E402

svc = ImplementationService(os.environ["STATEKEEP_REMOTE_SECRET"], job_store=os.environ["JOB_STORE"])
ACTIONS = json.load(open(os.environ["ACTIONS_FILE"]))
LEDGER, EFFECTS, ATTEMPTS = os.environ["LEDGER_FILE"], os.environ["EFFECTS_FILE"], os.environ["ATTEMPTS_FILE"]
PAST_TIMEOUT = float(os.environ.get("PAST_TIMEOUT_S", "2.2"))
# A generated workflow can loop: the follow-up re-enters a state whose entry runs the
# same action again, forever. Like a real service that stops after a few tries, each
# actor gets a follow-up for its first MAX_FOLLOWUPS jobs of an action; later jobs still
# perform the effect but report nothing. Decided per job from the attempts log, so the
# verifier and a re-run give the same answer.
MAX_FOLLOWUPS = int(os.environ.get("MAX_FOLLOWUPS", "3"))


def _append(path, obj):
    with open(path, "a") as f:
        f.write(json.dumps(obj) + "\n")
        f.flush()
        os.fsync(f.fileno())


def _lines(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass            # a line cut by SIGKILL: the effect it described did not complete
    return out


def _answer(name, spec, job, actor_id):
    order = []
    for a in _lines(ATTEMPTS):
        if a["action"] == name and a.get("actorId") == actor_id and a["job"] not in order:
            order.append(a["job"])
    if job in order and order.index(job) >= MAX_FOLLOWUPS:
        return {"ok": True}
    return {"send": {"type": spec["followUp"], "_job": job}}


def make(name, spec):
    def action(req):
        ctx = req.get("context") or {}
        job = req["jobId"]
        n = sum(1 for a in _lines(ATTEMPTS) if a["job"] == job) + 1
        faults = (ctx.get("_faults") or {}).get(name) or []
        fault = faults[n - 1] if n - 1 < len(faults) else "ok"
        _append(ATTEMPTS, {"job": job, "actorId": req.get("actorId"), "action": name, "n": n, "fault": fault, "at": time.time()})
        if fault == "error_4xx":
            raise RuntimeError("injected: rejected")
        if fault == "crash_before":
            os._exit(3)
        if fault == "hang_no_effect":
            time.sleep(PAST_TIMEOUT)
            raise TimeoutError("injected: hung")
        if fault == "slow":
            time.sleep(random.uniform(0.3, 1.0))
        if fault == "late_success":
            time.sleep(PAST_TIMEOUT)
        record = {"job": job, "actorId": req.get("actorId"), "action": name, "attempt": n, "fault": fault}
        if spec["delivery"] == "at-most-once":
            _append(EFFECTS, record)
        elif not any(r["job"] == job for r in _lines(LEDGER)):
            _append(LEDGER, record)
        if fault == "crash_after":
            os._exit(4)
        return _answer(name, spec, job, req.get("actorId"))
    return action


for _name, _spec in ACTIONS.items():
    svc.action(_name, delivery=_spec["delivery"])(make(_name, _spec))
    if _spec["delivery"] == "verify":
        def _verifier(req, _name=_name, _spec=_spec):
            done = any(r["job"] == req["jobId"] for r in _lines(LEDGER))
            return _answer(_name, _spec, req["jobId"], req.get("actorId")) if done else False
        svc.verifier(_name)(_verifier)

if __name__ == "__main__":
    svc.serve(port=int(os.environ["PORT"]))
