# Kodi setup (real instance, for dsh-kodi development and demos)

This document describes the Kodi instance the plugin is developed against: a
real Kodi 21.3 on this workstation, JSON-RPC reachable on
`http://127.0.0.1:8080/jsonrpc` with basic auth `kodi` / `kodi`, a small video
library seeded from generated media, and two scripts that provision and smoke
test it.

Everything below was measured on this machine on **2026-10-28**, not copied from
upstream documentation. Where a behaviour was surprising, the evidence is quoted.

| Item | Value (measured) |
|---|---|
| Package | `kodi` `2:21.3+dfsg-1ubuntu1` (Ubuntu 26.04, universe) |
| Version string | `Kodi 21.3 rev=20260315-nogitfound tag=stable` (`Kodi from Debian`) |
| Binary | `/usr/bin/kodi` (wrapper) → `/usr/lib/x86_64-linux-gnu/kodi/kodi.bin` |
| Endpoint | `http://127.0.0.1:8080/jsonrpc`, HTTP basic auth `kodi:kodi` |
| Listen address | `0.0.0.0:8080` and `[::]:8080` (see "Bind address" below) |
| Windowing | **native Wayland**, AMD `radeonsi` hardware GL, no flags needed |
| Window state | windowed (`fullscreen=false`) at idle; fullscreen only while a video plays |
| Library | 6 movies, 1 TV show, 2 episodes |
| Media | `~/Videos/kodi-samples` (8 files, ~20 MB) |
| Kodi log | `~/.kodi/temp/kodi.log` (console copy: `/tmp/kodi-live.log`) |
| Our pid file | `/tmp/kodi-dsh.pid` |

## 1. Install (one time)

The workstation has **no passwordless sudo**, so installation runs through
polkit and a dialog appears on the user's desktop:

```bash
pkexec env DEBIAN_FRONTEND=noninteractive apt-get install -y kodi
```

`scripts/kodi-provision.sh --install` runs exactly that command. Do not use
`sudo -n` (fails with "interactive authentication is required") and do not pass
`-y` alone without `DEBIAN_FRONTEND=noninteractive` — apt would otherwise try to
prompt and hang.

> Side effect seen here: because the box had pending archive upgrades, `apt-get
> install kodi` also configured `linux-image-7.0.0-42-generic` and rebuilt the
> DKMS `amdgpu` module. That is apt's normal behaviour, not something the
> scripts request. The running kernel stays what it was until the next reboot;
> Kodi 21.3 works on it.

## 2. Scripts

### `scripts/kodi-provision.sh`

Idempotent: re-running it verifies and repairs, and does nothing when the
instance is already healthy (measured: 0.32 s no-op run).

| Flag | Effect |
|---|---|
| *(none)* | verify everything, launch Kodi if needed, scan library, print summary |
| `--install` | also install Kodi through `pkexec` + apt |
| `--no-launch` | configure only, leave Kodi stopped |
| `--rescan` | force a library rescan even when the library looks complete |
| `--force-media` | regenerate the sample videos and `.nfo` files |
| `--status` | print state, change nothing |

Environment overrides: `KODI_PORT`, `KODI_USER`, `KODI_PASS`,
`KODI_SAMPLES`, `KODI_DATA`, `KODI_LOG`, `KODI_DISPLAY`, `KODI_WINDOWING`
(`auto|wayland|x11|gbm`, default `auto`), `KODI_PIDFILE`.

Exit codes: `0` ok, `1` failure, `2` missing prerequisite, `3` Kodi not installed.

What it does, in order:

1. **Install check.** Refuses with the exact `pkexec` command when Kodi is
   absent and `--install` was not given.
2. **Sample media** (`ffmpeg`), see §4.
3. **`~/.kodi/userdata/guisettings.xml`** — the web server settings, see §3.
4. **`~/.kodi/userdata/sources.xml`** — the two video sources.
5. **Source content types** in the video database, see §5.
6. **Launch + scan**, then a summary of the measured state.

### `scripts/kodi-live-smoke.sh`

Asserts the JSON-RPC surface the service layer depends on: reachability, auth,
`JSONRPC.Ping`, non-empty library, `Player.Open` (library id **and** raw file),
`Player.GetItem`, timeline actually advancing, pause/resume, absolute seek, stop.

```bash
scripts/kodi-live-smoke.sh            # full smoke; playback is stopped at the end
scripts/kodi-live-smoke.sh --keep     # leave the item playing
scripts/kodi-live-smoke.sh --no-episode
scripts/kodi-live-smoke.sh --quiet
```

