# -*- coding: utf-8 -*-
"""Headless tests for the pure layer: ``resources/lib/ui.py``, the string
tables, ``addon.xml`` and ``settings.xml``.

Nothing here imports Kodi, so it runs in plain CPython:

    python3 -m unittest discover -s kodi-addon/tests -v
"""

from __future__ import annotations

import ast
import os
import re
import sys
import unittest
import xml.etree.ElementTree as ElementTree

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

import _support  # noqa: E402

if _support.LIB_DIR not in sys.path:
    sys.path.insert(0, _support.LIB_DIR)

import bridge  # noqa: E402
import ui  # noqa: E402

EN = _support.strings("en_gb")
TR = _support.strings("tr_tr")

PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")


def text_for(language="en_gb"):
    table = EN if language == "en_gb" else TR
    return ui.Text(table.get)


TEXT = text_for()


class FormattingTests(unittest.TestCase):
    def test_format_seconds(self):
        self.assertEqual(ui.format_seconds(0), "0:00")
        self.assertEqual(ui.format_seconds(243), "4:03")
        self.assertEqual(ui.format_seconds(3723), "1:02:03")
        self.assertEqual(ui.format_seconds("95"), "1:35")
        self.assertEqual(ui.format_seconds(59.6), "1:00")
        self.assertEqual(ui.format_seconds(None), "0:00")
        self.assertEqual(ui.format_seconds(-30), "0:00")
        self.assertEqual(ui.format_seconds("soon"), "0:00")

    def test_percent_of(self):
        self.assertEqual(ui.percent_of(192, 634), 30)
        self.assertEqual(ui.percent_of(634, 634), 100)
        self.assertEqual(ui.percent_of(999, 634), 100)
        self.assertIsNone(ui.percent_of(10, 0))
        self.assertIsNone(ui.percent_of(None, 100))

    def test_truncate(self):
        self.assertEqual(ui.truncate("Big Buck Bunny", 40), "Big Buck Bunny")
        self.assertEqual(ui.truncate("  Big   Buck   Bunny  ", 40), "Big Buck Bunny")
        shortened = ui.truncate("The Curious Case of Benjamin Button", 20)
        self.assertLessEqual(len(shortened), 20)
        self.assertTrue(shortened.endswith(u"\u2026"))
        self.assertEqual(ui.truncate("", 10), "")
        self.assertEqual(ui.truncate("abc", 0), "abc")
        self.assertEqual(ui.truncate("abcdefgh", 1), u"\u2026")

    def test_clean_reply(self):
        self.assertEqual(ui.clean_reply(None), "")
        self.assertEqual(ui.clean_reply("a\r\nb"), "a\nb")
        self.assertEqual(ui.clean_reply(u"\x1b[31mred\x1b[0m"), "red")
        self.assertEqual(ui.clean_reply("a\n\n\n\n\nb"), "a\n\nb")
        self.assertEqual(ui.clean_reply("tab\there"), "tab    here")
        self.assertEqual(ui.clean_reply("bell\x07"), "bell")
        capped = ui.clean_reply("x" * 500, limit=100)
        self.assertTrue(capped.endswith(u"\u2026"))
        self.assertLessEqual(len(capped), 120)


