/**
 * src/kodi-service.mjs — the high-level Kodi surface the tools, the TV bridge,
 * the picks engine and the Web panel all share.
 *
 * `KodiService` owns three things:
 *  1. a state cache (`snapshot()`), kept fresh by Kodi notifications over the
 *     WebSocket endpoint and, when that socket is down, by a polling fallback;
 *  2. the user-visible operations (`play`, `queue`, `transport`, `volume`,
 *     `remote`, `notify`, `screenshot`, `search`, `library`);
 *  3. normalization: every item leaving this module has the same shape and
 *     every absent field is `null`, never `undefined`.
 *
 * It degrades instead of exploding: `snapshot()` always answers (with
 * `connected:false` when Kodi is unreachable) while `status()` — which promises
 * live data — throws the transport's typed `KodiRpcError`.
 *
 * Zero dependencies: the notification listener uses the global `WebSocket`
 * (Node 22+), and the raw client is anything shaped like `src/rpc.mjs`.
 *
 * @module dsh-kodi/kodi-service
 */

import { KodiRpcError } from './rpc.mjs';

/**
 * One JSON-RPC call, as the transport exposes it.
 * @typedef {<T>(method: string, params?: Record<string, unknown>, options?: {timeoutMs?: number}) => Promise<T>} KodiCall
 */

/**
 * The raw client `KodiService` needs: `call` is required, the endpoint/wsUrl/
 * authHeader getters are read when present (that is how the notification
 * socket finds Kodi and authenticates without the caller wiring it twice).
 * @typedef {{
 *   call: KodiCall,
 *   endpoint?: string,
 *   wsUrl?: string|null,
 *   authHeader?: string|null,
 * }} KodiRpcLike
 */

/**
 * A normalized media item. Every field is either a value or `null`; `undefined`
 * never survives normalization.
 *
 * @typedef {{
 *   id: number|string|null,
 *   kind: string|null,
 *   label: string|null,
 *   title: string|null,
 *   subtitle: string|null,
 *   year: number|null,
 *   runtime: number|null,
 *   thumbnail: string|null,
 *   file: string|null,
 *   show: string|null,
 *   season: number|null,
 *   episode: number|null,
 * }} KodiItem
 */

/**
 * The cache the panel, tools and bridge read.
 *
 * @typedef {{
 *   connected: boolean,
 *   version: string|null,
 *   updatedAt: string|null,
 *   playing: boolean,
 *   playerId: number|null,
 *   playerType: string|null,
 *   item: KodiItem|null,
 *   position: number|null, // playback position in SECONDS; null when nothing is loaded
 *   queueIndex: number|null, // 1-based slot in the queue; null when nothing is loaded
 *   percentage: number|null,
 *   speed: number|null,
 *   totaltime: number|null,
 *   volume: number|null,
 *   muted: boolean|null,
 *   queue: KodiItem[],
 *   libraryCounts: Record<string, number|null>|null,
 * }} KodiSnapshot
 */

/**
 * The slice of a WHATWG WebSocket that the notification listener uses.
 * @typedef {object} WebSocketInstance
 * @property {number} readyState
 * @property {((event: unknown) => void)|null} onopen
 * @property {((event: {data?: unknown}) => void)|null} onmessage
 * @property {((event: unknown) => void)|null} onerror
 * @property {((event: unknown) => void)|null} onclose
 * @property {() => void} close
 */

/**
 * WebSocket constructor (the global one, or a test double). Node's undici
 * implementation accepts `{headers}` in the second slot.
 * @typedef {new (url: string, options?: {headers?: Record<string, string>}) => WebSocketInstance} WebSocketCtor
 */

/**
 * `library()` accepts these kind names; `search()` accepts the per-item kinds.
 * @type {Record<string, {
 *   method: string,
 *   key: string,
 *   idField: string,
 *   kind: string,
 *   filterField: string,
 *   properties: string[],
 *   sorts: string[],
 *   countKey: string,
 * }>}
 */
const LIBRARY_SPECS = {
  movies: {
    method: 'VideoLibrary.GetMovies',
    key: 'movies',
    idField: 'movieid',
    kind: 'movie',
    filterField: 'title',
    properties: ['title', 'year', 'runtime', 'thumbnail', 'file', 'art', 'genre', 'rating', 'playcount', 'plot'],
    sorts: ['sorttitle', 'title', 'label', 'year', 'runtime', 'dateadded', 'rating', 'playcount', 'random'],
    countKey: 'movies',
  },
  tvshows: {
    method: 'VideoLibrary.GetTVShows',
    key: 'tvshows',
    idField: 'tvshowid',
    kind: 'tvshow',
    filterField: 'title',
    properties: ['title', 'year', 'thumbnail', 'art', 'genre', 'playcount', 'plot'],
    sorts: ['sorttitle', 'title', 'label', 'year', 'dateadded', 'playcount', 'random'],
    countKey: 'tvshows',
  },
  episodes: {
    method: 'VideoLibrary.GetEpisodes',
    key: 'episodes',
    idField: 'episodeid',
    kind: 'episode',
    filterField: 'title',
    properties: ['title', 'showtitle', 'season', 'episode', 'runtime', 'thumbnail', 'file', 'art', 'plot', 'playcount'],
    sorts: ['sorttitle', 'title', 'label', 'dateadded', 'runtime', 'playcount', 'random'],
    countKey: 'episodes',
  },
  artists: {
    method: 'AudioLibrary.GetArtists',
    key: 'artists',
    idField: 'artistid',
    kind: 'artist',
    filterField: 'artist',
    properties: ['genre', 'thumbnail', 'art', 'description'],
    sorts: ['artist', 'label', 'dateadded', 'random'],
    countKey: 'artists',
  },
  albums: {
    method: 'AudioLibrary.GetAlbums',
    key: 'albums',
    idField: 'albumid',
    kind: 'album',
    filterField: 'title',
    properties: ['title', 'artist', 'year', 'thumbnail', 'art', 'genre', 'albumlabel'],
    sorts: ['sorttitle', 'title', 'label', 'artist', 'year', 'dateadded', 'random'],
    countKey: 'albums',
  },
  songs: {
    method: 'AudioLibrary.GetSongs',
    key: 'songs',
    idField: 'songid',
    kind: 'song',
    filterField: 'title',
    properties: ['title', 'artist', 'album', 'duration', 'track', 'thumbnail', 'file', 'art'],
    sorts: ['title', 'label', 'track', 'duration', 'dateadded', 'playcount', 'random'],
    countKey: 'songs',
  },
};

/** Item kind → the `*id` key Kodi's Player.Open / Playlist.Add take. */
const KIND_TO_ID = {
  movie: 'movieid',
  episode: 'episodeid',
  tvshow: 'tvshowid',
  song: 'songid',
  album: 'albumid',
  artist: 'artistid',
};

/** Item kinds that live on Kodi's audio player (playlist 0). */
const AUDIO_KINDS = new Set(['song', 'album', 'artist']);

/** Item kind → `library()` kind, for `search()`. */
const KIND_TO_LIBRARY = {
  movie: 'movies',
  episode: 'episodes',
  tvshow: 'tvshows',
  artist: 'artists',
  album: 'albums',
  song: 'songs',
};

/** Properties Player.GetItem is asked for (Kodi rejects unknown names). */
const ITEM_PROPERTIES = [
  'title',
  'year',
  'runtime',
  'thumbnail',
  'file',
  'art',
  'showtitle',
  'season',
  'episode',
  'plot',
  'artist',
  'album',
  'duration',
  'track',
];

/** Properties Playlist.GetItems is asked for. */
const QUEUE_PROPERTIES = ['title', 'runtime', 'thumbnail', 'file', 'showtitle', 'season', 'episode', 'art', 'duration', 'artist', 'album'];

/** Properties Player.GetProperties is asked for. */
const PLAYER_PROPERTIES = ['position', 'percentage', 'speed', 'time', 'totaltime', 'subtitleenabled', 'currentaudiostream'];