Exit status `0` only when every check passed. Last measured run: **18/18 passed,
exit 0**. The final summary prints the Kodi version, the library counts and the
title that was played.

## 3. Web server (`guisettings.xml`)

Setting ids are taken from the installed
`/usr/share/kodi/system/settings/settings.xml` (not guessed):

| Setting id | Value | Default in Kodi 21.3 |
|---|---|---|
| `services.webserver` | `true` | `false` |
| `services.webserverport` | `8080` | `8080` |
| `services.webserverauthentication` | `true` | `true` |
| `services.webserverusername` | `kodi` | `kodi` |
| `services.webserverpassword` | `kodi` | *(empty)* |

Note the id is `services.webserverusername`, **not** `services.webserveruser`,
and there is no `services.webserverbindaddress`. The provision script writes a
minimal file before the first run and patches in place afterwards, preserving
every other key Kodi wrote (Kodi rewrites this file on exit, so never edit it
while Kodi runs — the script stops Kodi first).

Measured auth behaviour:

```
$ curl -s -o /dev/null -w '%{http_code}\n' -d '{"jsonrpc":"2.0","id":1,"method":"JSONRPC.Ping"}' \
       http://127.0.0.1:8080/jsonrpc
401
$ curl -s -o /dev/null -w '%{http_code}\n' -u kodi:wrong -d '...' http://127.0.0.1:8080/jsonrpc
401
$ curl -s -u kodi:kodi -d '{"jsonrpc":"2.0","id":1,"method":"JSONRPC.Ping"}' \
       http://127.0.0.1:8080/jsonrpc
{"id":1,"jsonrpc":"2.0","result":"pong"}
```

**Bind address.** Kodi 21.3 has no setting for it: the web server binds
`0.0.0.0:8080` and `[::]:8080` (verified with `ss -ltnp`). Clients reach it over
loopback; the HTTP basic auth is what protects it. Do not move the port — the
plugin, the add-on and the bridge all expect **8080**.

## 4. Sample media (`~/Videos/kodi-samples`)

Generated by `ffmpeg` (`libx264`, `yuv420p`, AAC mono), each with a `.nfo`
sidecar so the library is populated deterministically and offline (no scraper
network access, no "choose a match" dialogs).

```
Movies/
  Night Drive (2021).mkv        testsrc2   30 s
  Colour Bars (2019).mkv        smptebars  20 s
  Mandelbrot Zoom (2020).mkv    mandelbrot 45 s
  Sine Sweep (2018).mkv         rgbtestsrc 25 s
  Gradient Flow (2022).mkv      gradients  40 s
  Clock Face (2017).mkv         testsrc   60 s (1280x720)
TV/Demo Show/
  tvshow.nfo
  Season 01/Demo Show S01E01.mkv  testsrc2  20 s
  Season 01/Demo Show S01E02.mkv  gradients 35 s
```

### The "sample" landmine (measured)

Kodi's default library exclude regexp is `[!-._ \/]sample[-._ \/]`. A show
folder named `Sample Show` is therefore **silently excluded from the scan**:

```
debug: ExcludeFileOrFolder: File '.../TV/Sample Show/' excluded.
       (Matches exclude rule RegExp: '[!-._ \/]sample[-._ \/]')
debug: VideoInfoScanner: No (new) information was found in dir .../TV/
```

That is why the show is called **Demo Show**. The media root
`~/Videos/kodi-samples` is safe because the rule also requires a separator
*after* "sample", and `samples` continues with `s`.

## 5. Why the scripts touch the video database

Kodi has no JSON-RPC method to set a source's *content type*. Verified against
the running instance with `JSONRPC.Introspect`: `Files.GetSources` and
`VideoLibrary.GetSources` exist, **`Files.SetSources` does not**.

A source that is only listed in `sources.xml` has an empty `strContent`, and
`VideoLibrary.Scan` then adds nothing at all — measured on a scan of an empty
`path` table: `VideoInfoScanner: Finished scan. Scanning for video info took
10 ms`, `movie=0`, `files=0`.

So `scripts/kodi-provision.sh` writes the same rows Kodi's own "Set content"
dialog writes, into `~/.kodi/userdata/Database/MyVideos*.db`:

```sql
-- table: path (idPath, strPath, strContent, strScraper, strHash, scanRecursive,
--               useFolderNames, strSettings, noUpdate, exclude, allAudio,
--               dateAdded, idParentPath)
'/home/erkinalp/Videos/kodi-samples/Movies/'  -> strContent='movies',  strScraper='metadata.local'
'/home/erkinalp/Videos/kodi-samples/TV/'      -> strContent='tvshows', strScraper='metadata.local'
```

