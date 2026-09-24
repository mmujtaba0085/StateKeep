"""Integration tests: run with STATEKEEP_URL pointing at a live server (test/test_sdks.js does this)."""
import hashlib
import hmac
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from statekeep import Client, ImplementationService, StateKeepError, sign, verify_webhook  # noqa: E402

URL = os.environ.get("STATEKEEP_URL")
MACHINE = {"id": "pyloan", "initial": "draft", "states": {
    "draft": {"on": {"SUBMIT": "review"}},
    "review": {"on": {"APPROVE": [{"target": "approved", "guard": "cond:amount < 1000000"}, {"target": "manual"}]}},
    "approved": {"type": "final"}, "manual": {"type": "final"}}}


@unittest.skipUnless(URL, "STATEKEEP_URL not set")
class ClientTest(unittest.TestCase):
    sk = Client(URL or "http://x", api_key=os.environ.get("STATEKEEP_API_KEY"))

    @classmethod
    def setUpClass(cls):
        cls.sk.deploy("pyloan-v1", MACHINE)

    def test_lifecycle(self):
        a = self.sk.spawn("pyloan-v1", {"amount": 5000})
        self.assertEqual(a["stateValue"], "draft")
        self.assertEqual(self.sk.send(a["id"], "SUBMIT", {"docs": 2})["stateValue"], "review")
        self.assertEqual(self.sk.get(a["id"])["context"]["docs"], 2)          # payload merged into context
        self.assertEqual(self.sk.send(a["id"], "APPROVE")["stateValue"], "approved")
        self.assertGreaterEqual(self.sk.events(a["id"])["total"], 3)

    def test_errors_are_typed(self):
        a = self.sk.spawn("pyloan-v1", {"amount": 9_000_000})
        self.sk.send(a["id"], "SUBMIT")
        self.assertEqual(self.sk.send(a["id"], "APPROVE")["stateValue"], "manual")
        with self.assertRaises(StateKeepError) as cm:
            self.sk.send(a["id"], "SUBMIT")
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(cm.exception.code, "ACTOR_TERMINATED")
        with self.assertRaises(StateKeepError) as cm:
            self.sk.get("does-not-exist")
        self.assertEqual(cm.exception.status, 404)

    def test_idempotency(self):
        a = self.sk.spawn("pyloan-v1", {"amount": 1})
        self.sk.send(a["id"], "SUBMIT", idempotency_key="py-k1")
        r = self.sk.send(a["id"], "SUBMIT", idempotency_key="py-k1")
        self.assertTrue(r.get("idempotent"))

    def test_preview_and_import(self):
        p = self.sk.preview("pyloan-v1", MACHINE)
        self.assertIn("migration", p)
        imp = self.sk.import_definition('<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="a">'
                                        '<state id="a"><transition event="GO" target="b"/></state><final id="b"/></scxml>')
        self.assertEqual(imp["format"], "scxml")
        self.assertTrue(imp["valid"])


class OfflineTest(unittest.TestCase):
    def test_signatures(self):
        body = b'{"x":1}'
        sig = "sha256=" + hmac.new(b"s", body, hashlib.sha256).hexdigest()
        self.assertTrue(verify_webhook("s", body, sig))
        self.assertFalse(verify_webhook("s", body, "sha256=bad"))

    def test_implementation_service(self):
        svc = ImplementationService(secret="sec")

        @svc.guard("big")
        def big(req):
            return req["context"]["amount"] > 10

        @svc.action("notify")
        def notify(req):
            return {"send": {"type": "NOTIFIED"}}

        ts = str(int(time.time() * 1000))
        body = b'{"context":{"amount":50}}'
        headers = {"X-StateKeep-Timestamp": ts, "X-StateKeep-Signature": sign("sec", ts, body)}
        self.assertEqual(svc.handle("POST", "/statekeep/guards/big", headers, body, "/statekeep"), (200, {"result": True}))
        self.assertEqual(svc.handle("POST", "/statekeep/actions/notify", headers, body, "/statekeep")[1]["send"]["type"], "NOTIFIED")
        mh = {"X-StateKeep-Timestamp": ts, "X-StateKeep-Signature": sign("sec", ts, b"")}
        self.assertEqual(svc.handle("GET", "/statekeep/manifest", mh, b"", "/statekeep")[1], {"guards": ["big"], "actions": ["notify"]})
        bad = {"X-StateKeep-Timestamp": ts, "X-StateKeep-Signature": "sha256=forged"}
        self.assertEqual(svc.handle("POST", "/statekeep/guards/big", bad, body, "/statekeep")[0], 401)


    def test_retried_action_job_runs_once(self):
        svc = ImplementationService(secret="sec")
        calls = []

        @svc.action("charge")
        def charge(req):
            calls.append(req["jobId"])
            return {"send": {"type": "CHARGED", "n": len(calls)}}

        def post(body):
            ts = str(int(time.time() * 1000))
            h = {"X-StateKeep-Timestamp": ts, "X-StateKeep-Signature": sign("sec", ts, body)}
            return svc.handle("POST", "/statekeep/actions/charge", h, body, "/statekeep")[1]

        first = post(b'{"jobId":"j1"}')
        self.assertEqual(post(b'{"jobId":"j1"}'), first, "a retry replays the first result")
        self.assertEqual(calls, ["j1"])
        post(b'{"jobId":"j2"}')
        self.assertEqual(calls, ["j1", "j2"])


if __name__ == "__main__":
    unittest.main()
