/**
 * The agent-facing surface of dsh-kodi: twelve `kodi_*` tools for reading the
 * TV's state and changing what it shows.
 *
 * Three rules shape every tool here:
 *
 * - A description names the effect the person at the TV sees ("start playback
 *   on the TV"), never how the call travels. The model reads these every turn,
 *   so transport vocabulary is noise it can act on wrongly.
 * - A call never throws. An unreachable Kodi is an ordinary answer —
 *   `{ ok: false, error: 'Kodi is not reachable at …' }` — because an exception
 *   turns one failed action into a failed turn.
 * - A summary is compact prose: at most ten rows plus one "… and N more" line.
 *   The structured value carries every field; the summary is what the model
 *   reasons over, so it must never become a JSON dump.
 *
 * `registerTools(ctx, kodi, log, hooks)` returns one disposer that unregisters
 * every tool. `hooks` is optional and carries the one capability that belongs
 * to the bridge rather than the Kodi service:
 *
 *   hooks.say({ text })  → { ok, error? }   show a message on the television
 *   hooks.makePicks      → makePicks        test seam; production omits it
 */

import { makePicks } from './recommend.mjs'

/** The result envelope every tool promises: `ok` plus whatever it learned. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

/** List summaries stop here; the remainder becomes one "… and N more" line. */
const MAX_ROWS = 10

/** What a search can return, in the order Kodi groups it. */
const SEARCH_KINDS = ['movie', 'episode', 'artist', 'album', 'song']

/** What `kodi_library` can browse. Values are Kodi's own section names. */
const LIBRARY_KINDS = ['movies', 'tvshows', 'episodes', 'artists', 'albums', 'songs']

/** Section names as a person reads them. */
const LIBRARY_LABELS = {
  movies: 'movies',
  tvshows: 'TV shows',
  episodes: 'episodes',
  artists: 'artists',
  albums: 'albums',
  songs: 'songs',
}

/** Kinds that carry a numeric library id, used by playback and the queue. */
const PLAY_KINDS = ['movie', 'episode', 'song']

/** Playback actions, each with its own meaning for `value`. */
const TRANSPORT_ACTIONS = ['playpause', 'play', 'pause', 'stop', 'seek', 'skip', 'speed']

/** Remote buttons that exist on every Kodi skin; `key` carries a raw key name. */
const REMOTE_ACTIONS = ['up', 'down', 'left', 'right', 'select', 'back', 'home', 'context', 'info', 'key']

/** Queue operations. `list` is the default and needs no arguments. */
const QUEUE_ACTIONS = ['list', 'add', 'insert', 'clear', 'jump']

/** The names this module registers, in registration order. */
export const TOOL_NAMES = Object.freeze([
  'kodi_status',
  'kodi_search',
  'kodi_library',
  'kodi_play',
  'kodi_queue',
  'kodi_transport',
  'kodi_volume',
  'kodi_remote',
  'kodi_notify',
  'kodi_picks',
  'kodi_screenshot',
  'kodi_say',
])

// ---- small formatting helpers -------------------------------------------
// Everything below is pure so a render can replay from a session log.

/** Collapse any text to one trimmed line, ellipsized at `max` characters. */
function oneLine(value, max = 160) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** The first non-empty line of a multi-line message, ellipsized. */
function firstLine(value, max = 120) {
  const text = String(value ?? '')
  for (const part of text.split('\n')) {
    const line = part.trim()
    if (line !== '') return oneLine(line, max)
  }
  return ''
}

/** "1 item" / "3 items", with an irregular plural where one is needed. */
function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

/** Seconds as "9:56" or "1:02:03"; never negative, never NaN. */
function clock(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds)))
  if (!Number.isFinite(whole)) return '0:00'
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

/** One item as a single readable row: show/S1E2 — Title [movie, 2008] (9:56). */
function itemLine(item) {
  if (item === null || typeof item !== 'object') return 'Untitled'
  const show = typeof item.show === 'string' ? oneLine(item.show, 60) : ''
  const marker = Number.isInteger(item.season) && Number.isInteger(item.episode)
    ? `S${item.season}E${item.episode}`
    : ''
  const prefix = [show, marker].filter((part) => part !== '').join(' ')
  const title = oneLine(item.title ?? item.label ?? 'Untitled', 80)
  // A search result may carry a human extra ("Breaking Bad · S01E05", a genre)
  // instead of structured show/season fields; it is worth one meta slot.
  const extra = typeof item.extra === 'string' && item.extra !== '' && item.extra.toLowerCase() !== String(item.kind ?? '').toLowerCase()
    ? oneLine(item.extra, 50)
    : ''
  const meta = [
    typeof item.kind === 'string' ? item.kind : '',
    extra,
    Number.isInteger(item.year) ? String(item.year) : '',
  ].filter((part) => part !== '').join(', ')
  const runtime = Number.isFinite(item.runtime) && item.runtime > 0 ? ` (${clock(item.runtime)})` : ''
  return `${prefix !== '' ? `${prefix} — ` : ''}${title}${meta !== '' ? ` [${meta}]` : ''}${runtime}`
}

