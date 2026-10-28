# -*- coding: utf-8 -*-
"""End-to-end flow tests for ``default.py`` with fake ``xbmc*`` modules.

These tests matter most: they are the headless proof that the add-on's real menu
loop (real ``App``, real ``Screen``, real ``Progress``) never lets an exception
escape - the thing that would show a Python traceback on the TV - and that each
flow does the right HTTP call.

The ``xbmc``/``xbmcgui``/``xbmcaddon`` modules are replaced with recorders; the
strings come from the real ``strings.po``, so assertions check what a viewer
would actually read.

    python3 -m unittest discover -s kodi-addon/tests -v
"""

from __future__ import annotations

import importlib
import os
import sys
import types
import unittest

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

import _support  # noqa: E402
import test_bridge  # noqa: E402  (the stub bridge lives there)

if _support.PACKAGE_DIR not in sys.path:
    sys.path.insert(0, _support.PACKAGE_DIR)

EN = _support.strings("en_gb")

#: Menu order, as built by ui.menu_rows.
MENU = {
    "now_playing": 0,
    "ask": 1,
    "picks": 2,
    "resume": 3,
    "remote": 4,
    "settings": 5,
    "close": 6,
}


class Recorder(object):
    """One test run's scripted answers plus a log of what was shown."""

    def __init__(self, selects=(), inputs=()):
        self.selects = list(selects)
        self.inputs = list(inputs)
        self.calls = []

    def next_select(self):
        return self.selects.pop(0) if self.selects else -1

    def next_input(self):
        return self.inputs.pop(0) if self.inputs else ""

    # -- queries ---------------------------------------------------------
    def only(self, kind):
        return [call for call in self.calls if call[0] == kind]

    def first(self, kind, index=0):
        found = self.only(kind)
        return found[index] if len(found) > index else None

    def messages(self):
        return [call[2][0] for call in self.only("ok")]


class Fakes(object):
    def __init__(self):
        self.current = None
        self.settings = {}
        self.progress = []
        self.logs = []

    def reset(self, settings=None, selects=(), inputs=()):
        self.current = Recorder(selects=selects, inputs=inputs)
        self.settings = dict(settings or {})
        self.progress = []
        self.logs = []
        return self.current


_FAKES = None
_dialog_class = None
_progress_class = None


def _install_fakes():
    """Install fake xbmc modules once; return the shared :class:`Fakes`."""
    global _FAKES, _dialog_class, _progress_class
    if _FAKES is not None:
        return _FAKES

    fakes = Fakes()

    class FakeDialog(object):
        def __init__(self):
            self.script = fakes.current

        def ok(self, heading, *lines):
            self.script.calls.append(("ok", heading, list(lines)))
            return True

        def select(self, heading, items):
            self.script.calls.append(("select", heading, list(items)))
            return self.script.next_select()

        def input(self, heading, defaultt="", type=0, option=0, autoclose=0):
            self.script.calls.append(("input", heading, defaultt, type))
            return self.script.next_input()

        def textviewer(self, heading, body):
            self.script.calls.append(("textviewer", heading, body))
            return True

        def notification(self, heading, message, icon=None, time=5000):
            self.script.calls.append(("notification", heading, message))

    class FakeProgress(object):
        def __init__(self):
            self.script = fakes.current
            self.closed = False
            self.updates = []
            self.create_heading = None
            fakes.progress.append(self)

        def create(self, heading, message=""):
            self.create_heading = heading
            self.script.calls.append(("progress_create", heading))

        def update(self, percent, message=""):
            self.updates.append((percent, message))

        def iscanceled(self):
            return False

        def close(self):
            self.closed = True
            self.script.calls.append(("progress_close",))

    class FakeAddon(object):
        def __init__(self, addon_id=None):
            self.addon_id = addon_id

        def getLocalizedString(self, sid):
            return EN.get(int(sid), "")

        def getSetting(self, key):
            return fakes.settings.get(key, "")

        # Kodi 19+ typed getters (settings v2 XML) - exercised by the adapter.
        def getSettingString(self, key):
            return fakes.settings.get(key, "")

        def getSettingInt(self, key):
            try:
                return int(str(fakes.settings.get(key, "")).strip())
            except (TypeError, ValueError):
                return 0

        def getAddonInfo(self, key):
            return {"path": _support.PACKAGE_DIR, "id": "program.dsh", "name": "DSH"}.get(key, "")

        def openSettings(self):
            fakes.current.calls.append(("openSettings",))

    xbmc = types.ModuleType("xbmc")
    xbmc.LOGDEBUG = 0
    xbmc.LOGINFO = 1
    xbmc.LOGWARNING = 2
    xbmc.LOGERROR = 3
    xbmc.log = lambda message, level=1: fakes.logs.append((level, message))

    xbmcgui = types.ModuleType("xbmcgui")
    xbmcgui.INPUT_ALPHANUM = 1
    xbmcgui.NOTIFICATION_INFO = "info"
    xbmcgui.Dialog = FakeDialog
    xbmcgui.DialogProgress = FakeProgress

    xbmcaddon = types.ModuleType("xbmcaddon")
    xbmcaddon.Addon = FakeAddon

    sys.modules["xbmc"] = xbmc
    sys.modules["xbmcgui"] = xbmcgui
    sys.modules["xbmcaddon"] = xbmcaddon

    _dialog_class = FakeDialog
    _progress_class = FakeProgress
    _FAKES = fakes
    return fakes


