# -*- coding: utf-8 -*-
"""program.dsh - a 10-foot DeepSeek Harness surface inside Kodi.

The whole add-on is: a menu, a bridge call under a progress dialog, and a
dialog/viewer with the result.  Two properties matter more than anything else:

* **No traceback may ever reach the screen.**  Kodi turns an uncaught exception
  in a script add-on into a modal error with a Python stack trace, which is
  unusable on a TV.  Every bridge call is wrapped, every failure becomes a
  ``Dialog().ok`` with a localized, human sentence, and ``_entry`` is a last
  line of defence around the whole run.
* **Nothing blocks silently.**  A network call always runs inside a progress
  dialog (``screen.Progress``) so the TV never looks frozen, and the wait for an
  answer updates it once per poll.

Bridge endpoints used: ``GET /tv/state``, ``POST /tv/ask``,
``GET /tv/reply?after=<id>``, ``POST /tv/action``, ``POST /tv/seen``.
"""

from __future__ import annotations

import os
import sys
import time

import xbmc
import xbmcaddon
import xbmcgui

_ADDON_DIR = os.path.dirname(os.path.abspath(__file__))
if _ADDON_DIR not in sys.path:
    sys.path.insert(0, _ADDON_DIR)

from resources.lib import bridge, screen, ui  # noqa: E402  (needs sys.path first)

ADDON_ID = "program.dsh"
LOGWARNING = getattr(xbmc, "LOGWARNING", 2)
LOGERROR = getattr(xbmc, "LOGERROR", 3)

#: ``RunScript(program.dsh, ask)`` jumps straight into a action.
DIRECT_ACTIONS = ("now_playing", "ask", "picks", "resume", "remote", "settings")


def _log(message, level=None):
    try:
        xbmc.log("[%s] %s" % (ADDON_ID, message), getattr(xbmc, "LOGINFO", 1) if level is None else level)
    except Exception:  # noqa: BLE001
        pass