class StateTests(unittest.TestCase):
    NESTED = {
        "nowPlaying": {
            "playing": True,
            "position": 192,
            "runtime": 634,
            "volume": 42,
            "muted": False,
            "speed": 1,
            "item": {"title": "Big Buck Bunny", "show": "Blender"},
        },
        "queue": [{"id": 1}, {"id": 2}],
    }
    FLAT = {"nowPlaying": {"title": "Flat Item", "position": 10, "total": 100, "volume": 7}}

    def test_now_playing_nested(self):
        playing = ui.now_playing(self.NESTED)
        self.assertEqual(playing["title"], "Big Buck Bunny")
        self.assertEqual(playing["position"], 192)
        self.assertEqual(playing["runtime"], 634)
        self.assertEqual(playing["volume"], 42)
        self.assertEqual(playing["subtitle"], "Blender")
        self.assertFalse(playing["paused"])

    def test_now_playing_flat(self):
        playing = ui.now_playing(self.FLAT)
        self.assertEqual(playing["title"], "Flat Item")
        self.assertEqual(playing["runtime"], 100)

    def test_now_playing_paused(self):
        state = {"nowPlaying": {"title": "X", "playing": False, "runtime": 100, "position": 1}}
        self.assertTrue(ui.now_playing(state)["paused"])
        state = {"nowPlaying": {"title": "X", "speed": 0, "runtime": 100, "position": 1}}
        self.assertTrue(ui.now_playing(state)["paused"])

    def test_now_playing_missing(self):
        self.assertIsNone(ui.now_playing({}))
        self.assertIsNone(ui.now_playing({"nowPlaying": None}))
        self.assertIsNone(ui.now_playing({"nowPlaying": {}}))
        self.assertIsNone(ui.now_playing(None))
        self.assertIsNone(ui.now_playing({"nowPlaying": {"position": 3}}))

    def test_queue_length(self):
        self.assertEqual(ui.queue_length({"queue": [1, 2, 3]}), 3)
        self.assertEqual(ui.queue_length({"queue": {"items": [1, 2]}}), 2)
        self.assertEqual(ui.queue_length({"queue": {"count": 9}}), 9)
        self.assertIsNone(ui.queue_length({}))
        self.assertIsNone(ui.queue_length(None))

    def test_picks_nested_and_bare(self):
        nested = {"picks": {"generatedAt": "x", "picks": [{"id": 1, "kind": "movie", "title": "A"}]}}
        self.assertEqual(len(ui.picks_from_state(nested)), 1)
        bare = {"picks": [{"id": 2, "kind": "episode", "title": "B"}]}
        self.assertEqual(ui.picks_from_state(bare)[0]["id"], 2)

    def test_picks_drop_junk_and_duplicates(self):
        state = {
            "picks": [
                {"id": 1, "kind": "movie", "title": "A"},
                {"id": 1, "kind": "movie", "title": "A"},
                {"id": None, "kind": "movie", "title": ""},
                "not a pick",
                17,
                {"id": 2, "kind": "song", "title": "C", "resumeAt": "30"},
            ]
        }
        picks = ui.picks_from_state(state)
        self.assertEqual([pick["id"] for pick in picks], [1, 2])
        self.assertEqual(picks[1]["resumeAt"], 30)
        self.assertEqual(ui.picks_from_state({"picks": "nope"}), [])
        self.assertEqual(ui.picks_from_state(None), [])

    def test_resumable(self):
        picks = [
            {"id": 1, "resumeAt": 192},
            {"id": 2, "resumeAt": None},
            {"id": 3, "resumeAt": 0},
            {"id": 4, "resumeAt": "45"},
        ]
        self.assertEqual([pick["id"] for pick in ui.resumable(picks)], [1, 4])

    def test_last_reply_id(self):
        self.assertEqual(ui.last_reply_id({"lastReply": {"id": 7}}), 7)
        self.assertIsNone(ui.last_reply_id({"lastReply": None}))
        self.assertIsNone(ui.last_reply_id({}))