/** `remote(action)` → Kodi's simple Input.* method. */
const INPUT_ACTIONS = {
  up: 'Input.Up',
  down: 'Input.Down',
  left: 'Input.Left',
  right: 'Input.Right',
  select: 'Input.Select',
  back: 'Input.Back',
  home: 'Input.Home',
  context: 'Input.ContextMenu',
  info: 'Input.Info',
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a Kodi numeric field to `number|null`.
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Kodi's "not applicable" sentinels: `-1` for season/episode/runtime,
 * `0` for year. They must become `null`, never reach the panel as `-1`.
 * @param {unknown} value
 * @returns {number|null}
 */
function nonNegative(value) {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
}

/**
 * Kodi reports year `0` for "unknown year"; every real release year is > 0.
 * @param {unknown} value
 * @returns {number|null}
 */
function positiveOrNull(value) {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * Coerce a Kodi boolean-ish field to `boolean|null`.
 * @param {unknown} value
 * @returns {boolean|null}
 */
function boolOrNull(value) {
  if (value === null || value === undefined) return null;
  return Boolean(value);
}

/**
 * First non-empty value of the candidates, as `string|null`.
 * @param {...unknown} candidates
 * @returns {string|null}
 */
function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (Array.isArray(candidate)) {
      const joined = candidate.filter((part) => typeof part === 'string' && part.length > 0).join(', ');
      if (joined) return joined;
    }
  }
  return null;
}

/**
 * First non-null value among the candidates (0 and false are kept).
 * @param {...unknown} candidates
 * @returns {unknown}
 */
function firstValue(...candidates) {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined) return candidate;
  }
  return null;
}

/**
 * Kodi's version object → the string Kodi itself displays.
 *
 * Measured against Kodi 21.3: `Application.GetProperties(['version'])` returns
 * `{major:21, minor:3, revision:'20260315-nogitfound', tag:'stable'}` — there is
 * no `patch`, so `'21.3'` is right and `'21.3.0'` would be an invention. A build
 * that does report a non-zero patch keeps it.
 *
 * @param {unknown} version
 * @returns {string|null}
 */
function formatVersion(version) {
  if (!isRecord(version)) return null;
  const major = num(version.major);
  const minor = num(version.minor);
  const patch = num(version.patch);
  if (major === null) return null;
  const base = `${major}.${minor ?? 0}`;
  return patch !== null && patch > 0 ? `${base}.${patch}` : base;
}

/**
 * Kodi's `{hours, minutes, seconds, milliseconds}` time object → seconds.
 * @param {unknown} time
 * @returns {number|null}
 */
function kodiSeconds(time) {
  if (!isRecord(time)) return null;
  const hours = num(time.hours) ?? 0;
  const minutes = num(time.minutes) ?? 0;
  const seconds = num(time.seconds) ?? 0;
  const milliseconds = num(time.milliseconds) ?? 0;
  // Kodi has been observed sending a negative milliseconds field; never yield a
  // negative playback position from it.
  return Math.max(0, hours * 3600 + minutes * 60 + seconds + milliseconds / 1000);
}

/**
 * Infer an item kind from the id field a Kodi row carries.
 * @param {Record<string, any>} row
 * @returns {string|null}
 */
function inferKind(row) {
  if (num(row.movieid) !== null) return 'movie';
  if (num(row.episodeid) !== null) return 'episode';
  if (num(row.tvshowid) !== null) return 'tvshow';
  if (num(row.songid) !== null) return 'song';
  if (num(row.albumid) !== null) return 'album';
  if (num(row.artistid) !== null) return 'artist';
  return null;
}

/**
 * Normalize any Kodi item row into the contracted {@link KodiItem} shape.
 * Every field is present; missing ones are `null`, never `undefined`.
 *
 * @param {unknown} raw a Kodi JSON-RPC item (library row, Player.GetItem item, playlist row)
 * @param {string|null} [kindHint] used when the row carries no `type`/`*id`
 * @returns {KodiItem}
 */
export function normalizeItem(raw, kindHint = null) {
  const row = isRecord(raw) ? raw : {};
  const kind = firstString(row.type) ?? kindHint ?? inferKind(row);
  const season = nonNegative(row.season);
  const episode = nonNegative(row.episode);
  const show = firstString(row.showtitle);
  const art = isRecord(row.art) ? row.art : {};
  const artist = firstString(row.artist);

  const subtitleCandidates = [
    row.subtitle,
    row.tagline,
    kind === 'episode' ? show : null,
    kind === 'episode' && season !== null && episode !== null
      ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      : null,
    kind === 'song' ? firstString(row.album) : null,
    kind === 'album' ? artist : null,
  ];

  return {
    id: nonNegative(firstValue(row.movieid, row.episodeid, row.tvshowid, row.songid, row.albumid, row.artistid, row.id)),
    kind,
    label: firstString(row.label),
    title: firstString(row.title, row.label, row.artist),
    subtitle: firstString(...subtitleCandidates),
    year: positiveOrNull(row.year),
    runtime: nonNegative(firstValue(row.runtime, row.duration)),
    thumbnail: firstString(row.thumbnail, art.thumb, art.poster, art.icon, art.fanart),
    file: firstString(row.file),
    show,
    season: nonNegative(season),
    episode: nonNegative(episode),
  };
}

/**
 * Build the human "extra" line `search()` attaches to a result.
 * @param {Record<string, unknown>} row
 * @param {string} kind
 * @returns {string|null}
 */
