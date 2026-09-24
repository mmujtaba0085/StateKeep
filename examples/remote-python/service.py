"""
Example StateKeep implementation service in Python (standard library only).

StateKeep calls this service for guards and actions that are not implemented in
JavaScript. Run it, then start StateKeep with:

    STATEKEEP_REMOTE_URL=http://127.0.0.1:8088/statekeep
    STATEKEEP_REMOTE_SECRET=<same secret as below>

    python3 service.py            # listens on 127.0.0.1:8088
"""
import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ.get("STATEKEEP_REMOTE_SECRET", "change-me").encode()
PORT = int(os.environ.get("PORT", "8088"))
MAX_SKEW_MS = 5 * 60 * 1000   # reject replayed requests older than 5 minutes
CALLS = []                    # visible via GET /statekeep/_calls (for the demo/tests)


# ── Your business logic ──────────────────────────────────────────────────────
def is_credit_ok(req):
    """Guard: approve automatically only below 1,000,000 and with no defaults."""
    ctx = req.get("context") or {}
    return ctx.get("amount", 0) < 1_000_000 and not ctx.get("hasDefaults", False)


def send_offer(req):
    """Action: e.g. generate an offer letter; report back with a follow-up event."""
    offer_id = "OFF-" + (req.get("actorId") or "x")[:8]
    return {"send": {"type": "OFFER_SENT", "offerId": offer_id}}


GUARDS = {"isCreditOk": is_credit_ok}
ACTIONS = {"sendOffer": send_offer}


# ── Protocol plumbing ────────────────────────────────────────────────────────
def verify(headers, body: bytes) -> bool:
    ts = headers.get("X-StateKeep-Timestamp", "")
    sig = headers.get("X-StateKeep-Signature", "")
    if not ts.isdigit() or abs(time.time() * 1000 - int(ts)) > MAX_SKEW_MS:
        return False
    expected = "sha256=" + hmac.new(SECRET, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/statekeep/_calls":
            return self._reply(200, CALLS)
        if not verify(self.headers, b""):
            return self._reply(401, {"error": "bad signature"})
        if self.path == "/statekeep/manifest":
            return self._reply(200, {"guards": list(GUARDS), "actions": list(ACTIONS)})
        self._reply(404, {"error": "not found"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not verify(self.headers, body):
            return self._reply(401, {"error": "bad signature"})
        req = json.loads(body or b"{}")
        parts = self.path.strip("/").split("/")          # statekeep/<kind>/<name>
        if len(parts) != 3 or parts[0] != "statekeep":
            return self._reply(404, {"error": "not found"})
        kind, name = parts[1], parts[2]
        CALLS.append({"kind": kind, "name": name, "actorId": req.get("actorId")})
        if kind == "guards" and name in GUARDS:
            return self._reply(200, {"result": bool(GUARDS[name](req))})
        if kind == "actions" and name in ACTIONS:
            return self._reply(200, ACTIONS[name](req) or {})
        self._reply(404, {"error": f"unknown {kind} {name}"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
