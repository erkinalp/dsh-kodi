# -*- coding: utf-8 -*-
"""HTTP client for the dsh-kodi TV bridge.

Pure standard library: nothing in this module imports ``xbmc*``, so it runs and
is tested in plain CPython (see ``kodi-addon/tests/test_bridge.py``).

Design rules
------------
* One exception type, many failure classes.  :class:`BridgeError` carries a
  ``kind`` string; the screen layer maps ``kind`` to a localized string, so no
  raw exception text ever reaches the TV.  ``str(err)`` is developer-facing and
  only ever goes to kodi.log.
* Connect and read timeouts are separate: 2 s to open the socket, then the
  configured budget for the read.
* The token travels in headers only, never in the URL (a bridge URL with
  credentials is rejected outright).
* Every JSON answer is validated; a shape we do not understand is a
  ``protocol`` error instead of a ``KeyError``/``AttributeError`` later.

Endpoint contract (see CONTRACTS.md): ``GET /health``, ``GET /tv/state``,
``POST /tv/ask``, ``GET /tv/reply?after=<id>``, ``POST /tv/action``,
``POST /tv/seen``.
"""

from __future__ import annotations

import json
import socket
import time
from http.client import HTTPConnection, HTTPException, HTTPSConnection
from urllib.parse import urlencode, urlsplit

VERSION = "0.1.0"
USER_AGENT = "dsh-kodi-addon/" + VERSION

DEFAULT_BASE_URL = "http://127.0.0.1:8760"
DEFAULT_TIMEOUT = 60.0
MIN_TIMEOUT = 3.0
MAX_TIMEOUT = 600.0
CONNECT_TIMEOUT = 2.0
POLL_INTERVAL = 1.5
MAX_TRANSIENT_FAILURES = 3
MAX_RESPONSE_BYTES = 512 * 1024

# Setting ids; must match resources/settings.xml.
SETTING_URL = "bridge_url"
SETTING_TOKEN = "bridge_token"
SETTING_TIMEOUT = "timeout"

# Failure classes.  ``ui.ERROR_SID`` maps every one of them to a string id.
KIND_CONFIG = "config"
KIND_NETWORK = "network"
KIND_TIMEOUT = "timeout"
KIND_AUTH = "auth"
KIND_BUSY = "busy"
KIND_HTTP = "http"
KIND_JSON = "json"
KIND_PROTOCOL = "protocol"
KIND_REJECTED = "rejected"
KIND_EMPTY = "empty"

#: Failures that will not go away by retrying inside one wait loop.
FATAL_KINDS = (KIND_CONFIG, KIND_AUTH, KIND_PROTOCOL, KIND_JSON, KIND_REJECTED, KIND_EMPTY)

#: Header names we send the token under.  The bridge accepts either
#: (``Authorization: Bearer <token>`` or ``X-Bridge-Token: <token>``); a
#: ``?token=`` query parameter is deliberately never used (no credentials in
#: URLs).  With an empty token setting no auth header is sent at all.
AUTH_HEADER = "authorization"
TOKEN_HEADER = "x-bridge-token"


def _positive_timeout(value, default=DEFAULT_TIMEOUT):
    """Any positive number of seconds, capped at ``MAX_TIMEOUT``."""
    if value is None or value == "":
        return default
    try:
        seconds = float(str(value).strip().replace(",", "."))
    except (TypeError, ValueError):
        return default
    if seconds <= 0:
        return default
    return min(MAX_TIMEOUT, seconds)


def _clamp_timeout(value):
    """Coerce a *user* settings value into a sane read/wait budget."""
    return max(MIN_TIMEOUT, _positive_timeout(value))


def _short(value, limit=160):
    """Collapse arbitrary text into one short, log-safe line."""
    text = " ".join(str(value or "").split())
    return text[:limit]


