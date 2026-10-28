# DSH for Kodi (`program.dsh`)

A ten-foot DeepSeek Harness surface **inside** Kodi: see what is playing, ask the
agent for something to watch using the on-screen keyboard, pick from tonight's
suggestions, resume where you left off, and drive playback with a remote — all
from the sofa, with no second screen.

* **Target:** Kodi 21 "Omega" (`xbmc.python` 3.0.0, Python 3).
* **Dependencies:** none. Standard library only (`urllib`/`http.client`, `json`);
  no third-party packages, no compiled helpers.
* **Talks to:** the `dsh-kodi` bridge that the DeepSeek Harness plugin runs
  (default `http://127.0.0.1:8760`).

---

## Install into a running Kodi

### 1. Copy the add-on into Kodi's add-on directory

The folder that Kodi scans must be named after the add-on id, `program.dsh`:

| Platform | Destination |
|---|---|
| Linux | `~/.kodi/addons/program.dsh` |
| LibreELEC / CoreELEC / OSMC | `/storage/.kodi/addons/program.dsh` |
| macOS | `~/Library/Application Support/Kodi/addons/program.dsh` |
| Windows | `%APPDATA%\Kodi\addons\program.dsh` |
| Android | `/sdcard/Android/data/org.xbmc.kodi/files/.kodi/addons/program.dsh` |

From a checkout of this repository:

```bash
cp -r kodi-addon/program.dsh ~/.kodi/addons/
```

…or use the docker/portable profile with `-p /path/to/profile` and put it under
that profile's `addons/` instead. Copying (not symlinking) is recommended: Kodi
resolves an add-on's `resources/` through its own paths.

### 2. Enable it in Kodi

**Add-ons → Program add-ons → DSH → Enable** (it may already show as enabled).
If it does not appear in the list, **Settings → Add-ons → … → Check for updates**
or restart Kodi so the add-on directory is rescanned.

### 3. Or install it as a ZIP

```bash
kodi-addon/package-addon.sh          # -> kodi-addon/dist/program.dsh-0.1.0.zip
```

Then in Kodi: **Settings → Add-ons → Install from zip file →** pick the zip.
The archive contains `program.dsh/` at its root, which is the layout Kodi
expects.

### 4. Point it at the bridge

Open the add-on once — **Settings → Settings → DSH** (or the menu's *Settings*
entry) and fill in:

| Setting | Default | Meaning |
|---|---|---|
| **Bridge URL** | `http://127.0.0.1:8760` | Base URL of the `dsh-kodi` bridge. Port and path prefix are honoured. |
| **Token** | *(empty)* | Optional. Must equal the bridge's `bridgeToken`. The field is hidden (`option="hidden"`). |
| **Answer timeout (seconds)** | `60` | Read timeout for one HTTP call **and** the budget for waiting on an answer. Clamped to 5–300. |

The defaults are what a brand-new profile uses: the add-on reads settings through
`getSettingString`/`getSettingInt` and falls back to the documented values when a
setting was never saved (`''`/`0`), so an empty profile still talks to
`http://127.0.0.1:8760` with a 60 s timeout. Kodi 21 reads the **`<default>`
element**, not a `default="…"` attribute — with the attribute, `CSettingInt`
rejects the default and Kodi logs `error reading the default value of "timeout"`,
then treats *every* setting in the file as missing.

When the token is empty no auth header is sent at all. When it is set it is sent
as `Authorization: Bearer <token>` and `X-Bridge-Token: <token>`; it is never
put in the URL (the bridge refuses `?token=` on purpose).

---

## What each menu item does

The menu heading doubles as a status line (`DSH · Playing: Big Buck Bunny ·
3:12 / 10:34`), refreshed on every pass through the loop.

| Menu item | What happens | Endpoint |
|---|---|---|
| **Now playing** | Fetch the TV's state and show title, `time / total`, progress %, volume (or *Muted*), queue length and playback speed in a scrollable viewer. With nothing playing: "Nothing is playing right now." | `GET /tv/state` |
| **Ask DSH** | On-screen keyboard (`Dialog().input(type=INPUT_ALPHANUM)`) → send the question → a progress dialog polls every 1.5 s → the answer opens in `Dialog().textviewer`, so a long answer scrolls on a TV. A **429** ("a previous ask has no reply yet") is *not* an error: the add-on keeps waiting on the previous answer. The answer is then marked as read. | `POST /tv/ask`, `GET /tv/reply?after=<id>`, `POST /tv/seen` |
| **Tonight's picks** | `Dialog().select` over `state.picks`, each row `Title — reason · 21 min`; the chosen row is played. | `GET /tv/state`, `POST /tv/action` `{action:'play', value:{kind,id}}` |
| **Resume** | The same list, filtered to picks with `resumeAt`, rows shown as `Title — resume at 24:10`; plays the same way. | `GET /tv/state`, `POST /tv/action` |
| **Remote** | Play/Pause, Stop, Back 10 minutes, Forward 10 minutes, Volume up/down, Mute. | `POST /tv/action` |
| **Settings** | `Addon().openSettings()`; on return the bridge URL/token/timeout are re-read, so a fixed typo takes effect without restarting Kodi. | – |
| **Close** | Leaves the add-on (so does Back). | – |

Remote actions send these bodies (documented so the bridge's allowlist and the
add-on cannot drift):

```
{action:"playpause"}                      {action:"stop"}
{action:"skip",   value:-600}   {action:"skip",   value:600}      # seconds
{action:"volume", value:5}      {action:"volume", value:-5}       # delta
{action:"mute"}
```