class LabelTests(unittest.TestCase):
    def test_status_label_playing(self):
        label = ui.status_label(StateTests.NESTED, TEXT)
        self.assertIn("Big Buck Bunny", label)
        self.assertIn("3:12 / 10:34", label)

    def test_status_label_without_runtime(self):
        label = ui.status_label({"nowPlaying": {"title": "X", "position": 5}}, TEXT)
        self.assertEqual(label, EN[ui.SID["playing_title"]].format(title="X"))

    def test_status_label_paused(self):
        state = {"nowPlaying": {"title": "X", "playing": False, "position": 5, "runtime": 100}}
        self.assertTrue(ui.status_label(state, TEXT).startswith(EN[ui.SID["paused_line"]].split("{")[0]))

    def test_status_label_idle_and_offline(self):
        self.assertEqual(ui.status_label({}, TEXT), EN[ui.SID["menu_nothing_playing"]])
        offline = ui.status_label(None, TEXT, offline=True)
        self.assertIn(EN[ui.SID["menu_now_playing"]], offline)
        self.assertIn(EN[ui.SID["bridge_offline"]], offline)

    def test_menu_rows_order_and_labels(self):
        rows = ui.menu_rows(StateTests.NESTED, TEXT)
        self.assertEqual([key for key, _label in rows], list(ui.MENU_KEYS))
        labels = dict(rows)
        self.assertEqual(labels["ask"], EN[ui.SID["menu_ask"]])
        self.assertEqual(labels["close"], EN[ui.SID["menu_close"]])
        self.assertIn("Big Buck Bunny", labels["now_playing"])
        for _key, label in rows:
            self.assertTrue(label.strip())

    def test_menu_heading_carries_the_status(self):
        heading = ui.menu_heading(StateTests.NESTED, TEXT)
        self.assertTrue(heading.startswith(EN[ui.SID["main_heading"]]))
        self.assertIn("Big Buck Bunny", heading)

    def test_turkish_labels_are_localized(self):
        tr_text = text_for("tr_tr")
        rows = dict(ui.menu_rows(StateTests.NESTED, tr_text))
        self.assertEqual(rows["ask"], TR[ui.SID["menu_ask"]])
        self.assertNotEqual(rows["ask"], EN[ui.SID["menu_ask"]])

    def test_now_playing_lines(self):
        lines = ui.now_playing_lines(StateTests.NESTED, TEXT)
        self.assertEqual(lines[0], "Big Buck Bunny")
        self.assertIn("Blender", lines)
        self.assertTrue(any("3:12 / 10:34" in line for line in lines))
        self.assertTrue(any("30" in line and "%" in line for line in lines))
        self.assertTrue(any("42" in line for line in lines))
        self.assertTrue(any("2" in line for line in lines))
        self.assertEqual(ui.now_playing_lines({}, TEXT), [])

    PICKS = {
        "picks": {
            "generatedAt": "2026-10-28T12:00:00Z",
            "picks": [
                {"id": 11, "kind": "movie", "title": "Big Buck Bunny",
                 "reason": "you're 3 minutes in", "runtime": 634, "resumeAt": 192},
                {"id": 12, "kind": "episode", "title": "Cosmos S01E02",
                 "reason": "short enough for the evening", "runtime": 2700},
            ],
        }
    }

    def test_pick_rows_resume_and_reason(self):
        picks = ui.picks_from_state(self.PICKS)
        rows, chosen = ui.pick_rows(picks, TEXT)
        self.assertEqual(len(rows), 2)
        self.assertEqual(chosen[0]["id"], 11)
        self.assertIn("Big Buck Bunny", rows[0])
        self.assertIn("3:12", rows[0])
        self.assertIn("11 min", rows[0])
        self.assertIn("Cosmos S01E02", rows[1])
        self.assertIn("45 min", rows[1])

        rows, chosen = ui.pick_rows(picks, TEXT, resume_only=True)
        self.assertEqual(len(rows), 1)
        self.assertEqual(chosen[0]["id"], 11)

    def test_pick_rows_without_reason_or_runtime(self):
        rows, _chosen = ui.pick_rows([{"id": 1, "title": "Plain", "kind": "movie"}], TEXT)
        self.assertEqual(rows, ["Plain"])

    def test_remote_rows(self):
        rows = ui.remote_rows(TEXT)
        self.assertEqual(len(rows), len(ui.REMOTE_ITEMS))
        actions = [action for _label, action, _value in rows]
        self.assertEqual(actions[0], "playpause")
        self.assertIn("skip", actions)
        values = [value for _label, action, value in rows if action == "skip"]
        self.assertEqual(values, [-600, 600])
        for label, _action, _value in rows:
            self.assertTrue(label.strip())


class TextTests(unittest.TestCase):
    def test_missing_string_is_visible_not_fatal(self):
        text = ui.Text({}.get)
        self.assertEqual(text(99999), "[99999]")

    def test_getter_that_raises(self):
        def explode(_sid):
            raise RuntimeError("no locale")

        self.assertEqual(ui.Text(explode)(30001), "[30001]")

    def test_fields_are_formatted(self):
        self.assertEqual(TEXT(ui.SID["playing_title"], title="A"), "Playing: A")

    def test_bad_placeholder_returns_the_raw_template(self):
        text = ui.Text({1: "needs {missing}"}.get)
        self.assertEqual(text(1, other="x"), "needs {missing}")

    def test_blank_translation_falls_back_to_the_id(self):
        self.assertEqual(ui.Text({1: "   "}.get)(1), "[1]")