class BridgeError(Exception):
    """A bridge call failed; ``kind`` says how, ``detail`` is technical context.

    ``detail`` is deliberately language-neutral (a URL, ``HTTP 500``, an OS
    message) and is shown to the user inside parentheses under the localized
    sentence, never instead of it.
    """

    def __init__(self, kind, detail="", status=None, url=None):
        self.kind = kind
        self.detail = _short(detail)
        self.status = status
        self.url = url
        Exception.__init__(self, self.describe())

    def describe(self):
        parts = ["bridge error: " + str(self.kind)]
        if self.status is not None:
            parts.append("HTTP %s" % self.status)
        if self.detail:
            parts.append(self.detail)
        return " / ".join(parts)

    def __str__(self):
        return self.describe()

    def __repr__(self):
        return "BridgeError(kind=%r, status=%r, detail=%r)" % (self.kind, self.status, self.detail)


class BridgeBusy(BridgeError):
    """HTTP 429: the bridge already has an unanswered question in flight."""

    def __init__(self, detail="", status=429, url=None):
        BridgeError.__init__(self, KIND_BUSY, detail, status, url)


class Config(object):
    """Add-on settings, validated into the values the client needs."""

    __slots__ = ("base_url", "token", "timeout")

    def __init__(self, base_url=DEFAULT_BASE_URL, token="", timeout=DEFAULT_TIMEOUT):
        url = (base_url or "").strip() or DEFAULT_BASE_URL
        self.base_url = url
        self.token = (token or "").strip()
        self.timeout = _clamp_timeout(timeout)

    @classmethod
    def from_mapping(cls, get):
        """Build from ``addon.getSetting``; a broken setting must never raise."""

        def read(key):
            try:
                return get(key)
            except Exception:
                return ""

        return cls(read(SETTING_URL), read(SETTING_TOKEN), read(SETTING_TIMEOUT))

    def __repr__(self):
        return "Config(base_url=%r, token=%r, timeout=%r)" % (
            self.base_url,
            "***" if self.token else "",
            self.timeout,
        )


