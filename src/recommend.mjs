/**
 * @file Picks engine for the TV experience.
 *
 * `makePicks` turns a live Kodi library into a short, ordered list of things the
 * viewer plausibly wants next. The order is the contract order:
 *
 *   1. in-progress movies, then in-progress episodes (reason carries the minutes
 *      already watched),
 *   2. the next unwatched episode of a show the viewer has progress in,
 *   3. short items that still fit the rest of the evening,
 *   4. what they added recently.
 *
 * The engine talks to Kodi through the raw JSON-RPC surface, because the ranked
 * sources (an `inprogress`-filtered or resume-scanned `GetMovies`, a
 * playcount-filtered `GetEpisodes` and a runtime-sorted `GetMovies`) have no
 * faithful high-level equivalent. Only queries measured to work against Kodi 21
 * are used: there is no `VideoLibrary.GetInProgress*` method in that API, so
 * "in progress" is derived from `resume.position > 0`. That surface is resolved
 * tolerantly from the `KodiService` instance it is handed: `kodi.rpc.call(...)`
 * first, then `kodi.call(...)`, `kodi.rpcCall(...)` and `kodi.invoke(...)`.
 *
 * Nothing in here may throw at the caller: each Kodi source is individually
 * guarded, and a library that refuses to answer simply contributes no picks.
 * That is what keeps the TV usable while the media centre is asleep.
 */

/**
 * A single recommendation, in the shape the tools, the panel and the add-on
 * consume.
 *
 * `runtime` and `resumeAt` are seconds, never `undefined` (`null` when Kodi did
 * not report the value).
 *
 * @typedef {object} Pick
 * @property {number|string} id Kodi library id (movieid / episodeid).
 * @property {'movie'|'episode'} kind Which library the id belongs to.
 * @property {string} title Human title, show-prefixed for episodes.
 * @property {string} reason Why this is being offered, e.g. "you're 24 minutes in".
 * @property {number|null} runtime Total runtime in seconds.
 * @property {number|null} resumeAt Seconds into the item to resume at, or null.
 * @property {string|null} thumbnail Kodi thumbnail/poster URL as Kodi returned it.
 */

/**
 * @typedef {object} PicksResult
 * @property {string} generatedAt ISO-8601 timestamp the list was built for.
 * @property {Pick[]} picks Ordered, deduplicated, at most `limit` entries.
 * @property {string[]} skipped Sources that failed or were unusable, for logs and
 *   diagnostics. Never consumed by the UI; a non-empty list still yields picks.
 */

/** Kodi video library fields requested for movies. */
const MOVIE_PROPERTIES = Object.freeze([
  'title',
  'year',
  'runtime',
  'thumbnail',
  'art',
  'resume',
  'playcount',
  'file',
  'dateadded',
]);

/** Kodi video library fields requested for episodes. */
const EPISODE_PROPERTIES = Object.freeze([
  'title',
  'showtitle',
  'season',
  'episode',
  'runtime',
  'thumbnail',
  'art',
  'resume',
  'playcount',
  'file',
  'dateadded',
  'tvshowid',
]);

/** How much viewing time "the rest of the evening" is assumed to have. */
const EVENING_MINUTES = 90;

/** Default and maximum size of the returned list. */
const DEFAULT_LIMIT = 6;

/** How many recently-added rows to inspect per library. */
const RECENT_WINDOW = 10;

/** How many unwatched episodes of one show to inspect when finding "next up". */
const NEXT_EPISODE_WINDOW = 10;

/** How many unwatched movies the "short item" source considers. */
const SHORT_MOVIE_WINDOW = 60;

/** How many recently played unwatched rows are scanned for a resume point. */
const IN_PROGRESS_SCAN_WINDOW = 60;

/**
 * Build the ordered, deduplicated pick list for one moment in time.
 *
 * Never throws: a Kodi that is off, half-answering, or answering with rubbish
 * produces fewer picks, and the failure is described in `skipped`.
 *
 * @param {{rpc?: {call?: Function}, call?: Function, rpcCall?: Function, invoke?: Function}|null} kodi
 *   The `KodiService` instance (or anything exposing a JSON-RPC `call`). Only the
 *   raw RPC surface is used.
 * @param {object} [options]
 * @param {number} [options.now] Epoch milliseconds to build the list for; drives
 *   `generatedAt` and the "added N days ago" reason. Defaults to `Date.now()`.
 * @param {number} [options.limit] Maximum number of picks (0 yields none).
 *   Defaults to 6.
 * @param {number} [options.eveningMinutes] Size of the remaining-evening budget
 *   used by the "short item" source. Defaults to 90.
 * @returns {Promise<PicksResult>} The picks, plus the sources that were skipped.
 */