class ErrorTests(unittest.TestCase):
    def test_every_failure_kind_is_localized(self):
        for kind in (
            bridge.KIND_CONFIG,
            bridge.KIND_NETWORK,
            bridge.KIND_TIMEOUT,
            bridge.KIND_AUTH,
            bridge.KIND_BUSY,
            bridge.KIND_HTTP,
            bridge.KIND_JSON,
            bridge.KIND_PROTOCOL,
            bridge.KIND_REJECTED,
            bridge.KIND_EMPTY,
        ):
            self.assertIn(kind, ui.ERROR_SID)
            error = bridge.BridgeError(kind, "some detail", status=500, url="http://127.0.0.1:8760")
            message = ui.error_message(TEXT, error)
            self.assertTrue(message.strip())
            self.assertNotIn("{", message)
            self.assertNotIn("Traceback", message)

    def test_unknown_kind_uses_the_generic_message(self):
        error = bridge.BridgeError("something-new")
        self.assertEqual(ui.error_message(TEXT, error), EN[ui.SID["error_internal"]])

    def test_network_message_names_the_url(self):
        error = bridge.BridgeError(bridge.KIND_NETWORK, url="http://127.0.0.1:8760")
        message = ui.error_message(TEXT, error)
        self.assertIn("http://127.0.0.1:8760", message)

    def test_auth_message_is_actionable(self):
        message = ui.error_message(TEXT, bridge.BridgeError(bridge.KIND_AUTH))
        self.assertIn("token", message)
        self.assertNotIn("401", message)

    def test_rejected_message_shows_the_bridge_detail(self):
        error = bridge.BridgeError(bridge.KIND_REJECTED, "action not allowed")
        self.assertIn("action not allowed", ui.error_message(TEXT, error))

    def test_error_detail_is_short_and_optional(self):
        self.assertEqual(ui.error_detail(bridge.BridgeError(bridge.KIND_AUTH)), "")
        self.assertEqual(
            ui.error_detail(bridge.BridgeError(bridge.KIND_NETWORK, "Connection refused")),
            "Connection refused",
        )

    def test_heading_is_localized(self):
        self.assertEqual(ui.error_heading(TEXT), EN[ui.SID["error_heading"]])


class StringTableTests(unittest.TestCase):
    def test_both_languages_define_the_same_ids(self):
        en_ids = set(_support.parse_po(_support.po_path("en_gb")))
        tr_ids = set(_support.parse_po(_support.po_path("tr_tr")))
        self.assertEqual(en_ids, tr_ids)
        self.assertGreater(len(en_ids), 50)

    def test_every_referenced_id_exists_in_both_languages(self):
        used = set(ui.SID.values()) | set(ui.ERROR_SID.values())
        used |= set(int(label) for label in _settings_label_ids())
        en_ids = set(_support.parse_po(_support.po_path("en_gb")))
        tr_ids = set(_support.parse_po(_support.po_path("tr_tr")))
        self.assertEqual(used - en_ids, set(), "missing from en_gb")
        self.assertEqual(used - tr_ids, set(), "missing from tr_tr")

    def test_no_empty_translations(self):
        for language in _support.LANGUAGES:
            table = _support.parse_po(_support.po_path(language))
            for sid, entry in table.items():
                self.assertTrue((entry["msgstr"] or entry["msgid"]).strip(), "%s %s is empty" % (language, sid))

    def test_placeholders_match_between_languages(self):
        for sid, entry in _support.parse_po(_support.po_path("en_gb")).items():
            tr_entry = _support.parse_po(_support.po_path("tr_tr"))[sid]
            self.assertEqual(
                set(PLACEHOLDER.findall(entry["msgid"])),
                set(PLACEHOLDER.findall(tr_entry["msgstr"])),
                "placeholder mismatch for id %s" % sid,
            )

    def test_turkish_is_actually_translated(self):
        differing = [sid for sid, value in TR.items() if EN.get(sid) and value != EN[sid]]
        self.assertGreater(len(differing), 20)

    def test_english_strings_render_without_placeholders_left(self):
        for sid in ui.SID.values():
            template = EN[sid]
            fields = dict((name, "x") for name in PLACEHOLDER.findall(template))
            rendered = template.format(**fields)
            self.assertNotIn("{", rendered)