`metadata.local` ("Local information only", shipped in `kodi-data`) reads the
`.nfo` files and never touches the network.

**This edit requires Kodi to be stopped** — writing the database under a live
instance is exactly what left the library unusable during a dual-instance
collision (see §7). The script enforces this and refuses to proceed if any
`kodi.bin` is alive.

A wiped database is recoverable: deleting `MyVideos*.db` and re-running
`scripts/kodi-provision.sh` rebuilds the whole library in about 2 s (measured:
scan of 8 files → `6 movies, 2 episodes (after 2s)`).

## 6. Launching Kodi

```bash
DISPLAY=:0 XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 \
  setsid nohup kodi --logging=console >>/tmp/kodi-live.log 2>&1 </dev/null &
```

* **No `--windowing` flag is needed.** Plain `kodi` logs
  `InitWindowSystem: Connecting to Wayland server` and
  `CApplication::CreateGUI - using the wayland windowing system`, with
  `GL_RENDERER = AMD Radeon RX 5500 XT (radeonsi, navi14)`.
  `--windowing=x11|wayland|gbm` exist if you need to force one.
* **No `LIBGL_ALWAYS_SOFTWARE=1`.** Hardware GL works.
* It starts **windowed** (`GUI.GetProperties ["fullscreen"]` → `false`), so it
  does not take the desktop hostage. It goes fullscreen only while a video plays
  and returns to windowed after `Player.Stop` (measured both ways).
* `touch ~/.kodi/.no-kodi-splash` is not needed; no splash appeared.
* `-fs` forces fullscreen at start (`fullscreen=true`) — do not use it for a
  shared desktop.

Attach to the user session: `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`,
`DBUS_SESSION_BUS_ADDRESS` (`unix:path=/run/user/1000/bus`) must be present,
otherwise Kodi cannot open a window and its audio/polkit integration degrades.

## 7. One shared instance — the rule that matters most

**Run exactly one `kodi.bin` against `~/.kodi`.** Two instances do not fail
cleanly; they corrupt the experience in ways that look like unrelated bugs.
Measured on 2026-10-28, when a second instance
(`sh /usr/bin/kodi --windowing=x11 --logging=console --debug`) was started by
another shell while a healthy one was serving `:8080`:

* the HTTP port went dead (`http=000`), because only one process can own `:8080`
  and its web server then logs `CWebserver[8080]: Started` immediately followed
  by `CWebserver[8080]: Stopped`;
* the losing instance showed a modal dialog that blocked `Application.Quit`
  **and** `SIGTERM` — the process only died on `SIGKILL`;
* both instances fought over the same video database and the audio sink, which
  produced `CDVDAudio::AddPacketsRenderer - timeout adding data to renderer`,
  `ActiveAE - large audio sync error` and `OutputPicture - failed to configure
  renderer`. Those messages are **symptoms of two instances, not of the
  display**; a single instance has played 20 s with zero warnings (see §8).

How the scripts handle it:

* `kodi-provision.sh` enforces a single instance: if more than one runs, or if
  one runs but answers nothing on `:8080`, it stops them and starts one
  (JSON-RPC quit → `TERM` → `KILL`, each step logged and bounded).
* The pid it started is written to `/tmp/kodi-dsh.pid`, so later runs address
  the right process instead of "the first `kodi.bin` I can find".
* `kodi-live-smoke.sh` reports a warning when it sees more than one instance.

If you are another agent or a developer: **do not launch your own Kodi.** Use
the running instance on `:8080`; if something about it looks wrong, run
`scripts/kodi-provision.sh --status`, then `scripts/kodi-provision.sh` to
repair, and tell the environment owner instead of starting a second copy.
Do not change the port, do not use `--portable`, and do not start Kodi with a
different `KODI_HOME`.

## 8. JSON-RPC recipes (measured against this instance)