def _load_addon():
    _install_fakes()
    return importlib.import_module("default")


default = _load_addon()


class FlowTestCase(unittest.TestCase):
    """Live stub bridge + fake Kodi."""

    def setUp(self):
        self.server, self.stub, self.base_url = test_bridge.start_stub()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.fakes = _install_fakes()
        self.settings = {
            "bridge_url": self.base_url,
            "bridge_token": "tok",
            "timeout": "10",
        }

    def run_app(self, selects=(), inputs=(), settings=None, argv=()):
        merged = dict(self.settings)
        merged.update(settings or {})
        recorder = self.fakes.reset(settings=merged, selects=selects, inputs=inputs)
        app = default.App(default.xbmcaddon.Addon(default.ADDON_ID))
        app.run(list(argv))
        return recorder

    def assert_progress_closed(self, recorder):
        self.assertTrue(self.fakes.progress, "expected at least one progress dialog")
        for progress in self.fakes.progress:
            self.assertTrue(progress.closed, "a progress dialog was left open")


class MenuTests(FlowTestCase):
    def test_menu_shows_live_status_and_closes(self):
        recorder = self.run_app(selects=[MENU["close"]])
        select = recorder.first("select")
        self.assertIsNotNone(select)
        heading, labels = select[1], select[2]
        self.assertIn(EN[30001], heading)
        self.assertIn("Big Buck Bunny", heading)
        self.assertEqual(len(labels), 7)
        self.assertIn("Big Buck Bunny", labels[0])
        self.assertEqual(labels[1], EN[30004])
        self.assertEqual(labels[6], EN[30009])
        self.assertEqual(recorder.only("ok"), [])
        self.assert_progress_closed(recorder)

    def test_backing_out_of_the_menu_exits_cleanly(self):
        recorder = self.run_app(selects=[-1])
        self.assertEqual(len(recorder.only("select")), 1)
        self.assertEqual(recorder.only("ok"), [])

    def test_now_playing_shows_a_scrolling_detail_view(self):
        recorder = self.run_app(selects=[MENU["now_playing"], MENU["close"]])
        viewer = recorder.first("textviewer")
        self.assertIsNotNone(viewer)
        self.assertIn("Big Buck Bunny", viewer[2])
        self.assertIn("3:12 / 10:34", viewer[2])
        self.assertIn("42", viewer[2])

    def test_now_playing_when_idle(self):
        self.stub.state_payload["nowPlaying"] = None
        recorder = self.run_app(selects=[MENU["now_playing"], MENU["close"]])
        self.assertEqual(recorder.messages(), [EN[30010]])

    def test_odd_state_shape_is_tolerated(self):
        self.stub.state_payload["nowPlaying"] = "not an object"
        self.stub.state_payload["picks"] = 42
        recorder = self.run_app(selects=[MENU["now_playing"], MENU["close"]])
        select = recorder.first("select")
        self.assertEqual(select[2][0], EN[30003])
        self.assertEqual(recorder.first("ok")[2][0], EN[30010])


