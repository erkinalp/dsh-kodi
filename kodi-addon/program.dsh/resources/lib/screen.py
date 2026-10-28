# -*- coding: utf-8 -*-
"""Kodi GUI boundary for program.dsh.

This module (plus ``default.py``) is the only place that imports ``xbmc*``.
Everything it shows comes in as an already-localized string, so the dialog code
has no English of its own and every helper is a thin, exception-proof wrapper
around one ``xbmcgui`` call.

Two rules, both enforced here:

* a progress dialog is created and closed by a context manager, so it cannot
  stay on screen when a bridge call raises;
* no ``xbmcgui`` failure escapes - a broken dialog degrades to "nothing shown"
  plus a line in kodi.log, never to Kodi's traceback popup.
"""

from __future__ import annotations

import xbmc
import xbmcgui


def log(message, level=None):
    """Write to kodi.log; never raise."""
    try:
        xbmc.log("[program.dsh] %s" % (message,), xbmc.LOGINFO if level is None else level)
    except Exception:  # noqa: BLE001 - logging must not break the add-on
        pass


def log_exception(prefix=u"unexpected failure"):
    """Log the current traceback (goes to kodi.log, never to the TV)."""
    import traceback

    try:
        log("%s:\n%s" % (prefix, traceback.format_exc()), xbmc.LOGERROR)
    except Exception:  # noqa: BLE001
        pass


INPUT_ALPHANUM = getattr(xbmcgui, "INPUT_ALPHANUM", 0)


class Progress(object):
    """Context manager around ``xbmcgui.DialogProgress``.

    ``update``/``cancelled`` are safe to call even if the dialog could not be
    created, which keeps the polling loop free of special cases.
    """

    def __init__(self, heading, dialog_class=None):
        self._heading = heading
        self._class = dialog_class or xbmcgui.DialogProgress
        self._progress = None

    def __enter__(self):
        try:
            self._progress = self._class()
            self._progress.create(self._heading, u"")
        except Exception:  # noqa: BLE001
            log_exception(u"could not create the progress dialog")
            self._progress = None
        return self

    def update(self, percent, message=u""):
        if self._progress is None:
            return
        try:
            self._progress.update(int(percent), message)
        except Exception:  # noqa: BLE001
            pass

    def cancelled(self):
        if self._progress is None:
            return False
        try:
            return bool(self._progress.iscanceled())
        except Exception:  # noqa: BLE001
            return False

    def close(self):
        if self._progress is None:
            return
        try:
            self._progress.close()
        except Exception:  # noqa: BLE001
            pass
        self._progress = None

    def __exit__(self, exc_type, exc_value, tb):
        self.close()
        return False


def read_setting(addon, key, kind="string"):
    """Read one add-on setting across Kodi's two settings APIs.

    Kodi 19+ exposes ``getSettingString``/``getSettingInt`` (used by the
    settings v2 XML), older builds only ``getSetting``.  Trying the typed getter
    first and falling back keeps the add-on working on both - and, importantly,
    an unset setting must come back as ``''`` (not ``None``/``0``) so the caller
    can apply the documented default.
    """
    if kind == "int":
        names = ("getSettingInt", "getSettingString", "getSetting")
    else:
        names = ("getSettingString", "getSetting")
    for name in names:
        getter = getattr(addon, name, None)
        if getter is None:
            continue
        try:
            value = getter(key)
        except Exception:  # noqa: BLE001 - a settings failure must not abort startup
            continue
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        # getSettingInt answers 0 for a setting it does not know; that is
        # indistinguishable from "unset", and 0 is outside the schema's range,
        # so keep looking instead of forcing a zero timeout on the user.
        if kind == "int" and isinstance(value, int) and value == 0:
            continue
        return value
    return ""


def settings_reader(addon, integer_keys=()):
    """``key -> value`` callable for ``Config.from_mapping``."""
    integer_keys = tuple(integer_keys)

    def read(key):
        return read_setting(addon, key, "int" if key in integer_keys else "string")

    return read


class Screen(object):
    """Everything program.dsh is allowed to do to Kodi's GUI."""

    def __init__(self, addon, text, dialog=None):
        self._addon = addon
        self._text = text
        self._dialog = dialog if dialog is not None else xbmcgui.Dialog()

    # -- dialogs ----------------------------------------------------------
    def ok(self, heading, message, detail=u""):
        """Modal message box.  ``detail`` becomes the optional second line."""
        lines = [message]
        if detail:
            lines.append(detail)
        try:
            return self._dialog.ok(heading, *lines)
        except Exception:  # noqa: BLE001
            log_exception(u"could not show a message box")
            return False

    def select(self, heading, labels):
        """Index chosen, or ``-1`` for cancel/back."""
        items = list(labels)
        if not items:
            return -1
        try:
            return self._dialog.select(heading, items)
        except Exception:  # noqa: BLE001
            log_exception(u"could not show a selection dialog")
            return -1

    def ask_text(self, heading):
        """On-screen keyboard; returns ``''`` when the user backs out."""
        try:
            return self._dialog.input(heading, u"", type=INPUT_ALPHANUM) or u""
        except TypeError:
            # Older/alternative Dialog.input signatures.
            try:
                return self._dialog.input(heading, u"", INPUT_ALPHANUM) or u""
            except Exception:  # noqa: BLE001
                log_exception(u"could not show the keyboard")
                return u""
        except Exception:  # noqa: BLE001
            log_exception(u"could not show the keyboard")
            return u""

    def viewer(self, heading, body):
        """Scrollable text viewer - the right control for a long answer."""
        try:
            return self._dialog.textviewer(heading, body)
        except Exception:  # noqa: BLE001
            log_exception(u"could not show the text viewer")
            return False

    def notify(self, heading, message, time_ms=4000):
        try:
            self._dialog.notification(heading, message, xbmcgui.NOTIFICATION_INFO, time_ms)
        except Exception:  # noqa: BLE001
            log_exception(u"could not show a notification")

    def progress(self, heading, dialog_class=None):
        """``with screen.progress(heading) as progress:``"""
        return Progress(heading, dialog_class)

    # -- add-on plumbing --------------------------------------------------
    def open_settings(self):
        try:
            self._addon.openSettings()
            return True
        except Exception:  # noqa: BLE001
            log_exception(u"could not open the add-on settings")
            return False
