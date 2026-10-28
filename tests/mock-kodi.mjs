/**
 * tests/mock-kodi.mjs — dependency-free fake Kodi for the whole test suite.
 *
 * Serves the JSON-RPC surface over HTTP (JSON-RPC 2.0 POST on `/jsonrpc`) and,
 * unless disabled, the same endpoint as a WebSocket for notification tests.
 * No external packages, no fixed port: every call gets its own ephemeral port
 * so test files can run in parallel (`node --test` runs them as separate
 * processes anyway, but this keeps it true inside one file too).
 *
 * @example
 * import { startMockKodi } from './mock-kodi.mjs';
 * const kodi = await startMockKodi();
 * // kodi.url          -> 'http://127.0.0.1:PORT/jsonrpc'
 * // kodi.wsUrl        -> 'ws://127.0.0.1:PORT/jsonrpc'
 * // kodi.calls        -> [{ method, params, id, at }]
 * // kodi.findCalls('Player.Open')
 * // kodi.state        -> live fixture state (mutable)
 * // kodi.setFailMode('auth' | 'hang' | 'rpc-error' | 'http-500' | 'garbage' | 'destroy' | {kind, methods} | null)
 * // kodi.emit('Player.OnPlay', { data: { ... } })   // broadcast a Kodi notification
 * // await kodi.close()
 *
 * The mock records every request it handled in `calls` and intentionally
 * returns every field it knows for an item (real Kodi only returns the
 * requested `properties`); tests may therefore assert on any fixture field.
 * Auth is enforced when a password is configured: a wrong/missing Basic
 * header answers 401, which is how the transport's `auth` error kind is
 * exercised.
 */

import http from 'node:http';
import crypto from 'node:crypto';

/** @typedef {{ kind: string, methods?: string[]|null, code?: number, message?: string }} FailModeSpec */

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Build the default fixture library: four movies, two shows with three
 * episodes, two artists / two albums / three songs and a couple of
 * in-progress + recently-added rows.
 * @returns {Record<string, Array<Record<string, unknown>>>}
 */