export async function makePicks(kodi, { now = Date.now(), limit = DEFAULT_LIMIT, eveningMinutes = EVENING_MINUTES } = {}) {
  const at = Number.isFinite(now) ? /** @type {number} */ (now) : Date.now();
  const cap = normalizeLimit(limit);
  const eveningSeconds = (Number.isFinite(eveningMinutes) ? Number(eveningMinutes) : EVENING_MINUTES) * 60;
  const generatedAt = new Date(at).toISOString();

  /** @type {Pick[]} */
  const picks = [];
  /** @type {string[]} */
  const skipped = [];

  const call = resolveCall(kodi);
  if (!call) {
    return { generatedAt, picks, skipped: ['all sources: the Kodi service exposes no JSON-RPC call surface'] };
  }

  /** Pick identities already emitted, so no source can repeat another's item. */
  const seenIds = new Set();
  /** Files already emitted; two library rows can point at the same file. */
  const seenFiles = new Set();

  /**
   * Append one candidate if it is fresh and there is room.
   * @param {{pick: Pick, file: string|null}|null} candidate
   * @returns {boolean} Whether room remains for more picks.
   */
  const offer = (candidate) => {
    if (!candidate) return picks.length < cap;
    const { pick, file } = candidate;
    if (picks.length >= cap) return false;
    if (pick.id == null) return true;
    const identity = `${pick.kind}:${pick.id}`;
    if (seenIds.has(identity)) return true;
    if (file && seenFiles.has(file)) return true;
    seenIds.add(identity);
    if (file) seenFiles.add(file);
    picks.push(pick);
    return picks.length < cap;
  };

  const room = () => picks.length < cap;

  // 1a. In-progress movies.
  if (room()) {
    try {
      for (const movie of await inProgressMovies(call)) {
        offer(movieCandidate(movie, 'progress'));
        if (!room()) break;
      }
    } catch (error) {
      skipped.push(`in-progress movies: ${reasonOf(error)}`);
    }
  }

  // 1b. In-progress episodes; also the seed for "next unwatched".
  /** @type {Map<number|string, Record<string, any>>} tvshowid -> the episode in progress */
  const showsInProgress = new Map();
  if (room()) {
    try {
      for (const episode of await inProgressEpisodes(call)) {
        offer(episodeCandidate(episode, 'progress'));
        const showId = num(episode?.tvshowid);
        if (showId != null && !showsInProgress.has(showId)) showsInProgress.set(showId, episode);
        if (!room()) break;
      }
    } catch (error) {
      skipped.push(`in-progress episodes: ${reasonOf(error)}`);
    }
  }

  // 2. The next unwatched episode of each show in progress.
  for (const [showId, current] of showsInProgress) {
    if (!room()) break;
    try {
      const next = await nextEpisode(call, showId, current);
      offer(next ? episodeCandidate(next, 'nextup', current) : null);
    } catch (error) {
      skipped.push(`next unwatched episode of show ${showId}: ${reasonOf(error)}`);
    }
  }

  // 3. Short items that still fit the evening.
  if (room()) {
    try {
      const result = await call('VideoLibrary.GetMovies', {
        properties: MOVIE_PROPERTIES,
        filter: { field: 'playcount', operator: 'is', value: '0' },
        limits: { start: 0, end: SHORT_MOVIE_WINDOW },
        sort: { method: 'runtime', order: 'ascending' },
      });
      // Kodi is asked to sort by runtime, but the sort is re-applied here: the
      // promise to the viewer is "the shortest thing that still fits", and that
      // must not depend on a server honouring the sort parameter.
      const eligible = [];
      for (const movie of rows(result, 'movies')) {
        const runtime = num(movie?.runtime);
        if (runtime == null || runtime <= 0 || runtime > eveningSeconds) continue;
        eligible.push({ movie, runtime });
      }
      eligible.sort((left, right) => left.runtime - right.runtime);
      for (const entry of eligible) {
        if (!room()) break;
        offer(movieCandidate(entry.movie, 'short', eveningSeconds));
      }
    } catch (error) {
      skipped.push(`short items: ${reasonOf(error)}`);
    }
  }

  // 4. Recently added, movies then episodes.
  if (room()) {
    try {
      const result = await call('VideoLibrary.GetRecentlyAddedMovies', {
        properties: MOVIE_PROPERTIES,
        limits: { start: 0, end: RECENT_WINDOW },
      });
      for (const movie of rows(result, 'movies')) {
        if (!room()) break;
        offer(movieCandidate(movie, 'recent', at));
      }
    } catch (error) {
      skipped.push(`recently added movies: ${reasonOf(error)}`);
    }
  }
  if (room()) {
    try {
      const result = await call('VideoLibrary.GetRecentlyAddedEpisodes', {
        properties: EPISODE_PROPERTIES,
        limits: { start: 0, end: RECENT_WINDOW },
      });
      for (const episode of rows(result, 'episodes')) {
        if (!room()) break;
        offer(episodeCandidate(episode, 'recent', at));
      }
    } catch (error) {
      skipped.push(`recently added episodes: ${reasonOf(error)}`);
    }
  }

  return { generatedAt, picks, skipped };
}

