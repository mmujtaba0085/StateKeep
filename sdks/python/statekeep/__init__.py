"""
StateKeep Python SDK — standard library only (Python 3.9+).

    from statekeep import Client
    sk = Client("http://localhost:3001", api_key="sk_live_...")
    sk.deploy("loan-v1", {"id": "loan", "initial": "draft", "states": {...}})
    actor = sk.spawn("loan", {"amount": 50000})
    sk.send(actor["id"], "SUBMIT", {"documents": 3})

Remote guards/actions (docs/remote-implementations.md):

    from statekeep import ImplementationService
    svc = ImplementationService(secret="...")

    @svc.guard("isCreditOk")
    def is_credit_ok(req): return req["context"]["amount"] < 1_000_000

    @svc.action("sendOffer")
    def send_offer(req): return {"send": {"type": "OFFER_SENT", "offerId": "OFF-1"}}

    svc.serve(port=8088, prefix="/statekeep")
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional

__all__ = ["Client", "StateKeepError", "ImplementationService", "verify_webhook", "sign"]
__version__ = "0.1.0"


class StateKeepError(Exception):
    """Non-2xx response. `status`, `code` (e.g. ACTOR_TERMINATED) and `body` are set."""

    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        self.code = body.get("code") if isinstance(body, dict) else None
        msg = body.get("error") or body.get("message") if isinstance(body, dict) else str(body)
        super().__init__(f"HTTP {status}: {msg}")


class Client:
    def __init__(self, url: str = "http://localhost:3001", api_key: Optional[str] = None, timeout: float = 30.0):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    # ── transport ────────────────────────────────────────────────────────────
    def _request(self, method: str, path: str, body: Any = None, query: Optional[dict] = None) -> Any:
        url = self.url + path
        if query:
            q = {k: v for k, v in query.items() if v is not None}
            if q:
                url += "?" + urllib.parse.urlencode(q)
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.api_key:
            req.add_header("X-API-Key", self.api_key)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = {"error": raw.decode(errors="replace")}
            raise StateKeepError(e.code, parsed) from None

    @staticmethod
    def _q(s: str) -> str:
        return urllib.parse.quote(s, safe="")

    # ── health ───────────────────────────────────────────────────────────────
    def health(self) -> dict:
        return self._request("GET", "/v1/health")

    # ── definitions ──────────────────────────────────────────────────────────
    def validate(self, definition: dict) -> dict:
        return self._request("POST", "/v1/definitions/validate", {"definition": definition})

    def deploy(self, id: str, definition: dict, parent_id: Optional[str] = None,
               history_path: Optional[List[str]] = None, state_mapping: Optional[Dict[str, str]] = None,
               context_transform: Optional[Dict[str, str]] = None, confirm_token: Optional[str] = None) -> dict:
        body = {"id": id, "definition": definition, "parentId": parent_id, "historyPath": history_path,
                "stateMapping": state_mapping, "contextTransform": context_transform, "confirmToken": confirm_token}
        return self._request("PUT", "/v1/definitions", {k: v for k, v in body.items() if v is not None})

    def preview(self, parent_id: str, definition: dict, history_path: Optional[List[str]] = None,
                state_mapping: Optional[Dict[str, str]] = None) -> dict:
        body = {"parentId": parent_id, "definition": definition, "historyPath": history_path, "stateMapping": state_mapping}
        return self._request("POST", "/v1/definitions/preview", {k: v for k, v in body.items() if v is not None})

    def import_definition(self, source: Any, format: Optional[str] = None, id: Optional[str] = None) -> dict:
        body = {"source": source, "format": format, "id": id}
        return self._request("POST", "/v1/definitions/import", {k: v for k, v in body.items() if v is not None})

    def get_definition(self, id: str) -> dict:
        return self._request("GET", f"/v1/definitions/{self._q(id)}")

    def list_definitions(self, limit: int = 50, offset: int = 0) -> dict:
        return self._request("GET", "/v1/definitions", query={"limit": limit, "offset": offset})

    # ── actors ───────────────────────────────────────────────────────────────
    def spawn(self, definition_id: str, context: Optional[dict] = None) -> dict:
        return self._request("POST", "/v1/actors", {"definitionId": definition_id, "initialContext": context or {}})

    def send(self, actor_id: str, type: str, payload: Optional[dict] = None,
             idempotency_key: Optional[str] = None) -> dict:
        body = {"type": type, "payload": payload, "idempotencyKey": idempotency_key}
        return self._request("POST", f"/v1/actors/{self._q(actor_id)}/event", {k: v for k, v in body.items() if v is not None})

    def get(self, actor_id: str) -> dict:
        return self._request("GET", f"/v1/actors/{self._q(actor_id)}")

    def events(self, actor_id: str, limit: int = 50) -> dict:
        return self._request("GET", f"/v1/actors/{self._q(actor_id)}/events", query={"limit": limit})

    def decisions(self, actor_id: str) -> dict:
        return self._request("GET", f"/v1/actors/{self._q(actor_id)}/decisions")

    def terminate(self, actor_id: str) -> dict:
        return self._request("DELETE", f"/v1/actors/{self._q(actor_id)}")

    def list_actors(self, status: Optional[str] = None, definition_id: Optional[str] = None,
                    limit: int = 50, offset: int = 0) -> dict:
        return self._request("GET", "/v1/actors", query={"status": status, "definitionId": definition_id,
                                                          "limit": limit, "offset": offset})

    def needs_rescue(self, limit: int = 50) -> dict:
        return self._request("GET", "/v1/actors/needs-rescue", query={"limit": limit})

    # ── scheduling ───────────────────────────────────────────────────────────
    def schedule(self, actor_id: str, type: str, fire_at_ms: int, payload: Optional[dict] = None) -> dict:
        body = {"type": type, "fireAt": fire_at_ms, "payload": payload}
        return self._request("POST", f"/v1/actors/{self._q(actor_id)}/schedule", {k: v for k, v in body.items() if v is not None})

    def cancel_schedule(self, actor_id: str, schedule_id: str) -> Any:
        return self._request("DELETE", f"/v1/actors/{self._q(actor_id)}/schedule/{self._q(schedule_id)}")

    # ── webhooks ─────────────────────────────────────────────────────────────
    def create_webhook(self, url: str, secret: str, events: List[str]) -> dict:
        return self._request("POST", "/v1/webhooks", {"url": url, "secret": secret, "events": events})

    def delete_webhook(self, webhook_id: str) -> Any:
        return self._request("DELETE", f"/v1/webhooks/{self._q(webhook_id)}")


# ── Signatures ──────────────────────────────────────────────────────────────
def verify_webhook(secret: str, raw_body: bytes, signature_header: str) -> bool:
    """Verify X-StateKeep-Signature on a webhook delivery (sha256=HMAC(secret, body))."""
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header or "")


def sign(secret: str, timestamp: str, raw_body: bytes) -> str:
    """Signature StateKeep puts on remote-implementation calls."""
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()


# ── Remote implementations ──────────────────────────────────────────────────
class ImplementationService:
    """Serve guards and actions for StateKeep (see docs/remote-implementations.md)."""

    def __init__(self, secret: str, max_skew_ms: int = 5 * 60 * 1000):
        self.secret = secret
        self.max_skew_ms = max_skew_ms
        self.guards: Dict[str, Callable[[dict], bool]] = {}
        self.actions: Dict[str, Callable[[dict], Optional[dict]]] = {}

    def guard(self, name: str):
        def deco(fn):
            self.guards[name] = fn
            return fn
        return deco

    def action(self, name: str):
        def deco(fn):
            self.actions[name] = fn
            return fn
        return deco

    def verify(self, headers, raw_body: bytes) -> bool:
        ts = headers.get("X-StateKeep-Timestamp", "")
        if not ts.isdigit() or abs(time.time() * 1000 - int(ts)) > self.max_skew_ms:
            return False
        return hmac.compare_digest(sign(self.secret, ts, raw_body), headers.get("X-StateKeep-Signature", ""))

    def handle(self, method: str, path: str, headers, raw_body: bytes, prefix: str = ""):
        """Framework-agnostic handler → (status, json_body). Use it from Flask/FastAPI/Django too."""
        if not self.verify(headers, raw_body):
            return 401, {"error": "bad signature"}
        rel = path[len(prefix):] if prefix and path.startswith(prefix) else path
        parts = [p for p in rel.split("/") if p]
        if method == "GET" and parts == ["manifest"]:
            return 200, {"guards": list(self.guards), "actions": list(self.actions)}
        if method == "POST" and len(parts) == 2:
            kind, name = parts[0], urllib.parse.unquote(parts[1])
            req = json.loads(raw_body or b"{}")
            if kind == "guards" and name in self.guards:
                return 200, {"result": bool(self.guards[name](req))}
            if kind == "actions" and name in self.actions:
                return 200, self.actions[name](req) or {}
        return 404, {"error": "not found"}

    def serve(self, host: str = "127.0.0.1", port: int = 8088, prefix: str = "/statekeep"):
        svc = self

        class H(BaseHTTPRequestHandler):
            def _go(self, method):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
                status, obj = svc.handle(method, self.path, self.headers, body, prefix)
                data = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._go("GET")

            def do_POST(self):
                self._go("POST")

            def log_message(self, *a):
                pass

        server = ThreadingHTTPServer((host, port), H)
        server.serve_forever()
