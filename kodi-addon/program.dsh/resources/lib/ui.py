# -*- coding: utf-8 -*-
"""Pure presentation helpers for the DSH Kodi add-on.

No ``xbmc*`` imports live here: every function takes a ``text`` callable and
plain data, which keeps the whole module unit-testable in CPython and keeps
``default.py`` small.  The screen layer (``screen.py``) is the only place that
touches Kodi's GUI.

Localization contract: *nothing* in this file contains user-facing English.  A
function that needs words calls ``text(SID['...'], **fields)``; ``SID`` maps
names to ``strings.po`` ids and ``Text`` resolves them through
``xbmcaddon.Addon().getLocalizedString``.  If a string is missing from the .po
the placeholder ``[30012]`` is rendered instead - visible, debuggable, and
never a traceback.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# String ids.  Every id here must exist in BOTH
# resources/language/resource.language.en_gb/strings.po and .../tr_tr/strings.po;
# kodi-addon/tests verifies that.
# ---------------------------------------------------------------------------
SID = {
    "app_name": 30000,
    "main_heading": 30001,
    "menu_now_playing": 30002,
    "menu_nothing_playing": 30003,
    "menu_ask": 30004,
    "menu_picks": 30005,
    "menu_resume": 30006,
    "menu_remote": 30007,
    "menu_settings": 30008,
    "menu_close": 30009,
    "nothing_playing": 30010,
    "playing_title": 30011,
    "time_of_total": 30012,
    "volume": 30013,
    "muted": 30014,
    "queue": 30015,
    "progress": 30016,
    "speed": 30017,
    "connecting": 30018,
    "bridge_host": 30019,
    "playing_line": 30020,
    "paused_line": 30021,
    "bridge_offline": 30022,
    "paused": 30023,
    "waiting_seconds": 30024,
    "answer_heading": 30025,
    "no_answer": 30026,
    "busy_waiting": 30027,
    "cancelled": 30028,
    "ask_prompt": 30029,
    "sending": 30030,
    "reading_state": 30031,
    "empty_message": 30032,
    "working": 30033,
    "err_config": 30040,
    "err_network": 30041,
    "err_auth": 30042,
    "err_timeout": 30043,
    "err_http": 30044,
    "err_json": 30045,
    "err_protocol": 30046,
    "err_rejected": 30047,
    "err_busy": 30048,
    "err_empty": 30049,
    "error_heading": 30050,
    "error_internal": 30051,
    "no_picks": 30060,
    "nothing_to_resume": 30061,
    "sent_to_kodi": 30062,
    "pick_row": 30063,
    "resume_row": 30064,
    "runtime_suffix": 30065,
    "remote_playpause": 30070,
    "remote_stop": 30071,
    "remote_back": 30072,
    "remote_forward": 30073,
    "remote_volume_up": 30074,
    "remote_volume_down": 30075,
    "remote_mute": 30076,
}

#: Bridge failure kind -> string id.  ``bridge.KIND_*`` values are the keys.
ERROR_SID = {
    "config": SID["err_config"],
    "network": SID["err_network"],
    "auth": SID["err_auth"],
    "timeout": SID["err_timeout"],
    "http": SID["err_http"],
    "json": SID["err_json"],
    "protocol": SID["err_protocol"],
    "rejected": SID["err_rejected"],
    "busy": SID["err_busy"],
    "empty": SID["err_empty"],
}

#: Keys of the main menu, in display order.  Labels are resolved per iteration
#: because "Now playing" carries live status.
MENU_KEYS = ("now_playing", "ask", "picks", "resume", "remote", "settings", "close")

#: (label sid, action, value) for the remote submenu.
REMOTE_ITEMS = (
    ("remote_playpause", "playpause", None),
    ("remote_stop", "stop", None),
    ("remote_back", "skip", -600),
    ("remote_forward", "skip", 600),
    ("remote_volume_up", "volume", 5),
    ("remote_volume_down", "volume", -5),
    ("remote_mute", "mute", None),
)

_ELLIPSIS = u"\u2026"
_ANSI = re.compile(u"\x1b\\[[0-9;?]*[ -/]*[@-~]")
_CONTROL = re.compile(u"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Text(object):
    """Localized string lookup with ``str.format`` fields.

    ``getter`` is ``xbmcaddon.Addon().getLocalizedString`` in Kodi and any
    ``sid -> str`` callable in tests.
    """

    def __init__(self, getter):
        self._get = getter

    def raw(self, sid):
        try:
            value = self._get(sid)
        except Exception:  # noqa: BLE001 - a missing table must not crash the UI
            return u""
        if value is None:
            return u""
        return u"%s" % (value,)

    def __call__(self, sid, **fields):
        template = self.raw(sid)
        if not template.strip():
            template = u"[%s]" % (sid,)
        if not fields:
            return template
        try:
            return template.format(**fields)
        except (KeyError, IndexError, ValueError, AttributeError):
            # A translation with a typo in a placeholder still has to show
            # something - fall back to the unformatted template.
            return template


# ---------------------------------------------------------------------------
# small value helpers
# ---------------------------------------------------------------------------
def _number(value):
    """Coerce to int/float, or None.  Booleans are not numbers here."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        text = str(value).strip().replace(",", ".")
    except Exception:  # noqa: BLE001
        return None
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _int(value):
    number = _number(value)
    if number is None:
        return None
    try:
        return int(number)
    except (OverflowError, ValueError):
        return None