/** The title of an item, or '' when Kodi has not told us what it is. */
function labelOf(item) {
  if (item === null || typeof item !== 'object') return ''
  return oneLine(item.title ?? item.label ?? '', 90)
}

/** A library id Kodi can play. Numeric strings from a search are coerced. */
function playableId(value) {
  if (Number.isInteger(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** Numbered rows, capped at `max`, followed by "… and N more". */
function rows(items, row, max = MAX_ROWS) {
  const shown = items.slice(0, max)
  const lines = shown.map((item, index) => `${index + 1}. ${row(item, index)}`)
  const hidden = items.length - shown.length
  if (hidden > 0) lines.push(`… and ${hidden} more`)
  return lines
}

/** A clamped integer argument, or `fallback` when absent/not a number. */
function boundedInt(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Freeze the arguments into the plain object the run functions expect. */
function readArgs(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

// ---- renderers -----------------------------------------------------------
// One per tool. Each renders a successful value as prose; a failed value is
// rendered by the shared failure line instead. Renders never throw (the
// factory wraps them), and they use at most MAX_ROWS rows.

function viewStatus(value) {
  const lines = []
  const item = value.item
  if (value.connected === false) {
    lines.push('Kodi is not connected.')
  } else if (value.playing === true && item !== null && item !== undefined) {
    const position = Number.isFinite(value.position) ? clock(value.position) : ''
    const total = Number.isFinite(item.runtime) && item.runtime > 0 ? clock(item.runtime) : ''
    const at = position !== '' && total !== '' ? ` — ${position} of ${total}` : position !== '' ? ` — ${position}` : ''
    const speed = Number.isFinite(value.speed) && value.speed !== 1 ? `, ${value.speed}× speed` : ''
    lines.push(`Playing "${labelOf(item)}"${at}${speed}`)
  } else if (item !== null && item !== undefined) {
    lines.push(`Paused on "${labelOf(item)}".`)
  } else {
    lines.push('Nothing is playing.')
  }
  if (Number.isFinite(value.volume)) {
    lines.push(value.muted === true ? `Muted (volume ${value.volume}).` : `Volume ${value.volume}.`)
  }
  if (Array.isArray(value.queue)) {
    if (value.queue.length > 0) lines.push(`${plural(value.queue.length, 'item')} in the queue.`)
  } else if (Number.isFinite(value.queue) && value.queue > 0) {
    lines.push(`${plural(value.queue, 'item')} in the queue.`)
  }
  const counts = value.libraryCounts
  if (counts !== null && typeof counts === 'object' && !Array.isArray(counts)) {
    const parts = Object.entries(counts)
      .filter(([, count]) => Number.isFinite(count) && count >= 0)
      .slice(0, 5)
      .map(([kind, count]) => `${count} ${kind}`)
    if (parts.length > 0) lines.push(`Library: ${parts.join(', ')}.`)
  }
  if (typeof value.version === 'string' && value.version !== '') lines.push(`Kodi ${value.version}.`)
  return lines.join('\n')
}

function viewSearch(value) {
  const results = Array.isArray(value.results) ? value.results : []
  const query = oneLine(value.query ?? '', 60)
  if (results.length === 0) return `Nothing in the library matches "${query}".`
  return [
    `${plural(results.length, 'match', 'matches')} for "${query}":`,
    ...rows(results, itemLine),
  ].join('\n')
}

function viewLibrary(value) {
  const items = Array.isArray(value.items) ? value.items : []
  const label = LIBRARY_LABELS[value.kind] ?? 'the library'
  if (items.length === 0) {
    return typeof value.filter === 'string' && value.filter !== ''
      ? `Nothing in ${label} matches "${oneLine(value.filter, 60)}".`
      : `No items in ${label}.`
  }
  const total = Number.isFinite(value.total) ? value.total : items.length
  const start = Number.isFinite(value.start) ? value.start : 0
  const header = `${label.charAt(0).toUpperCase()}${label.slice(1)} ${start + 1}–${start + items.length} of ${total}:`
  return [header, ...rows(items, itemLine)].join('\n')
}

function viewPlay(value) {
  const title = typeof value.title === 'string' && value.title !== '' ? `"${oneLine(value.title, 90)}"` : 'it'
  if (value.queued === true) return `Queued ${title} to play after what is already queued.`
  return `Playing ${title} on the TV.`
}

function viewQueue(value) {
  if (value.action === undefined || value.action === 'list') {
    const items = Array.isArray(value.items) ? value.items : []
    if (items.length === 0) return 'The queue is empty.'
    const lines = [`${plural(items.length, 'item')} in the queue:`, ...rows(items, itemLine)]
    // `current` is the 1-based queue position the service reports, so it lines
    // up with the row numbers above.
    const current = Number.isInteger(value.current) ? value.current : null
    if (current !== null && current >= 1 && current <= items.length) {
      lines.push(`Now: ${itemLine(items[current - 1])}`)
    }
    return lines.join('\n')
  }
  const done = {
    add: 'Added to the queue.',
    insert: 'Inserted into the queue.',
    clear: 'Cleared the queue.',
    jump: 'Jumped within the queue.',
  }[value.action] ?? 'Updated the queue.'
  return Number.isFinite(value.length) ? `${done} ${plural(value.length, 'item')} now queued.` : done
}

function viewTransport(value, args) {
  const at = Number.isFinite(value.position) ? ` at ${clock(value.position)}` : ''
  switch (value.action) {
    case 'playpause':
      return value.playing === false ? `Paused on the TV${at}.` : `Resumed on the TV${at}.`
    case 'play':
      return `Playback started on the TV${at}.`
    case 'pause':
      return `Paused on the TV${at}.`
    case 'stop':
      return 'Stopped playback on the TV.'
    case 'seek':
      return Number.isFinite(value.position)
        ? `Jumped to ${clock(value.position)} on the TV.`
        : 'Jumped within the current title on the TV.'
    case 'skip': {
      // A number is a relative jump in seconds; the words change queue item.
      if (args.value === 'previous') return 'Went back to the previous item on the TV.'
      if (args.value === 'next') return 'Skipped to the next item on the TV.'
      if (typeof args.value === 'number' && args.value < 0) {
        return `Went back ${plural(Math.abs(Math.round(args.value)), 'second')} on the TV.`
      }
      if (typeof args.value === 'number' && args.value > 0) {
        return `Skipped forward ${plural(Math.round(args.value), 'second')} on the TV.`
      }
      return 'Skipped to the next item on the TV.'
    }
    case 'speed':
      return Number.isFinite(value.speed)
        ? `Playback speed is now ${value.speed}× on the TV.`
        : 'Changed the playback speed on the TV.'
    default:
      return 'Updated playback on the TV.'
  }
}

function viewVolume(value) {
  if (value.muted === true) {
    return Number.isFinite(value.volume) ? `The TV is muted at volume ${value.volume}.` : 'The TV is muted.'
  }
  return Number.isFinite(value.volume) ? `Volume ${value.volume} on the TV.` : 'Changed the TV volume.'
}

function viewRemote(value, args) {
  const action = typeof value.action === 'string' ? value.action : args.action
  const name = action === 'key' ? `"${oneLine(args.value ?? '', 40)}"` : String(action ?? 'a button')
  return `Pressed ${name} on the TV remote.`
}

function viewNotify(value) {
  const title = oneLine(value.title ?? '', 80)
  if (title === '') return 'Shown a notification on the TV.'
  const message = oneLine(value.message ?? '', 120)
  const detail = message !== '' && message !== title ? ` — ${message}` : ''
  return `Shown on the TV: ${title}${detail}.`
}

function viewPicks(value) {
  const picks = Array.isArray(value.picks) ? value.picks : []
  if (picks.length === 0) return 'No picks tonight: nothing is in progress and nothing new was added.'
  const lines = ['Tonight\'s picks:']
  lines.push(...rows(picks, (pick) => {
    const title = oneLine(pick.title ?? pick.label ?? 'Untitled', 80)
    const reason = oneLine(pick.reason ?? '', 100)
    const runtime = Number.isFinite(pick.runtime) && pick.runtime > 0 ? clock(pick.runtime) : ''
    const resume = Number.isFinite(pick.resumeAt) && pick.resumeAt > 0 ? `from ${clock(pick.resumeAt)}` : ''
    const detail = [runtime, resume].filter((part) => part !== '').join(', ')
    return `"${title}"${reason !== '' ? ` — ${reason}` : ''}${detail !== '' ? ` (${detail})` : ''}`
  }))
  return lines.join('\n')
}

function viewScreenshot(value) {
  // `file` is the downloadable URL when Kodi can serve it; `path` is Kodi's own
  // special:// location, useful only on the box itself.
  const location = typeof value.file === 'string' && value.file !== '' ? value.file : value.path
  return typeof location === 'string' && location !== ''
    ? `Screenshot of the TV saved to ${location}.`
    : 'Took a screenshot of the TV, but Kodi did not say where it went.'
}

function viewSay(value, args) {
  const line = firstLine(value.text ?? args.text, 120)
  return line !== '' ? `Shown on the TV: ${line}` : 'Shown on the TV.'
}

/** Render a completed call as model-facing text; total by construction. */
function renderResult(name, view, args, value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `${name} finished without a result.`
    }
    if (value.ok === false) {
      return oneLine(value.error ?? `${name} did not complete.`, 600) || `${name} did not complete.`
    }
    const text = view === undefined ? '' : view(value, args)
    return typeof text === 'string' && text !== '' ? text : `${name} finished.`
  } catch {
    return `${name} finished, but its summary could not be written.`
  }
}

// ---- picks recommendation -------------------------------------------------
// The ranking itself lives in src/recommend.mjs (owned by the bridge); this
// module only calls it. `hooks.makePicks` exists so the tool spec can prove the
// delegation without building a library fixture — production never passes it.

/** The ranker a picks call should use: the test seam when present, else the module. */
function picksRanker(hooks) {
  return typeof hooks?.makePicks === 'function' ? hooks.makePicks : makePicks
}

// ---- errors ---------------------------------------------------------------

/** Redacted address of the configured Kodi, for the failure sentence. */
function endpointOf(kodi) {
  try {
    if (typeof kodi?.endpoint === 'string' && kodi.endpoint !== '') return kodi.endpoint
    if (typeof kodi?.rpc?.endpoint === 'string' && kodi.rpc.endpoint !== '') return kodi.rpc.endpoint
  } catch {
    // A getter that throws is not worth a second failure; fall through.
  }
  return 'the configured Kodi address'
}

/** Readable message from anything that was thrown or returned as `error`. */
function messageOf(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return oneLine(error, 500)
  if (typeof error === 'object' && typeof error.message === 'string') return oneLine(error.message, 500)
  try {
    return oneLine(String(error), 500)
  } catch {
    return ''
  }
}

/** Plain network failures arrive as TypeErrors, without a Kodi error kind. */
function looksLikeConnectionFailure(message) {
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EPIPE|socket hang up|network|other side closed/i
    .test(message)
}

/**
 * Turn a thrown value into one sentence the model can act on. An unreachable
 * Kodi gets the fixed wording the contract promises; a refusal by Kodi gets
 * the refusal; anything else names the tool so a bug is not mistaken for an
 * outage. The transport already writes complete sentences that name the
 * endpoint ("Kodi is not reachable at http://… (Player.Open: ECONNREFUSED)"),
 * so those pass through untouched instead of being wrapped twice.
 */
function reasonFor(name, error, kodi) {
  const kind = error !== null && typeof error === 'object' ? error.kind : undefined
  const message = messageOf(error) || 'Kodi gave no reason'
  const where = endpointOf(kodi)
  if (/^Kodi (?:is not reachable|did not answer|rejected|answered|returned|RPC error)\b/.test(message)) {
    return message
  }
  if (kind === 'auth') return `Kodi rejected the login at ${where}: ${message}`
  if (kind === 'rpc') return `Kodi could not do that: ${message}`
  if (kind === 'timeout') return `Kodi did not answer at ${where} in time: ${message}`
  if (kind === 'disabled') return `The Kodi connection is switched off in this configuration: ${message}`
  if (kind === 'transport' || (kind === undefined && looksLikeConnectionFailure(message))) {
    return `Kodi is not reachable at ${where}: ${message}`
  }
  return `The ${name} tool could not finish: ${message}`
}

/** Whether a thrown value carries a Kodi error kind (transport, rpc, …). */
function isKodiError(error) {
  return error !== null && typeof error === 'object' && typeof error.kind === 'string'
}

/** Guarantee the envelope: an object with a boolean `ok` and an error on failure. */
function settle(name, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true }
  if (typeof value.ok !== 'boolean') return { ok: true, ...value }
  if (value.ok === false && !Object.hasOwn(value, 'error')) {
    return { ...value, error: `${name} did not complete.` }
  }
  return value
}

// ---- registration ---------------------------------------------------------

/**
 * Register the `kodi_*` tools on a context.
 * @param ctx - context providing `ctx.tools.register`.
 * @param kodi - the Kodi service (see CONTRACTS.md § src/kodi-service.mjs).
 * @param log - optional logger; only debug/warn levels are used.
 * @param hooks - optional `{ say, makePicks }` supplied by the bridge wiring.
 * @returns one disposer that unregisters every tool (idempotent).
 */
export function registerTools(ctx, kodi, log, hooks = {}) {
  if (ctx === null || typeof ctx !== 'object'
    || ctx.tools === null || typeof ctx.tools !== 'object'
    || typeof ctx.tools.register !== 'function') {
    throw new TypeError('registerTools(ctx, kodi, log, hooks): ctx.tools.register is required')
  }
  if (kodi === null || typeof kodi !== 'object') {
    throw new TypeError('registerTools(ctx, kodi, log, hooks): the Kodi service is required')
  }

  /** Debug-level note; logging must never break a tool. */
  function note(message) {
    try {
      log?.debug?.(message)
    } catch {
      // A logger that throws is not a tool failure.
    }
  }

  function reason(name, error) {
    return reasonFor(name, error, kodi)
  }

  /**
   * Run one service call and normalize its result. `{ ok: true, ...}` on success
   * (so service extras pass through), `{ ok: false, error }` on refusal or throw.
   */
  async function perform(name, call) {
    try {
      const value = await call()
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (value.ok === false) {
          return { ...value, ok: false, error: messageOf(value.error) || 'Kodi did not accept that.' }
        }
        return { ok: true, ...value }
      }
      return { ok: true }
    } catch (error) {
      note(`${name} failed: ${messageOf(error)}`)
      return { ok: false, error: reason(name, error) }
    }
  }

  /**
   * Prove the canonical value is lossless JSON before the executor sees it:
   * `undefined` fields are dropped and NaN/Infinity become null instead of
   * failing materialization after the fact. A value that cannot round-trip
   * (a cycle, a BigInt) degrades to the envelope rather than a failed turn.
   */
  function jsonSafe(name, value) {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch (error) {
      note(`${name} produced a value that cannot be read back: ${messageOf(error)}`)
      return value.ok === false
        ? { ok: false, error: value.error ?? `${name} did not complete.` }
        : { ok: true }
    }
  }

  /** Build one tool definition in the shape `ctx.tools.register` accepts. */
  function tool({ name, description, parameters, run, view }) {
    return {
      name,
      description,
      parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (args, value) => [{ type: 'text', text: renderResult(name, view, readArgs(args), value) }],
      },
      async execute(args, exec) {
        const input = readArgs(args)
        try {
          return jsonSafe(name, settle(name, await run(input, exec)))
        } catch (error) {
          note(`${name} failed: ${messageOf(error)}`)
          return { ok: false, error: reason(name, error) }
        }
      },
    }
  }

  const STRING = { type: 'string' }
  const INTEGER = { type: 'integer' }
  const BOOLEAN = { type: 'boolean' }

  /** A string node restricted to a fixed set of words. */
  const choice = (values) => ({ type: 'string', enum: values })

  const definitions = [
    // ---- kodi_status ------------------------------------------------------
    tool({
      name: 'kodi_status',
      description: 'Show what the TV is playing right now: the title, how far into it playback is, the volume, and the queue. Call this first when you need the current state before changing anything.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      view: viewStatus,
      async run() {
        return perform('kodi_status', () => kodi.status())
      },
    }),

    // ---- kodi_search ------------------------------------------------------
    tool({
      name: 'kodi_search',
      description: 'Search the Kodi library for something to watch or listen to, across movies, episodes, artists, albums, and songs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, as a person would type it: a title, a show, or an artist.' },
          kinds: {
            type: 'array',
            items: choice(SEARCH_KINDS),
            description: 'Limit the search to these kinds. Default: all of them.',
          },
          limit: { type: 'integer', description: 'How many matches to return (default 25, at most 100).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      view: viewSearch,
      async run(args) {
        const query = oneLine(args.query, 200)
        if (query === '') return { ok: false, error: 'kodi_search needs something to look for.' }
        const limit = boundedInt(args.limit, 25, 1, 100)
        const options = { limit }
        if (Array.isArray(args.kinds)) {
          const kinds = args.kinds.filter((kind) => SEARCH_KINDS.includes(kind))
          if (kinds.length > 0) options.kinds = kinds
        }
        const found = await perform('kodi_search', () => kodi.search(query, options))
        if (!found.ok) return found
        const results = Array.isArray(found.results) ? found.results : []
        return { ok: true, query, count: results.length, results }
      },
    }),

    // ---- kodi_library -----------------------------------------------------
    tool({
      name: 'kodi_library',
      description: 'Browse one section of the library — movies, TV shows, episodes, artists, albums, or songs — in library order, to see what is there before picking something.',
      parameters: {
        type: 'object',
        properties: {
          kind: { ...choice(LIBRARY_KINDS), description: 'Which section to browse.' },
          limit: { type: 'integer', description: 'How many items to return (default 20, at most 100).' },
          start: { type: 'integer', description: 'How many items to skip for the next page (default 0).' },
          sort: { type: 'string', description: 'Kodi sort order: sorttitle, title, year, rating, dateadded, or random (default sorttitle).' },
          filter: { type: 'string', description: 'Only items whose title contains this text. Default: no filter.' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      view: viewLibrary,
      async run(args) {
        const kind = LIBRARY_KINDS.includes(args.kind) ? args.kind : ''
        if (kind === '') {
          return { ok: false, error: `kodi_library needs kind to be one of: ${LIBRARY_KINDS.join(', ')}.` }
        }
        const options = {
          limit: boundedInt(args.limit, 20, 1, 100),
          start: boundedInt(args.start, 0, 0, 100000),
          sort: typeof args.sort === 'string' && args.sort !== '' ? args.sort : 'sorttitle',
          filter: typeof args.filter === 'string' ? args.filter : '',
        }
        const listed = await perform('kodi_library', () => kodi.library(kind, options))
        if (!listed.ok) return listed
        const items = Array.isArray(listed.items) ? listed.items : []
        const total = Number.isFinite(listed.total) ? listed.total : items.length
        return { ok: true, kind, start: options.start, total, filter: options.filter, items }
      },
    }),

    // ---- kodi_play --------------------------------------------------------
    tool({
      name: 'kodi_play',
      description: 'Start playback on the TV. Give a search phrase, a library id, or a file. A phrase that matches several different titles is refused with the candidates instead of guessing.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to play, as a person would ask for it; it is searched first, and playback starts only on an unambiguous match.' },
          kind: { ...choice(PLAY_KINDS), description: 'With id: what that id refers to (default movie).' },
          id: { type: 'integer', description: 'Library id to play, from kodi_search or kodi_library.' },
          file: { type: 'string', description: 'A file path or stream URL Kodi can open, instead of a library item.' },
          queue: { type: 'boolean', description: 'Add to the end of the queue instead of playing now (default false).' },
        },
        additionalProperties: false,
      },
      view: viewPlay,
      async run(args, exec) {
        const queued = args.queue === true
        const target = {}
        let title = ''

        const file = typeof args.file === 'string' ? args.file.trim() : ''
        if (file !== '') {
          target.file = file
        } else if (Number.isInteger(args.id)) {
          const kind = PLAY_KINDS.includes(args.kind) ? args.kind : 'movie'
          target.kind = kind
          target.id = args.id
        } else if (typeof args.query === 'string' && args.query.trim() !== '') {
          const query = oneLine(args.query, 200)
          const found = await perform('kodi_play', () => kodi.search(query, { limit: 10 }))
          if (!found.ok) return found
          const raw = Array.isArray(found.results) ? found.results : []
          // The same item can appear in more than one section; count it once.
          const seen = new Set()
          const results = []
          for (const result of raw) {
            if (result === null || typeof result !== 'object') continue
            const id = playableId(result.id)
            const key = id !== null && typeof result.kind === 'string' ? `${result.kind}:${id}` : ''
            if (key !== '') {
              if (seen.has(key)) continue
              seen.add(key)
            }
            results.push(result)
          }
          if (results.length === 0) {
            return { ok: false, error: `Nothing in the library matches "${query}", so nothing was played.` }
          }
          const exact = results.filter((result) => labelOf(result).toLowerCase() === query.toLowerCase())
          const pool = exact.length === 1 ? exact : results
          if (pool.length > 1) {
            const candidates = pool.slice(0, MAX_ROWS).map((result) => ({
              kind: typeof result.kind === 'string' ? result.kind : null,
              id: playableId(result.id),
              title: oneLine(result.title ?? result.label ?? 'Untitled', 120),
              year: Number.isInteger(result.year) ? result.year : null,
              runtime: Number.isFinite(result.runtime) ? result.runtime : null,
            }))
            const listed = candidates.map((candidate) => itemLine(candidate)).join('; ')
            return {
              ok: false,
              error: `"${query}" matches ${plural(pool.length, 'different title')}, so nothing was played. Say which one you mean: ${listed}.`,
              candidates,
            }
          }
          const only = pool[0]
          const id = playableId(only.id)
          if (id === null || typeof only.kind !== 'string') {
            return { ok: false, error: `Kodi found something for "${query}" but did not identify a playable item.` }
          }
          target.kind = only.kind
          target.id = id
          title = labelOf(only)
        } else {
          return { ok: false, error: 'kodi_play needs one of: query, id with kind, or file.' }
        }

        const played = await perform('kodi_play', () => kodi.play(target, { queue: queued }))
        if (!played.ok) return played
        // Player.Open is asynchronous: the service's answer is the authority on
        // whether a player actually started. A queued add may leave the TV idle,
        // but a "play now" that started nothing is a failure, not a success.
        if (!queued && played.playing === false) {
          return { ok: false, error: 'Kodi accepted the request, but no player started on the TV.' }
        }
        if (title === '') {
          // The service has refreshed its cache by now; use it only to label the
          // result, never as a reason to fail a playback that already started.
          try {
            title = labelOf(kodi.snapshot?.()?.item)
          } catch {
            title = ''
          }
        }
        return {
          ok: true,
          playing: played.playing ?? true,
          queued,
          title,
          kind: target.kind ?? (target.file !== undefined ? 'file' : null),
          id: target.id ?? null,
          target,
        }
      },
    }),

    // ---- kodi_queue -------------------------------------------------------
    tool({
      name: 'kodi_queue',
      description: 'Show or change what will play next on the TV: list the queue, add items, jump to a position, or clear it.',
      parameters: {
        type: 'object',
        properties: {
          action: { ...choice(QUEUE_ACTIONS), description: 'What to do with the queue (default list).' },
          kind: { ...choice(PLAY_KINDS), description: 'With ids or id: what those ids refer to (default movie).' },
          id: { type: 'integer', description: 'One library id to add or insert.' },
          ids: { type: 'array', items: INTEGER, description: 'Several library ids to add or insert, in play order.' },
          position: { type: 'integer', description: 'With jump: the 1-based queue position to jump to. With insert: where to insert.' },
          play: { type: 'boolean', description: 'Start playing the queued item immediately (default false).' },
        },
        additionalProperties: false,
      },
      view: viewQueue,
      async run(args) {
        const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'list'
        if (!QUEUE_ACTIONS.includes(action)) {
          return { ok: false, error: `kodi_queue needs action to be one of: ${QUEUE_ACTIONS.join(', ')}.` }
        }

        if (action === 'list') {
          const listed = await perform('kodi_queue', () => kodi.queueList())
          if (!listed.ok) return { ...listed, action }
          return {
            ok: true,
            action,
            items: Array.isArray(listed.items) ? listed.items : [],
            current: Number.isInteger(listed.current) ? listed.current : null,
          }
        }

        if (action === 'clear') {
          const cleared = await perform('kodi_queue', () => kodi.queue('clear'))
          return cleared.ok ? { ...cleared, action } : cleared
        }

        if (action === 'jump') {
          if (!Number.isInteger(args.position) || args.position < 1) {
            return { ok: false, error: 'kodi_queue with action="jump" needs position, the 1-based queue position to jump to.' }
          }
          const jumped = await perform('kodi_queue', () => kodi.queue('jump', { position: args.position }))
          return jumped.ok ? { ...jumped, action, position: args.position } : jumped
        }

        // add / insert
        const kind = PLAY_KINDS.includes(args.kind) ? args.kind : 'movie'
        const ids = []
        if (Number.isInteger(args.id)) ids.push(args.id)
        if (Array.isArray(args.ids)) {
          for (const id of args.ids) if (Number.isInteger(id)) ids.push(id)
        }
        if (ids.length === 0) {
          return { ok: false, error: `kodi_queue with action="${action}" needs id or ids.` }
        }
        const options = { items: ids.map((id) => ({ kind, id })) }
        if (Number.isInteger(args.position) && args.position >= 0) options.position = args.position
        if (typeof args.play === 'boolean') options.play = args.play
        const queued = await perform('kodi_queue', () => kodi.queue(action, options))
        return queued.ok ? { ...queued, action, items: options.items } : queued
      },
    }),

    // ---- kodi_transport ---------------------------------------------------
    tool({
      name: 'kodi_transport',
      description: 'Pause, resume, seek, skip, stop, or change the speed of what is playing on the TV.',
      parameters: {
        type: 'object',
        properties: {
          action: { ...choice(TRANSPORT_ACTIONS), description: 'The playback change to make.' },
          value: {
            oneOf: [
              { type: 'number' },
              { type: 'string', enum: ['previous', 'next'] },
            ],
            description: 'With seek: the position to jump to, in seconds from the start. With speed: the playback rate, such as 2 or 0.5. With skip: seconds to jump forward (positive) or back (negative), or "previous"/"next" to change item. Ignored otherwise.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      view: viewTransport,
      async run(args) {
        const action = typeof args.action === 'string' ? args.action : ''
        if (!TRANSPORT_ACTIONS.includes(action)) {
          return { ok: false, error: `kodi_transport needs action to be one of: ${TRANSPORT_ACTIONS.join(', ')}.` }
        }
        // skip has a usable default (the next item); seek and speed do not.
        const needsValue = action === 'seek' || action === 'speed'
        const options = {}
        if (Number.isFinite(args.value)) options.value = args.value
        else if (args.value === 'previous' || args.value === 'next') options.value = args.value
        if (needsValue && options.value === undefined) {
          return { ok: false, error: `kodi_transport with action="${action}" needs value.` }
        }
        if (action === 'skip' && args.value !== undefined && options.value === undefined) {
          return { ok: false, error: 'kodi_transport with action="skip" needs value to be seconds, "previous", or "next".' }
        }
        const changed = await perform('kodi_transport', () => kodi.transport(action, options))
        return changed.ok ? { ...changed, action } : changed
      },
    }),

    // ---- kodi_volume ------------------------------------------------------
    tool({
      name: 'kodi_volume',
      description: 'Read or set the volume on the TV, or mute and unmute it. Worth doing before playing something loud late at night.',
      parameters: {
        type: 'object',
        properties: {
          set: { type: 'integer', description: 'Set the volume to this level, 0 to 100.' },
          delta: { type: 'integer', description: 'Change the volume by this many steps, positive or negative.' },
          mute: { type: 'boolean', description: 'Mute (true) or unmute (false).' },
        },
        additionalProperties: false,
      },
      view: viewVolume,
      async run(args) {
        const options = {}
        if (Number.isInteger(args.set)) {
          if (args.set < 0 || args.set > 100) {
            return { ok: false, error: 'kodi_volume needs set to be between 0 and 100.' }
          }
          options.set = args.set
        }
        if (Number.isInteger(args.delta)) options.delta = args.delta
        if (typeof args.mute === 'boolean') options.mute = args.mute
        const changed = await perform('kodi_volume', () => kodi.volume(options))
        if (!changed.ok) return changed
        return {
          ok: true,
          volume: Number.isFinite(changed.volume) ? changed.volume : null,
          muted: typeof changed.muted === 'boolean' ? changed.muted : null,
        }
      },
    }),

    // ---- kodi_remote ------------------------------------------------------
    tool({
      name: 'kodi_remote',
      description: 'Press a remote button on the TV, for when someone has to navigate Kodi\'s own menus rather than start playback.',
      parameters: {
        type: 'object',
        properties: {
          action: { ...choice(REMOTE_ACTIONS), description: 'The button to press.' },
          value: { type: 'string', description: 'With action="key": the Kodi action to run, such as "screenshot" or "osd". Default: none.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      view: viewRemote,
      async run(args) {
        const action = typeof args.action === 'string' ? args.action : ''
        if (!REMOTE_ACTIONS.includes(action)) {
          return { ok: false, error: `kodi_remote needs action to be one of: ${REMOTE_ACTIONS.join(', ')}.` }
        }
        const options = {}
        if (typeof args.value === 'string' && args.value !== '') options.value = args.value
        if (action === 'key' && options.value === undefined) {
          return { ok: false, error: 'kodi_remote with action="key" needs the key name in value.' }
        }
        const pressed = await perform('kodi_remote', () => kodi.remote(action, options))
        return pressed.ok ? { ...pressed, action, ...(options.value !== undefined ? { value: options.value } : {}) } : pressed
      },
    }),

    // ---- kodi_notify ------------------------------------------------------
    tool({
      name: 'kodi_notify',
      description: 'Show a short notification banner on the TV, so whoever is watching sees it without looking away.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The one-line headline of the notification.' },
          message: { type: 'string', description: 'The body text (default: the title).' },
          image: { type: 'string', description: 'An image URL to show beside the text. Default: no image.' },
          time: { type: 'integer', description: 'How long to show it, in seconds (default 5).' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      view: viewNotify,
      async run(args) {
        const title = typeof args.title === 'string' ? oneLine(args.title, 120) : ''
        if (title === '') return { ok: false, error: 'kodi_notify needs a title.' }
        const message = typeof args.message === 'string' && args.message.trim() !== ''
          ? oneLine(args.message, 500)
          : title
        const options = { title, message }
        if (typeof args.image === 'string' && args.image !== '') options.image = args.image
        if (Number.isFinite(args.time) && args.time > 0) options.time = Math.round(args.time)
        const shown = await perform('kodi_notify', () => kodi.notify(options))
        return shown.ok ? { ...shown, title, message } : shown
      },
    }),

    // ---- kodi_picks -------------------------------------------------------
    tool({
      name: 'kodi_picks',
      description: 'Suggest what to watch tonight, ranked by what is already in progress, what fits the time left in the evening, and what was added recently. Each pick says why it is there.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many picks to suggest (default 6, at most 20).' },
        },
        additionalProperties: false,
      },
      view: viewPicks,
      async run(args) {
        const limit = boundedInt(args.limit, 6, 1, 20)
        const makePicksFor = picksRanker(hooks)
        let made
        try {
          made = await makePicksFor(kodi, { limit })
        } catch (error) {
          return {
            ok: false,
            error: isKodiError(error)
              ? reason('kodi_picks', error)
              : `Tonight's picks could not be built: ${messageOf(error) || 'the recommendation module failed'}.`,
          }
        }
        if (made === null || typeof made !== 'object' || !Array.isArray(made.picks)) {
          return { ok: false, error: 'Tonight\'s picks could not be built: the recommendation module returned no picks list.' }
        }
        return {
          ok: true,
          generatedAt: typeof made.generatedAt === 'string' ? made.generatedAt : null,
          picks: made.picks,
        }
      },
    }),

    // ---- kodi_screenshot --------------------------------------------------
    tool({
      name: 'kodi_screenshot',
      description: 'Take a screenshot of what the TV is showing, for when you need to see the screen rather than describe it.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      view: viewScreenshot,
      async run() {
        const shot = await perform('kodi_screenshot', () => kodi.screenshot())
        if (!shot.ok) return shot
        return {
          ok: true,
          path: typeof shot.path === 'string' ? shot.path : null,
          file: typeof shot.file === 'string' ? shot.file : null,
        }
      },
    }),

    // ---- kodi_say ---------------------------------------------------------
    tool({
      name: 'kodi_say',
      description: 'Show a message on the TV. Use this to answer a question that came from the TV, or to announce something before it plays.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to show, up to 2000 characters. The first line is the part that fits on the TV.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      view: viewSay,
      async run(args) {
        if (typeof hooks?.say !== 'function') {
          return { ok: false, error: 'The TV bridge is not running; nothing can be shown on the TV.' }
        }
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (text === '') return { ok: false, error: 'kodi_say needs text to show on the TV.' }
        if (text.length > 2000) {
          return { ok: false, error: 'kodi_say text is limited to 2000 characters.' }
        }
        try {
          const shown = await hooks.say({ text })
          return { ok: true, ...(shown !== null && typeof shown === 'object' ? shown : {}) }
        } catch (error) {
          return { ok: false, error: `The message could not be shown on the TV: ${messageOf(error) || 'the bridge failed'}.` }
        }
      },
    }),
  ]

  // Register in order. A throw here is a wiring bug (duplicate name, unsupported
  // schema) and must surface immediately; anything already registered by this
  // call is disposed first so the tool surface never ends up half-present.
  const disposers = []
  try {
    for (const definition of definitions) disposers.push(ctx.tools.register(definition))
  } catch (error) {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // Cleanup failures must not mask the registration error.
      }
    }
    throw error
  }
  let disposed = false

  return function dispose() {
    if (disposed) return
    disposed = true
    for (let index = disposers.length - 1; index >= 0; index--) {
      try {
        disposers[index]()
      } catch (error) {
        note(`unregistering a Kodi tool failed: ${messageOf(error)}`)
      }
    }
  }
}