`value` may be `null` for actions that need none. The add-on treats
`{ok:false, error:"…"}` as a refusal and shows the bridge's own reason.

### Shortcut

```python
xbmc.executebuiltin('RunScript(program.dsh, ask)')
```

jumps straight into a flow (`ask`, `picks`, `resume`, `remote`, `now_playing`,
`settings`) instead of the menu — handy for a keymap or a remote button.

---

## Failure behaviour (the important part)

Kodi renders an uncaught Python exception in a script add-on as a modal error
with a stack trace. On a TV that is unacceptable, so:

* every bridge failure becomes `Dialog().ok(<localized sentence>, <technical
  detail>)` — e.g. *"Cannot reach the DSH bridge at http://127.0.0.1:8760."*,
  *"The DSH bridge rejected the request: check the bridge token in DSH
  settings."*, *"The DSH bridge sent a reply that is not valid JSON."*;
* the traceback, if any, goes to `kodi.log` only (`_entry()` in `default.py` is
  the last line of defence);
* every network call runs inside a progress dialog that a context manager always
  closes, so the TV never shows a frozen screen or a stuck dialog;
* cancel, back and an empty question are quiet no-ops, not errors;
* a missing/mangled bridge URL or a settings value that raises is reported as a
  configuration error and the add-on keeps running, so Settings is still
  reachable.

Failure classes carried by `bridge.BridgeError.kind`, and the string each maps
to: `config` 30040, `network` 30041, `auth` 30042, `timeout` 30043, `http`
30044, `json` 30045, `protocol` 30046, `rejected` 30047, `busy` 30048, `empty`
30049.

---

## Localization

All on-screen text lives in `resources/language/`:

```
resources/language/resource.language.en_gb/strings.po   # English, ids 30000+
resources/language/resource.language.tr_tr/strings.po   # Turkish, same msgctxt ids
```

Python contains **no user-facing English**: `ui.SID` maps names to ids and
`ui.Text` resolves them through `xbmcaddon.Addon().getLocalizedString`. A message
that is missing from a `.po` renders as `[30012]` (visible and debuggable)
instead of an empty dialog or a crash.

Adding a language: copy `resource.language.en_gb`, rename it to Kodi's language
code (e.g. `resource.language.de_de`), translate the `msgstr` lines, and keep the
`msgctxt "#30001"` numbering identical — placeholders such as `{title}` must
survive translation (the test suite checks both properties).

---

## Layout

```
program.dsh/
├── addon.xml                     # id, xbmc.python 3.0.0, metadata, assets
├── default.py                    # entry point, menu loop, actions
├── resources/
│   ├── icon.png, fanart.jpg      # 512×512 / 1920×1080
│   ├── settings.xml              # bridge URL, hidden token, timeout
│   ├── language/…/strings.po     # en_gb + tr_tr
│   └── lib/
│       ├── bridge.py             # HTTP client, pure stdlib, no xbmc imports
│       ├── ui.py                 # formatting/menu/error text, pure Python
│       └── screen.py             # the only xbmcgui boundary
├── README.md
└── ../../tests/                  # see below
```

`bridge.py` and `ui.py` deliberately do not import `xbmc*`, which is what makes
them testable in plain CPython. Only `screen.py` and `default.py` touch Kodi's
GUI.

---

## Tests

Headless, standard library only — no Kodi, no TV, no bridge needed for the unit
tests (the tests start their own stub bridge):

```bash
# every file must at least compile for Kodi's Python 3
python3 -m py_compile kodi-addon/program.dsh/default.py \
    kodi-addon/program.dsh/resources/lib/*.py

# 115 tests: bridge client, pure formatting/localization, settings defaults,
# and full flows with fake xbmc modules (including "no traceback")
python3 -m unittest discover -s kodi-addon/tests -v
```

| File | Covers |
|---|---|
| `tests/test_bridge.py` | success, 401, 429, timeout, malformed JSON, refused connection, HTTP 500, URL/credential validation, token headers, polling deadline/cancel, settings clamping — against a stdlib `http.server` stub |
| `tests/test_ui.py` | `m:ss` formatting, truncation, reply cleaning, state normalization, pick rows, error sentences, `.po` parity (same ids, same placeholders, Turkish actually translated), `addon.xml`/`settings.xml` shape, "no third-party imports" |
| `tests/test_addon_flow.py` | the real `default.py` against fake `xbmc*` modules: menu/status, Ask (incl. 429 and timeout), picks, resume, remote, settings, bridge down, malformed JSON, bad URL, settings defaults on a fresh profile — and that no exception escapes and every progress dialog is closed |

---

## Known limits

* One question at a time, by design: the bridge answers 429 while a previous ask
  is still unanswered, and the add-on waits for that one instead of stacking
  requests.
* `resumeAt` is read as *seconds into the item* (the `makePicks` contract).
* No library browsing/queue management inside Kodi: the tools and the web panel
  cover that; the TV surface stays a five-action remote.
* The add-on settings *dialog* itself (labels, the hidden token field's masking)
  is not exercised headlessly: it needs a click on Settings. The schema is
  validated by Kodi at load time and the log is clean, and the values it exposes
  are covered by tests through the same reader the add-on uses.
* Artwork (`resources/icon.png`, `resources/fanart.jpg`) is generated by
  `kodi-addon/tools/make-assets.py` (dev-only, needs Pillow) and committed; the
  add-on never imports Pillow.