class App(object):
    """The menu loop and every action behind it."""

    def __init__(self, addon):
        self._addon = addon
        self._text = ui.Text(addon.getLocalizedString)
        self._screen = screen.Screen(addon, self._text)
        self._client = None
        self._config_error = None
        self._state = None
        self._offline = False
        self._reload()

    # -- settings ---------------------------------------------------------
    def _reload(self):
        """(Re)build the bridge client from the current settings."""
        reader = screen.settings_reader(self._addon, integer_keys=(bridge.SETTING_TIMEOUT,))
        config = bridge.Config.from_mapping(reader)
        try:
            self._client = bridge.BridgeClient.from_config(config)
            self._config_error = None
            # Logs the *effective* values, which is how a support log proves the
            # defaults were applied on a profile that never saved a setting.
            _log(
                "bridge %s, timeout %ss, token %s"
                % (self._client.endpoint, int(self._client.timeout), "set" if self._client.token else "unset")
            )
            return True
        except bridge.BridgeError as err:
            self._client = None
            self._config_error = err
            _log("bridge configuration rejected: %s" % (err,), LOGWARNING)
            return False

    @property
    def client(self):
        """The configured bridge client, or ``None`` when the URL is invalid.

        Read-only: used by the add-on's own tests and useful when reading a
        support log ("which endpoint did it actually use?").
        """
        return self._client

    def _require_client(self):
        if self._client is None:
            raise self._config_error or bridge.BridgeError(bridge.KIND_CONFIG, "no bridge client")
        return self._client

    # -- run --------------------------------------------------------------
    def run(self, argv=None):
        direct = _direct_action(argv)
        if direct:
            self._invoke(direct)
        while True:
            offline = self._offline or self._client is None
            if self._state is None and not offline:
                self._load_state(force=True)
                offline = self._offline
            rows = ui.menu_rows(self._state, self._text, offline=offline)
            labels = [label for _key, label in rows]
            _log("menu shown: %d items, offline=%s" % (len(rows), offline))
            heading = ui.menu_heading(self._state, self._text, offline=offline)
            index = self._screen.select(heading, labels)
            if index < 0 or index >= len(rows):
                return
            key = rows[index][0]
            if key == "close":
                return
            self._invoke(key)

    def _invoke(self, key):
        """Run one action, converting every failure into a human dialog."""
        handler = {
            "now_playing": self._now_playing,
            "ask": self._ask,
            "picks": self._picks,
            "resume": self._resume,
            "remote": self._remote,
            "settings": self._settings,
        }.get(key)
        if handler is None:
            return
        try:
            handler()
        except bridge.BridgeError as err:
            if err.kind in (bridge.KIND_NETWORK, bridge.KIND_TIMEOUT):
                self._offline = True
            self._show_error(err)
        except Exception:  # noqa: BLE001 - the TV must never see this
            screen.log_exception(u"action %r failed" % (key,))
            self._screen.ok(ui.error_heading(self._text), self._text(ui.SID["error_internal"]))

    def _show_error(self, err):
        _log("bridge failure: %s" % (err,), LOGWARNING)
        self._screen.ok(
            ui.error_heading(self._text),
            ui.error_message(self._text, err),
            ui.error_detail(err),
        )

    # -- state ------------------------------------------------------------
    def _load_state(self, force=False):
        """Refresh ``/tv/state``; returns False and explains after a failure."""
        if not force and isinstance(self._state, dict) and not self._offline:
            return True
        try:
            client = self._require_client()
            with self._screen.progress(self._text(ui.SID["connecting"])) as progress:
                progress.update(15, self._text(ui.SID["reading_state"]))
                state = client.state()
        except bridge.BridgeError as err:
            self._state = None
            self._offline = err.kind in (bridge.KIND_NETWORK, bridge.KIND_TIMEOUT)
            self._show_error(err)
            return False
        except Exception:  # noqa: BLE001
            self._state = None
            self._offline = True
            screen.log_exception(u"state refresh failed")
            self._screen.ok(ui.error_heading(self._text), self._text(ui.SID["error_internal"]))
            return False
        self._state = state if isinstance(state, dict) else {}
        self._offline = False
        _log("state loaded: playing=%s picks=%d"
             % (ui.now_playing(self._state) is not None, len(ui.picks_from_state(self._state))))
        return True

    # -- actions ----------------------------------------------------------
    def _now_playing(self):
        client = self._require_client()
        with self._screen.progress(self._text(ui.SID["connecting"])) as progress:
            progress.update(20, self._text(ui.SID["reading_state"]))
            state = client.state()
        self._state = state if isinstance(state, dict) else {}
        self._offline = False
        lines = ui.now_playing_lines(self._state, self._text)
        if not lines:
            self._screen.ok(self._text(ui.SID["menu_now_playing"]), self._text(ui.SID["nothing_playing"]))
            return
        self._screen.viewer(self._text(ui.SID["menu_now_playing"]), u"\n".join(lines))

    def _ask(self):
        """Keyboard -> /tv/ask -> poll /tv/reply -> textviewer."""
        client = self._require_client()
        question = self._screen.ask_text(self._text(ui.SID["ask_prompt"]))
        if not question or not question.strip():
            # Backing out of the keyboard is not an error.
            return

        after = None
        try:
            with self._screen.progress(self._text(ui.SID["sending"])) as progress:
                progress.update(30, self._text(ui.SID["sending"]))
                after = client.ask(question)
        except bridge.BridgeBusy:
            # 429: a previous question is still unanswered.  Keep waiting on
            # that one instead of showing an error.
            after = client.last_reply_id
            self._screen.notify(self._text(ui.SID["app_name"]), self._text(ui.SID["busy_waiting"]))

        reply = self._wait_for_reply(client, after)
        if reply is None:
            return

        body = ui.clean_reply(reply.get("text"))
        if not body:
            self._screen.ok(self._text(ui.SID["ask_prompt"]), self._text(ui.SID["no_answer"]))
            return
        self._screen.viewer(self._text(ui.SID["answer_heading"]), body)
        try:
            client.seen(ui.reply_id(reply))
        except bridge.BridgeError as err:
            # Marking as read is bookkeeping; never bother the viewer with it.
            _log("could not mark the reply as seen: %s" % (err,), LOGWARNING)

    def _wait_for_reply(self, client, after):
        """Poll until an answer, a cancel, or the configured timeout."""
        heading = self._text(ui.SID["ask_prompt"])
        deadline = time.monotonic() + client.timeout
        budget = max(client.timeout, 1.0)
        outcome = ("pending", None)

        with self._screen.progress(heading) as progress:
            progress.update(2, self._text(ui.SID["working"]))

            def tick(elapsed):
                percent = 2 + int(min(elapsed / budget, 1.0) * 93)
                progress.update(percent, self._text(ui.SID["waiting_seconds"], seconds=int(elapsed)))
                return not progress.cancelled()

            try:
                found = client.wait_for_reply(after, deadline=deadline, on_tick=tick)
            except bridge.BridgeError as err:
                outcome = ("error", err)
            else:
                outcome = ("reply", found)

        kind, payload = outcome
        if kind == "reply":
            if payload is None:
                self._screen.ok(heading, self._text(ui.SID["cancelled"]))
                return None
            return payload
        err = payload
        if err.kind == bridge.KIND_TIMEOUT:
            self._screen.ok(heading, self._text(ui.SID["no_answer"]), ui.error_detail(err))
            return None
        raise err

    def _picks(self):
        self._pick_flow(resume_only=False)

    def _resume(self):
        self._pick_flow(resume_only=True)

    def _pick_flow(self, resume_only):
        if not self._load_state(force=True):
            return
        picks = ui.picks_from_state(self._state)
        if resume_only:
            picks = ui.resumable(picks)
        rows, chosen = ui.pick_rows(picks, self._text, resume_only=resume_only)
        heading = self._text(ui.SID["menu_resume"] if resume_only else ui.SID["menu_picks"])
        if not rows:
            empty = ui.SID["nothing_to_resume"] if resume_only else ui.SID["no_picks"]
            self._screen.ok(heading, self._text(empty))
            return
        index = self._screen.select(heading, rows)
        if index < 0 or index >= len(chosen):
            return
        self._play(chosen[index])

    def _play(self, pick):
        client = self._require_client()
        payload = {"kind": pick.get("kind") or "movie", "id": pick.get("id")}
        with self._screen.progress(self._text(ui.SID["working"])) as progress:
            progress.update(45, self._text(ui.SID["working"]))
            client.action("play", payload)
        self._screen.notify(self._text(ui.SID["app_name"]), self._text(ui.SID["sent_to_kodi"]))
        self._state = None  # playback changed; refresh on the next loop pass

    def _remote(self):
        client = self._require_client()
        rows = ui.remote_rows(self._text)
        labels = [label for label, _action, _value in rows]
        index = self._screen.select(self._text(ui.SID["menu_remote"]), labels)
        if index < 0 or index >= len(rows):
            return
        _label, action, value = rows[index]
        with self._screen.progress(self._text(ui.SID["working"])) as progress:
            progress.update(50, self._text(ui.SID["working"]))
            client.action(action, value)
        self._state = None

    def _settings(self):
        self._screen.open_settings()
        self._reload()
        self._state = None
        self._offline = False
        if self._client is None and self._config_error is not None:
            self._show_error(self._config_error)


def _direct_action(argv):
    """Map ``RunScript(program.dsh, <word>)`` onto a menu key."""
    for argument in argv or ():
        word = (argument or "").strip().lower().replace("-", "_")
        if word in ("nowplaying", "now"):
            return "now_playing"
        if word in DIRECT_ACTIONS:
            return word
    return None


def main(argv=None):
    addon = xbmcaddon.Addon(ADDON_ID)
    app = App(addon)
    app.run(sys.argv[1:] if argv is None else argv)


def _entry():
    """Kodi entry point: nothing may escape from here."""
    try:
        main()
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        screen.log_exception(u"program.dsh aborted")
        try:
            addon = xbmcaddon.Addon(ADDON_ID)
            text = ui.Text(addon.getLocalizedString)
            xbmcgui.Dialog().ok(ui.error_heading(text), text(ui.SID["error_internal"]))
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    _entry()
