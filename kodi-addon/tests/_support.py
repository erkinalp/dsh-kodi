# -*- coding: utf-8 -*-
"""Shared, dependency-free helpers for the add-on's tests.

Deliberately stdlib-only: the tests must run in plain CPython on a machine with
no Kodi, no TV and no third-party packages.
"""

from __future__ import annotations

import io
import os
import socket

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
ADDON_DIR = os.path.dirname(TESTS_DIR)
PACKAGE_DIR = os.path.join(ADDON_DIR, "program.dsh")
LIB_DIR = os.path.join(PACKAGE_DIR, "resources", "lib")
RESOURCES_DIR = os.path.join(PACKAGE_DIR, "resources")
LANGUAGES = ("en_gb", "tr_tr")


def po_path(language):
    return os.path.join(
        RESOURCES_DIR,
        "language",
        "resource.language.%s" % language,
        "strings.po",
    )


def addon_xml_path():
    return os.path.join(PACKAGE_DIR, "addon.xml")


def settings_xml_path():
    return os.path.join(RESOURCES_DIR, "settings.xml")


def _unquote(text):
    """Undo the C-style escapes a .po string may contain (UTF-8 safe)."""
    out = []
    index = 0
    escapes = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "r": "\r"}
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            following = text[index + 1]
            out.append(escapes.get(following, following))
            index += 2
        else:
            out.append(char)
            index += 1
    return "".join(out)


def _quoted(line):
    """The quoted payload of a .po line (``msgid "text"`` -> ``text``)."""
    start = line.find('"')
    if start < 0:
        return ""
    end = line.rfind('"')
    if end <= start:
        end = len(line)
    return _unquote(line[start + 1:end])


def _sid(line):
    value = _quoted(line).strip()
    if value.startswith("#"):
        value = value[1:]
    try:
        return int(value)
    except ValueError:
        return None


def _flush(entries, current):
    if current is not None and current.get("id") is not None:
        entries[current["id"]] = {"msgid": current["msgid"], "msgstr": current["msgstr"]}


def parse_po(path):
    """Parse a Kodi ``strings.po`` into ``{id: {'msgid': str, 'msgstr': str}}``."""
    entries = {}
    current = None
    field = None
    with io.open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("msgctxt"):
                _flush(entries, current)
                current = {"id": _sid(line), "msgid": "", "msgstr": ""}
                field = None
            elif line.startswith("msgid"):
                if current is not None:
                    current["msgid"] = _quoted(line)
                field = "msgid"
            elif line.startswith("msgstr"):
                if current is not None:
                    current["msgstr"] = _quoted(line)
                field = "msgstr"
            elif line.startswith('"') and current is not None and field:
                current[field] += _quoted(line)
    _flush(entries, current)
    return entries


def strings(language="en_gb"):
    """``{id: translated text}`` for one language."""
    table = parse_po(po_path(language))
    return dict((sid, entry["msgstr"] or entry["msgid"]) for sid, entry in table.items())


def closed_port():
    """A loopback TCP port that nothing is listening on."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()