/**
 * Movies the viewer is part-way through.
 *
 * Kodi answers the `inprogress` filter directly, which is the cheap and precise
 * form. A build whose filter surface does not know the field is covered by
 * scanning the most recently played unwatched movies instead: an item is in
 * progress exactly when it is unwatched and its resume point is past the start.
 * The scan also runs when the filter answers with no rows, because a build that
 * silently ignores an unknown field would otherwise look like an empty shelf.
 *
 * @param {(method: string, params?: Record<string, unknown>) => Promise<any>} call
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function inProgressMovies(call) {
  /** @type {Array<Record<string, any>>} */
  const found = [];
  /** @type {unknown} */
  let filterError = null;

  try {
    const filtered = await call('VideoLibrary.GetMovies', {
      properties: MOVIE_PROPERTIES,
      filter: { field: 'inprogress', operator: 'is', value: 'true' },
    });
    found.push(...rows(filtered, 'movies'));
  } catch (error) {
    filterError = error;
  }

  if (found.length === 0) {
    try {
      const scanned = await call('VideoLibrary.GetMovies', {
        properties: MOVIE_PROPERTIES,
        filter: { field: 'playcount', operator: 'is', value: '0' },
        limits: { start: 0, end: IN_PROGRESS_SCAN_WINDOW },
        sort: { method: 'lastplayed', order: 'descending' },
      });
      found.push(...rows(scanned, 'movies'));
    } catch (error) {
      throw filterError ?? error;
    }
  }

  // `resume.position === 0` means "not started", even when playcount is 0.
  return found.filter((movie) => (num(movie?.resume?.position) ?? 0) > 0);
}

