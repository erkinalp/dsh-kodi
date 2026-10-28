# -*- coding: utf-8 -*-
"""Headless tests for ``resources/lib/bridge.py``.

A stdlib ``http.server`` stub speaks the endpoint set from CONTRACTS.md
(``/health``, ``/tv/state``, ``/tv/ask``, ``/tv/reply``, ``/tv/action``,
``/tv/seen``) so the client's success, 401, 429, timeout and malformed-JSON
handling is exercised without Kodi, a TV or the real bridge.

Run from the repository root::

    python3 -m unittest discover -s kodi-addon/tests -v
    python3 kodi-addon/tests/test_bridge.py          # same thing, one file
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

import _support  # noqa: E402  (local helper: paths + .po parser)

if _support.LIB_DIR not in sys.path:
    sys.path.insert(0, _support.LIB_DIR)

import bridge  # noqa: E402

TOKEN = "s3cret-token"


# ---------------------------------------------------------------------------
# stub bridge
# ---------------------------------------------------------------------------
class StubBridge(object):
    """Mutable state the handler serves; tests adjust it before calling."""

    def __init__(self):
        self.requests = []
        self.state_payload = {
            "nowPlaying": {
                "playing": True,
                "position": 192.0,
                "runtime": 634.0,
                "volume": 42,
                "muted": False,
                "speed": 1,
                "item": {"title": "Big Buck Bunny", "kind": "movie", "id": 1},
            },
            "queue": [{"id": 1}],
            "picks": {
                "generatedAt": "2026-10-28T12:00:00Z",
                "picks": [
                    {
                        "id": 11,
                        "kind": "movie",
                        "title": "Big Buck Bunny",
                        "reason": "you're 3 minutes in",
                        "runtime": 634,
                        "resumeAt": 192,
                    },
                    {
                        "id": 12,
                        "kind": "episode",
                        "title": "Cosmos S01E02",
                        "reason": "short enough for the evening",
                        "runtime": 2700,
                        "resumeAt": None,
                    },
                ],
            },
            "lastReply": {"id": 7, "text": "Earlier answer", "at": "2026-10-28T11:00:00Z"},
        }
        self.state_status = 200
        self.state_bad_json = False  # /tv/state answers junk instead of JSON
        self.unauth = False          # /health answers 401
        self.bad_json = False        # /health answers junk instead of JSON
        self.ask_ids = [4242]
        self.ask_status = 200
        self.ask_error = {"error": "a previous ask is still pending"}
        self.reply_id = 4243
        self.reply_text = "Starting Big Buck Bunny (2010)."
        self.reply_ready_after = 0  # first N polls answer {"reply": null}
        self.reply_429_polls = 0    # first N polls answer 429
        self.reply_status = 200     # non-200 to simulate a failing bridge
        self.delay = 0.0            # seconds /slow sleeps
        self.action_result = {"ok": True, "playing": True}
        self._reply_polls = 0
        self._busy_served = 0

    # -- helpers ---------------------------------------------------------
    def record(self, method, path, query, headers, body):
        self.requests.append(
            {
                "method": method,
                "path": path,
                "query": query,
                "headers": dict((key.lower(), value) for key, value in headers.items()),
                "body": body,
            }
        )

    def calls(self, method=None, path=None):
        return [
            entry
            for entry in self.requests
            if (method is None or entry["method"] == method)
            and (path is None or entry["path"] == path)
        ]

    def last(self, method, path):
        found = self.calls(method, path)
        return found[-1] if found else None


class StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the test output clean
        pass

    @property
    def stub(self):
        return self.server.stub

    # -- plumbing --------------------------------------------------------
    def _send(self, status, payload=None, raw=None):
        if raw is None:
            raw = json.dumps(payload if payload is not None else {}).encode("utf-8")
        elif isinstance(raw, str):
            raw = raw.encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(raw)
        except OSError:
            pass

    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            return None

    # -- routes ----------------------------------------------------------
    def do_GET(self):
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        self.stub.record("GET", parsed.path, query, self.headers, None)
        stub = self.stub

        if parsed.path == "/health":
            if stub.unauth:
                self._send(401, {"error": "invalid token"})
                return
            if stub.bad_json:
                self._send(200, raw="this is not json{{")
                return
            self._send(
                200,
                {
                    "ok": True,
                    "kodi": {"connected": True, "version": "21.3"},
                    "bridge": {"port": 8760, "authed": True},
                },
            )
            return

        if parsed.path == "/tv/state":
            if stub.state_bad_json:
                self._send(200, raw="<html>not json</html>")
                return
            if stub.state_status != 200:
                self._send(stub.state_status, {"error": "state unavailable"})
                return
            self._send(200, stub.state_payload)
            return

        if parsed.path == "/tv/reply":
            stub._reply_polls += 1
            if stub.reply_status != 200:
                self._send(stub.reply_status, {"error": "reply read failed"})
                return
            if stub._busy_served < stub.reply_429_polls:
                stub._busy_served += 1
                self._send(429, {"error": "a previous ask is still pending"})
                return
            if stub._reply_polls <= stub.reply_ready_after:
                self._send(200, {"reply": None})
                return
            self._send(
                200,
                {"reply": {"id": stub.reply_id, "text": stub.reply_text, "at": "2026-10-28T12:00:00Z"}},
            )
            return

        if parsed.path == "/slow":
            time.sleep(stub.delay)
            self._send(200, {"ok": True})
            return

        if parsed.path == "/badjson":
            self._send(200, raw="this is not json{{")
            return

        if parsed.path == "/unauth":
            self._send(401, {"error": "invalid token"})
            return

        self._send(404, {"error": "no such endpoint"})

    def do_POST(self):
        parsed = urlsplit(self.path)
        body = self._body()
        self.stub.record("POST", parsed.path, parse_qs(parsed.query), self.headers, body)
        stub = self.stub

        if parsed.path == "/tv/ask":
            if stub.ask_status != 200:
                self._send(stub.ask_status, stub.ask_error)
                return
            ask_id = stub.ask_ids[0] if len(stub.ask_ids) == 1 else stub.ask_ids.pop(0)
            self._send(200, {"ok": True, "id": ask_id})
            return

        if parsed.path == "/tv/action":
            action = (body or {}).get("action")
            if action == "forbidden":
                self._send(200, {"ok": False, "error": "action not allowed"})
                return
            self._send(200, stub.action_result)
            return

        if parsed.path == "/tv/seen":
            self._send(200, {"ok": True})
            return

        self._send(404, {"error": "no such endpoint"})


class StubServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_stub():
    """Start the stub on a free loopback port -> ``(server, stub, base_url)``."""
    stub = StubBridge()
    server = StubServer(("127.0.0.1", 0), StubHandler)
    server.stub = stub
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.daemon = True
    thread.start()
    base_url = "http://127.0.0.1:%d" % server.server_address[1]
    return server, stub, base_url


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------
class StubTestCase(unittest.TestCase):
    def setUp(self):
        self.server, self.stub, self.base_url = start_stub()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def client(self, **kwargs):
        kwargs.setdefault("token", TOKEN)
        kwargs.setdefault("timeout", 2.0)
        return bridge.BridgeClient(self.base_url, **kwargs)


class SuccessTests(StubTestCase):
    def test_health_returns_the_snapshot(self):
        payload = self.client().health()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["kodi"]["version"], "21.3")

    def test_state_parses_with_ui_helpers(self):
        state = self.client().state()
        self.assertEqual(state["picks"]["picks"][0]["id"], 11)
        self.assertEqual(len(state["queue"]), 1)

    def test_ask_posts_json_and_returns_the_id(self):
        ask_id = self.client().ask("  play something funny  ")
        self.assertEqual(ask_id, 4242)
        request = self.stub.last("POST", "/tv/ask")
        self.assertIsNotNone(request)
        self.assertEqual(request["body"], {"text": "play something funny"})
        self.assertIn("application/json", request["headers"]["content-type"])

    def test_token_travels_in_headers_only(self):
        self.client().health()
        request = self.stub.last("GET", "/health")
        self.assertEqual(request["headers"]["authorization"], "Bearer " + TOKEN)
        self.assertEqual(request["headers"]["x-bridge-token"], TOKEN)
        self.assertNotIn("token", request["query"])
        self.assertNotIn("token", request["path"])

    def test_empty_token_sends_no_auth_header(self):
        self.client(token="").health()
        headers = self.stub.last("GET", "/health")["headers"]
        self.assertNotIn("authorization", headers)
        self.assertNotIn("x-bridge-token", headers)

    def test_ask_without_text_never_reaches_the_network(self):
        with self.assertRaises(bridge.BridgeError) as caught:
            self.client().ask("   ")
        self.assertEqual(caught.exception.kind, bridge.KIND_EMPTY)
        self.assertEqual(self.stub.calls("POST", "/tv/ask"), [])

    def test_reply_is_none_while_the_answer_is_pending(self):
        self.stub.reply_ready_after = 1
        self.assertIsNone(self.client().reply(4242))

    def test_reply_returns_the_text(self):
        found = self.client().reply(4242)
        self.assertEqual(found["id"], 4243)
        self.assertIn("Big Buck Bunny", found["text"])

    def test_reply_with_blank_text_counts_as_pending(self):
        self.stub.reply_text = "   "
        self.assertIsNone(self.client().reply(4242))

    def test_state_seeds_last_reply_id(self):
        client = self.client()
        self.assertIsNone(client.last_reply_id)
        client.state()
        self.assertEqual(client.last_reply_id, 7)

    def test_action_ok(self):
        payload = self.client().action("play", {"kind": "movie", "id": 11})
        self.assertTrue(payload["ok"])
        request = self.stub.last("POST", "/tv/action")
        self.assertEqual(request["body"], {"action": "play", "value": {"kind": "movie", "id": 11}})

    def test_action_refused_by_the_bridge_is_typed(self):
        with self.assertRaises(bridge.BridgeError) as caught:
            self.client().action("forbidden")
        self.assertEqual(caught.exception.kind, bridge.KIND_REJECTED)
        self.assertIn("not allowed", str(caught.exception))

    def test_seen_marks_the_reply(self):
        self.client().seen(4243)
        self.assertEqual(self.stub.last("POST", "/tv/seen")["body"], {"id": 4243})

    def test_base_url_may_carry_a_trailing_slash(self):
        client = bridge.BridgeClient(self.base_url + "/", token=TOKEN, timeout=2.0)
        self.assertTrue(client.health()["ok"])

    def test_base_url_path_prefix_is_preserved(self):
        client = bridge.BridgeClient(self.base_url + "/dsh/", token=TOKEN, timeout=2.0)
        with self.assertRaises(bridge.BridgeError):
            client.health()  # the stub does not serve the prefix, but records it
        self.assertEqual(self.stub.last("GET", "/dsh/health")["path"], "/dsh/health")

    def test_endpoint_is_redacted(self):
        client = bridge.BridgeClient(self.base_url, token=TOKEN, timeout=2.0)
        self.assertNotIn(TOKEN, client.endpoint)
        self.assertNotIn(TOKEN, repr(client))


class FailureTests(StubTestCase):
    def test_401_is_an_auth_error_with_the_bridge_detail(self):
        self.stub.unauth = True
        client = self.client(token="wrong")
        with self.assertRaises(bridge.BridgeError) as caught:
            client.health()
        error = caught.exception
        self.assertEqual(error.kind, bridge.KIND_AUTH)
        self.assertEqual(error.status, 401)
        self.assertIn("invalid token", error.detail)

    def test_401_on_ask_is_also_auth(self):
        self.stub.ask_status = 401
        self.stub.ask_error = {"error": "invalid token"}
        with self.assertRaises(bridge.BridgeError) as caught:
            self.client().ask("hello")
        self.assertEqual(caught.exception.kind, bridge.KIND_AUTH)

    def test_429_on_ask_is_busy(self):
        self.stub.ask_status = 429
        with self.assertRaises(bridge.BridgeBusy) as caught:
            self.client().ask("hello")
        self.assertEqual(caught.exception.kind, bridge.KIND_BUSY)
        self.assertEqual(caught.exception.status, 429)

    def test_wait_for_reply_keeps_waiting_through_429(self):
        self.stub.reply_429_polls = 2
        found = self.client().wait_for_reply(4242, interval=0.01)
        self.assertEqual(found["id"], 4243)
        self.assertEqual(self.stub._busy_served, 2)

    def test_read_timeout(self):
        self.stub.delay = 1.0
        client = bridge.BridgeClient(self.base_url, token=TOKEN, timeout=0.2)
        started = time.monotonic()
        with self.assertRaises(bridge.BridgeError) as caught:
            client._request("GET", "/slow")
        self.assertEqual(caught.exception.kind, bridge.KIND_TIMEOUT)
        self.assertLess(time.monotonic() - started, 0.9)

    def test_connection_refused_is_a_network_error(self):
        port = _support.closed_port()
        client = bridge.BridgeClient("http://127.0.0.1:%d" % port, token=TOKEN, timeout=1.0)
        with self.assertRaises(bridge.BridgeError) as caught:
            client.state()
        self.assertEqual(caught.exception.kind, bridge.KIND_NETWORK)

    def test_malformed_json_is_a_json_error(self):
        self.stub.bad_json = True
        client = self.client()
        with self.assertRaises(bridge.BridgeError) as caught:
            client.health()
        self.assertEqual(caught.exception.kind, bridge.KIND_JSON)

    def test_http_500_is_an_http_error_carrying_the_detail(self):
        self.stub.state_status = 500
        with self.assertRaises(bridge.BridgeError) as caught:
            self.client().state()
        self.assertEqual(caught.exception.kind, bridge.KIND_HTTP)
        self.assertEqual(caught.exception.status, 500)
        self.assertIn("state unavailable", caught.exception.detail)

    def test_invalid_url_is_a_config_error(self):
        for url in ("not a url", "ftp://127.0.0.1:8760", "http://"):
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.BridgeClient(url)
            self.assertEqual(caught.exception.kind, bridge.KIND_CONFIG)

    def test_credentials_in_the_url_are_refused(self):
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.BridgeClient("http://user:pass@127.0.0.1:8760")
        self.assertEqual(caught.exception.kind, bridge.KIND_CONFIG)


class WaitTests(StubTestCase):
    def test_polls_until_the_answer_arrives(self):
        self.stub.reply_ready_after = 3
        found = self.client().wait_for_reply(4242, interval=0.01)
        self.assertEqual(found["text"], self.stub.reply_text)
        self.assertGreaterEqual(self.stub._reply_polls, 4)

    def test_deadline_raises_timeout(self):
        self.stub.reply_ready_after = 10 ** 6
        client = self.client(timeout=5.0)
        started = time.monotonic()
        with self.assertRaises(bridge.BridgeError) as caught:
            client.wait_for_reply(4242, deadline=time.monotonic() + 0.15, interval=0.02)
        self.assertEqual(caught.exception.kind, bridge.KIND_TIMEOUT)
        self.assertLess(time.monotonic() - started, 1.0)

    def test_on_tick_can_cancel_the_wait(self):
        self.stub.reply_ready_after = 10 ** 6
        client = self.client(timeout=5.0)
        ticks = []

        def tick(elapsed):
            ticks.append(elapsed)
            return len(ticks) < 3

        self.assertIsNone(client.wait_for_reply(4242, interval=0.01, on_tick=tick))
        self.assertEqual(len(ticks), 3)

    def test_gives_up_after_repeated_transport_failures(self):
        self.stub.reply_status = 500
        client = self.client(timeout=5.0)
        with self.assertRaises(bridge.BridgeError) as caught:
            client.wait_for_reply(4242, interval=0.01)
        self.assertEqual(caught.exception.kind, bridge.KIND_HTTP)
        self.assertEqual(len(self.stub.calls("GET", "/tv/reply")), bridge.MAX_TRANSIENT_FAILURES)


class ConfigTests(StubTestCase):
    def test_from_mapping_reads_settings(self):
        values = {
            bridge.SETTING_URL: "http://127.0.0.1:9999",
            bridge.SETTING_TOKEN: "  abc  ",
            bridge.SETTING_TIMEOUT: "45",
        }
        config = bridge.Config.from_mapping(values.get)
        self.assertEqual(config.base_url, "http://127.0.0.1:9999")
        self.assertEqual(config.token, "abc")
        self.assertEqual(config.timeout, 45.0)

    def test_missing_and_mad_settings_fall_back(self):
        config = bridge.Config.from_mapping(lambda key: "")
        self.assertEqual(config.base_url, bridge.DEFAULT_BASE_URL)
        self.assertEqual(config.token, "")
        self.assertEqual(config.timeout, bridge.DEFAULT_TIMEOUT)

        self.assertEqual(bridge.Config(timeout="soon").timeout, bridge.DEFAULT_TIMEOUT)
        self.assertEqual(bridge.Config(timeout="1").timeout, bridge.MIN_TIMEOUT)
        self.assertEqual(bridge.Config(timeout="99999").timeout, bridge.MAX_TIMEOUT)

    def test_get_setting_that_raises_is_tolerated(self):
        def explode(_key):
            raise RuntimeError("settings are broken")

        self.assertEqual(bridge.Config.from_mapping(explode).base_url, bridge.DEFAULT_BASE_URL)

    def test_repr_never_leaks_the_token(self):
        config = bridge.Config(token="hunter2")
        self.assertNotIn("hunter2", repr(config))


if __name__ == "__main__":
    unittest.main(verbosity=2)
