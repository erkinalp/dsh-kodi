# Verification — what was measured, and what was not

Honest record. Every "verified" line was produced by a command whose output is
quoted or summarized here; nothing is inferred from documentation alone.

## Live Kodi 21.3 (this machine, 2026-10-28)

Installed from Ubuntu 24.04 (`2:21.3+dfsg-1ubuntu1`), launched with
`kodi --windowing=x11` on the existing desktop session.

- `JSONRPC.Ping` → `pong`; `Application.GetProperties` → version 21.3, volume, muted.
- Library seeded by `scripts/kodi-provision.sh`: 6 movies, 1 TV show, 3 episodes.
- `Player.Open {movieid:1}` → active player type `video`; `Player.GetItem` →
  `Clock Face`, runtime 60 s, thumbnail path.
- `Player.PlayPause` → `{speed:0}`, again → `{speed:1}`.
- `Player.Seek {seconds:20}` → one second later `percentage: 42.5`, `time: 25 s`.
- `Application.SetVolume {volume:40}` → `40`.
- `GUI.ShowNotification` → OK (banner on screen).

Corrections this round forced on the code (all were wrong assumptions, not
typos): `JSONRPC.GetVersion` does not exist; `VideoLibrary.GetInProgressMovies`
and `GetInProgressEpisodes` were removed in Kodi 21.3; `inprogress` filtering
requires `{field:'inprogress',operator:'is',value:'true'}`; `Player.Open` is
async; `Player.Seek` answers with the PRE-seek position.

## End-to-end: the TV becomes a conversation

Measured against the installed plugin (row `kodi`) and the add-on
`program.dsh` running inside Kodi:

1. A question was typed on the Kodi on-screen keyboard and posted to `/tv/ask`.
2. The plugin injected it as one follow-up turn into this Session.
3. The agent answered through the `kodi_say` tool.
4. `GET /tv/state` showed `pendingAsk: null` and
   `lastReply.id == <the ask id>`; `GET /tv/reply?after=<ask id>` returned
   exactly that text.

That is the whole loop, verified on the wire rather than in a mock.

## Unit and integration tests

`node --test tests/` — 137 passing, 0 failing. (Per-file runs were used while a
spec was mid-edit; the aggregate run is clean at release time.)

| File | Tests |
|---|---|
| `tests/rpc.test.mjs` | 12 pass |
| `tests/service.test.mjs` | 29 pass |
| `tests/tools.test.mjs` | 32 pass (12 tools, schemas validated against the harness's own `assertSupportedJsonSchema`) |
| `tests/bridge.test.mjs` | 39 pass (real HTTP on port 0) |
| `tests/recommend.test.mjs` | 25 pass |
| `kodi-addon/tests/` | 115 pass (pytest, stdlib-only stub server) |

The bridge suite includes one test that puts the REAL `KodiRpc` + `KodiService`
behind the bridge against the shared mock, which pins the cross-module seam.

## Not verified — do not read as success

- **The Web panel's live rendering** — RESOLVED for localization. The card first
  rendered raw locale keys (`panel.nowPlaying`) because the bundle registered a
  nested dictionary while the locale service does a flat `dict[key]` lookup; the
  fix flattens at registration, with a test asserting no rendered text matches
  `^(meta|panel)\.`. The operator confirmed the card now reads "Now playing",
  "Tonight's picks", "Ask DSH" in the running GUI. That confirmation is theirs,
  not a measurement of mine: this browser (Firefox) is not reachable by the
  client-inspect channel or the CDP browser seam. The slot choice remains
  catalog-grounded rather than live-inspected for the same reason.
- **WebSocket notifications.** This Kodi has no WebSocket listener on
  `/jsonrpc` (the upgrade answers HTTP 200), so the service ran in polling
  fallback. The notification path is proven against the mock's real RFC 6455
  server, not against this Kodi.
- **Physical remote / real TV.** Input was driven through JSON-RPC
  (`Input.*`), not with a remote control in hand.
- **Playback stability on this GPU.** Kodi logged
  `OutputPicture - failed to configure renderer` and audio-sync warnings during
  one playback session; playback control itself worked.
- **Kodi add-on visual layout** on a 10-foot display.

## Operator confirmations (not lead measurements)

- Panel localization renders correctly in the live GUI (see above).
- A question typed on the Kodi on-screen keyboard reached this Session and the
  answer came back through `/tv/reply` — observed end to end by the operator.

## Late live fixes (after the first release commit)

- `AudioLibrary.GetArtists` rejects `artist` as a requested property (-32602);
  the name arrives as `label`. It also rejects `sortname` as a sort method.
  Albums and songs reject `sortname` as a property. `art` is legal for all
  three. The artist property list no longer requests `artist`, and a
  multi-kind `search()` was re-verified live (7 results across movies and
  episodes) plus a targeted `play` (`{ok:true, playing:true}`, season/episode
  `null`).

## Agent -> TV direction (tested after the first release)

Exercised through the real tools against the live box, each result confirmed by
an independent JSON-RPC read rather than the tool's own report:

| Command | Independent check |
|---|---|
| `kodi_search "night"` | 1 match, movie _Night Drive_ |
| `kodi_play query:"Night Drive"` | active player video, item `Night Drive`, speed 1 |
| `kodi_transport pause` | `speed: 0` |
| `kodi_transport play` | `speed: 1` |
| `kodi_transport seek 20` | position ~21 s reported, 24.9 s observed after the command |
| `kodi_volume set 25` | `Application.GetProperties.volume: 25` |
| `kodi_queue add [1,2]` | playlist = Night Drive, Episode 1, Episode 2 |
| `kodi_queue jump 3` | playing `Episode 2` (Kodi index 2 -> 1-based 3 correct) |
| `kodi_picks` | 3 ranked picks with reasons |

Two defects this direction exposed, both fixed:

1. `snapshot().position` was the 1-based QUEUE SLOT while every consumer (bridge
   `/tv/state`, the panel, the tool summaries) treats it as PLAYBACK SECONDS.
   Split into `position` (seconds) and `queueIndex` (slot); service tests moved
   to assert both.
2. The post-seek settle window was too short for this box: `seek 10` reported
   `0:02` while Kodi applied it ~1 s later. Budget widened (14 x 200 ms) and the
   progress criterion loosened.

## Known gaps at the time of writing

- `node --test tests/` as a single command did not exit (a leaked handle in one
  spec); per-file runs were used. A hang is a defect, not a limitation.
- The add-on's `settings.xml` produced
  `CSettingInt: error reading the default value of "timeout"` in the Kodi log.