/**
 * Episodes the viewer is part-way through.
 *
 * There is no library-wide in-progress *episode* query to lean on, so this asks
 * for the recently played unwatched episodes and keeps the ones that carry a
 * resume point. A server that refuses the recency sort is retried without it -
 * and without the window, so nothing in progress can fall outside the scan.
 *
 * @param {(method: string, params?: Record<string, unknown>) => Promise<any>} call
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function inProgressEpisodes(call) {
  const base = {
    properties: EPISODE_PROPERTIES,
    filter: { field: 'playcount', operator: 'is', value: '0' },
  };

  let result;
  try {
    result = await call('VideoLibrary.GetEpisodes', {
      ...base,
      limits: { start: 0, end: IN_PROGRESS_SCAN_WINDOW },
      sort: { method: 'lastplayed', order: 'descending' },
    });
  } catch {
    result = await call('VideoLibrary.GetEpisodes', base);
  }

  return rows(result, 'episodes').filter((episode) => (num(episode?.resume?.position) ?? 0) > 0);
}

/**
 * Find the episode a viewer should watch next: the first unwatched episode that
 * follows the one in progress, or - when they are sitting on the last one - the
 * first unwatched episode that is not the one they are already on.
 *
 * @param {(method: string, params?: Record<string, unknown>) => Promise<any>} call
 * @param {number|string} showId
 * @param {Record<string, any>} current Episode in progress for that show.
 * @returns {Promise<Record<string, any>|null>}
 */async function nextEpisode(call, showId, current) {
  const result = await call('VideoLibrary.GetEpisodes', {
    tvshowid: Number(showId),
    properties: EPISODE_PROPERTIES,
    filter: { field: 'playcount', operator: 'is', value: '0' },
    limits: { start: 0, end: NEXT_EPISODE_WINDOW },
    sort: { method: 'episode', order: 'ascending' },
  });

  const episodes = rows(result, 'episodes');
  if (episodes.length === 0) return null;

  const season = num(current?.season);
  const episode = num(current?.episode);
  if (season != null && episode != null) {
    for (const candidate of episodes) {
      const candidateSeason = num(candidate?.season);
      const candidateEpisode = num(candidate?.episode);
      if (candidateSeason == null || candidateEpisode == null) continue;
      if (candidateSeason > season || (candidateSeason === season && candidateEpisode > episode)) {
        return candidate;
      }
    }
  }

  const currentId = current?.episodeid;
  return episodes.find((candidate) => String(candidate?.episodeid) !== String(currentId)) ?? null;
}

/**
 * Shape one movie row into an offer.
 *
 * @param {Record<string, any>} movie
 * @param {'progress'|'short'|'recent'} source
 * @param {number} [detail] Evening budget (seconds) for `short`, epoch ms for `recent`.
 * @returns {{pick: Pick, file: string|null}}
 */
function movieCandidate(movie, source, detail) {
  const runtime = num(movie?.runtime) ?? num(movie?.resume?.total);
  const resumeAt = num(movie?.resume?.position);
  return {
    pick: {
      id: movie?.movieid ?? null,
      kind: 'movie',
      title: str(movie?.title) ?? str(movie?.label) ?? 'Untitled movie',
      reason: movieReason(source, { runtime, resumeAt, added: movie?.dateadded, detail }),
      runtime: runtime ?? null,
      resumeAt: source === 'progress' ? resumeAt ?? null : null,
      thumbnail: thumbnailOf(movie),
    },
    file: str(movie?.file),
  };
}

/**
 * Shape one episode row into an offer.
 *
 * @param {Record<string, any>} episode
 * @param {'progress'|'nextup'|'recent'} source
 * @param {Record<string, any>|number} [detail] The in-progress episode for
 *   `nextup`, epoch ms for `recent`.
 * @returns {{pick: Pick, file: string|null}}
 */
function episodeCandidate(episode, source, detail) {
  const runtime = num(episode?.runtime) ?? num(episode?.resume?.total);
  const resumeAt = num(episode?.resume?.position);
  return {
    pick: {
      id: episode?.episodeid ?? null,
      kind: 'episode',
      title: episodeTitle(episode),
      reason: episodeReason(source, {
        runtime,
        resumeAt,
        show: str(episode?.showtitle),
        added: episode?.dateadded,
        detail,
      }),
      runtime: runtime ?? null,
      resumeAt: source === 'progress' ? resumeAt ?? null : null,
      thumbnail: thumbnailOf(episode),
    },
    file: str(episode?.file),
  };
}

/**
 * @param {'progress'|'short'|'recent'} source
 * @param {{runtime: number|null, resumeAt: number|null, added?: unknown, detail?: unknown}} facts
 * @returns {string}
 */
function movieReason(source, facts) {
  if (source === 'progress') return progressReason(facts.resumeAt);
  if (source === 'short') return shortReason(facts.runtime);
  return recentlyAddedReason(facts.added, facts.detail);
}

/**
 * @param {'progress'|'nextup'|'recent'} source
 * @param {{runtime: number|null, resumeAt: number|null, show: string|null, added?: unknown, detail?: unknown}} facts
 * @returns {string}
 */
function episodeReason(source, facts) {
  if (source === 'progress') return progressReason(facts.resumeAt);
  if (source === 'nextup') return facts.show ? `next unwatched episode of ${facts.show}` : 'next unwatched episode';
  return recentlyAddedReason(facts.added, facts.detail);
}