def _first_text(*values):
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return u""


def _first_number(*values):
    for value in values:
        number = _number(value)
        if number is not None:
            return number
    return None


def format_seconds(value):
    """``243`` -> ``4:03``, ``3723`` -> ``1:02:03``; junk -> ``0:00``."""
    number = _number(value)
    total = int(round(number)) if number is not None and number > 0 else 0
    hours, rem = divmod(total, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours:
        return u"%d:%02d:%02d" % (hours, minutes, seconds)
    return u"%d:%02d" % (minutes, seconds)


def truncate(value, limit=44):
    """Collapse whitespace and shorten with an ellipsis, on a word boundary."""
    text = _first_text(value if isinstance(value, str) else u"")
    if not text:
        return u""
    text = u" ".join(text.split())
    if limit is None or limit <= 0 or len(text) <= limit:
        return text
    if limit <= 1:
        return _ELLIPSIS
    budget = limit - 1
    cut = text[:budget]
    space = cut.rfind(u" ")
    if space >= budget // 2:
        cut = cut[:space]
    return cut.rstrip(u" ,.;:-") + _ELLIPSIS


def percent_of(position, total):
    pos = _number(position)
    dur = _number(total)
    if pos is None or dur is None or dur <= 0:
        return None
    value = int(round((pos / float(dur)) * 100.0))
    return max(0, min(100, value))


def clean_reply(value, limit=200000):
    """Make agent output safe for ``Dialog().textviewer``.

    Strips ANSI escapes and control characters, normalizes CRLF, collapses runs
    of blank lines, and caps pathological sizes.  Markdown is left alone: on a
    TV a literal ``**bold**`` is less confusing than a half-stripped line.
    """
    if value is None:
        return u""
    text = u"%s" % (value,)
    text = text.replace(u"\r\n", u"\n").replace(u"\r", u"\n")
    text = _ANSI.sub(u"", text)
    text = _CONTROL.sub(u"", text)
    text = text.replace(u"\t", u"    ")
    lines = [line.rstrip() for line in text.split(u"\n")]
    out = []
    blanks = 0
    for line in lines:
        if line:
            blanks = 0
            out.append(line)
            continue
        blanks += 1
        if blanks <= 1:
            out.append(line)
    text = u"\n".join(out).strip()
    if limit and len(text) > limit:
        text = text[:limit].rstrip() + u"\n" + _ELLIPSIS
    return text


# ---------------------------------------------------------------------------
# /tv/state shaping
# ---------------------------------------------------------------------------
def now_playing(state):
    """Normalize ``state['nowPlaying']`` into a dict, or ``None``.

    Tolerates both shapes the bridge may send: a nested ``item`` object (the
    KodiService snapshot) and a flat ``{title, position, runtime, volume}``.
    """
    if not isinstance(state, dict):
        return None
    raw = state.get("nowPlaying")
    if not isinstance(raw, dict) or not raw:
        return None
    item = raw.get("item") if isinstance(raw.get("item"), dict) else {}
    title = _first_text(
        item.get("title"),
        item.get("label"),
        raw.get("title"),
        raw.get("label"),
    )
    if not title:
        return None

    position = _first_number(raw.get("position"), raw.get("time"), item.get("position"))
    runtime = _first_number(
        raw.get("runtime"),
        raw.get("total"),
        raw.get("duration"),
        item.get("runtime"),
        item.get("duration"),
    )
    speed = _first_number(raw.get("speed"))
    playing = raw.get("playing")
    paused = (playing is False) or (speed is not None and speed == 0)

    return {
        "title": title,
        "subtitle": _first_text(item.get("subtitle"), item.get("show"), raw.get("subtitle")),
        "position": position,
        "runtime": runtime,
        "volume": _int(_first_number(raw.get("volume"), (state.get("volume") if isinstance(state, dict) else None))),
        "muted": bool(raw.get("muted")) if raw.get("muted") is not None else None,
        "speed": speed,
        "paused": paused,
        "thumbnail": item.get("thumbnail") or raw.get("thumbnail") or None,
    }


def queue_length(state):
    """Number of queued items, or ``None`` when the bridge did not say."""
    if not isinstance(state, dict):
        return None
    queue = state.get("queue")
    if queue is None:
        return None
    if isinstance(queue, (list, tuple)):
        return len(queue)
    if isinstance(queue, dict):
        items = queue.get("items")
        if isinstance(items, (list, tuple)):
            return len(items)
        return _int(queue.get("count"))
    return None


def reply_id(reply):
    if isinstance(reply, dict):
        return reply.get("id")
    return None


def last_reply_id(state):
    """Id of the newest reply the bridge knows about (used to resume a wait)."""
    if not isinstance(state, dict):
        return None
    last = state.get("lastReply")
    if isinstance(last, dict):
        return last.get("id")
    return None


def picks_from_state(state):
    """Normalized picks: ``[{id, kind, title, reason, runtime, resumeAt, thumbnail}]``.

    Accepts ``picks: {generatedAt, picks: [...]}`` (the ``makePicks`` shape) or a
    bare list.  Entries without a title or an id are dropped; duplicates are
    removed by ``(kind, id)``.
    """
    if not isinstance(state, dict):
        return []
    raw = state.get("picks")
    if isinstance(raw, dict):
        raw = raw.get("picks")
    if not isinstance(raw, (list, tuple)):
        return []

    picks = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        title = _first_text(entry.get("title"), entry.get("label"))
        ident = entry.get("id")
        if not title and ident is None:
            continue
        kind = _first_text(entry.get("kind"), entry.get("type")) or u"movie"
        key = (kind, ident, title)
        if key in seen:
            continue
        seen.add(key)
        picks.append(
            {
                "id": ident,
                "kind": kind,
                "title": title,
                "reason": _first_text(entry.get("reason")),
                "runtime": _int(entry.get("runtime")),
                "resumeAt": _int(entry.get("resumeAt")),
                "thumbnail": entry.get("thumbnail") or None,
            }
        )
    return picks


def resumable(picks):
    """Picks that carry a resume position (``resumeAt`` > 0)."""
    out = []
    for pick in picks or ():
        resume_at = _number(pick.get("resumeAt"))
        if resume_at is not None and resume_at > 0:
            out.append(pick)
    return out


# ---------------------------------------------------------------------------
# labels built from state
# ---------------------------------------------------------------------------
def status_label(state, text, offline=False):
    """One-line status: what is playing, or why there is nothing to show."""
    if offline or not isinstance(state, dict):
        label = text(SID["menu_now_playing"])
        if offline:
            label = label + u" \u00b7 " + text(SID["bridge_offline"])
        return label
    playing = now_playing(state)
    if not playing:
        return text(SID["menu_nothing_playing"])
    title = truncate(playing["title"], 40)
    has_total = _number(playing.get("runtime")) not in (None, 0)
    if has_total:
        key = "paused_line" if playing.get("paused") else "playing_line"
        return text(
            SID[key],
            title=title,
            time=format_seconds(playing.get("position")),
            total=format_seconds(playing.get("runtime")),
        )
    return text(SID["playing_title"], title=title)


def menu_heading(state, text, offline=False):
    """Dialog heading that doubles as a status line while the menu is open."""
    return text(SID["main_heading"]) + u" \u00b7 " + status_label(state, text, offline=offline)


def menu_rows(state, text, offline=False):
    """``[(key, label)]`` for the main menu, in ``MENU_KEYS`` order."""
    return [
        ("now_playing", status_label(state, text, offline=offline)),
        ("ask", text(SID["menu_ask"])),
        ("picks", text(SID["menu_picks"])),
        ("resume", text(SID["menu_resume"])),
        ("remote", text(SID["menu_remote"])),
        ("settings", text(SID["menu_settings"])),
        ("close", text(SID["menu_close"])),
    ]


def now_playing_lines(state, text):
    """Multi-line detail for the Now-playing dialog (empty when idle)."""
    playing = now_playing(state)
    if not playing:
        return []
    lines = [playing["title"]]
    if playing["subtitle"]:
        lines.append(playing["subtitle"])
    if _number(playing.get("runtime")) not in (None, 0):
        lines.append(
            text(
                SID["time_of_total"],
                time=format_seconds(playing.get("position")),
                total=format_seconds(playing.get("runtime")),
            )
        )
        percent = percent_of(playing.get("position"), playing.get("runtime"))
        if percent is not None:
            lines.append(text(SID["progress"], percent=percent))
    elif playing.get("position") is not None:
        lines.append(format_seconds(playing.get("position")))
    if playing.get("paused"):
        lines.append(text(SID["paused"]))
    if playing.get("muted"):
        lines.append(text(SID["muted"]))
    elif playing.get("volume") is not None:
        lines.append(text(SID["volume"], volume=playing["volume"]))
    count = queue_length(state)
    if count:
        lines.append(text(SID["queue"], count=count))
    speed = _number(playing.get("speed"))
    if speed is not None and speed not in (0, 1):
        lines.append(text(SID["speed"], speed=("%g" % speed)))
    return lines


def pick_rows(picks, text, resume_only=False):
    """``(rows, picks)`` aligned lists for ``Dialog().select``.

    ``rows`` are display labels, ``picks`` the matching normalized picks.
    """
    rows = []
    chosen = []
    for pick in picks or ():
        resume_at = _number(pick.get("resumeAt"))
        if resume_only and not (resume_at is not None and resume_at > 0):
            continue
        title = truncate(pick.get("title") or u"", 40)
        if resume_at is not None and resume_at > 0:
            label = text(
                SID["resume_row"],
                title=title,
                time=format_seconds(resume_at),
            )
        elif pick.get("reason"):
            label = text(
                SID["pick_row"],
                title=title,
                reason=truncate(pick.get("reason"), 60),
            )
        else:
            label = title
        runtime = _number(pick.get("runtime"))
        if runtime is not None and runtime > 0:
            label = label + u" " + text(
                SID["runtime_suffix"],
                minutes=max(1, int(round(runtime / 60.0))),
            )
        rows.append(label)
        chosen.append(pick)
    return rows, chosen


def remote_rows(text):
    """``[(label, action, value)]`` for the remote submenu."""
    return [(text(SID[key]), action, value) for key, action, value in REMOTE_ITEMS]


# ---------------------------------------------------------------------------
# errors
# ---------------------------------------------------------------------------
def error_message(text, err):
    """Localized, human sentence for a bridge failure."""
    kind = getattr(err, "kind", None)
    sid = ERROR_SID.get(kind, SID["error_internal"])
    url = getattr(err, "url", None) or u""
    detail = getattr(err, "detail", None) or u""
    host = u""
    if url:
        try:
            host = url.split("://", 1)[1]
        except IndexError:
            host = url
    return text(sid, url=url, host=host, detail=detail)


def error_detail(err):
    """Second dialog line: the technical detail, or ``''`` when there is none."""
    kind = getattr(err, "kind", None)
    detail = getattr(err, "detail", None) or u""
    status = getattr(err, "status", None)
    if kind in ("auth", "busy", "rejected") and not detail:
        return u""
    if detail and status and ("HTTP %s" % status) not in detail:
        return detail
    return detail


def error_heading(text):
    return text(SID["error_heading"])
