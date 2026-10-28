# dsh-kodi internal contracts (v1)

Authoritative interface spec. Every module is implemented against this file; a
later step may extend it but never re-derive it. Zero runtime dependencies:
Node builtins only (`node:http`, `node:crypto`, global `fetch`/`WebSocket`).

## Repository layout and ownership

| Path | Owner | Responsibility |
|---|---|---|
| `index.mjs` | lead | config defaults, service lifecycle, tools wiring, agent delivery, bridge wiring, system-prompt section |
| `src/rpc.mjs` | kodi-rpc | JSON-RPC transport + typed errors |
| `src/kodi-service.mjs` | kodi-rpc | `KodiService`: high-level Kodi operations, state cache, notification listener |
| `src/tools.mjs` | kodi-tools | `registerTools(ctx, kodi, log)` → 11 `kodi_*` tools |
| `src/recommend.mjs` | kodi-bridge | `makePicks(...)`: continue-watching + curated picks |
| `src/bridge.mjs` | kodi-bridge | `startBridge(...)`: HTTP endpoints the TV and panel call |
| `lib/client.js` | kodi-ui | Web UI panel (now playing, queue, remote, ask) |
| `kodi-addon/program.dsh/**` | kodi-addon | Kodi Python add-on: 10-foot UI inside Kodi |
| `scripts/**` | kodi-env | Kodi provisioning, media seeding, live smoke |
| `tests/**` | all | `node:test`; each owner writes its own spec |

## src/rpc.mjs

```js
export class KodiRpcError extends Error { code; kind; method }  // kind: 'transport'|'timeout'|'auth'|'rpc'|'disabled'
export class KodiRpc {
  constructor({ url, user, password, timeoutMs = 8000, fetchImpl = globalThis.fetch })
  async call(method, params = {}, { timeoutMs } = {})   // → JSON-RPC `result`; throws KodiRpcError
  get endpoint()                                          // redacted url, never the password
}
```

- JSON-RPC 2.0 over HTTP POST; `id` increments; `jsonrpc: '2.0'`.
- HTTP 401 → `KodiRpcError{kind:'auth'}`; non-2xx → `kind:'transport'`; aborted/timed out → `kind:'timeout'`.
- A JSON-RPC `error` object → `kind:'rpc'`, keeping `.code` and `.message`.
- Never log or embed the password in an error message.

## src/kodi-service.mjs

```js
export class KodiService {
  constructor({ rpc, log, notificationUrl })   // notificationUrl defaults to rpc endpoint ws://
  async start(); async stop()                  // start(): ping + notification listener + cache seed
  get connected(); get version()
  snapshot()                                   // { connected, version, updatedAt, playing, item, position, speed, volume, muted, queue, libraryCounts }
  onState(listener)                            // → unsubscribe; listeners receive snapshot() on change
  async ping()                                 // { ok, version, apiVersion }
  async status()                               // → snapshot(); refreshes from Kodi
  async search(query, { kinds = ['movie','episode','artist','album','song'], limit = 25 } = {})
                                               // → { results: [{ kind, id, label, title, extra, thumbnail, file, year, runtime }] }
  async library(kind, { limit = 50, start = 0, sort = 'sorttitle', filter = '' } = {})
                                               // kind: 'movies'|'tvshows'|'episodes'|'artists'|'albums'|'songs'
                                               // → { items: [...], total, limits }
  async play(target, { queue = false } = {})   // target { kind, id } | { file } → { ok, playing }
  async queueList()                            // → { items: [...], current }
  async queue(action, { items = [], position, play } = {})
                                               // action: 'add'|'insert'|'clear'|'jump' → { ok, length, current }
  async transport(action, { value } = {})      // 'playpause'|'play'|'pause'|'stop'|'seek'|'skip'|'speed'
                                               // → { ok, playing, position, speed }
  async volume({ set, delta, mute } = {})      // → { volume, muted }
  async remote(action, { value } = {})         // 'up'|'down'|'left'|'right'|'select'|'back'|'home'|'context'|'info'|'key'
  async notify({ title, message, image, time } = {})  // → { ok }
  async screenshot()                           // → { path, file }  (Kodi writes it; we locate the newest)
  async refresh()                              // force snapshot refresh
}
```

### Item normalization (used by tools, bridge, panel)

```js
{ id, kind, label, title, subtitle, year, runtime, thumbnail, file, show, season, episode }
```

`runtime` is seconds; `thumbnail` is an image URL/path Kodi returned as-is; every
field may be `null` but never `undefined`.