function extraFor(row, kind) {
  switch (kind) {
    case 'episode': {
      const show = firstString(row.showtitle);
      const season = num(row.season);
      const episode = num(row.episode);
      if (show && season !== null && episode !== null) return `${show} · S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      return show;
    }
    case 'movie':
      return firstString(row.genre) ?? 'Movie';
    case 'tvshow':
      return firstString(row.genre) ?? 'TV show';
    case 'artist':
      return firstString(row.genre) ?? 'Artist';
    case 'album':
      return firstString(row.artist) ?? 'Album';
    case 'song':
      return firstString(row.artist) && firstString(row.album) ? `${firstString(row.artist)} · ${firstString(row.album)}` : firstString(row.artist, row.album);
    default:
      return null;
  }
}

/**
 * Build the searchable text for a row (used by the client-side fallback when
 * Kodi refuses server-side filters).
 * @param {Record<string, unknown>} row
 * @param {typeof LIBRARY_SPECS[string]} spec
 * @returns {string}
 */
function haystack(row, spec) {
  const parts = [row.label, row.title, row.artist, row.album, row.showtitle, row.genre];
  return parts
    .map((part) => (Array.isArray(part) ? part.join(' ') : String(part ?? '')))
    .join(' ')
    .toLowerCase();
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function messageOf(value) {
  if (value instanceof Error) return value.message;
  return String(value ?? 'unknown error');
}

/**
 * Kodi "player + library + cache" facade.
 *
 * @example
 * const kodi = new KodiService({ rpc, log: (level, message) => console.log(level, message) });
 * await kodi.start();
 * await kodi.play({ kind: 'movie', id: 1 });
 * kodi.snapshot(); // => { connected: true, playing: true, item: {...}, ... }
 */
export class KodiService {
  /** @type {KodiRpcLike} */
  #rpc;
  /** @type {((level: string, message: string) => void)|Record<string, unknown>|null} */
  #log;
  /** @type {string|null} */
  #notificationUrl;
  /** @type {number} */
  #pollMs;
  /** @type {number} */
  #countsTtlMs;
  /** @type {number} */
  #debounceMs;
  /** @type {WebSocketCtor|null} */
  #webSocketImpl;
  /** @type {() => number} */
  #now;
  /** @type {KodiSnapshot} */
  #state;
  /** @type {Set<(snapshot: KodiSnapshot) => void>} */
  #listeners = new Set();
  /** @type {string} */
  #lastEmitted = '';
  /** @type {number} */
  #countsAt = 0;
  /** @type {Promise<KodiSnapshot>|null} */
  #refreshPromise = null;
  /** @type {WebSocketInstance|null} */
  #ws = null;
  /** @type {boolean} */
  #wsLive = false;
  /** @type {NodeJS.Timeout|null} */
  #reconnectTimer = null;
  /** @type {number} */
  #reconnectAttempt = 0;
  /** @type {NodeJS.Timeout|null} */
  #pollTimer = null;
  /** @type {NodeJS.Timeout|null} */
  #debounceTimer = null;
  /** @type {boolean} */
  #stopped = true;
  /** @type {unknown} */
  #lastError = null;
  /** @type {{attempts: number, delayMs: number}} */
  #startupWait;

  /**
   * @param {{
   *   rpc: KodiRpcLike,
   *   log?: ((level: string, message: string) => void)|Record<string, unknown>|null,
   *   notificationUrl?: string|null,
   *   pollMs?: number,
   *   countsTtlMs?: number,
   *   debounceMs?: number,
   *   webSocketImpl?: WebSocketCtor|null,
   *   now?: () => number,
   *   startupWait?: {attempts?: number, delayMs?: number},
   * }} options
   */
  constructor({
    rpc,
    log = null,
    notificationUrl = null,
    pollMs = 5000,
    countsTtlMs = 60000,
    debounceMs = 120,
    webSocketImpl = null,
    now = () => Date.now(),
    startupWait = { attempts: 5, delayMs: 200 },
  }) {
    if (!rpc || typeof rpc.call !== 'function') {
      throw new TypeError('KodiService requires an rpc client with a call(method, params) method');
    }
    this.#rpc = rpc;
    this.#log = log;
    this.#notificationUrl = notificationUrl ? String(notificationUrl) : null;
    this.#pollMs = Number.isFinite(Number(pollMs)) ? Math.max(0, Number(pollMs)) : 5000;
    this.#countsTtlMs = Number.isFinite(Number(countsTtlMs)) ? Math.max(0, Number(countsTtlMs)) : 60000;
    this.#debounceMs = Number.isFinite(Number(debounceMs)) ? Math.max(0, Number(debounceMs)) : 120;
    this.#webSocketImpl = webSocketImpl;
    this.#now = typeof now === 'function' ? now : () => Date.now();
    const waitAttempts = Number(startupWait?.attempts);
    const waitDelay = Number(startupWait?.delayMs);
    this.#startupWait = {
      attempts: Number.isFinite(waitAttempts) && waitAttempts >= 1 ? Math.trunc(waitAttempts) : 5,
      delayMs: Number.isFinite(waitDelay) && waitDelay >= 0 ? Math.trunc(waitDelay) : 200,
    };
    this.#state = {
      connected: false,
      version: null,
      updatedAt: null,
      playing: false,
      playerId: null,
      playerType: null,
      item: null,
      position: null,
      queueIndex: null,
      percentage: null,
      speed: null,
      totaltime: null,
      volume: null,
      muted: null,
      queue: [],
      libraryCounts: null,
    };
  }

  /**
   * The raw JSON-RPC client, for Kodi methods this facade does not wrap (the
   * picks engine uses it for playcount and in-progress filters).
   * @returns {KodiRpcLike}
   */
  get rpc() {
    return this.#rpc;
  }

  /**
   * Forward a raw JSON-RPC call to Kodi (same typed errors as the transport).
   * @template T
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<T>}
   */
  async call(method, params = {}, options = {}) {
    return this.#rpc.call(method, params, options);
  }

  /** @returns {boolean} last observed reachability (cache, never a live probe). */
  get connected() {
    return this.#state.connected;
  }

  /** @returns {string|null} Kodi version string, e.g. `'21.2.0'`. */
  get version() {
    return this.#state.version;
  }

  /** @returns {unknown} the last error that made the service go disconnected. */
  get lastError() {
    return this.#lastError;
  }

  /** @returns {string} redacted endpoint, for tool error messages. */
  get endpoint() {
    const endpoint = this.#rpc.endpoint;
    return typeof endpoint === 'string' && endpoint ? endpoint : '(Kodi endpoint)';
  }

  /**
   * Current cache, as a plain object safe to hand to tools / the bridge / the
   * panel. Always answers, even when Kodi is down.
   * @returns {KodiSnapshot}
   */
  snapshot() {
    const state = this.#state;
    return {
      connected: state.connected,
      version: state.version,
      updatedAt: state.updatedAt,
      playing: state.playing,
      playerId: state.playerId,
      playerType: state.playerType,
      item: state.item ? { ...state.item } : null,
      position: state.position,
      queueIndex: state.queueIndex,
      percentage: state.percentage,
      speed: state.speed,
      totaltime: state.totaltime,
      volume: state.volume,
      muted: state.muted,
      queue: state.queue.map((item) => ({ ...item })),
      libraryCounts: state.libraryCounts ? { ...state.libraryCounts } : null,
    };
  }

  /**
   * Subscribe to state changes. The listener is called immediately with the
   * current snapshot, then on every meaningful change (position included,
   * `updatedAt` alone does not count as a change).
   * @param {(snapshot: KodiSnapshot) => void} listener
   * @returns {() => void} unsubscribe
   */
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('onState(listener) requires a function');
    this.#listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch (error) {
      this.#logMessage('warn', `state listener failed: ${messageOf(error)}`);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Ping Kodi and read its version. Throws `KodiRpcError` when unreachable.
   *
   * Only two calls are made, both verified against a live Kodi 21.3:
   * `JSONRPC.Ping` and `Application.GetProperties(['version','name'])`.
   * `JSONRPC.GetVersion` was REMOVED from Kodi (it answers `-32601 Method not
   * found`), so `apiVersion` is `null` on those builds rather than a value
   * invented from the application version.
   *
   * @returns {Promise<{ok: boolean, version: string|null, apiVersion: string|null}>}
   */
  async ping() {
    await this.#rpc.call('JSONRPC.Ping');
    const props = await this.#rpc.call('Application.GetProperties', { properties: ['version', 'name'] });
    const version = formatVersion(isRecord(props) ? props.version : null);
    this.#state.version = version;
    this.#state.connected = true;
    return { ok: true, version, apiVersion: null };
  }

  /**
   * Live snapshot: force a refresh first. Throws when Kodi is unreachable
   * (use `snapshot()` when you want the cached, possibly-stale answer).
   * @returns {Promise<KodiSnapshot>}
   */
  async status() {
    await this.refresh();
    return this.snapshot();
  }

  /**
   * Start the service: ping, seed the cache, connect the notification socket
   * and start the polling fallback. A down Kodi is not an error here — the
   * service stays up in a disconnected state and recovers by itself.
   * @returns {Promise<{ok: boolean, version: string|null, apiVersion: string|null, error?: string}>}
   */
  async start() {
    this.#stopped = false;
    /** @type {{ok: boolean, version: string|null, apiVersion: string|null, error?: string}} */
    let pingResult;
    try {
      pingResult = await this.ping();
    } catch (error) {
      this.#lastError = error;
      this.#state.connected = false;
      pingResult = { ok: false, version: null, apiVersion: null, error: messageOf(error) };
      this.#logMessage('warn', `Kodi is not reachable at ${this.endpoint}: ${messageOf(error)}`);
    }
    this.#countsAt = 0;
    await this.#safeRefresh();
    this.#connectNotifications();
    this.#startPollFallback();
    this.#emit();
    return pingResult;
  }

  /**
   * Stop timers and close the notification socket. Idempotent; the cache and
   * listeners survive so `start()` can be called again.
   * @returns {Promise<void>}
   */
  async stop() {
    this.#stopped = true;
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    const socket = this.#ws;
    this.#ws = null;
    this.#wsLive = false;
    if (socket) {
      try {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
      } catch {
        // A non-extensible implementation: closing below still releases it.
      }
      try {
        if (socket.readyState === 0 || socket.readyState === 1) socket.close();
      } catch {
        // Already closed by the peer.
      }
    }
    this.#state.connected = false;
    this.#emit();
  }

  /**
   * Refresh the cache from Kodi. Concurrent calls share one refresh.
   * Throws the transport error when Kodi is unreachable; the cache is marked
   * `connected:false` before the throw.
   * @returns {Promise<KodiSnapshot>}
   */
  async refresh() {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#doRefresh().finally(() => {
      this.#refreshPromise = null;
    });
    return this.#refreshPromise;
  }

  /**
   * Search the video and audio libraries.
   *
   * Uses Kodi's server-side `filter` when the build supports it and falls back
   * to fetching a window and matching locally when Kodi refuses the filter.
   *
   * @param {string} query
   * @param {{kinds?: string[], limit?: number}} [options]
   * @returns {Promise<{results: Array<{
   *   kind: string, id: number|string|null, label: string|null, title: string|null,
   *   extra: string|null, thumbnail: string|null, file: string|null,
   *   year: number|null, runtime: number|null,
   * }>}>}
   */
  async search(query, { kinds = ['movie', 'episode', 'artist', 'album', 'song'], limit = 25 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return { results: [] };
    const perKind = Math.max(1, Number(limit) || 25);
    const requested = Array.isArray(kinds) ? kinds.map((kind) => String(kind)) : [];
    const wanted = [...new Set(requested)].filter((kind) => KIND_TO_LIBRARY[kind]);

    /** @type {Array<Record<string, unknown>>} */
    const results = [];
    for (const kind of wanted) {
      const spec = LIBRARY_SPECS[KIND_TO_LIBRARY[kind]];
      const rows = await this.#searchKind(spec, q, perKind);
      for (const row of rows) {
        const item = normalizeItem(row, kind);
        results.push({
          kind,
          id: item.id,
          label: item.label,
          title: item.title,
          extra: extraFor(row, kind),
          thumbnail: item.thumbnail,
          file: item.file,
          year: item.year,
          runtime: item.runtime,
        });
      }
    }

    const needle = q.toLowerCase();
    /**
     * @param {Record<string, unknown>} row
     * @returns {number}
     */
    const rank = (row) => {
      const text = String(row.label ?? row.title ?? '').toLowerCase();
      return text.startsWith(needle) ? 0 : 1;
    };
    results.sort((a, b) => rank(a) - rank(b) || String(a.label ?? '').localeCompare(String(b.label ?? ''), 'en'));
    return { results: results.slice(0, perKind) };
  }

  /**
   * List one library. Unknown defaults are mapped to a sort method the library
   * actually accepts, so `library('songs')` with the contracted default
   * (`'sorttitle'`) does not become a Kodi `-32602`.
   *
   * @param {'movies'|'tvshows'|'episodes'|'artists'|'albums'|'songs'} kind
   * @param {{limit?: number, start?: number, sort?: string, filter?: string|Record<string, unknown>}} [options]
   * @returns {Promise<{items: KodiItem[], total: number, limits: {start: number, end: number, total: number}}>}
   * @throws {RangeError} unknown kind
   */
  async library(kind, { limit = 50, start = 0, sort = 'sorttitle', filter = '' } = {}) {
    const spec = LIBRARY_SPECS[String(kind)];
    if (!spec) throw new RangeError(`Unknown library kind: ${kind} (expected ${Object.keys(LIBRARY_SPECS).join(', ')})`);

    const startAt = Math.max(0, Math.trunc(Number(start) || 0));
    const count = Math.max(0, Math.trunc(Number(limit) || 0));
    const sortMethod = spec.sorts.includes(String(sort)) ? String(sort) : spec.sorts[0];

    /** @type {Record<string, unknown>} */
    const params = {
      properties: spec.properties,
      limits: { start: startAt, end: startAt + count },
      sort: { method: sortMethod, order: 'ascending' },
    };
    if (isRecord(filter)) {
      params.filter = filter;
    } else if (typeof filter === 'string' && filter.trim()) {
      params.filter = { field: spec.filterField, operator: 'contains', value: filter.trim() };
    }

    const response = await this.#rpc.call(spec.method, params);
    const rows = Array.isArray(response?.[spec.key]) ? response[spec.key] : [];
    const items = rows.map((row) => normalizeItem(row, spec.kind));
    const limits = {
      start: num(response?.limits?.start) ?? startAt,
      end: num(response?.limits?.end) ?? startAt + items.length,
      total: num(response?.limits?.total) ?? items.length,
    };
    return { items, total: limits.total, limits };
  }

  /**
   * Start playback (or append to the queue).
   *
   * `Player.Open` is asynchronous: it answers `"OK"` before a player exists, so
   * this waits for `Player.GetActivePlayers` to report one (constructor option
   * `startupWait`, default 5 × 200 ms) and reports
   * `{ok:false, playing:false, error:'Kodi accepted the request, but no player
   * started on the TV.'}` when none appears. A queued add is never failed that
   * way — queueing legitimately leaves the TV idle.
   *
   * A `{playlistid, position}` target is accepted too (position 1-based, 1 =
   * first item), which is how the panel resumes a queue slot.
   *
   * @param {{kind?: string, id?: number|string, file?: string, playlistid?: number, position?: number}} target
   * @param {{queue?: boolean}} [options] `queue:true` appends instead of playing now
   * @returns {Promise<{ok: boolean, playing: boolean, queued?: boolean, playlistid?: number, error?: string}>}
   */
  async play(target, { queue = false } = {}) {
    const item = this.#playItem(target);
    if (queue) {
      const playlistid = this.#playlistFor(target);
      await this.#rpc.call('Playlist.Add', { playlistid, item });
      await this.#safeRefresh();
      // A queued add legitimately leaves the TV idle; never fail it for that.
      return { ok: true, playing: this.#state.playing, queued: true, playlistid };
    }
    await this.#rpc.call('Player.Open', { item });
    // Player.Open is asynchronous: it answers "OK" before a player exists, and
    // GetActivePlayers can still be [] right afterwards (measured on Kodi 21.3).
    // Only report success once a player is actually active.
    const starter = await this.#waitForPlayer();
    if (!starter) {
      await this.#safeRefresh();
      return { ok: false, playing: false, error: 'Kodi accepted the request, but no player started on the TV.' };
    }
    // Right after a start Kodi can still report the previous (or an empty)
    // item; wait for the new item before caching and reporting.
    await this.#waitForPlaybackItem(starter.playerid);
    await this.#safeRefresh();
    return { ok: true, playing: true };
  }

  /**
   * The active playlist, as normalized items plus the 1-based position of the
   * item that is playing (`null` when nothing is loaded).
   * @returns {Promise<{items: KodiItem[], current: number|null, playlistid: number}>}
   */
  async queueList() {
    const player = await this.#activePlayer();
    const playlistid = player ? player.playerid : 1;
    const [listing, props] = await Promise.all([
      this.#rpc.call('Playlist.GetItems', { playlistid, properties: QUEUE_PROPERTIES, limits: { start: 0, end: 200 } }),
      player
        ? this.#rpc.call('Player.GetProperties', { playerid: player.playerid, properties: ['position'] }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const items = (Array.isArray(listing?.items) ? listing.items : []).map((row) => normalizeItem(row, playlistid === 0 ? 'song' : null));
    const playlistIndex = num(props?.position);
    return { items, current: playlistIndex === null ? null : playlistIndex + 1, playlistid };
  }

  /**
   * Mutate the playlist.
   *
   * `remove` is a documented extension beyond the contracted
   * `add|insert|clear|jump` set (the panel's queue needs it).
   *
   * Positions are 1-based, the way a person counts a queue: `jump`/`remove`
   * take `1` for the first item, and `insert` inserts *before* item N (0 is
   * tolerated as "before the first item"). Kodi's 0-based indices never leak.
   *
   * @param {'add'|'insert'|'clear'|'jump'|'remove'} action
   * @param {{items?: Array<Record<string, unknown>>, position?: number, play?: boolean}} [options]
   * @returns {Promise<{ok: boolean, length: number, current: number|null, playlistid: number}>}
   */
  async queue(action, { items = [], position, play } = {}) {
    const act = String(action);
    const list = Array.isArray(items) ? items : [items];
    const refs = list.filter(Boolean).map((entry) => this.#playItem(entry));
    const playlistid = refs.length > 0 ? this.#playlistFor(list.find(Boolean)) : await this.#defaultPlaylistId();

    switch (act) {
      case 'add': {
        for (const item of refs) await this.#rpc.call('Playlist.Add', { playlistid, item });
        break;
      }
      case 'insert': {
        // 1-based: "insert before item N"; 0 is tolerated as "before the first".
        const requested = Math.trunc(Number(position) || 0);
        let at = requested <= 0 ? 0 : requested - 1;
        for (const item of refs) {
          await this.#rpc.call('Playlist.Insert', { playlistid, position: at, item });
          at += 1;
        }
        break;
      }
      case 'clear': {
        await this.#rpc.call('Playlist.Clear', { playlistid });
        break;
      }
      case 'remove': {
        const at = Number(position);
        if (!Number.isFinite(at) || at < 1) throw new RangeError('queue remove needs a 1-based position (1 = first item)');
        await this.#rpc.call('Playlist.Remove', { playlistid, position: Math.trunc(at) - 1 });
        break;
      }
      case 'jump': {
        const to = Number(position);
        if (!Number.isFinite(to) || to < 1) throw new RangeError('queue jump needs a 1-based position (1 = first item)');
        // Verified live on Kodi 21.3: Player.GoTo `to` and Player.Open `position`
        // are 0-BASED (`to:1` played the 2nd queue item; `to:0` the 1st).
        const index = Math.trunc(to) - 1;
        const player = await this.#activePlayer();
        const before = player ? await this.#readPlayback(player.playerid) : { index: null, itemId: null };
        if (player) {
          await this.#rpc.call('Player.GoTo', { playerid: player.playerid, to: index });
          await this.#settlePosition(player.playerid, before);
        } else if (play !== false) {
          await this.#rpc.call('Player.Open', { item: { playlistid, position: index } });
          const opened = await this.#waitForPlayer();
          if (opened) await this.#waitForPlaybackItem(opened.playerid);
        }
        break;
      }
      default:
        throw new RangeError(`Unknown queue action: ${action} (expected add, insert, clear, jump, remove)`);
    }

    const updated = await this.queueList();
    await this.#safeRefresh();
    return { ok: true, length: updated.items.length, current: updated.current, playlistid };
  }

  /**
   * Transport controls.
   * `skip` with a number is a *relative* jump in seconds (`-30` goes back);
   * `skip` with `'previous'`/`'next'` moves between queue items.
   *
   * @param {'playpause'|'play'|'pause'|'stop'|'seek'|'skip'|'speed'} action
   * @param {{value?: number|string|Record<string, unknown>}} [options]
   * @returns {Promise<{ok: boolean, playing: boolean, position: number|null, speed: number|null}>}
   */
  async transport(action, { value } = {}) {
    const act = String(action);
    const player = await this.#activePlayer();

    try {
      switch (act) {
        case 'playpause': {
          if (player) await this.#rpc.call('Player.PlayPause', { playerid: player.playerid });
          else await this.#resumeLastPlayed();
          break;
        }
        case 'play': {
          if (player) await this.#rpc.call('Player.PlayPause', { playerid: player.playerid, play: true });
          else await this.#resumeLastPlayed();
          break;
        }
        case 'pause': {
          if (!player) return { ok: true, playing: false, position: null, speed: null };
          await this.#rpc.call('Player.PlayPause', { playerid: player.playerid, play: false });
          break;
        }
        case 'stop': {
          if (!player) return { ok: true, playing: false, position: null, speed: null };
          await this.#rpc.call('Player.Stop', { playerid: player.playerid });
          break;
        }
        case 'seek': {
          this.#requirePlayer(player, 'seek');
          const seekValue = this.#seekValue(value);
          const before = await this.#readPlayback(player.playerid);
          await this.#rpc.call('Player.Seek', { playerid: player.playerid, value: seekValue });
          // Player.Seek is asynchronous too: the first GetProperties after it can
          // still report the pre-seek position (measured: 4.59% / 2s at first,
          // 42.5% / 25s a moment later). Wait for it to settle, then refresh.
          await this.#confirmSeek(player.playerid, seekValue, before);
          break;
        }
        case 'skip': {
          this.#requirePlayer(player, 'skip');
          if (typeof value === 'number' && Number.isFinite(value)) {
            // The model-facing contract for "skip 30 seconds" is a relative jump.
            // `time` (exact seconds) beats `percentage` (rounded to 0.1%).
            const before = await this.#readPlayback(player.playerid);
            if (!before.total || before.total <= 0) {
              throw new KodiRpcError('Cannot skip relative to an item of unknown duration; seek with an absolute value instead', {
                kind: 'rpc',
                code: 'ENODURATION',
                method: 'Player.Seek',
              });
            }
            const target = Math.min(before.total, Math.max(0, before.seconds + value));
            const seekValue = { seconds: Math.round(target * 1000) / 1000 };
            await this.#rpc.call('Player.Seek', { playerid: player.playerid, value: seekValue });
            await this.#confirmSeek(player.playerid, seekValue, before);
          } else {
            const previous = value === 'previous' || value === 'prev' || value === 'back' || value === -1;
            const before = await this.#readPlayback(player.playerid);
            await this.#rpc.call('Player.GoTo', { playerid: player.playerid, to: previous ? 'previous' : 'next' });
            await this.#settlePosition(player.playerid, before);
          }
          break;
        }
        case 'speed': {
          this.#requirePlayer(player, 'speed');
          const speed = Number(value);
          if (!Number.isFinite(speed)) throw new RangeError('transport speed needs a numeric value (e.g. 1, 2, 0.5)');
          await this.#rpc.call('Player.SetSpeed', { playerid: player.playerid, speed });
          break;
        }
        default:
          throw new RangeError(`Unknown transport action: ${action}`);
      }
    } catch (error) {
      throw this.#humanizePlaybackError(error, act);
    }

    await this.#safeRefresh();
    return { ok: true, playing: this.#state.playing, position: this.#state.position, speed: this.#state.speed };
  }

  /**
   * Read and/or change volume/mute.
   * @param {{set?: number, delta?: number, mute?: boolean|'toggle'}} [options]
   * @returns {Promise<{volume: number|null, muted: boolean|null}>}
   */
  async volume({ set, delta, mute } = {}) {
    if (mute !== undefined && mute !== null) {
      await this.#rpc.call('Application.SetMute', { mute: mute === 'toggle' ? 'toggle' : Boolean(mute) });
    }
    const wantsLevel = typeof set === 'number' || typeof delta === 'number';
    if (wantsLevel) {
      let target;
      if (typeof set === 'number') {
        target = set;
      } else {
        const current = await this.#rpc.call('Application.GetProperties', { properties: ['volume'] });
        target = Number(current?.volume ?? 0) + Number(delta);
      }
      const clamped = Math.max(0, Math.min(100, Math.round(Number(target))));
      await this.#rpc.call('Application.SetVolume', { volume: clamped });
    }
    const props = await this.#rpc.call('Application.GetProperties', { properties: ['volume', 'muted'] });
    this.#state.volume = num(props?.volume);
    this.#state.muted = boolOrNull(props?.muted);
    this.#emit();
    return { volume: this.#state.volume, muted: this.#state.muted };
  }

  /**
   * D-pad / keyboard actions on the TV.
   * @param {'up'|'down'|'left'|'right'|'select'|'back'|'home'|'context'|'info'|'sendtext'|'key'} action
   * @param {{value?: string}} [options] `sendtext` → text, `key` → a Kodi action name
   * @returns {Promise<{ok: boolean, action: string, executed?: string}>}
   */
  async remote(action, { value } = {}) {
    const act = String(action);
    if (Object.prototype.hasOwnProperty.call(INPUT_ACTIONS, act)) {
      await this.#rpc.call(INPUT_ACTIONS[act]);
      return { ok: true, action: act };
    }
    if (act === 'sendtext' || act === 'text') {
      if (typeof value !== 'string') throw new RangeError('remote sendtext needs a text value');
      await this.#rpc.call('Input.SendText', { text: value, done: true });
      return { ok: true, action: 'sendtext' };
    }
    if (act === 'key') {
      if (typeof value !== 'string' || value.length === 0) {
        throw new RangeError('remote key needs a Kodi action name, e.g. "screenshot", "osd" or "shutdown"');
      }
      await this.#rpc.call('Input.ExecuteAction', { action: value });
      return { ok: true, action: 'key', executed: value };
    }
    throw new RangeError(`Unknown remote action: ${action}`);
  }

  /**
   * Show a Kodi notification on the TV.
   * @param {{title?: string, message?: string, image?: string|null, time?: number|null}} [options]
   *        `time` is the display duration in seconds (Kodi's `displaytime` is ms).
   * @returns {Promise<{ok: boolean}>}
   */
  async notify({ title = 'DeepSeek Harness', message = '', image = null, time = null } = {}) {
    /** @type {Record<string, unknown>} */
    const params = { title: String(title), message: String(message) };
    if (typeof image === 'string' && image) params.image = image;
    if (typeof time === 'number' && Number.isFinite(time)) params.displaytime = Math.max(1000, Math.round(time * 1000));
    await this.#rpc.call('GUI.ShowNotification', params);
    return { ok: true };
  }

  /**
   * Ask Kodi to take a screenshot and locate the file it wrote.
   *
   * Kodi writes `special://temp/screenshotNNNN.png`; this finds the newest one
   * and, when Kodi's web server can serve it, also returns an HTTP URL.
   * @returns {Promise<{path: string|null, file: string|null}>} `path` is the
   *          Kodi `special://` path, `file` the downloadable HTTP URL (or null)
   */
  async screenshot() {
    await this.#rpc.call('Input.ExecuteAction', { action: 'screenshot' });
    /** @type {string|null} */
    let path = null;
    /** @type {string|null} */
    let file = null;
    try {
      const listing = await this.#rpc.call('Files.GetDirectory', {
        directory: 'special://temp/',
        media: 'files',
        properties: ['file', 'lastmodified', 'size'],
      });
      const shots = (Array.isArray(listing?.files) ? listing.files : [])
        .filter((entry) => /screenshot[^/\\]*\.(png|jpe?g)$/i.test(String(entry?.file ?? '')))
        .sort((a, b) => this.#timestamp(b?.lastmodified) - this.#timestamp(a?.lastmodified));
      if (shots.length > 0) {
        path = String(shots[0].file);
        try {
          const prepared = await this.#rpc.call('Files.PrepareDownload', { path });
          const details = isRecord(prepared?.details) ? prepared.details : {};
          if (typeof details.path === 'string' && details.path) file = `${this.#httpOrigin()}${details.path}`;
        } catch {
          // The screenshot exists; a served URL is a convenience only.
        }
      }
    } catch (error) {
      this.#logMessage('debug', `screenshot listing failed: ${messageOf(error)}`);
    }
    return { path, file };
  }

  // ---------------------------------------------------------------- internals

  /**
   * Fetch the rows for one search kind, preferring Kodi's server-side filter.
   * @param {typeof LIBRARY_SPECS[string]} spec
   * @param {string} query
   * @param {number} limit
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async #searchKind(spec, query, limit) {
    const window = Math.max(limit * 2, 20);
    /** @param {boolean} useFilter */
    const request = (useFilter) => {
      /** @type {Record<string, unknown>} */
      const params = {
        properties: spec.properties,
        limits: { start: 0, end: window },
        sort: { method: spec.filterField, order: 'ascending' },
      };
      if (useFilter) params.filter = { field: spec.filterField, operator: 'contains', value: query };
      return this.#rpc.call(spec.method, params);
    };

    try {
      const response = await request(true);
      return Array.isArray(response?.[spec.key]) ? response[spec.key] : [];
    } catch (error) {
      const kind = isRecord(error) && typeof error.kind === 'string' ? error.kind : '';
      if (kind === 'transport' || kind === 'timeout' || kind === 'auth' || kind === 'disabled') throw error;
      // Kodi rejected the filter (older build, or the field is not filterable
      // server-side): fetch a window and match locally.
      const response = await request(false);
      const needle = query.toLowerCase();
      const rows = Array.isArray(response?.[spec.key]) ? response[spec.key] : [];
      return rows.filter((row) => haystack(row, spec).includes(needle)).slice(0, window);
    }
  }

  /**
   * @returns {Promise<{playerid: number, type: string}|null>}
   */
  async #activePlayer() {
    const players = await this.#rpc.call('Player.GetActivePlayers');
    return Array.isArray(players) && players.length > 0 ? { playerid: Number(players[0].playerid), type: String(players[0].type ?? '') } : null;
  }

  /**
   * A player-independent "what should I act on" guard.
   * @param {{playerid: number}|null} player
   * @param {string} action
   * @returns {asserts player is {playerid: number, type: string}}
   */
  #requirePlayer(player, action) {
    if (!player) {
      // The sentence the model reads, not Kodi's "-32100".
      throw new KodiRpcError('Nothing is playing on the TV.', {
        kind: 'rpc',
        code: 'ENOPLAYER',
        method: action,
      });
    }
  }

  /**
   * Kodi answers `-32100 Failed to execute method` for player commands when no
   * player is active. Keep the wire code for logs, but hand the model a
   * sentence instead of a number.
   * @param {unknown} error
   * @param {string|null} action
   * @returns {unknown} the typed error to throw
   */
  #humanizePlaybackError(error, action) {
    if (isRecord(error) && error.kind === 'rpc' && error.code === -32100) {
      return new KodiRpcError('Nothing is playing on the TV.', {
        kind: 'rpc',
        code: error.code,
        method: typeof error.method === 'string' ? error.method : action,
        data: error.data ?? null,
        cause: error,
      });
    }
    return error;
  }

  /**
   * Poll until a player is active after Player.Open (which is asynchronous).
   * @returns {Promise<{playerid: number, type: string}|null>}
   */
  async #waitForPlayer() {
    const { attempts, delayMs } = this.#startupWait;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const players = await this.#rpc.call('Player.GetActivePlayers');
        if (Array.isArray(players) && players.length > 0) {
          return { playerid: Number(players[0].playerid), type: String(players[0].type ?? '') };
        }
      } catch {
        // A transient failure here must not turn a successful start into an error.
      }
      if (i < attempts - 1 && delayMs > 0) await sleep(delayMs);
    }
    return null;
  }

  /**
   * Right after a start or a queue move, `Player.GetItem` can still answer with
   * the previous item (measured: position already updated, title stale by one
   * poll). Wait until the item reports an id or a title.
   * @param {number} playerid
   * @param {{attempts?: number, delayMs?: number}} [options]
   * @returns {Promise<void>}
   */
  async #waitForPlaybackItem(playerid, { attempts = 4, delayMs = 150 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      const response = await this.#rpc.call('Player.GetItem', { playerid, properties: ITEM_PROPERTIES }).catch(() => null);
      const item = isRecord(response) && isRecord(response.item) ? response.item : null;
      if (item && (num(item.id) !== null || firstString(item.title, item.label) !== null)) return;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }

  /**
   * Read the playback position once, in both seconds and percentage terms.
   * @param {number} playerid
   * @returns {Promise<{seconds: number|null, percentage: number|null, total: number|null, index: number|null, itemId: number|string|null}>}
   */
  async #readPlayback(playerid) {
    const [props, response] = await Promise.all([
      this.#rpc
        .call('Player.GetProperties', { playerid, properties: ['position', 'percentage', 'speed', 'time', 'totaltime'] })
        .catch(() => null),
      this.#rpc.call('Player.GetItem', { playerid, properties: ['title'] }).catch(() => null),
    ]);
    const item = isRecord(response) && isRecord(response.item) ? response.item : null;
    return {
      seconds: kodiSeconds(props?.time),
      percentage: num(props?.percentage),
      total: kodiSeconds(props?.totaltime),
      index: num(props?.position),
      itemId: item ? nonNegative(firstValue(item.id, item.movieid, item.episodeid, item.songid)) : null,
    };
  }

  /**
   * Wait for a seek to actually take effect.
   *
   * Kodi's first `GetProperties` after `Player.Seek` can still return the
   * pre-seek position, so settle on the observed value: near the requested
   * target, or moved in the requested direction by most of the requested
   * distance. Returns the last observed properties (or null).
   *
   * @param {number} playerid
   * @param {{seconds?: number, percentage?: number, step?: string}} seekValue
   * @param {{seconds: number|null, total: number|null}} before
   * @param {{attempts?: number, delayMs?: number}} [options]
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async #confirmSeek(playerid, seekValue, before, { attempts = 14, delayMs = 200 } = {}) {
    const expectedSeconds = typeof seekValue.seconds === 'number' ? seekValue.seconds : null;
    const expectedDelta = expectedSeconds !== null && before.seconds !== null ? expectedSeconds - before.seconds : null;
    let last = null;

    for (let i = 0; i < attempts; i += 1) {
      const props = await this.#rpc
        .call('Player.GetProperties', { playerid, properties: ['position', 'percentage', 'speed', 'time', 'totaltime'] })
        .catch(() => null);
      if (props) {
        last = props;
        const seconds = kodiSeconds(props.time);
        const total = kodiSeconds(props.totaltime);
        if (seconds === null || before.seconds === null) return props;

        let settled;
        if (expectedSeconds === null) {
          // A step seek has no numeric target: any visible movement will do.
          settled = Math.abs(seconds - before.seconds) >= 2;
        } else {
          const target = Math.max(0, Math.min(total ?? expectedSeconds, expectedSeconds));
          const tolerance = Math.max(0.35, Math.min(1.5, Math.abs((expectedDelta ?? 0) * 0.35)));
          const nearTarget = Math.abs(seconds - target) <= tolerance;
          const progressed =
            expectedDelta !== null &&
            expectedDelta !== 0 &&
            Math.sign(seconds - before.seconds) === Math.sign(expectedDelta) &&
            Math.abs(seconds - before.seconds) >= Math.abs(expectedDelta) * 0.5;
          settled = nearTarget || progressed || expectedDelta === 0;
        }
        if (settled) return props;
      }
      if (i < attempts - 1) await sleep(delayMs);
    }
    return last;
  }

  /**
   * Wait for a queue move (Player.GoTo) to show up in both the reported index
   * and the item. Measured: after GoTo the index updates first, while
   * `Player.GetItem` still answers with the previous item for one poll.
   * @param {number} playerid
   * @param {{index: number|null, itemId: number|string|null}} before
   * @param {{attempts?: number, delayMs?: number}} [options]
   * @returns {Promise<void>}
   */
  async #settlePosition(playerid, before, { attempts = 4, delayMs = 150 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      const [props, response] = await Promise.all([
        this.#rpc.call('Player.GetProperties', { playerid, properties: ['position'] }).catch(() => null),
        this.#rpc.call('Player.GetItem', { playerid, properties: ['title'] }).catch(() => null),
      ]);
      const index = num(props?.position);
      const item = isRecord(response) && isRecord(response.item) ? response.item : null;
      const itemId = item ? num(firstValue(item.id, item.movieid, item.episodeid, item.songid)) : null;
      const movedIndex = index === null || before.index === null || index !== before.index;
      const movedItem = itemId === null || before.itemId === null || String(itemId) !== String(before.itemId);
      if (movedIndex && movedItem) return;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }

  /**
   * Resolve a play target into the item object Player.Open / Playlist.Add take.
   * @param {unknown} target
   * @returns {Record<string, unknown>}
   */
  #playItem(target) {
    if (!isRecord(target)) throw new RangeError('play target must be {kind,id}, {file} or {playlistid,position}');
    if (typeof target.file === 'string' && target.file) return { file: target.file };
    if (target.kind !== undefined && target.id !== undefined && target.id !== null) {
      const idKey = KIND_TO_ID[String(target.kind)];
      if (!idKey) throw new RangeError(`Unknown play target kind: ${target.kind}`);
      const id = Number(target.id);
      if (!Number.isFinite(id)) throw new RangeError(`play target id must be numeric, got ${JSON.stringify(target.id)}`);
      return { [idKey]: id };
    }
    if (target.playlistid !== undefined && target.playlistid !== null) {
      // User-facing positions are 1-based everywhere in this service, including
      // here; Kodi's Player.Open `position` is 0-based (verified live).
      const wanted = Number(target.position ?? 1);
      const index = Number.isFinite(wanted) ? Math.max(0, Math.trunc(wanted) - 1) : 0;
      return { playlistid: Number(target.playlistid), position: index };
    }
    for (const key of Object.values(KIND_TO_ID)) {
      if (target[key] !== undefined && target[key] !== null) return { [key]: Number(target[key]) };
    }
    throw new RangeError('play target must be {kind,id}, {file} or {playlistid,position}');
  }

  /**
   * @param {unknown} target
   * @returns {number} Kodi playlist id: 0 audio, 1 video
   */
  #playlistFor(target) {
    if (!isRecord(target)) return 1;
    if (target.playlistid !== undefined && target.playlistid !== null) return Number(target.playlistid);
    return AUDIO_KINDS.has(String(target.kind)) ? 0 : 1;
  }

  /**
   * @returns {Promise<number>} 1 when the video playlist has items (or neither
   *          playlist does), 0 when only audio does
   */
  async #defaultPlaylistId() {
    const [video, audio] = await Promise.all([
      this.#rpc.call('Playlist.GetItems', { playlistid: 1, limits: { start: 0, end: 0 } }).catch(() => null),
      this.#rpc.call('Playlist.GetItems', { playlistid: 0, limits: { start: 0, end: 0 } }).catch(() => null),
    ]);
    const videoTotal = num(video?.limits?.total) ?? 0;
    const audioTotal = num(audio?.limits?.total) ?? 0;
    return videoTotal > 0 || audioTotal === 0 ? 1 : 0;
  }

  /**
   * Nothing is loaded: start the last-used playlist from the top.
   * @returns {Promise<void>}
   */
  async #resumeLastPlayed() {
    const playlistid = await this.#defaultPlaylistId();
    await this.#rpc.call('Player.Open', { item: { playlistid, position: 0 } });
  }

  /**
   * @param {unknown} value
   * @returns {{seconds?: number, percentage?: number, step?: string}}
   */
  #seekValue(value) {
    if (isRecord(value)) {
      /** @type {{seconds?: number, percentage?: number, step?: string}} */
      const out = {};
      if (typeof value.seconds === 'number') out.seconds = value.seconds;
      if (typeof value.percentage === 'number') out.percentage = value.percentage;
      if (typeof value.step === 'string') out.step = value.step;
      if (Object.keys(out).length > 0) return out;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return { seconds: value };
    if (typeof value === 'string') {
      const text = value.trim();
      const percentage = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(text);
      if (percentage) return { percentage: Number(percentage[1]) };
      if (['smallforward', 'bigforward', 'smallbackward', 'bigbackward'].includes(text)) return { step: text };
      const seconds = Number(text);
      if (Number.isFinite(seconds)) return { seconds };
    }
    throw new RangeError('seek needs seconds (number), a percentage string ("25%"), a step name or {seconds|percentage|step}');
  }

  /**
   * @param {unknown} value
   * @returns {number} epoch ms, 0 when unparseable
   */
  #timestamp(value) {
    if (typeof value !== 'string' || !value) return 0;
    const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Kodi's web root, for turning a `Files.PrepareDownload` path into a URL.
   * Derived from the redacted endpoint, so no credentials can leak into it.
   * @returns {string}
   */
  #httpOrigin() {
    try {
      const url = new URL(this.endpoint);
      return `${url.protocol}//${url.host}`;
    } catch {
      return '';
    }
  }

  /**
   * Refresh and swallow the failure (cache/poll paths must not crash).
   * @returns {Promise<void>}
   */
  async #safeRefresh() {
    try {
      await this.refresh();
    } catch (error) {
      this.#lastError = error;
      this.#logMessage(this.#state.connected ? 'warn' : 'debug', `state refresh failed: ${messageOf(error)}`);
    }
  }

  /**
   * One real refresh of the cache.
   * @returns {Promise<KodiSnapshot>}
   */
  async #doRefresh() {
    try {
      // One call for volume/muted/version: Kodi returns all three together.
      const appProps = await this.#rpc.call('Application.GetProperties', { properties: ['volume', 'muted', 'version'] });
      const reportedVersion = formatVersion(isRecord(appProps) ? appProps.version : null);
      if (reportedVersion) this.#state.version = reportedVersion;
      const player = await this.#activePlayer();

      /** @type {KodiItem|null} */
      let item = null;
      let position = null;
      let queueIndex = null;
      let percentage = null;
      let speed = null;
      let totaltime = null;

      if (player) {
        const [itemResponse, propsResponse] = await Promise.all([
          this.#rpc.call('Player.GetItem', { playerid: player.playerid, properties: ITEM_PROPERTIES }),
          this.#rpc.call('Player.GetProperties', { playerid: player.playerid, properties: PLAYER_PROPERTIES }),
        ]);
        item = normalizeItem(isRecord(itemResponse) ? itemResponse.item : null, player.type || null);
        const playlistIndex = num(propsResponse?.position);
        queueIndex = playlistIndex === null ? null : playlistIndex + 1; // 1-based, Kodi's index never leaks
        // Kodi's `position` is the queue slot; playback time lives in `time`.
        position = kodiSeconds(propsResponse?.time);
        percentage = num(propsResponse?.percentage);
        speed = num(propsResponse?.speed);
        totaltime = num(propsResponse?.totaltime);
      }

      const playlistid = player ? player.playerid : 1;
      const listing = await this.#rpc
        .call('Playlist.GetItems', { playlistid, properties: QUEUE_PROPERTIES, limits: { start: 0, end: 200 } })
        .catch(() => null);
      const queue = (Array.isArray(listing?.items) ? listing.items : []).map((row) => normalizeItem(row, playlistid === 0 ? 'song' : null));

      await this.#refreshCountsIfStale();

      this.#state.connected = true;
      this.#state.playing = Boolean(player) && (speed ?? 0) > 0;
      this.#state.playerId = player ? player.playerid : null;
      this.#state.playerType = player ? player.type || null : null;
      this.#state.item = item;
      this.#state.position = position;
      this.#state.queueIndex = queueIndex;
      this.#state.percentage = percentage;
      this.#state.speed = speed;
      this.#state.totaltime = totaltime;
      this.#state.volume = num(appProps?.volume);
      this.#state.muted = boolOrNull(appProps?.muted);
      this.#state.queue = queue;
      this.#state.updatedAt = new Date(this.#now()).toISOString();
      this.#lastError = null;
      this.#emit();
      return this.snapshot();
    } catch (error) {
      this.#lastError = error;
      this.#state.connected = false;
      this.#state.playing = false;
      this.#state.playerId = null;
      this.#state.playerType = null;
      this.#state.speed = null;
      this.#state.updatedAt = new Date(this.#now()).toISOString();
      this.#emit();
      throw error;
    }
  }

  /**
   * Refresh library counts, at most once per `countsTtlMs` (six extra requests
   * are too many to pay on every poll tick).
   * @returns {Promise<void>}
   */
  async #refreshCountsIfStale() {
    const now = this.#now();
    if (this.#state.libraryCounts && now - this.#countsAt < this.#countsTtlMs) return;

    const keys = /** @type {Array<keyof typeof LIBRARY_SPECS>} */ (Object.keys(LIBRARY_SPECS));
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        const spec = LIBRARY_SPECS[key];
        const response = await this.#rpc.call(spec.method, { limits: { start: 0, end: 0 } });
        return num(response?.limits?.total) ?? (Array.isArray(response?.[spec.key]) ? response[spec.key].length : 0);
      }),
    );

    /** @type {Record<string, number|null>} */
    const counts = {};
    let anySucceeded = false;
    keys.forEach((key, index) => {
      const result = results[index];
      if (result.status === 'fulfilled') {
        counts[LIBRARY_SPECS[key].countKey] = result.value;
        anySucceeded = true;
      } else {
        counts[LIBRARY_SPECS[key].countKey] = null;
      }
    });
    if (anySucceeded) {
      this.#state.libraryCounts = counts;
      this.#countsAt = now;
    }
  }

  /**
   * Emit the snapshot to listeners when something meaningful changed.
   * `updatedAt` alone is not a change (otherwise every poll would wake the UI).
   * @returns {void}
   */
  #emit() {
    const snapshot = this.snapshot();
    const { updatedAt: _updatedAt, ...rest } = snapshot;
    const key = JSON.stringify(rest);
    if (key === this.#lastEmitted) return;
    this.#lastEmitted = key;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#logMessage('warn', `state listener failed: ${messageOf(error)}`);
      }
    }
  }

  /**
   * @returns {string|null}
   */
  #resolveNotificationUrl() {
    if (this.#notificationUrl) return this.#notificationUrl;
    const fromRpc = this.#rpc.wsUrl;
    if (typeof fromRpc === 'string' && fromRpc) return fromRpc;
    try {
      const url = new URL(this.endpoint);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.toString();
    } catch {
      return null;
    }
  }

  /**
   * @returns {string|null} Basic auth header value for the WS upgrade
   */
  #authHeader() {
    const header = this.#rpc.authHeader;
    return typeof header === 'string' && header ? header : null;
  }

  /**
   * Connect the notification socket (real Kodi notifies over the same
   * `/jsonrpc` endpoint). Reconnects with capped exponential backoff; while it
   * is down the polling fallback keeps the cache honest.
   * @returns {void}
   */
  #connectNotifications() {
    if (this.#stopped) return;
    const url = this.#resolveNotificationUrl();
    if (!url) {
      this.#logMessage('debug', 'no notification URL; relying on polling');
      return;
    }
    const globalWebSocket = /** @type {{WebSocket?: WebSocketCtor}} */ (globalThis).WebSocket;
    const Impl = this.#webSocketImpl ?? globalWebSocket;
    if (typeof Impl !== 'function') {
      this.#logMessage('warn', 'no global WebSocket; relying on polling');
      return;
    }

    /** @type {WebSocketInstance|null} */
    let socket = null;
    const authHeader = this.#authHeader();
    try {
      // Node's WebSocket (undici) accepts undici options in the second slot,
      // which is how Kodi's basic-auth-protected upgrade is satisfied.
      socket = authHeader ? new Impl(url, { headers: { authorization: authHeader } }) : new Impl(url);
    } catch {
      try {
        socket = new Impl(url);
      } catch (error) {
        this.#logMessage('warn', `Kodi notification socket could not be created: ${messageOf(error)}`);
        this.#scheduleReconnect();
        return;
      }
    }
    if (!socket) return;

    this.#ws = socket;
    socket.onopen = () => {
      this.#wsLive = true;
      this.#reconnectAttempt = 0;
      this.#logMessage('debug', 'Kodi notification socket connected');
      // Catch up on anything that happened while the socket was down.
      void this.#safeRefresh();
    };
    socket.onmessage = (event) => {
      this.#onNotification(event?.data);
    };
    socket.onerror = () => {
      // `onclose` always follows; logging here would double-report.
    };
    socket.onclose = () => {
      const wasLive = this.#wsLive;
      this.#wsLive = false;
      if (this.#ws === socket) this.#ws = null;
      if (this.#stopped) return;
      this.#logMessage(wasLive ? 'warn' : 'debug', 'Kodi notification socket closed; polling and retrying');
      this.#scheduleReconnect();
    };
  }

  /**
   * Reconnect with capped exponential backoff. A Kodi whose WebSocket service
   * is switched off must not be hammered: after six failures the retry cadence
   * drops to once every five minutes, while polling keeps the cache fresh.
   * @returns {void}
   */
  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer) return;
    this.#reconnectAttempt += 1;
    const delay =
      this.#reconnectAttempt > 6 ? 300000 : Math.min(15000, 500 * 2 ** Math.min(this.#reconnectAttempt - 1, 5));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connectNotifications();
    }, delay);
    if (typeof this.#reconnectTimer.unref === 'function') this.#reconnectTimer.unref();
  }

  /**
   * Handle one Kodi notification: every event that can change what is playing
   * triggers a (debounced) refresh, so the cache matches the TV quickly without
   * a query per event in a burst.
   * @param {unknown} raw
   * @returns {void}
   */
  #onNotification(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return;
    /** @type {unknown} */
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const method = isRecord(payload) && typeof payload.method === 'string' ? payload.method : null;
    if (!method) return; // a JSON-RPC response to some other client; not a state event

    if (method === 'System.OnQuit') {
      this.#state.connected = false;
      this.#emit();
      return;
    }
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#safeRefresh();
    }, this.#debounceMs);
    if (typeof this.#debounceTimer.unref === 'function') this.#debounceTimer.unref();
  }

  /**
   * Start the polling fallback. Polling is skipped while the notification
   * socket is live, so a healthy Kodi sees one query per event, not per tick.
   * @returns {void}
   */
  #startPollFallback() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#pollMs <= 0) return;
    this.#pollTimer = setInterval(() => {
      if (this.#stopped || this.#wsLive) return;
      void this.#safeRefresh();
    }, this.#pollMs);
    if (typeof this.#pollTimer.unref === 'function') this.#pollTimer.unref();
  }

  /**
   * Log through whatever the caller supplied: a `(level, message)` function or
   * a leveled logger object. Never throws.
   * @param {'debug'|'warn'|'error'} level
   * @param {string} message
   * @returns {void}
   */
  #logMessage(level, message) {
    const log = this.#log;
    try {
      if (typeof log === 'function') {
        log(level, message);
        return;
      }
      const leveled = isRecord(log) ? log[level] : null;
      if (typeof leveled === 'function') leveled(message);
    } catch {
      // A broken logger must never break the service.
    }
  }
}
