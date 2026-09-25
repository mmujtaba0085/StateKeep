# StateKeep — Python SDK

Standard library only (Python 3.9+). Copy `statekeep/` into your project or add this folder to `PYTHONPATH`.

```python
from statekeep import Client, StateKeepError
sk = Client("http://localhost:3001", api_key="sk_live_...")
sk.deploy("loan-v1", {"id": "loan", "initial": "draft", "states": {...}})
a = sk.spawn("loan", {"amount": 50000})
sk.send(a["id"], "SUBMIT", {"documents": 3})       # payload merges into context
try:
    sk.send(a["id"], "SUBMIT")
except StateKeepError as e:
    if e.code == "ACTOR_TERMINATED": ...
```

Serve guards/actions to StateKeep (docs/remote-implementations.md):

```python
from statekeep import ImplementationService
svc = ImplementationService(secret=os.environ["STATEKEEP_REMOTE_SECRET"])

@svc.guard("isCreditOk")
def is_credit_ok(req): return req["context"]["amount"] < 1_000_000

@svc.action("sendOffer")
def send_offer(req): return {"send": {"type": "OFFER_SENT", "offerId": "OFF-1"}}

svc.serve(port=8088, prefix="/statekeep")   # or call svc.handle(...) from Flask/FastAPI
```

Also: `preview`, `import_definition`, `events`, `schedule`, `create_webhook`, `verify_webhook`.
Tests: `STATEKEEP_URL=http://localhost:3001 python3 -m unittest discover -s tests`.

## Side effects: never silently repeated

```python
svc = ImplementationService(secret, job_store="jobs.sqlite")   # remembers every job

@svc.action("chargeCard", delivery="idempotent")   # retried; pass req["jobId"] downstream as the idempotency key
@svc.action("refundOrder")                          # 'verify' (default with a job store)
@svc.verifier("refundOrder")                        # optional: answer "did job X happen?" from the real system
@svc.action("sendSms", delivery="at-most-once")     # never repeated; a human decides
```

Raising from an action means "it did not happen", so StateKeep may retry. See `docs/side-effects.md`.