class BridgeClient(object):
    """Small, synchronous JSON-over-HTTP client for the local bridge."""

    def __init__(
        self,
        base_url=DEFAULT_BASE_URL,
        token="",
        timeout=DEFAULT_TIMEOUT,
        connect_timeout=CONNECT_TIMEOUT,
        poll_interval=POLL_INTERVAL,
    ):
        raw = (base_url or "").strip() or DEFAULT_BASE_URL
        parts = urlsplit(raw)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise BridgeError(KIND_CONFIG, "bridge url must be http(s)://host[:port]", url=raw)
        if parts.username or parts.password:
            raise BridgeError(KIND_CONFIG, "credentials are not allowed in the bridge url", url=raw)
        try:
            port = parts.port
        except ValueError:
            raise BridgeError(KIND_CONFIG, "bridge url has an invalid port", url=raw)

        self.base_url = raw
        self.token = (token or "").strip()
        # The settings layer clamps to MIN_TIMEOUT; the constructor accepts any
        # positive value so tests (and future callers) can use short budgets.
        self.timeout = _positive_timeout(timeout)
        self.connect_timeout = connect_timeout
        self.poll_interval = poll_interval
        self.last_reply_id = None

        self._scheme = parts.scheme
        self._host = parts.hostname
        self._port = port
        self._prefix = parts.path.rstrip("/")
        self._default_port = 443 if parts.scheme == "https" else 80

    # -- introspection ----------------------------------------------------
    @property
    def endpoint(self):
        """Redacted base URL, safe to show on screen or in a log."""
        host = self._host
        if self._port and self._port != self._default_port:
            host = "%s:%s" % (host, self._port)
        return "%s://%s%s" % (self._scheme, host, self._prefix)

    def __repr__(self):
        return "BridgeClient(endpoint=%r, token=%r, timeout=%r)" % (
            self.endpoint,
            "***" if self.token else "",
            self.timeout,
        )

    @classmethod
    def from_config(cls, config):
        return cls(config.base_url, token=config.token, timeout=config.timeout)

    # -- transport --------------------------------------------------------
    def _target(self, path, query=None):
        target = self._prefix + path
        if query:
            target = target + "?" + urlencode(query)
        return target

    def _connection(self):
        factory = HTTPSConnection if self._scheme == "https" else HTTPConnection
        try:
            return factory(self._host, self._port, timeout=self.connect_timeout)
        except (OSError, ValueError) as exc:
            raise BridgeError(KIND_NETWORK, _short(exc), url=self.endpoint)

    @staticmethod
    def _apply_read_timeout(conn, seconds):
        sock = getattr(conn, "sock", None)
        if sock is None or not seconds:
            return
        try:
            sock.settimeout(seconds)
        except OSError:
            pass

    def _headers(self, body):
        headers = {
            "accept": "application/json",
            "user-agent": USER_AGENT,
            "connection": "close",
        }
        if self.token:
            headers[AUTH_HEADER] = "Bearer " + self.token
            headers[TOKEN_HEADER] = self.token
        if body is not None:
            headers["content-type"] = "application/json; charset=utf-8"
        return headers

    def _request(self, method, path, query=None, body=None):
        target = self._target(path, query)
        payload = None
        if body is not None:
            try:
                payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            except (TypeError, ValueError) as exc:
                raise BridgeError(KIND_PROTOCOL, "request body is not serializable: %s" % _short(exc))

        conn = self._connection()
        try:
            try:
                conn.connect()
                self._apply_read_timeout(conn, self.timeout)
                conn.request(method, target, body=payload, headers=self._headers(body))
                response = conn.getresponse()
                status = response.status
                reason = response.reason or ""
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            except (socket.timeout, TimeoutError) as exc:
                raise BridgeError(KIND_TIMEOUT, _short(exc) or "timed out", url=self.endpoint)
            except (OSError, HTTPException) as exc:
                raise BridgeError(KIND_NETWORK, _short(exc) or exc.__class__.__name__, url=self.endpoint)
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - closing must never mask the real error
                pass

        return self._decode(method, path, status, reason, raw)

    def _decode(self, method, path, status, reason, raw):
        if len(raw) > MAX_RESPONSE_BYTES:
            raise BridgeError(KIND_PROTOCOL, "response larger than %d bytes" % MAX_RESPONSE_BYTES, status)
        encoding = "utf-8"
        try:
            text = raw.decode(encoding, "replace") if raw else ""
        except Exception:  # noqa: BLE001 - decode('replace') should not fail, be safe
            text = ""

        if not 200 <= status < 300:
            detail = self._error_detail(text) or _short("HTTP %s %s" % (status, reason))
            if status in (401, 403):
                raise BridgeError(KIND_AUTH, detail, status, self.endpoint)
            if status == 429:
                raise BridgeBusy(detail, status, self.endpoint)
            if status == 404:
                raise BridgeError(KIND_PROTOCOL, "no such endpoint: %s %s" % (method, path), status, self.endpoint)
            raise BridgeError(KIND_HTTP, detail, status, self.endpoint)

        if not text.strip():
            return {}
        try:
            data = json.loads(text)
        except ValueError as exc:
            raise BridgeError(KIND_JSON, _short(exc) or "invalid JSON", status, self.endpoint)
        if not isinstance(data, dict):
            raise BridgeError(KIND_PROTOCOL, "expected a JSON object, got %s" % type(data).__name__, status)
        return data

    @staticmethod
    def _error_detail(text):
        """Pull a human detail out of an error body without trusting its shape."""
        stripped = (text or "").strip()
        if not stripped:
            return ""
        try:
            data = json.loads(stripped)
        except ValueError:
            return _short(stripped)
        if isinstance(data, dict):
            for key in ("error", "message", "detail", "reason"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return _short(value)
                if value:  # non-string error payloads
                    return _short(json.dumps(value, ensure_ascii=False))
        return ""

    # -- endpoints --------------------------------------------------------
    def health(self):
        """``GET /health`` -> ``{ok, kodi:{...}, bridge:{...}}``."""
        return self._request("GET", "/health")

    def state(self):
        """``GET /tv/state`` -> ``{nowPlaying, queue, picks, lastReply}``.

        Remembers the newest reply id so a later ask can resume waiting on it.
        """
        data = self._request("GET", "/tv/state")
        last = data.get("lastReply")
        if isinstance(last, dict) and last.get("id") is not None:
            self.last_reply_id = last.get("id")
        return data

    def ask(self, text):
        """``POST /tv/ask`` -> ask id.

        Raises :class:`BridgeBusy` when a previous question is still pending;
        callers waiting on an answer keep waiting instead of failing.
        """
        question = (text or "").strip()
        if not question:
            raise BridgeError(KIND_EMPTY, "empty message")
        data = self._request("POST", "/tv/ask", body={"text": question})
        ask_id = data.get("id")
        if ask_id is None:
            raise BridgeError(KIND_PROTOCOL, "ask reply carries no id")
        return ask_id

    def reply(self, after=0):
        """``GET /tv/reply?after=<id>`` -> ``{id, text, at}`` or ``None``."""
        query = {"after": "" if after is None else after}
        data = self._request("GET", "/tv/reply", query=query)
        found = data.get("reply")
        if found is None:
            return None
        if not isinstance(found, dict):
            raise BridgeError(KIND_PROTOCOL, "reply is not an object")
        text = found.get("text")
        if text is None:
            text = ""
        if not isinstance(text, str):
            raise BridgeError(KIND_PROTOCOL, "reply text is not a string")
        if not text.strip():
            return None
        result = {"id": found.get("id"), "text": text, "at": found.get("at")}
        if result["id"] is not None:
            self.last_reply_id = result["id"]
        return result

    def action(self, action, value=None):
        """``POST /tv/action`` -> bridge payload; raises when the bridge says no."""
        if not action:
            raise BridgeError(KIND_PROTOCOL, "missing action")
        data = self._request("POST", "/tv/action", body={"action": action, "value": value})
        if data.get("ok") is False:
            raise BridgeError(KIND_REJECTED, self._error_detail(json.dumps(data)) or "action refused")
        return data

    def seen(self, reply_id):
        """``POST /tv/seen`` — tell the bridge the answer was read (best effort)."""
        if reply_id is None:
            return {}
        return self._request("POST", "/tv/seen", body={"id": reply_id})

    # -- polling ----------------------------------------------------------
    def wait_for_reply(
        self,
        after=0,
        deadline=None,
        interval=None,
        on_tick=None,
        clock=time.monotonic,
        sleep=time.sleep,
    ):
        """Poll ``/tv/reply`` until an answer arrives, the budget runs out, or
        ``on_tick(elapsed)`` returns ``False`` (the user cancelled).

        * returns the reply dict on success,
        * returns ``None`` when ``on_tick`` asked to stop,
        * raises ``BridgeError(kind='timeout')`` when the budget is exhausted,
        * raises fatal errors (auth/protocol/json/config) immediately,
        * tolerates up to ``MAX_TRANSIENT_FAILURES`` consecutive transport
          errors and any number of 429 "still pending" answers.
        """
        if interval is None:
            interval = self.poll_interval
        started = clock()
        end = started + self.timeout if deadline is None else deadline
        failures = 0

        while True:
            if on_tick is not None:
                try:
                    keep_going = on_tick(clock() - started)
                except Exception:  # noqa: BLE001 - a UI hiccup must not kill the wait
                    keep_going = True
                if keep_going is False:
                    return None

            try:
                found = self.reply(after)
                failures = 0
                if found is not None:
                    return found
            except BridgeBusy:
                failures = 0
            except BridgeError as exc:
                if exc.kind in FATAL_KINDS:
                    raise
                failures += 1
                if failures >= MAX_TRANSIENT_FAILURES:
                    raise

            remaining = end - clock()
            if remaining <= 0:
                raise BridgeError(
                    KIND_TIMEOUT,
                    "no reply within %d s" % int(round(self.timeout)),
                    url=self.endpoint,
                )
            sleep(min(interval, remaining))