/**
 * "you're 24 minutes in" - the contract's own example wording.
 *
 * @param {number|null} resumeAt Seconds into the item.
 * @returns {string}
 */
function progressReason(resumeAt) {
  const minutes = resumeAt == null ? 0 : Math.round(resumeAt / 60);
  if (minutes < 1) return "you're partway in";
  return minutes === 1 ? "you're 1 minute in" : `you're ${minutes} minutes in`;
}

/**
 * @param {number|null} runtime Seconds.
 * @returns {string}
 */
function shortReason(runtime) {
  if (runtime == null || runtime <= 0) return 'short enough for tonight';
  return `${duration(runtime)} - fits your evening`;
}

/**
 * @param {unknown} added Kodi `dateadded` (`YYYY-MM-DD HH:MM:SS` or ISO).
 * @param {unknown} now Epoch milliseconds of the moment the list is built for.
 * @returns {string}
 */
function recentlyAddedReason(added, now) {
  const addedMs = epochMs(added);
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (addedMs == null) return 'recently added';
  const days = Math.floor((nowMs - addedMs) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return 'added today';
  if (days === 1) return 'added yesterday';
  if (days < 30) return `added ${days} days ago`;
  const weeks = Math.floor(days / 7);
  return `added ${weeks} weeks ago`;
}

/**
 * Title for an episode, prefixed with its show and carrying the season/episode
 * code when Kodi's label does not already contain one.
 *
 * @param {Record<string, any>} episode
 * @returns {string}
 */
function episodeTitle(episode) {
  const label = str(episode?.title) ?? str(episode?.label);
  const show = str(episode?.showtitle);
  const base = show && label && !label.toLowerCase().startsWith(show.toLowerCase()) ? `${show} - ${label}` : label ?? show ?? 'Untitled episode';

  const season = num(episode?.season);
  const number = num(episode?.episode);
  if (season == null || number == null) return base;
  if (/\bs\d{1,3}\s*e\d{1,4}\b/i.test(base)) return base;
  if (new RegExp(`(^|\\D)${season}x0*${number}(\\D|$)`).test(base)) return base;
  return `${base} (S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')})`;
}

/**
 * @param {Record<string, any>|null|undefined} item
 * @returns {string|null}
 */
function thumbnailOf(item) {
  return str(item?.thumbnail) ?? str(item?.art?.poster) ?? str(item?.art?.thumb) ?? null;
}

/**
 * `1h 30m` / `42m`, used only inside human reason strings.
 *
 * @param {number} seconds
 * @returns {string}
 */
function duration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/**
 * Read one result list out of a Kodi response, tolerating an omitted key.
 *
 * @param {any} result
 * @param {'movies'|'episodes'} key
 * @returns {Array<Record<string, any>>}
 */
function rows(result, key) {
  const value = result?.[key];
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Parse a Kodi timestamp (`2019-11-02 10:20:30`) or an ISO string.
 *
 * @param {unknown} value
 * @returns {number|null} Epoch milliseconds.
 */
function epochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} limit
 * @returns {number}
 */
function normalizeLimit(limit) {
  const value = num(limit);
  if (value == null) return DEFAULT_LIMIT;
  return Math.max(0, Math.floor(value));
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

/**
 * Resolve the raw JSON-RPC `call(method, params)` surface from the Kodi service.
 *
 * `KodiService` keeps its `KodiRpc` instance as `rpc`; the other spellings are
 * accepted so the picks engine does not need a specific service implementation
 * to be useful.
 *
 * @param {any} kodi
 * @returns {((method: string, params?: Record<string, unknown>) => Promise<any>)|null}
 */
function resolveCall(kodi) {
  if (!kodi || (typeof kodi !== 'object' && typeof kodi !== 'function')) return null;
  if (typeof kodi.rpc?.call === 'function') return (method, params) => kodi.rpc.call(method, params ?? {});
  if (typeof kodi.call === 'function') return (method, params) => kodi.call(method, params ?? {});
  if (typeof kodi.rpcCall === 'function') return (method, params) => kodi.rpcCall(method, params ?? {});
  if (typeof kodi.invoke === 'function') return (method, params) => kodi.invoke(method, params ?? {});
  return null;
}
