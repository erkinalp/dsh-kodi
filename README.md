# dsh-kodi

Kodi for DeepSeek Harness. The media center stays the 10-foot UI on the
television; the Harness becomes the thing that *knows what to put on it*, and
the remote becomes a conversation.

Two plugins, one loop:

```
        ┌──────────────────────────────┐
        │  Kodi on the TV              │
        │  program.dsh (Python add-on) │  "Ask DSH…" typed with the remote
        └──────────────┬───────────────┘
                       │ HTTP, loopback, optional token
        ┌──────────────▼───────────────┐
        │  dsh-kodi TV bridge          │  /tv/ask → one follow-up turn
        │  (this plugin, Host side)    │  kodi_say → the answer, on the TV
        └──────────────┬───────────────┘
                       │ JSON-RPC 2.0
        ┌──────────────▼───────────────┐
        │  Kodi web server :8080       │  library, playback, input, notify
        └──────────────────────────────┘
```

The agent also drives Kodi directly: `kodi_play`, `kodi_search`, `kodi_queue`,
`kodi_picks`. So "play the next episode of the thing I fell asleep in" is one
tool call, and "what should we watch for 40 minutes" is `kodi_picks`.

## What you get

**Agent tools (12)** — `kodi_status`, `kodi_search`, `kodi_library`,
`kodi_play`, `kodi_queue`, `kodi_transport`, `kodi_volume`, `kodi_remote`,
`kodi_notify`, `kodi_picks`, `kodi_screenshot`, `kodi_say`.

**The `kodi` service** — a JSON-RPC client with a state cache and a
notification socket, so the rest of the Harness reads the television instead of
polling it.

**A now-playing panel** in the Harness Web UI: title and progress, transport
buttons, queue, tonight's picks, and an Ask box that reaches the same agent the
TV reaches.

**A Kodi add-on** (`program.dsh`) with a TV-sized menu: Now playing, Ask DSH
(on-screen keyboard → spoken answer in a scrollable viewer), Tonight's picks,
Resume, Remote, Settings.

**A TV bridge** — a loopback HTTP server the TV and the panel share, with a
one-question-at-a-time contract so a mashed remote cannot flood the agent.

## Quick start

### 1. Kodi with its web server

```sh
sudo apt-get install -y kodi          # 21.3 Omega on Ubuntu 24.04
./scripts/kodi-provision.sh           # web server + sample library + launch
./scripts/kodi-live-smoke.sh          # ping, library, playback: exit 0 or a reason
```

`scripts/kodi-provision.sh` is idempotent. It enables Kodi's web server on
`127.0.0.1:8080` (`kodi` / `kodi`), generates a small sample library under
`~/Videos/kodi-samples`, and launches Kodi on the current desktop session. If
you already have a Kodi, skip it and point the plugin at your host instead.

### 2. The Harness plugin

```sh
dsh plugin add github:erkinalp/dsh-kodi
```

Then restart the Harness. One row (`kodi`) carries the Host half: the service,
the tools, and the bridge on `127.0.0.1:8760`.

### 3. The Kodi add-on

```sh
ln -s "$PWD/kodi-addon/program.dsh" ~/.kodi/addons/program.dsh
# Kodi > Add-ons > Program add-ons > DSH
```

Or zip `kodi-addon/program.dsh` and use *Install from zip file*.

### 4. Say something to the television

From the TV: *Add-ons → DSH → Ask DSH* → "play something funny for forty
minutes". From the laptop:

```sh
curl -s -X POST http://127.0.0.1:8760/tv/ask -d '{"text":"play something funny for 40 minutes"}'
curl -s 'http://127.0.0.1:8760/tv/reply?after=<id>'
```

Either way the question becomes one ordinary turn in the Harness Session: the
agent can search the library, start playback, and answer with `kodi_say`.

## Configuration

The cordis row validates every field at activation; a bad value fails loud on
load instead of degrading later.

| Field | Default | Meaning |
|---|---|---|
| `url` | `http://127.0.0.1:8080/jsonrpc` | Kodi's JSON-RPC endpoint |
| `user` / `password` | `kodi` / empty | Basic auth for the Kodi web server |
| `timeoutMs` | `8000` | Per-call RPC timeout |
| `bridgePort` | `8760` | TV bridge port (`0` picks a free port) |
| `bridgeBind` | `127.0.0.1` | Bridge bind address |
| `bridgeToken` | empty | Shared token; **mandatory** for a non-loopback bind |
| `sessionId` | empty | Pin the TV conversation to one Session; empty = most recent |
| `panelOrigin` | `http://127.0.0.1:3080` | Origin allowed by the bridge's CORS |
| `picksLimit` | `6` | Picks returned by `kodi_picks` and the panel |

## The bridge

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | bridge + Kodi liveness |
| GET | `/tv/state` | now playing, queue, picks, last reply |
| POST | `/tv/ask` | `{text}` → one agent turn; 429 while a question is unanswered |
| GET | `/tv/reply?after=<id>` | the answer to that question, or null |
| POST | `/tv/action` | `play`, `pause`, `playpause`, `stop`, `seek`, `skip`, `volume`, `mute` |
| POST | `/tv/seen` | acknowledge a reply |

A non-loopback `bridgeBind` without `bridgeToken` refuses to start
(`E_BRIDGE_INSECURE`): the bridge can start playback and push prompts into an
agent, so it is not something to expose casually. Bodies are capped at 16 KiB,
tokens compare in constant time, and CORS is limited to `panelOrigin`.

## Design notes

- **Why `kodi_say`.** A chat answer is not visible on a television. The prompt
  injected from the TV says so, and the answer travels through a tool whose
  effect the bridge owns — one deterministic path, no scraping of assistant
  prose out of the Session log.
- **One question at a time.** `/tv/ask` answers 429 while a previous question
  has no reply. A remote gets mashed; the agent does not get flooded.
- **Two plugins, honestly.** The Kodi add-on needs no knowledge of Cordis or
  the Harness: it speaks five HTTP routes. The Harness plugin needs no
  knowledge of Kodi's Python API. Either side can be replaced.
- **Zero runtime dependencies.** Node builtins and the global `fetch` /
  `WebSocket`; Python standard library in the add-on.

## Verification

Honest state of what is and is not proven is in [docs/VERIFICATION.md](docs/VERIFICATION.md):
unit and integration tests against a JSON-RPC mock, the live Kodi round trip,
and which claims remain unverified.

## License

MIT — Erkin Alp Güney.