class ManifestTests(unittest.TestCase):
    def test_addon_xml_is_well_formed_and_targets_kodi_21(self):
        root = ElementTree.parse(_support.addon_xml_path()).getroot()
        self.assertEqual(root.get("id"), "program.dsh")
        self.assertEqual(root.get("name"), "DSH")
        self.assertEqual(root.get("version"), "0.1.0")
        self.assertTrue(root.get("provider-name"))

        requires = [node.get("addon") for node in root.iter("import")]
        self.assertEqual(requires, ["xbmc.python"])
        self.assertEqual(root.find("requires/import").get("version"), "3.0.0")

        scripts = [node for node in root.iter("extension") if node.get("point") == "xbmc.python.script"]
        self.assertEqual(len(scripts), 1)
        self.assertEqual(scripts[0].get("library"), "default.py")

    def test_assets_exist(self):
        root = ElementTree.parse(_support.addon_xml_path()).getroot()
        icon = root.find(".//assets/icon").text
        fanart = root.find(".//assets/fanart").text
        for relative in (icon, fanart):
            path = os.path.join(_support.PACKAGE_DIR, relative)
            self.assertTrue(os.path.isfile(path), path)
            self.assertGreater(os.path.getsize(path), 1024, path)

    def test_settings_xml_has_the_three_settings(self):
        root = ElementTree.parse(_support.settings_xml_path()).getroot()
        self.assertEqual(root.get("version"), "1")
        settings = dict((node.get("id"), node) for node in root.iter("setting"))
        self.assertEqual(
            set(settings),
            {bridge.SETTING_URL, bridge.SETTING_TOKEN, bridge.SETTING_TIMEOUT},
        )

        url = settings[bridge.SETTING_URL]
        self.assertEqual(url.get("type"), "string")
        # Kodi 21 reads the *element* <default>, not a default="..." attribute;
        # an attribute makes CSettingInt/String reject the whole schema.
        self.assertIsNone(url.get("default"))
        self.assertEqual(url.find("default").text, bridge.DEFAULT_BASE_URL)
        self.assertEqual(url.find("control").get("format"), "string")

        token = settings[bridge.SETTING_TOKEN]
        self.assertEqual(token.get("type"), "string")
        self.assertEqual(token.get("option"), "hidden")
        self.assertEqual((token.find("default").text or ""), "")
        self.assertEqual(token.find("constraints/allowempty").text, "true")

        timeout = settings[bridge.SETTING_TIMEOUT]
        self.assertEqual(timeout.get("type"), "integer")
        self.assertEqual(timeout.find("default").text, "60")
        self.assertEqual(timeout.find("constraints/minimum").text, "5")
        self.assertEqual(timeout.find("constraints/maximum").text, "300")

    def test_settings_labels_are_localized(self):
        root = ElementTree.parse(_support.settings_xml_path()).getroot()
        ids = _settings_label_ids(root)
        self.assertEqual(len(ids), 7)
        for sid in ids:
            self.assertIn(int(sid), EN)

    def test_no_third_party_imports_in_the_runtime_package(self):
        allowed = set(getattr(sys, "stdlib_module_names", set())) | {
            "xbmc",
            "xbmcgui",
            "xbmcaddon",
            "xbmcvfs",
            "resources",
        }
        for path in _python_files():
            with open(path, "r", encoding="utf-8") as handle:
                tree = ast.parse(handle.read(), filename=path)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        top = alias.name.split(".")[0]
                        self.assertIn(top, allowed, "%s imports %s" % (path, top))
                elif isinstance(node, ast.ImportFrom):
                    if node.level:
                        continue
                    top = (node.module or "").split(".")[0]
                    self.assertIn(top, allowed, "%s imports %s" % (path, top))


def _settings_label_ids(root=None):
    if root is None:
        root = ElementTree.parse(_support.settings_xml_path()).getroot()
    ids = []
    for node in root.iter():
        for attribute in ("label", "help"):
            value = node.get(attribute)
            if value and value.isdigit():
                ids.append(value)
    return ids


def _python_files():
    files = [os.path.join(_support.PACKAGE_DIR, "default.py")]
    lib = os.path.join(_support.PACKAGE_DIR, "resources", "lib")
    for name in sorted(os.listdir(lib)):
        if name.endswith(".py"):
            files.append(os.path.join(lib, name))
    return files


if __name__ == "__main__":
    unittest.main(verbosity=2)