class AskTests(FlowTestCase):
    def test_ask_sends_the_question_and_shows_the_answer(self):
        self.stub.reply_text = "Starting Big Buck Bunny (2010)."
        recorder = self.run_app(
            selects=[MENU["ask"], MENU["close"]],
            inputs=["play something funny"],
        )
        ask = self.stub.last("POST", "/tv/ask")
        self.assertEqual(ask["body"], {"text": "play something funny"})
        input_call = recorder.first("input")
        self.assertEqual(input_call[1], EN[30029])
        self.assertEqual(input_call[3], 1, "Dialog().input must use INPUT_ALPHANUM")

        viewer = recorder.first("textviewer")
        self.assertIsNotNone(viewer)
        self.assertEqual(viewer[1], EN[30025])
        self.assertIn("Big Buck Bunny", viewer[2])
        self.assertEqual(self.stub.last("POST", "/tv/seen")["body"], {"id": 4243})
        self.assertEqual(recorder.only("ok"), [])
        self.assert_progress_closed(recorder)

    def test_ask_429_keeps_waiting_for_the_pending_answer(self):
        self.stub.ask_status = 429
        self.stub.reply_text = "Here is the answer to your earlier question."
        recorder = self.run_app(selects=[MENU["ask"], MENU["close"]], inputs=["hello again"])
        self.assertEqual(recorder.only("ok"), [])
        viewer = recorder.first("textviewer")
        self.assertIsNotNone(viewer)
        self.assertIn("earlier question", viewer[2])
        notification = recorder.first("notification")
        self.assertEqual(notification[2], EN[30027])

    def test_ask_backing_out_of_the_keyboard_sends_nothing(self):
        recorder = self.run_app(selects=[MENU["ask"], MENU["close"]], inputs=[])
        self.assertEqual(self.stub.calls("POST", "/tv/ask"), [])
        self.assertEqual(recorder.only("textviewer"), [])

    def test_ask_timeout_reports_no_answer(self):
        # The settings layer clamps to a 3 s minimum; that is the shortest
        # honest end-to-end exercise of the deadline path.
        self.stub.reply_ready_after = 10 ** 6
        recorder = self.run_app(
            selects=[MENU["ask"], MENU["close"]],
            inputs=["anything"],
            settings={"timeout": "3"},
        )
        self.assertEqual(recorder.messages(), [EN[30026]])
        self.assert_progress_closed(recorder)

    def test_ask_auth_failure_is_explained(self):
        self.stub.ask_status = 401
        self.stub.ask_error = {"error": "invalid token"}
        recorder = self.run_app(selects=[MENU["ask"], MENU["close"]], inputs=["hello"])
        self.assertEqual(recorder.messages(), [EN[30042]])

    def test_direct_ask_from_a_shortcut_runs_before_the_menu(self):
        recorder = self.run_app(selects=[MENU["close"]], inputs=["hi"], argv=["ask"])
        self.assertIsNotNone(recorder.first("textviewer"))
        self.assertEqual(len(recorder.only("select")), 1)