function defaultLibrary() {
  return {
    movies: [
      {
        movieid: 1,
        label: 'Big Buck Bunny',
        title: 'Big Buck Bunny',
        sorttitle: 'Big Buck Bunny',
        year: 2008,
        runtime: 596,
        thumbnail: 'image://https%3a//example.test/bbb.jpg/',
        fanart: 'image://https%3a//example.test/bbb-fanart.jpg/',
        file: '/media/movies/big_buck_bunny.mkv',
        genre: ['Animation', 'Comedy'],
        rating: 8.0,
        playcount: 0,
        plot: 'A large rabbit takes revenge on three rodents.',
      },
      {
        movieid: 2,
        label: 'Sintel',
        title: 'Sintel',
        sorttitle: 'Sintel',
        year: 2010,
        runtime: 888,
        thumbnail: 'image://https%3a//example.test/sintel.jpg/',
        file: '/media/movies/sintel.mkv',
        genre: ['Animation', 'Fantasy'],
        rating: 7.6,
        playcount: 0,
        resume: { position: 300, total: 888 },
        plot: 'A lone girl befriends a dragon.',
      },
      {
        movieid: 3,
        label: 'Tears of Steel',
        title: 'Tears of Steel',
        sorttitle: 'Tears of Steel',
        year: 2012,
        runtime: 734,
        thumbnail: 'image://https%3a//example.test/tears.jpg/',
        file: '/media/movies/tears_of_steel.mkv',
        genre: ['Sci-Fi'],
        rating: 6.6,
        playcount: 1,
        plot: 'Robots overrun Amsterdam.',
      },
      {
        movieid: 4,
        label: 'Elephants Dream',
        title: 'Elephants Dream',
        sorttitle: 'Elephants Dream',
        year: 2006,
        runtime: 654,
        thumbnail: 'image://https%3a//example.test/elephants.jpg/',
        file: '/media/movies/elephants_dream.mkv',
        genre: ['Animation'],
        rating: 7.0,
        playcount: 0,
        plot: 'Two men explore a mechanical world.',
      },
    ],
    tvshows: [
      {
        tvshowid: 1,
        label: 'Pioneer One',
        title: 'Pioneer One',
        sorttitle: 'Pioneer One',
        year: 2010,
        season: -1,
        episode: -1,
        watchedepisodes: 0,
        thumbnail: 'image://https%3a//example.test/pioneer.jpg/',
      },
      {
        tvshowid: 2,
        label: 'Cosmos',
        title: 'Cosmos',
        sorttitle: 'Cosmos',
        year: 2014,
        season: -1,
        episode: -1,
        watchedepisodes: 0,
        thumbnail: 'image://https%3a//example.test/cosmos.jpg/',
      },
    ],
    episodes: [
      {
        episodeid: 101,
        tvshowid: 1,
        label: '1x01 Earth',
        title: 'Earth',
        showtitle: 'Pioneer One',
        season: 1,
        episode: 1,
        runtime: 1800,
        file: '/media/tv/pioneer_one/s01e01.mkv',
        playcount: 0,
        resume: { position: 600, total: 1800 },
        thumbnail: 'image://https%3a//example.test/pioneer-s01e01.jpg/',
      },
      {
        episodeid: 102,
        tvshowid: 1,
        label: '1x02 Water',
        title: 'Water',
        showtitle: 'Pioneer One',
        season: 1,
        episode: 2,
        runtime: 1740,
        file: '/media/tv/pioneer_one/s01e02.mkv',
        playcount: 0,
        thumbnail: 'image://https%3a//example.test/pioneer-s01e02.jpg/',
      },
      {
        episodeid: 201,
        tvshowid: 2,
        label: '2x01 Standing Up in the Milky Way',
        title: 'Standing Up in the Milky Way',
        showtitle: 'Cosmos',
        season: 2,
        episode: 1,
        runtime: 2640,
        file: '/media/tv/cosmos/s02e01.mkv',
        playcount: 1,
        thumbnail: 'image://https%3a//example.test/cosmos-s02e01.jpg/',
      },
    ],
    // Bookkeeping only (the GetInProgress* methods are gone): ids whose fixture
    // rows carry `resume`, i.e. what the 'inprogress' filter selects.
    inProgressMovies: [2],
    inProgressEpisodes: [101],
    recentlyAddedMovies: [4, 3],
    recentlyAddedEpisodes: [201],
    artists: [
      {
        artistid: 1,
        label: 'Nine Inch Nails',
        artist: 'Nine Inch Nails',
        thumbnail: 'image://https%3a//example.test/nin.jpg/',
        genre: ['Industrial'],
      },
      {
        artistid: 2,
        label: 'Amon Tobin',
        artist: 'Amon Tobin',
        thumbnail: 'image://https%3a//example.test/amon.jpg/',
        genre: ['Electronic'],
      },
    ],
    albums: [
      {
        albumid: 1,
        label: 'The Slip',
        title: 'The Slip',
        artist: ['Nine Inch Nails'],
        artistid: [1],
        year: 2008,
        thumbnail: 'image://https%3a//example.test/the-slip.jpg/',
      },
      {
        albumid: 2,
        label: 'Foley Room',
        title: 'Foley Room',
        artist: ['Amon Tobin'],
        artistid: [2],
        year: 2007,
        thumbnail: 'image://https%3a//example.test/foley-room.jpg/',
      },
    ],
    songs: [
      {
        songid: 1,
        label: '999,999',
        title: '999,999',
        artist: ['Nine Inch Nails'],
        album: 'The Slip',
        albumid: 1,
        duration: 86,
        track: 1,
        file: '/media/music/the_slip/01_999999.flac',
        thumbnail: 'image://https%3a//example.test/the-slip.jpg/',
      },
      {
        songid: 2,
        label: '1,000,000',
        title: '1,000,000',
        artist: ['Nine Inch Nails'],
        album: 'The Slip',
        albumid: 1,
        duration: 225,
        track: 2,
        file: '/media/music/the_slip/02_1000000.flac',
        thumbnail: 'image://https%3a//example.test/the-slip.jpg/',
      },
      {
        songid: 3,
        label: 'The Killer Robots',
        title: 'The Killer Robots',
        artist: ['Amon Tobin'],
        album: 'Foley Room',
        albumid: 2,
        duration: 300,
        track: 5,
        file: '/media/music/foley_room/05_killer_robots.flac',
        thumbnail: 'image://https%3a//example.test/foley-room.jpg/',
      },
    ],
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The live state behind one mock instance.
 * @param {{ major: number, minor: number, patch: number }} version
 * @returns {Record<string, any>}
 */
function defaultState(version) {
  const library = defaultLibrary();
  return {
    version: { ...version, tag: 'stable' },
    activePlayers: /** @type {Array<{playerid: number, type: string, speed: number, position: number}>} */ ([]),
    /** @type {Array<Record<string, any>>} */
    players: [],
    /** @type {Record<number, Array<Record<string, any>>>} */
    playlists: { 0: [], 1: [] },
    volume: 62,
    muted: false,
    library,
    /** library key -> fixture ids in insertion order, used for "recently added" */
    screenshotSeq: 0,
    screenshots: /** @type {Array<{file: string, lastmodified: string, size: number}>} */ ([]),
    notifications: /** @type {Array<Record<string, any>>} */ ([]),
    inputCalls: /** @type {Array<{method: string, params: Record<string, any>}>} */ ([]),
    lastError: /** @type {null | {message: string}} */ (null),
    /** Player.Open answers "OK" but never starts a player (async-open failure). */
    silentOpen: false,
    /** Player.Open starts its player only after this many ms (async-open success). */
    deferPlayerMs: 0,
    /** How many GetProperties calls after a seek still report the pre-seek position. */
    staleSeekReads: 0,
    /** Bookkeeping for the staleness simulation: {remaining, positionSeconds}. */
    staleSeek: /** @type {null | {remaining: number, positionSeconds: number}} */ (null),
    /** How many GetItem calls after Open/GoTo still report the previous item. */
    staleItemReads: 0,
    /** Bookkeeping: {remaining, item}. */
    staleItem: /** @type {null | {remaining: number, item: Record<string, any>}} */ (null),
  };
}

/**
 * Case-insensitive substring / equality / prefix match used by the mock's
 * JSON-RPC `filter` implementation.
 * @param {unknown} fieldValue
 * @param {string} operator
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesFilter(fieldValue, operator, value) {
  if (typeof fieldValue === 'boolean') {
    const wanted = value === true || String(value).toLowerCase() === 'true';
    if (operator === 'is') return fieldValue === wanted;
    return fieldValue === wanted;
  }
  const haystack = Array.isArray(fieldValue) ? fieldValue.join(' ') : String(fieldValue ?? '');
  const needle = String(value ?? '');
  switch (operator) {
    case 'is':
      return haystack.toLowerCase() === needle.toLowerCase();
    case 'startswith':
      return haystack.toLowerCase().startsWith(needle.toLowerCase());
    case 'endswith':
      return haystack.toLowerCase().endsWith(needle.toLowerCase());
    case 'contains':
      return haystack.toLowerCase().includes(needle.toLowerCase());
    case 'greaterthan':
      return Number(fieldValue) > Number(value);
    case 'lessthan':
      return Number(fieldValue) < Number(value);
    case 'between':
      return Array.isArray(value) && Number(fieldValue) >= Number(value[0]) && Number(fieldValue) <= Number(value[1]);
    default:
      return haystack.toLowerCase().includes(needle.toLowerCase());
  }
}

/**
 * Evaluate a Kodi library `filter` object. Supports the flat
 * `{field, operator, value}` form and one level of `{and: [...]}` / `{or: [...]}`.
 * @param {Record<string, any>} item
 * @param {Record<string, any>|undefined} filter
 * @returns {boolean}
 */
function applyFilter(item, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (Array.isArray(filter.and)) return filter.and.every((f) => applyFilter(item, f));
  if (Array.isArray(filter.or)) return filter.or.some((f) => applyFilter(item, f));
  if (typeof filter.field !== 'string') return true;
  // Kodi's virtual "inprogress" field, which replaced GetInProgress* methods.
  if (filter.field === 'inprogress') {
    const inProgress = isRecord(item.resume) && Number(item.resume.position) > 0;
    return matchesFilter(inProgress, String(filter.operator ?? 'is'), filter.value);
  }
  return matchesFilter(item[filter.field], String(filter.operator ?? 'contains'), filter.value);
}

/**
 * Sort a library result set the way Kodi's `sort` parameter does.
 * Unknown methods fall back to `label`.
 * @param {Array<Record<string, any>>} items
 * @param {{method?: string, order?: string}|undefined} sort
 * @returns {Array<Record<string, any>>}
 */
function applySort(items, sort) {
  const method = sort?.method ?? 'label';
  const order = sort?.order === 'descending' ? -1 : 1;
  if (method === 'random') return items.slice();
  const key = method === 'sorttitle' ? 'sorttitle' : method;
  return items.slice().sort((a, b) => {
    const av = /** @type {any} */ (a)[key] ?? /** @type {any} */ (a).label ?? '';
    const bv = /** @type {any} */ (b)[key] ?? /** @type {any} */ (b).label ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * order;
    return String(av).localeCompare(String(bv), 'en', { sensitivity: 'base' }) * order;
  });
}

/**
 * Apply a Kodi `limits` object. `end` is exclusive, which is what Kodi's
 * JSON-RPC does in practice (`{start: 0, end: 2}` returns two rows).
 * @param {Array<Record<string, any>>} items
 * @param {{start?: number, end?: number}|undefined} limits
 * @returns {{rows: Array<Record<string, any>>, start: number, end: number, total: number}}
 */
function applyLimits(items, limits) {
  const total = items.length;
  const start = Math.max(0, Number(limits?.start ?? 0));
  const end = Math.min(total, Number(limits?.end ?? total));
  return { rows: items.slice(start, end), start, end, total };
}

/**
 * Encode one server→client WebSocket text frame (unmasked, as required for
 * server frames).
 * @param {string} text
 * @returns {Buffer}
 */
function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  /** @type {number[]} */
  let header;
  if (payload.length < 126) {
    header = [0x81, payload.length];
  } else if (payload.length < 65536) {
    header = [0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff];
  } else {
    header = [0x81, 127, 0, 0, 0, 0, (payload.length >>> 24) & 0xff, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff];
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

/**
 * Start a fake Kodi on an ephemeral port.
 *
 * @param {{
 *   port?: number,
 *   host?: string,
 *   user?: string,
 *   password?: string,
 *   failMode?: FailModeSpec|string|null,
 *   enableWebSocket?: boolean,
 *   version?: {major: number, minor: number, patch: number},
 * }} [options]
 * @returns {Promise<{
 *   url: string,
 *   wsUrl: string|null,
 *   port: number,
 *   calls: Array<{method: string, params: Record<string, any>, id: unknown, at: number}>,
 *   findCalls: (method: string) => Array<{method: string, params: Record<string, any>, id: unknown, at: number}>,
 *   state: Record<string, any>,
 *   setFailMode: (mode: FailModeSpec|string|null) => void,
 *   setState: (patch: Record<string, any>) => void,
 *   emit: (method: string, params?: Record<string, any>) => number,
 *   clientCount: () => number,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startMockKodi(options = {}) {
  const {
    port = 0,
    host = '127.0.0.1',
    user = 'kodi',
    password = 'kodi',
    failMode = null,
    enableWebSocket = true,
    version = { major: 21, minor: 3, revision: '20260315-nogitfound' },
  } = options;

  /** @type {{kind: string, methods: string[]|null, code: number, message: string}|null} */
  let failure = normalizeFailMode(failMode);
  const state = defaultState(version);
  /** @type {Array<{method: string, params: Record<string, any>, id: unknown, at: number}>} */
  const calls = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  /** @type {Set<import('node:net').Socket>} */
  const wsClients = new Set();
  let socketSeq = 0;

  /**
   * @param {import('node:http').IncomingHttpHeaders} headers
   * @returns {boolean}
   */
  function authorized(headers) {
    if (!password && !user) return true;
    const header = String(headers.authorization ?? '');
    if (!header.startsWith('Basic ')) return false;
    const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    return header === expected;
  }

  /**
   * Dispatch one JSON-RPC request object.
   * @param {{jsonrpc?: string, id?: unknown, method?: string, params?: Record<string, any>}} request
   * @returns {{result?: unknown, error?: {code: number, message: string}, id: unknown}}
   */
  function dispatch(request) {
    const method = String(request.method ?? '');
    const params = /** @type {Record<string, any>} */ (request.params ?? {});
    const id = request.id ?? null;
    try {
      const result = invoke(method, params);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const error = /** @type {any} */ (err);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: Number(error.rpcCode ?? -32603), message: String(error.message ?? 'Internal error') },
      };
    }
  }

  /**
   * The fake Kodi method table. Throws `Error` objects carrying `rpcCode` for
   * JSON-RPC failures.
   * @param {string} method
   * @param {Record<string, any>} params
   * @returns {unknown}
   */
  function invoke(method, params) {
    const player = playerFor(params);

    switch (method) {
      case 'JSONRPC.Ping':
        return 'pong';
      // NOTE: JSONRPC.GetVersion is intentionally absent — Kodi 21.3 answers
      // -32601 for it (measured live), so the mock must too.
      case 'JSONRPC.Introspect':
        return { version: '1.0' };

      case 'Player.GetActivePlayers':
        return state.activePlayers.map((p) => ({ playerid: p.playerid, type: p.type }));

      case 'Player.GetItem': {
        if (!player) return {};
        if (state.staleItem && state.staleItem.remaining > 0) {
          state.staleItem.remaining -= 1;
          return { item: { ...state.staleItem.item } };
        }
        const playlist = state.playlists[player.playerid] ?? [];
        const item = player.position >= 0 ? playlist[player.position] : undefined;
        if (!item) return {};
        return { item: { ...item, id: item.id, type: item.type } };
      }

      case 'Player.GetProperties': {
        const playerid = Number(params.playerid ?? 1);
        const active = state.activePlayers.find((p) => p.playerid === playerid);
        if (!active) throw rpcError(-32100, 'Failed to execute method');
        const playlist = state.playlists[playerid] ?? [];
        const current = playlist[active.position];
        const total = Number(current?.runtime ?? current?.duration ?? 0);
        let position = Number(active.positionSeconds ?? 0);
        if (state.staleSeek && state.staleSeek.remaining > 0) {
          // Real Kodi: the first read after a seek still shows the old position.
          state.staleSeek.remaining -= 1;
          position = state.staleSeek.positionSeconds;
        }
        const percentage = total > 0 ? Math.round((position / total) * 1000) / 10 : 0;
        /** @type {Record<string, unknown>} */
        const props = {};
        for (const key of params.properties ?? []) {
          switch (key) {
            case 'position':
              props.position = active.position;
              break;
            case 'percentage':
              props.percentage = percentage;
              break;
            case 'speed':
              props.speed = active.speed;
              break;
            case 'time':
              props.time = kodiTime(position);
              break;
            case 'totaltime':
              props.totaltime = kodiTime(total);
              break;
            case 'subtitleenabled':
              props.subtitleenabled = false;
              break;
            case 'currentaudiostream':
              props.currentaudiostream = { index: 0, name: 'stereo', language: 'eng', channels: 2, codec: 'aac' };
              break;
            case 'playlistid':
              props.playlistid = playerid;
              break;
            default:
              break;
          }
        }
        return props;
      }

      case 'Player.Open': {
        const item = /** @type {Record<string, any>} */ (params.item ?? {});
        const playlistid = item.playlistid ?? (item.songid || item.albumid || item.artistid ? 0 : 1);
        const playlists = (state.playlists[playlistid] ??= []);
        let position = Number(item.position ?? 0);
        if (item.file) {
          playlists.push({ id: -1, type: 'unknown', label: item.file, file: item.file });
          position = playlists.length - 1;
        } else if (item.movieid || item.episodeid || item.songid || item.albumid || item.artistid) {
          const found = findLibraryItem(item);
          if (!found) throw rpcError(-32602, 'Invalid params');
          playlists.push(found.row);
          position = playlists.length - 1;
        }
        const startIt = () => {
          armItemLag(); // captured against the pre-open player state
          startPlayer(playlistid, position, playlists[position]);
        };
        if (state.silentOpen) return 'OK'; // accepted, but no player ever appears
        const delay = Number(state.deferPlayerMs) || 0;
        if (delay > 0) {
          const timer = setTimeout(startIt, delay);
          if (typeof timer.unref === 'function') timer.unref();
        } else {
          startIt();
        }
        return 'OK';
      }

      case 'Player.PlayPause': {
        const active = requirePlayer(params);
        if (params.play === true) active.speed = 1;
        else if (params.play === false) active.speed = 0;
        else active.speed = active.speed === 0 ? 1 : 0;
        return { speed: active.speed };
      }

      case 'Player.Stop': {
        const playerid = Number(params.playerid ?? 1);
        state.activePlayers = state.activePlayers.filter((p) => p.playerid !== playerid);
        return 'OK';
      }

      case 'Player.Seek': {
        const active = requirePlayer(params);
        const playlist = state.playlists[active.playerid] ?? [];
        const current = playlist[active.position];
        const total = Number(current?.runtime ?? current?.duration ?? 0);
        const value = /** @type {Record<string, any>} */ (params.value ?? {});
        const beforeSeek = Number(active.positionSeconds ?? 0);
        if (typeof value.seconds === 'number') active.positionSeconds = value.seconds;
        else if (typeof value.percentage === 'number') active.positionSeconds = (total * value.percentage) / 100;
        else if (typeof value.step === 'string') {
          const bump = { smallforward: 10, bigforward: 60, smallbackward: -10, bigbackward: -60 }[/** @type {string} */ (value.step)] ?? 0;
          active.positionSeconds = Math.max(0, Number(active.positionSeconds ?? 0) + bump);
        }
        if (current && active.positionSeconds > total) active.positionSeconds = total;
        const staleReads = Number(state.staleSeekReads) || 0;
        state.staleSeek = staleReads > 0 ? { remaining: staleReads, positionSeconds: beforeSeek } : null;
        const percentage = total > 0 ? Math.round((Number(active.positionSeconds ?? 0) / total) * 1000) / 10 : 0;
        return { percentage, time: kodiTime(Number(active.positionSeconds ?? 0)) };
      }

      case 'Player.SetSpeed': {
        const active = requirePlayer(params);
        active.speed = Number(params.speed ?? 1);
        return { speed: active.speed };
      }

      case 'Player.GoTo': {
        const active = requirePlayer(params);
        armItemLag();
        const playlist = state.playlists[active.playerid] ?? [];
        const to = params.to;
        if (to === 'next') active.position = Math.min(playlist.length - 1, active.position + 1);
        else if (to === 'previous') active.position = Math.max(0, active.position - 1);
        else active.position = Number(to ?? 0);
        active.positionSeconds = 0;
        return 'OK';
      }

      case 'Playlist.GetItems': {
        const playlistid = Number(params.playlistid ?? 1);
        const rows = state.playlists[playlistid] ?? [];
        const limited = applyLimits(rows, params.limits);
        return { items: limited.rows.map((row) => ({ ...row })), limits: { start: limited.start, end: limited.end, total: limited.total } };
      }
      case 'Playlist.Add': {
        const playlistid = Number(params.playlistid ?? 1);
        const playlists = (state.playlists[playlistid] ??= []);
        const item = /** @type {Record<string, any>} */ (params.item ?? {});
        if (item.file) playlists.push({ id: -1, type: 'unknown', label: item.file, file: item.file });
        else {
          const found = findLibraryItem(item);
          if (!found) throw rpcError(-32602, 'Invalid params');
          playlists.push(found.row);
        }
        return 'OK';
      }
      case 'Playlist.Insert': {
        const playlistid = Number(params.playlistid ?? 1);
        const playlists = (state.playlists[playlistid] ??= []);
        const found = findLibraryItem(/** @type {Record<string, any>} */ (params.item ?? {}));
        if (!found) throw rpcError(-32602, 'Invalid params');
        playlists.splice(Number(params.position ?? 0), 0, found.row);
        return 'OK';
      }
      case 'Playlist.Remove': {
        const playlistid = Number(params.playlistid ?? 1);
        const playlists = (state.playlists[playlistid] ??= []);
        playlists.splice(Number(params.position ?? 0), 1);
        return 'OK';
      }
      case 'Playlist.Clear': {
        state.playlists[Number(params.playlistid ?? 1)] = [];
        return 'OK';
      }

      case 'Application.GetProperties': {
        /** @type {Record<string, unknown>} */
        const props = {};
        for (const key of params.properties ?? []) {
          if (key === 'volume') props.volume = state.volume;
          else if (key === 'muted') props.muted = state.muted;
          else if (key === 'version') props.version = { ...state.version };
          else if (key === 'name') props.name = 'mock-kodi';
        }
        return props;
      }
      case 'Application.SetVolume': {
        const volume = params.volume;
        if (volume === 'increment') state.volume = Math.min(100, state.volume + 1);
        else if (volume === 'decrement') state.volume = Math.max(0, state.volume - 1);
        else if (typeof volume === 'number') state.volume = Math.max(0, Math.min(100, Math.round(volume)));
        else throw rpcError(-32602, 'Invalid params');
        return state.volume;
      }
      case 'Application.SetMute': {
        const mute = params.mute;
        if (mute === 'toggle') state.muted = !state.muted;
        else state.muted = Boolean(mute);
        return state.muted;
      }

      case 'GUI.ShowNotification': {
        state.notifications.push({ ...params, at: Date.now() });
        return 'OK';
      }
      case 'GUI.ActivateWindow':
        state.inputCalls.push({ method, params });
        return 'OK';

      case 'Input.Up':
      case 'Input.Down':
      case 'Input.Left':
      case 'Input.Right':
      case 'Input.Select':
      case 'Input.Back':
      case 'Input.Home':
      case 'Input.ContextMenu':
      case 'Input.Info':
      case 'Input.SendText':
        state.inputCalls.push({ method, params });
        return 'OK';
      case 'Input.ExecuteAction': {
        state.inputCalls.push({ method, params });
        if (params.action === 'screenshot') {
          state.screenshotSeq += 1;
          const n = String(state.screenshotSeq).padStart(4, '0');
          state.screenshots.push({
            file: `special://temp/screenshot${n}.png`,
            lastmodified: new Date(Date.now() - state.screenshotSeq * 1000).toISOString(),
            size: 1024 * state.screenshotSeq,
          });
        }
        return 'OK';
      }

      case 'VideoLibrary.GetMovies':
        return libraryCall('movies', params);
      case 'VideoLibrary.GetTVShows':
        return libraryCall('tvshows', params);
      case 'VideoLibrary.GetEpisodes':
        return libraryCall('episodes', params);
      // VideoLibrary.GetInProgress{Movies,Episodes} no longer exist on Kodi 21
      // (measured -32601). Picks use GetMovies/GetEpisodes with the virtual
      // filter {field:'inprogress', operator:'is', value:'true'} instead.
      case 'VideoLibrary.GetRecentlyAddedMovies':
        return recentlyAddedCall('movies', 'recentlyAddedMovies');
      case 'VideoLibrary.GetRecentlyAddedEpisodes':
        return recentlyAddedCall('episodes', 'recentlyAddedEpisodes');
      case 'AudioLibrary.GetArtists':
        return libraryCall('artists', params);
      case 'AudioLibrary.GetAlbums':
        return libraryCall('albums', params);
      case 'AudioLibrary.GetSongs':
        return libraryCall('songs', params);

      case 'Files.PrepareDownload': {
        const path = String(params.path ?? '');
        return { details: { path: `/vfs/${encodeURIComponent(path)}`, protocol: 'http' }, mode: 'redirect', protocol: 'http' };
      }
      case 'Files.GetDirectory': {
        const directory = String(params.directory ?? '');
        const files = directory.startsWith('special://temp')
          ? state.screenshots.map((shot) => ({ ...shot, label: String(shot.file).split('/').pop(), filetype: 'file' }))
          : [];
        return { files, limits: { start: 0, end: files.length, total: files.length } };
      }

      case 'XBMC.GetInfoBooleans':
        return Object.fromEntries((params.booleans ?? []).map((/** @type {string} */ key) => [key, false]));
      default:
        throw rpcError(-32601, 'Method not found.');
    }

    /**
     * Shared library listing for VideoLibrary.* / AudioLibrary.*.
     * @param {string} key state.library key
     * @param {Record<string, any>} params
     * @returns {Record<string, any>}
     */
    function libraryCall(key, params) {
      if (state.rejectFilters && params.filter) throw rpcError(-32602, 'Invalid params');
      let rows = state.library[key] ?? [];
      // Player-style scoping used by the picks engine: GetEpisodes {tvshowid}.
      if (params.tvshowid !== undefined && params.tvshowid !== null) {
        rows = rows.filter((item) => Number(item.tvshowid) === Number(params.tvshowid));
      }
      if (params.movieid !== undefined && params.movieid !== null) {
        rows = rows.filter((item) => Number(item.movieid) === Number(params.movieid));
      }
      rows = rows.filter((item) => applyFilter(item, params.filter));
      const sorted = applySort(rows, params.sort);
      const limited = applyLimits(sorted, params.limits);
      return {
        [key]: limited.rows.map((row) => ({ ...row })),
        limits: { start: limited.start, end: limited.end, total: limited.total },
      };
    }

    /**
     * @param {string} key
     * @param {string} indexKey
     * @returns {Record<string, any>}
     */
    function recentlyAddedCall(key, indexKey) {
      const ids = state.library[indexKey] ?? [];
      const byId = new Map((state.library[key] ?? []).map((row) => [row[`${key === 'movies' ? 'movieid' : 'episodeid'}`], row]));
      const rows = ids.map((/** @type {number} */ id) => byId.get(id)).filter(Boolean);
      return { [key]: rows.map((/** @type {any} */ row) => ({ ...row })), limits: { start: 0, end: rows.length, total: rows.length } };
    }
  }

  /**
   * @param {number} rpcCode
   * @param {string} message
   * @returns {Error & {rpcCode: number}}
   */
  function rpcError(rpcCode, message) {
    const err = /** @type {Error & {rpcCode: number}} */ (new Error(message));
    err.rpcCode = rpcCode;
    return err;
  }

  /**
   * Resolve the active player referenced by params.playerid (default: the
   * first active player, which is what a single-player Kodi does).
   * @param {Record<string, any>} params
   * @returns {Record<string, any>}
   */
  function requirePlayer(params) {
    const playerid = Number(params.playerid ?? state.activePlayers[0]?.playerid ?? 1);
    const active = state.activePlayers.find((p) => p.playerid === playerid);
    if (!active) throw rpcError(-32100, 'Failed to execute method');
    return active;
  }

  /**
   * @param {Record<string, any>} params
   * @returns {Record<string, any>|null}
   */
  function playerFor(params) {
    const playerid = params.playerid === undefined ? state.activePlayers[0]?.playerid : Number(params.playerid);
    if (playerid === undefined || playerid === null) return null;
    return state.activePlayers.find((p) => p.playerid === playerid) ?? null;
  }

  /**
   * Map a library item from a Player.Open / Playlist.Add item reference.
   * @param {Record<string, any>} item
   * @returns {{row: Record<string, any>, playlistid: number}|null}
   */
  function findLibraryItem(item) {
    /** @type {Array<[string, string, string, number, string]>} */
    const map = [
      ['movieid', 'movies', 'movieid', 1, 'movie'],
      ['episodeid', 'episodes', 'episodeid', 1, 'episode'],
      ['tvshowid', 'tvshows', 'tvshowid', 1, 'tvshow'],
      ['songid', 'songs', 'songid', 0, 'song'],
      ['albumid', 'albums', 'albumid', 0, 'album'],
      ['artistid', 'artists', 'artistid', 0, 'artist'],
    ];
    for (const [param, key, idField, playlistid, type] of map) {
      if (item[param] === undefined) continue;
      const row = (state.library[key] ?? []).find((/** @type {any} */ candidate) => candidate[idField] === Number(item[param]));
      if (!row) return null;
      return {
        playlistid,
        row: { ...row, id: row[idField], type, label: row.label ?? row.title ?? String(item[param]) },
      };
    }
    return null;
  }

  /**
   * Put a player on a playlist position and start it.
   * @param {number} playlistid
   * @param {number} position
   * @param {Record<string, any>} item
   */
  function startPlayer(playlistid, position, item) {
    const existing = state.activePlayers.find((p) => p.playerid === playlistid);
    const type = item?.type === 'unknown' ? (playlistid === 0 ? 'audio' : 'video') : (item?.type ?? 'video');
    if (existing) {
      existing.position = position;
      existing.speed = 1;
      existing.positionSeconds = 0;
      existing.type = type;
    } else {
      state.activePlayers.push({ playerid: playlistid, type, speed: 1, position, positionSeconds: 0 });
    }
  }

  /**
   * Remember what is playing now and arm the GetItem lag, so tests can verify
   * that the service waits for the *new* item after a start or a queue move.
   * @returns {void}
   */
  function armItemLag() {
    const total = Number(state.staleItemReads) || 0;
    if (total <= 0) {
      state.staleItem = null;
      return;
    }
    const active = state.activePlayers[0];
    const playlist = active ? state.playlists[active.playerid] ?? [] : [];
    const current = active ? playlist[active.position] : null;
    state.staleItem = { remaining: total, item: current ? { ...current } : {} };
  }

  /**
   * @param {number} seconds
   * @returns {{hours: number, minutes: number, seconds: number, milliseconds: number}}
   */
  function kodiTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60, milliseconds: 0 };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const fail = activeFailure();
      if (fail?.kind === 'hang') return; // leave the socket hanging for the client's timeout
      if (fail?.kind === 'destroy') {
        req.socket.destroy();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('mock-kodi');
        return;
      }
      if (!authorized(req.headers)) {
        res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="Kodi"' });
        res.end('Unauthorized');
        return;
      }
      if (fail?.kind === 'auth') {
        res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="Kodi"' });
        res.end('Unauthorized');
        return;
      }
      if (fail?.kind === 'http-500') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      }
      if (fail?.kind === 'garbage') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>not json</body></html>');
        return;
      }

      /** @type {Record<string, any>|Array<Record<string, any>>} */
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const batch = Array.isArray(request) ? request : [request];
      const responses = batch.map((one) => {
        const method = String(one.method ?? '');
        calls.push({ method, params: /** @type {Record<string, any>} */ (one.params ?? {}), id: one.id ?? null, at: Date.now() });
        if (fail?.kind === 'rpc-error' && (!fail.methods || fail.methods.includes(method))) {
          return { jsonrpc: '2.0', id: one.id ?? null, error: { code: fail.code, message: fail.message } };
        }
        return dispatch(one);
      });
      const payload = JSON.stringify(Array.isArray(request) ? responses : responses[0]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });

  server.on('connection', (socket) => {
    socketSeq += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  if (enableWebSocket) {
    server.on('upgrade', (req, socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '');
      if (!key || !authorized(req.headers)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      wsClients.add(socket);
      socket.on('close', () => wsClients.delete(socket));
      socket.on('error', () => wsClients.delete(socket));
      socket.on('data', (buf) => {
        // Minimal client-frame reader: enough to answer ping and close.
        let offset = 0;
        while (offset + 2 <= buf.length) {
          const opcode = buf[offset] & 0x0f;
          let length = buf[offset + 1] & 0x7f;
          let cursor = offset + 2;
          if (length === 126 && cursor + 2 <= buf.length) {
            length = buf.readUInt16BE(cursor);
            cursor += 2;
          } else if (length === 127 && cursor + 8 <= buf.length) {
            length = Number(buf.readBigUInt64BE(cursor));
            cursor += 8;
          }
          const masked = (buf[offset + 1] & 0x80) !== 0;
          const maskOffset = cursor;
          if (masked) cursor += 4;
          if (cursor + length > buf.length) break;
          if (opcode === 8) {
            socket.write(Buffer.from([0x88, 0]));
            socket.end();
            wsClients.delete(socket);
            return;
          }
          if (opcode === 9) {
            const payload = Buffer.from(buf.subarray(cursor, cursor + length));
            if (masked) {
              for (let i = 0; i < payload.length; i += 1) payload[i] ^= buf[maskOffset + (i % 4)];
            }
            socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          }
          offset = cursor + length;
        }
      });
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://${host}:${address.port}/jsonrpc`;

  /**
   * @param {FailModeSpec|string|null} mode
   * @returns {{kind: string, methods: string[]|null, code: number, message: string}|null}
   */
  function normalizeFailMode(mode) {
    if (!mode) return null;
    const spec = typeof mode === 'string' ? { kind: mode } : mode;
    return {
      kind: String(spec.kind),
      methods: Array.isArray(spec.methods) ? spec.methods.map(String) : null,
      code: Number(spec.code ?? -32602),
      message: String(spec.message ?? 'Invalid params'),
    };
  }

  function activeFailure() {
    return failure;
  }

  return {
    url,
    wsUrl: enableWebSocket ? `ws://${host}:${address.port}/jsonrpc` : null,
    port: address.port,
    calls,
    /**
     * @param {string} method
     * @returns {Array<{method: string, params: Record<string, any>, id: unknown, at: number}>}
     */
    findCalls(method) {
      return calls.filter((call) => call.method === method);
    },
    state,
    /**
     * @param {FailModeSpec|string|null} mode
     * @returns {void}
     */
    setFailMode(mode) {
      failure = normalizeFailMode(mode);
    },
    /**
     * Shallow-merge a patch into the mock state (e.g. `{ volume: 10 }` or a
     * replacement `library`), so tests can reshape the fixture per case.
     * @param {Record<string, any>} patch
     * @returns {void}
     */
    setState(patch) {
      Object.assign(state, patch);
    },
    /**
     * Broadcast a Kodi notification to every connected WebSocket client.
     * @param {string} method e.g. 'Player.OnPlay'
     * @param {Record<string, any>} [params] e.g. `{ data: { item: {...} } }`
     * @returns {number} how many clients received it
     */
    emit(method, params = { data: {} }) {
      const frame = wsFrame(JSON.stringify({ jsonrpc: '2.0', method, params: { sender: 'xbmc', ...params } }));
      let sent = 0;
      for (const client of wsClients) {
        if (client.destroyed) continue;
        client.write(frame);
        sent += 1;
      }
      return sent;
    },
    /** @returns {number} */
    clientCount() {
      return wsClients.size;
    },
    /**
     * Stop the server and destroy every open connection (keep-alive sockets
     * included) so the test process exits cleanly.
     * @returns {Promise<void>}
     */
    async close() {
      for (const client of wsClients) client.destroy();
      wsClients.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        // A hanging handler may keep the server from closing; destroy again.
        setTimeout(resolve, 50).unref?.();
      });
    },
  };
}