```bash
K='-sS -u kodi:kodi -H content-type:application/json'
U=http://127.0.0.1:8080/jsonrpc

curl $K $U -d '{"jsonrpc":"2.0","id":1,"method":"JSONRPC.Ping"}'
# {"result":"pong"}

curl $K $U -d '{"jsonrpc":"2.0","id":1,"method":"Application.GetProperties",
                "params":{"properties":["version"]}}'
# {"result":{"version":{"major":21,"minor":3,"revision":"20260315-nogitfound","tag":"stable"}}}

curl $K $U -d '{"jsonrpc":"2.0","id":1,"method":"VideoLibrary.GetMovies",
                "params":{"limits":{"start":0,"end":0}}}'
# {"result":{"limits":{"end":6,"start":0,"total":6}}}

curl $K $U -d '{"jsonrpc":"2.0","id":1,"method":"Player.Open","params":{"item":{"movieid":1}}}'
# {"result":"OK"}

curl $K $U -d '{"jsonrpc":"2.0","id":1,"method":"Player.GetItem",
                "params":{"playerid":1,"properties":["title","file","year"]}}'
# {"result":{"item":{"id":1,"type":"movie","label":"Clock Face","title":"Clock Face", ...}}}

curl $K $U -d '{"jsonrpc":"2.0","id":1,"method":"Player.PlayPause",
                "params":{"playerid":1,"play":false}}'
# {"result":{"speed":0}}

curl $K $U -d '{"jsonrpc":"2.0","id":1,"method":"Player.Seek",
                "params":{"playerid":1,"value":{"percentage":50.0}}}'
# {"result":{"percentage":50.0,...}}   -> landed at 49.99–50.00 % of a 60 s item

curl $K $U -d '{"jsonrpc":"2.0","id":1,"method":"Player.Stop","params":{"playerid":1}}'
# {"result":"OK"}
```

Stability, measured on the single instance (2026-10-28): a 20 s soak of
`Clock Face` held `speed=1` at every 2 s sample with a linear timeline
(3.72 % → 43.98 %, ≈ 2.01 %/s), **zero** warnings or errors in that window, and
an active AAC-LC audio stream. That is the state to demo against.

### RPC traps worth knowing

* `Player.GetItem`, `VideoLibrary.GetMovies` and friends **reject unknown
  property names** with `-32602 Invalid params` — the whole call fails.
  - `"type"` is **not** a requestable `Player.GetItem` property (it is always
    present in the returned item anyway).
  - `"movieid"` is **not** a requestable `VideoLibrary.GetMovies` property.
* `Player.Seek` wants an **object**: `{"percentage":50.0}` or
  `{"time":{"hours":0,"minutes":0,"seconds":5}}`. A bare number, and a raw
  string such as `"smallforward"`, are not usable here.
* `Input.ExecuteAction` enum: `up`, `down`, `left`, `right`, `select`, `back`,
  `contextmenu`, `info`, `playpause`, `stop`, `togglefullscreen` are accepted;
  **`home`, `Fullscreen` and `seekforward` are rejected** ("does not match any
  of the defined enum values"). Going home is `Input.Home` — the `Input.*`
  family (`Input.Home`, `Input.Back`, `Input.Up`, …) is the reliable route.
  `Input.ExecuteAction {"action":"togglefullscreen"}` is accepted but did not
  change the window state here; do not depend on it.
* `Player.GetActivePlayers` returns `[]` when idle — never assume `playerid: 1`
  exists without checking.
* `Player.GetItem` on an idle player does **not** return a JSON-RPC error: it
  answers `{"item":{"label":"","title":"","type":"unknown"}}`. Check
  `Player.GetActivePlayers` first and treat an empty title as "nothing playing".
* `Application.Quit` can be blocked by an open modal dialog (see §7).

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `curl` to `:8080` → `000` | no instance owns the port, or a second instance took it. `pgrep -a -x kodi.bin`; run `scripts/kodi-provision.sh` (it enforces one instance) |
| `401` with correct credentials | `services.webserverusername`/`password` were not applied — re-run provisioning; check the guisettings table in §3 |
| Scan finishes in milliseconds, library stays empty | source content type unset → §5 |
| A folder is never scanned | Kodi's `[!-._ \/]sample[-._ \/]` exclude regexp → §4 |
| `failed to configure renderer`, audio sync errors | two Kodi instances → §7 |
| `refusing to edit the video database while kodi is running` | stop Kodi first (`scripts/kodi-provision.sh` does it) |
| Library looks wrong after an experiment | delete `~/.kodi/userdata/Database/MyVideos*.db` and re-run provisioning; the media and `.nfo` files regenerate the library deterministically |

## 10. Files this setup touches

| Path | Who writes it |
|---|---|
| `~/Videos/kodi-samples/**` | `scripts/kodi-provision.sh` (ffmpeg + `.nfo`) |
| `~/.kodi/userdata/guisettings.xml` | provisioning (and Kodi itself on exit) |
| `~/.kodi/userdata/sources.xml` | provisioning |
| `~/.kodi/userdata/Database/MyVideos*.db` | Kodi, plus the content-type rows from §5 |
| `~/.kodi/temp/kodi.log` | Kodi |
| `/tmp/kodi-live.log` | stdout/stderr of the launched Kodi (`--logging=console`) |
| `/tmp/kodi-dsh.pid` | pid of the instance the scripts started |