class PicksTests(FlowTestCase):
    def test_picks_play_the_chosen_item(self):
        recorder = self.run_app(selects=[MENU["picks"], 0, MENU["close"]])
        action = self.stub.last("POST", "/tv/action")
        self.assertEqual(action["body"], {"action": "play", "value": {"kind": "movie", "id": 11}})
        notification = recorder.first("notification")
        self.assertEqual(notification[2], EN[30062])
        self.assertEqual(recorder.only("ok"), [])

    def test_picks_rows_carry_reason_and_runtime(self):
        recorder = self.run_app(selects=[MENU["picks"], -1, MENU["close"]])
        rows = recorder.only("select")[1][2]
        self.assertEqual(len(rows), 2)
        self.assertIn("Big Buck Bunny", rows[0])
        self.assertIn("resume at 3:12", rows[0])
        self.assertIn("11 min", rows[0])
        self.assertIn("short enough for the evening", rows[1])
        self.assertIn("45 min", rows[1])

    def test_resume_only_lists_resumable_items(self):
        recorder = self.run_app(selects=[MENU["resume"], 0, MENU["close"]])
        rows = recorder.only("select")[1][2]
        self.assertEqual(len(rows), 1)
        self.assertIn("3:12", rows[0])
        action = self.stub.last("POST", "/tv/action")
        self.assertEqual(action["body"]["value"], {"kind": "movie", "id": 11})

    def test_no_picks_is_explained(self):
        self.stub.state_payload["picks"] = {"picks": []}
        recorder = self.run_app(selects=[MENU["picks"], MENU["close"]])
        self.assertEqual(recorder.messages(), [EN[30060]])

    def test_nothing_to_resume_is_explained(self):
        for pick in self.stub.state_payload["picks"]["picks"]:
            pick["resumeAt"] = None
        recorder = self.run_app(selects=[MENU["resume"], MENU["close"]])
        self.assertEqual(recorder.messages(), [EN[30061]])

    def test_backing_out_of_the_pick_list_plays_nothing(self):
        self.run_app(selects=[MENU["picks"], -1, MENU["close"]])
        self.assertEqual(self.stub.calls("POST", "/tv/action"), [])

    def test_bridge_refusing_an_action_is_explained(self):
        self.stub.action_result = {"ok": False, "error": "action not allowed"}
        recorder = self.run_app(selects=[MENU["picks"], 0, MENU["close"]])
        message = recorder.messages()[0]
        self.assertIn(EN[30047].split("{")[0].strip(), message)
        self.assertIn("action not allowed", message)


class RemoteTests(FlowTestCase):
    def test_remote_forward_seeks_ten_minutes(self):
        recorder = self.run_app(selects=[MENU["remote"], 3, MENU["close"]])
        action = self.stub.last("POST", "/tv/action")
        self.assertEqual(action["body"], {"action": "skip", "value": 600})
        self.assertEqual(recorder.only("ok"), [])

    def test_remote_playpause(self):
        self.run_app(selects=[MENU["remote"], 0, MENU["close"]])
        self.assertEqual(
            self.stub.last("POST", "/tv/action")["body"],
            {"action": "playpause", "value": None},
        )

    def test_remote_backs_out_without_calling_the_bridge(self):
        self.run_app(selects=[MENU["remote"], -1, MENU["close"]])
        self.assertEqual(self.stub.calls("POST", "/tv/action"), [])


class FailureTests(FlowTestCase):
    def test_bridge_down_is_a_localized_dialog_not_a_traceback(self):
        port = _support.closed_port()
        recorder = self.run_app(
            settings={"bridge_url": "http://127.0.0.1:%d" % port},
            selects=[-1],
        )
        self.assertEqual(len(recorder.only("ok")), 1)
        ok = recorder.first("ok")
        self.assertEqual(ok[1], EN[30050])
        self.assertIn(EN[30041].split("{")[0].strip(), ok[2][0])
        self.assertNotIn("Traceback", ok[2][0])
        logged = " ".join(message for _level, message in self.fakes.logs)
        self.assertIn("bridge failure", logged)
        self.assertNotIn("Traceback", logged)
        self.assert_progress_closed(recorder)

    def test_progress_dialog_closes_even_when_the_call_fails(self):
        self.stub.state_status = 500
        recorder = self.run_app(selects=[-1])
        self.assert_progress_closed(recorder)
        self.assertEqual(len(recorder.only("ok")), 1)
        self.assertEqual(recorder.first("ok")[2][0], EN[30044])

    def test_malformed_json_is_explained(self):
        self.stub.state_bad_json = True
        recorder = self.run_app(selects=[-1])
        self.assertEqual(recorder.first("ok")[2][0], EN[30045])

    def test_invalid_bridge_url_is_explained(self):
        recorder = self.run_app(settings={"bridge_url": "not a url"}, selects=[MENU["close"]])
        # The menu opens first; the configuration error appears on use.
        self.assertEqual(recorder.only("ok"), [])
        recorder = self.run_app(settings={"bridge_url": "not a url"}, selects=[MENU["now_playing"], MENU["close"]])
        self.assertEqual(recorder.first("ok")[2][0], EN[30040])

    def test_settings_shortcut_opens_kodi_settings(self):
        recorder = self.run_app(selects=[MENU["settings"], MENU["close"]])
        self.assertEqual(len(recorder.only("openSettings")), 1)
        self.assertEqual(recorder.only("ok"), [])

    def test_settings_change_is_picked_up(self):
        recorder = self.run_app(
            selects=[MENU["settings"], MENU["close"]],
            settings={"bridge_url": "http://127.0.0.1:%d" % _support.closed_port()},
        )
        # After settings the add-on rebuilds its client; going back must not
        # raise, and no bridge call may have escaped as a traceback.
        self.assertEqual(recorder.only("openSettings"), [("openSettings",)])
        for message in recorder.messages():
            self.assertNotIn("Traceback", message)