## src/tools.mjs

`export function registerTools(ctx, kodi, log) → () => void` (disposer).

Registers exactly these names, each with a JSON-Schema `parameters` object and an
`output.schema` of `{ ok: boolean, [key: string]: unknown }`:

`kodi_status`, `kodi_search`, `kodi_library`, `kodi_play`, `kodi_queue`,
`kodi_transport`, `kodi_volume`, `kodi_remote`, `kodi_notify`, `kodi_picks`,
`kodi_screenshot`.

Model-facing rules: descriptions name the user-visible effect ("start playback
on the TV"), never the transport. A failed call returns `{ ok:false, error }`
instead of throwing. Every tool tolerates an unreachable Kodi by returning
`{ ok:false, error:'Kodi is not reachable at <endpoint>: <reason>' }`.

## src/recommend.mjs

```js
export function makePicks(kodi, { now = Date.now(), limit = 6 } = {})
// → { generatedAt, picks: [{ id, kind, title, reason, runtime, resumeAt, thumbnail }] }
```

Ranking order: in-progress (`VideoLibrary.GetInProgressMovies` /
`GetInProgressEpisodes`) → next unwatched episode of a show with progress →
short items fitting the remaining evening → recently added. Each pick carries a
human `reason` string ("you're 24 minutes in"). No pick may be a duplicate.

## src/bridge.mjs

```js
export async function startBridge({ config, kodi, picks, deliver, log, state })
// deliver(text, { origin }) → Promise<{ id, sessionId }>
// → { close(), url, port }
```

Endpoints (all JSON, `GET` read-only, `POST` mutating):

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | – | `{ ok, kodi:{connected,version}, bridge:{port,authed} }` |
| GET | `/tv/state` | – | `{ nowPlaying, queue, picks, lastReply }` |
| POST | `/tv/ask` | `{ text }` | `{ ok, id }` — injects a turn; 400 empty, 429 when a previous ask has no reply yet |
| GET | `/tv/reply?after=<id>` | – | `{ reply: { id, text, at } \| null }` |
| POST | `/tv/action` | `{ action, value }` | `{ ok, ... }` — allowlist: `play`,`pause`,`playpause`,`stop`,`seek`,`skip`,`volume`,`mute` |
| POST | `/tv/seen` | `{ id }` | `{ ok }` |

Rules: bind comes from config; **non-loopback bind without `bridgeToken`
refuses to start** (`E_BRIDGE_INSECURE`). Requests carrying a token compare in
constant time. CORS: allow the configured panel origin for `GET`, plus
`OPTIONS` preflight. Body limit 16 KiB. Every response carries
`content-type: application/json`. Bridge state (pending ask, last reply) lives
in one object owned by the caller (`state`), so the panel and the add-on see the
same reply.

## lib/client.js

Web client bundle in the profile's Client bundle format: a lazy factory whose id
is `dsh-kodi`, registering into a slot that already allocates space (discover it
with `cordis_inspect_query` `Slots.listSubTree`). Shows: now-playing title with
progress, transport buttons, queue, three picks, and an "Ask DSH" input posting
to `/tv/ask`. No polling faster than 2 s; no hardcoded English in JSX — route
copy through the Client locale service.

## kodi-addon/program.dsh

Python 3 add-on, `addon.xml` id `program.dsh`, no third-party imports (stdlib
`urllib` only). Reads the bridge URL + token from add-on settings
(`resources/settings.xml`). Entry `default.py`: main menu with Now playing,
Ask DSH, Picks, Resume, Remote, and a Settings shortcut. Every network failure
renders as a `xbmcgui.Dialog().ok` with the reason — never a silent no-op.


### Amendments (v1.1, agreed with owners)

- `KodiService` exposes the raw client publicly: `service.rpc` and
  `async service.call(method, params, options)`. The picks engine needs real
  JSON-RPC by name (`VideoLibrary.GetInProgressEpisodes`,
  `GetEpisodes{tvshowid, filter:{field:'playcount',operator:'is',value:'0'}}`,
  `GetMovies{filter/sort:'runtime'}`, `GetRecentlyAdded*`); the high-level
  `library()` cannot express a playcount filter. The raw path is additive.
- Bridge auth: token ONLY via `Authorization: Bearer <t>` or
  `X-Bridge-Token: <t>`. `?token=` is refused (no credentials in URLs).
- CORS: `Access-Control-Allow-Origin` echoes `config.panelOrigin` (string or
  array). Unset means no CORS, and the browser panel cannot POST.
- Reply id convention: `state.pendingAsk = {id, at, text} | null`,
  `state.lastReply = {id, text, at} | null`, where a reply's `id` is the id of
  the ask it answers (set by the `kodi_say` hook). `/tv/reply?after=<askId>`
  returns only a reply whose `id` equals `<askId>`.
- 12 tools, including `kodi_say`; `registerTools(ctx, kodi, log, hooks)` with
  `hooks.say({ text }) -> { ok, error? }`.


### Measured Kodi 21.3 facts (verified against the live instance, 2026-10-28)

Do not re-derive these from memory; they were measured.

- `JSONRPC.Ping` → `"pong"`. `JSONRPC.GetVersion` does NOT exist (-32601).
- Version and audio state in one call: `Application.GetProperties
  {properties:['volume','muted','version']}` → `{volume,muted,version:{major,minor,revision,tag}}`.
- `VideoLibrary.GetInProgressMovies` and `GetInProgressEpisodes` do NOT exist
  (-32601) in Kodi 21.3. In-progress state comes from the `resume` property
  (`{position,total}` seconds, `{0,0}` when not started) plus the filter
  `{"field":"inprogress","operator":"is","value":"true"}`. The no-value form
  `{"field":"inprogress","operator":"true"}` is rejected as invalid params.
- `VideoLibrary.GetRecentlyAddedMovies/Episodes` exist and return
  `{limits:{total}, movies|episodes:[...]}`.
- `GetEpisodes` accepts `{tvshowid, filter:{field:'playcount',operator:'is',value:'0'}}`.
- Web server listens on 0.0.0.0:8080 and notifications on 127.0.0.1:9090.


### Amendments (v1.2)

- **12 tools** and `registerTools(ctx, kodi, log, hooks)` with `hooks.say({text})`;
  `kodi_say` is the TV's only output path for agent prose.
- `/tv/action` `play` with `value:{kind,id}` or `{file}` is a TARGETED play →
  `kodi.play(...)`, never `transport('play')`. Allowlist:
  `play, pause, playpause, stop, seek, skip, volume, mute`.
- `deliver(text, {origin})` must resolve `{id, sessionId}` when the turn is
  ACCEPTED, not when the agent finishes (otherwise `lastReply.id` can never
  correlate with `pendingAsk.id`).
- Positions at the service boundary are 1-based (`snapshot().position`,
  `queueList().current`, `queue('jump'|'remove',{position})`); Kodi's 0-based
  indices never leak. `transport('skip', {value})` takes relative seconds or
  `'previous'|'next'`.
- Measured playback behaviours the service must own: `Player.Open` is async
  (poll `GetActivePlayers`, never claim `playing:true` from the Open reply);
  `Player.Seek` returns the PRE-seek position (re-read `GetProperties`);
  `-32100` with no active player maps to "Nothing is playing on the TV."
- Client locale dictionaries must be FLAT dotted keys (`'panel.nowPlaying'`):
  the locale service looks up `dict[key]` directly, so a nested dictionary
  resolves nothing and every label renders as its key. `locale/*.json` stays
  nested - that is manifest metadata, not a client dictionary.


### Amendments (v1.3) - measured transport vocabulary

- `/tv/action` `play` with `value:{kind,id}` or `{file}` is a TARGETED play.
- `seek` accepts absolute seconds, `"25%"`, the step names
  `smallforward|bigforward|smallbackward|bigbackward` (Kodi's own ±10 s / ±60 s,
  duration-independent), and `{seconds|percentage|step}`.
- `skip` accepts a NUMBER of relative seconds (negative = back; throws
  `ENODURATION` on duration-less items) or `previous|next`. Any other string
  changes the queue item in Kodi, so the bridge refuses it with 400 rather than
  translating it: one action, one dialect.
- Bridge error provenance: caller mistakes (`RangeError` from argument
  validation) are 400; Kodi refusals and transport failures are 502.
- `/tv/state.queueCurrent` is the 1-based position of the playing item derived by
  kind+id match, and `null` when that is ambiguous or nothing plays.

## Non-negotiables

- No dependency on a running Kodi for unit tests: `tests/mock-kodi.mjs` serves
  the JSON-RPC surface and is the fixture for rpc/service/bridge/tool specs.
- No secrets in logs; no credentials in URLs.
- Every registered resource is disposed by the returned disposer / `ctx.effect`.