class SettingsTests(FlowTestCase):
    """The settings path on a profile that never saved a setting (the default
    path), on Kodi's two settings APIs, and when the settings API breaks."""

    def test_fresh_profile_gets_the_documented_defaults(self):
        self.fakes.reset(settings={}, selects=[MENU["close"]])
        app = default.App(default.xbmcaddon.Addon(default.ADDON_ID))
        self.assertIsNotNone(app.client)
        self.assertEqual(app.client.endpoint, "http://127.0.0.1:8760")
        self.assertEqual(app.client.timeout, 60.0)
        self.assertEqual(app.client.token, "")

    def test_getsettingint_answering_zero_falls_back_to_60(self):
        self.fakes.reset(settings={}, selects=[MENU["close"]])
        reader = default.screen.settings_reader(
            default.xbmcaddon.Addon(default.ADDON_ID),
            integer_keys=(default.bridge.SETTING_TIMEOUT,),
        )
        config = default.bridge.Config.from_mapping(reader)
        self.assertEqual(config.base_url, "http://127.0.0.1:8760")
        self.assertEqual(config.timeout, 60.0)

    def test_typed_getters_are_preferred(self):
        class Typed(object):
            def getSettingString(self, key):
                return {"bridge_url": "http://10.0.0.5:9000", "bridge_token": "abc"}.get(key, "")

            def getSettingInt(self, key):
                return 45

            def getSetting(self, key):
                raise AssertionError("the legacy getter must not be needed")

        reader = default.screen.settings_reader(Typed(), integer_keys=("timeout",))
        config = default.bridge.Config.from_mapping(reader)
        self.assertEqual(config.base_url, "http://10.0.0.5:9000")
        self.assertEqual(config.token, "abc")
        self.assertEqual(config.timeout, 45.0)

    def test_legacy_only_addon_still_works(self):
        class Legacy(object):
            def getSetting(self, key):
                return {"bridge_url": "http://127.0.0.1:8761", "timeout": "30"}.get(key, "")

        reader = default.screen.settings_reader(Legacy(), integer_keys=("timeout",))
        config = default.bridge.Config.from_mapping(reader)
        self.assertEqual(config.base_url, "http://127.0.0.1:8761")
        self.assertEqual(config.timeout, 30.0)

    def test_a_raising_settings_api_is_tolerated(self):
        class Broken(object):
            def getSettingString(self, key):
                raise RuntimeError("settings manager is down")

            def getSetting(self, key):
                raise RuntimeError("settings manager is down")

        reader = default.screen.settings_reader(Broken(), integer_keys=("timeout",))
        config = default.bridge.Config.from_mapping(reader)
        self.assertEqual(config.base_url, "http://127.0.0.1:8760")
        self.assertEqual(config.timeout, 60.0)

    def test_effective_config_is_logged_for_support(self):
        self.fakes.reset(settings={}, selects=[MENU["close"]])
        default.App(default.xbmcaddon.Addon(default.ADDON_ID))
        logged = " ".join(message for _level, message in self.fakes.logs)
        self.assertIn("http://127.0.0.1:8760", logged)
        self.assertIn("timeout 60s", logged)
        self.assertIn("token unset", logged)

    def test_invalid_url_leaves_no_client(self):
        self.fakes.reset(settings={"bridge_url": "nope"}, selects=[MENU["close"]])
        app = default.App(default.xbmcaddon.Addon(default.ADDON_ID))
        self.assertIsNone(app.client)


if __name__ == "__main__":
    unittest.main(verbosity=2)
