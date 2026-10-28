/**
 * @file Spec for the picks engine (`src/recommend.mjs`).
 *
 * Two fixtures are in play:
 * - a recording stub for the library shapes this engine has to survive
 *   (ordering, dedupe, caps, broken sources), because those cases need exact
 *   control over every source at once;
 * - the shared `tests/mock-kodi.mjs` over real HTTP for the two cases where the
 *   wire format matters (real Kodi JSON-RPC envelope, real per-method failure).
 *
 * The query shapes asserted here are the ones measured against Kodi 21.3: an
 * `inprogress` filter on `GetMovies`, a `playcount` filter on `GetEpisodes`, and
 * `resume.position > 0` as the definition of "part-way through".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makePicks } from '../src/recommend.mjs';
import { startMockKodi } from './mock-kodi.mjs';

/** A fixed instant so "added N days ago" is stable. */
const NOW = Date.parse('2026-03-10T20:00:00.000Z');

const IN_PROGRESS_MOVIE = {
  movieid: 11,
  title: 'In Progress Movie',
  runtime: 7200,
  playcount: 0,
  resume: { position: 1440, total: 7200 },
  thumbnail: 'image://movie11/',
  file: '/media/movies/in_progress.mkv',
};

const IN_PROGRESS_EPISODE = {
  episodeid: 21,
  tvshowid: 7,
  showtitle: 'Show A',
  season: 2,
  episode: 3,
  title: 'Ep Three',
  runtime: 2700,
  playcount: 0,
  resume: { position: 600, total: 2700 },
  file: '/media/tv/showa/s02e03.mkv',
};

const NEXT_EPISODE = {
  episodeid: 22,
  tvshowid: 7,
  showtitle: 'Show A',
  season: 2,
  episode: 4,
  title: 'Ep Four',
  runtime: 2700,
  playcount: 0,
  file: '/media/tv/showa/s02e04.mkv',
};

const SHORT_MOVIE = { movieid: 31, title: 'Short Movie', runtime: 3600, playcount: 0, file: '/media/movies/short.mkv' };
const LONG_MOVIE = { movieid: 32, title: 'Long Movie', runtime: 9000, playcount: 0, file: '/media/movies/long.mkv' };
const RECENT_MOVIE = {
  movieid: 41,
  title: 'New Movie',
  runtime: 6000,
  dateadded: '2026-03-07 10:00:00',
  file: '/media/movies/new.mkv',
};
const RECENT_EPISODE = {
  episodeid: 51,
  showtitle: 'Show B',
  season: 1,
  episode: 1,
  title: 'Pilot',
  runtime: 3000,
  dateadded: '2026-03-09 10:00:00',
  file: '/media/tv/showb/s01e01.mkv',
};

/**
 * A Kodi service stub whose raw JSON-RPC surface answers from a handler map.
 *
 * A handler may be a plain result, a function of the params, or a function that
 * throws - the last of which is how a single failing source is simulated.
 *
 * @param {Record<string, unknown|((params: Record<string, any>) => unknown)>} handlers
 * @returns {{rpc: {call: (method: string, params?: Record<string, any>) => Promise<any>}, calls: Array<{method: string, params: Record<string, any>}>}}
 */
function stubKodi(handlers) {
  /** @type {Array<{method: string, params: Record<string, any>}>} */
  const calls = [];
  return {
    calls,
    rpc: {
      async call(method, params = {}) {
        calls.push({ method, params });
        if (!Object.hasOwn(handlers, method)) throw new Error(`stub has no answer for ${method}`);
        const handler = handlers[method];
        return typeof handler === 'function' ? await handler(params) : handler;
      },
    },
  };
}

/** @param {Array<{method: string, params: Record<string, any>}>} calls @param {string} method */
function methodsOnly(calls, method) {
  return calls.filter((entry) => entry.method === method);
}

/**
 * The full happy-path library: one movie in progress, one show in progress, a
 * short unwatched movie, a too-long one, and one recent movie plus one recent
 * episode. Handlers answer according to the params Kodi would receive, so the
 * "in progress" query and the "short item" query can be told apart.
 *
 * @param {Record<string, any>} [overrides]
 */
function happyLibrary(overrides = {}) {
  return {
    'VideoLibrary.GetMovies': (params) =>
      params.filter?.field === 'inprogress' ? { movies: [IN_PROGRESS_MOVIE] } : { movies: [SHORT_MOVIE, LONG_MOVIE] },
    'VideoLibrary.GetEpisodes': (params) =>
      params.tvshowid == null ? { episodes: [IN_PROGRESS_EPISODE] } : { episodes: [NEXT_EPISODE] },
    'VideoLibrary.GetRecentlyAddedMovies': { movies: [RECENT_MOVIE] },
    'VideoLibrary.GetRecentlyAddedEpisodes': { episodes: [RECENT_EPISODE] },
    ...overrides,
  };
}

describe('makePicks ordering', () => {
  it('ranks in-progress, then next unwatched, then short items, then recently added', async () => {
    const kodi = stubKodi(happyLibrary());
    const result = await makePicks(kodi, { now: NOW });

    assert.equal(result.generatedAt, new Date(NOW).toISOString());
    assert.deepEqual(
      result.picks.map((pick) => pick.id),
      [11, 21, 22, 31, 41, 51],
      'contract ranking order: progress (movie, episode), next up, short, recent',
    );
    assert.deepEqual(
      result.picks.map((pick) => pick.kind),
      ['movie', 'episode', 'episode', 'movie', 'movie', 'episode'],
    );
    assert.deepEqual(result.skipped, []);
  });

  it('explains every pick in words a viewer can read', async () => {
    const result = await makePicks(stubKodi(happyLibrary()), { now: NOW });
    const [movie, episode, nextUp, short, recent, recentEpisode] = result.picks;

    assert.equal(movie.reason, "you're 24 minutes in");
    assert.equal(episode.reason, "you're 10 minutes in");
    assert.equal(nextUp.reason, 'next unwatched episode of Show A');
    assert.match(short.reason, /fits your evening$/);
    assert.equal(recent.reason, 'added 3 days ago');
    assert.equal(recentEpisode.reason, 'added yesterday');
  });

  it('ranks a movie resumed ten minutes in first, and says so', async () => {
    const tenMinutesIn = { ...IN_PROGRESS_MOVIE, movieid: 12, title: 'Ten Minutes In', resume: { position: 600, total: 7200 } };
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetMovies': (params) =>
          params.filter?.field === 'inprogress' ? { movies: [tenMinutesIn] } : { movies: [SHORT_MOVIE] },
      }),
    );
    const result = await makePicks(kodi, { now: NOW });

    assert.equal(result.picks[0].id, 12, 'the item being watched outranks everything else');
    assert.match(result.picks[0].reason, /you're 10 minutes in/);
    assert.equal(result.picks[0].resumeAt, 600);
  });

  it('treats resume.position 0 as not started even when playcount is 0', async () => {
    const untouched = { movieid: 13, title: 'Untouched', runtime: 5400, playcount: 0, resume: { position: 0, total: 5400 } };
    const kodi = stubKodi(
      happyLibrary({
        // A sloppy answer to the inprogress filter: the item is not in progress.
        'VideoLibrary.GetMovies': (params) =>
          params.filter?.field === 'inprogress' ? { movies: [untouched] } : { movies: [] },
      }),
    );
    const result = await makePicks(kodi, { now: NOW });

    assert.equal(result.picks.some((pick) => pick.id === 13), false, 'an item at position 0 is not in progress');
    assert.deepEqual(
      result.picks.filter((pick) => pick.kind === 'movie' && pick.reason.startsWith("you're")),
      [],
    );
    assert.equal(result.picks.some((pick) => pick.resumeAt === 0), false);
  });

  it('carries the resumable offset only for items in progress', async () => {
    const result = await makePicks(stubKodi(happyLibrary()), { now: NOW });
    const byId = new Map(result.picks.map((pick) => [pick.id, pick]));

    assert.equal(byId.get(11).resumeAt, 1440);
    assert.equal(byId.get(21).resumeAt, 600);
    assert.equal(byId.get(22).resumeAt, null);
    assert.equal(byId.get(31).resumeAt, null);
    assert.equal(byId.get(11).runtime, 7200);
    assert.equal(byId.get(11).thumbnail, 'image://movie11/');
  });

  it('names episodes with their show and season/episode code', async () => {
    const result = await makePicks(stubKodi(happyLibrary()), { now: NOW });
    const byId = new Map(result.picks.map((pick) => [pick.id, pick]));

    assert.equal(byId.get(22).title, 'Show A - Ep Four (S02E04)');
    assert.equal(byId.get(51).title, 'Show B - Pilot (S01E01)');
  });

  it('does not repeat a season/episode code the Kodi label already carries', async () => {
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetRecentlyAddedEpisodes': {
          episodes: [
            { episodeid: 61, showtitle: 'Show C', season: 1, episode: 2, title: 'S01E02 The Code', runtime: 1800, dateadded: '2026-03-10 09:00:00' },
            { episodeid: 62, showtitle: 'Show C', season: 1, episode: 3, title: '1x03 The Other Code', runtime: 1800, dateadded: '2026-03-10 09:00:00' },
          ],
        },
      }),
    );
    const result = await makePicks(kodi, { now: NOW, limit: 10 });
    const byId = new Map(result.picks.map((pick) => [pick.id, pick]));

    assert.equal(byId.get(61).title, 'Show C - S01E02 The Code');
    assert.equal(byId.get(62).title, 'Show C - 1x03 The Other Code');
  });
});

describe('makePicks dedupe and caps', () => {
  it('never offers the same item twice, even when two sources return it', async () => {
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetMovies': (params) =>
          params.filter?.field === 'inprogress' ? { movies: [IN_PROGRESS_MOVIE] } : { movies: [IN_PROGRESS_MOVIE] },
        'VideoLibrary.GetRecentlyAddedMovies': { movies: [IN_PROGRESS_MOVIE] },
        'VideoLibrary.GetRecentlyAddedEpisodes': { episodes: [IN_PROGRESS_EPISODE] },
      }),
    );
    const result = await makePicks(kodi, { now: NOW, limit: 10 });

    assert.deepEqual(result.picks.map((pick) => pick.id), [11, 21, 22], 'each item appears once');
  });

  it('deduplicates two library rows that point at the same file', async () => {
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetMovies': (params) =>
          params.filter?.field === 'inprogress'
            ? { movies: [] }
            : {
                movies: [
                  { movieid: 71, title: 'Same File', runtime: 1200, playcount: 0, file: '/media/shared.mkv' },
                  { movieid: 72, title: 'Same File (duplicate row)', runtime: 1200, playcount: 0, file: '/media/shared.mkv' },
                ],
              },
      }),
    );
    const result = await makePicks(kodi, { now: NOW, limit: 10 });
    const sameFile = result.picks.filter((pick) => pick.id === 71 || pick.id === 72);

    assert.equal(sameFile.length, 1);
    assert.equal(sameFile[0].id, 71);
  });

  it('caps the list at the requested limit and defaults to six', async () => {
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetRecentlyAddedMovies': {
          movies: Array.from({ length: 8 }, (_, index) => ({
            movieid: 100 + index,
            title: `Recent ${index}`,
            runtime: 6000,
            dateadded: '2026-03-09 10:00:00',
            file: `/media/recent-${index}.mkv`,
          })),
        },
      }),
    );

    assert.equal((await makePicks(kodi, { now: NOW })).picks.length, 6);
    assert.equal((await makePicks(kodi, { now: NOW, limit: 3 })).picks.length, 3);
    assert.deepEqual((await makePicks(kodi, { now: NOW, limit: 0 })).picks, []);
  });

  it('stops spending the list on one source when the limit is small', async () => {
    const result = await makePicks(stubKodi(happyLibrary()), { now: NOW, limit: 2 });
    assert.deepEqual(result.picks.map((pick) => pick.id), [11, 21]);
  });
});

describe('makePicks source failures', () => {
  it('rescues in-progress movies when the inprogress filter is not understood', async () => {
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetMovies': (params) => {
          if (params.filter?.field === 'inprogress') throw new Error('Invalid params.');
          return { movies: [SHORT_MOVIE, IN_PROGRESS_MOVIE] };
        },
      }),
    );
    const result = await makePicks(kodi, { now: NOW });

    assert.equal(result.picks[0].id, 11, 'the resume scan found it anyway');
    assert.deepEqual(result.skipped, [], 'a recovered source is not reported as broken');

    const movieCalls = methodsOnly(kodi.calls, 'VideoLibrary.GetMovies');
    assert.equal(movieCalls[0].params.filter.field, 'inprogress');
    assert.equal(movieCalls[1].params.filter.field, 'playcount');
  });

  it('skips a source that fails for good and keeps the rest', async () => {
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetEpisodes': () => {
          throw new Error('Kodi is not reachable at http://127.0.0.1:8080/jsonrpc');
        },
      }),
    );
    const result = await makePicks(kodi, { now: NOW });

    assert.deepEqual(result.picks.map((pick) => pick.id), [11, 31, 41, 51]);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /^in-progress episodes: Kodi is not reachable/);
  });

  it('survives every source failing', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    const result = await makePicks(
      stubKodi({
        'VideoLibrary.GetMovies': boom,
        'VideoLibrary.GetEpisodes': boom,
        'VideoLibrary.GetRecentlyAddedMovies': boom,
        'VideoLibrary.GetRecentlyAddedEpisodes': boom,
      }),
      { now: NOW },
    );

    assert.deepEqual(result.picks, []);
    assert.equal(result.skipped.length, 5);
  });

  it('returns an empty list, not an exception, when Kodi has no call surface', async () => {
    for (const kodi of [null, undefined, {}, { snapshot: () => ({}) }]) {
      const result = await makePicks(kodi, { now: NOW });
      assert.deepEqual(result.picks, []);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.generatedAt, new Date(NOW).toISOString());
    }
  });

  it('survives an in-progress episode with no usable show id', async () => {
    const orphan = { episodeid: 81, title: 'Orphan', runtime: 1200, resume: { position: 120, total: 1200 } };
    const kodi = stubKodi(happyLibrary({ 'VideoLibrary.GetEpisodes': { episodes: [orphan] } }));
    const result = await makePicks(kodi, { now: NOW });

    assert.ok(result.picks.some((pick) => pick.id === 81), 'the orphan is still offered');
    assert.equal(
      methodsOnly(kodi.calls, 'VideoLibrary.GetEpisodes').filter((entry) => entry.params.tvshowid != null).length,
      0,
      'no show id means no next-up lookup is possible, so none is attempted',
    );
    assert.equal(result.picks.filter((pick) => pick.reason.startsWith('next unwatched')).length, 0);
  });

  it('falls back to a plain call() surface when rpc is not exposed', async () => {
    const handlers = happyLibrary();
    const seen = [];
    const kodi = {
      async call(method, params = {}) {
        seen.push(method);
        const handler = handlers[method];
        return typeof handler === 'function' ? handler(params) : handler;
      },
    };
    const result = await makePicks(kodi, { now: NOW });

    assert.equal(result.picks.length, 6);
    assert.ok(seen.includes('VideoLibrary.GetMovies'));
    assert.ok(!seen.includes('VideoLibrary.GetInProgressMovies'), 'the dead method is never called');
  });
});

describe('makePicks next-unwatched selection', () => {
  it('picks the episode after the one in progress, not the one in progress', async () => {
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetEpisodes': (params) =>
          params.tvshowid == null
            ? { episodes: [IN_PROGRESS_EPISODE] }
            : { episodes: [IN_PROGRESS_EPISODE, NEXT_EPISODE] },
      }),
    );
    const result = await makePicks(kodi, { now: NOW });
    const nextUp = result.picks.find((pick) => pick.reason === 'next unwatched episode of Show A');

    assert.equal(nextUp.id, 22);
    const lookup = methodsOnly(kodi.calls, 'VideoLibrary.GetEpisodes').find((entry) => entry.params.tvshowid != null);
    assert.deepEqual(lookup.params.filter, { field: 'playcount', operator: 'is', value: '0' }, 'only unwatched episodes');
    assert.equal(lookup.params.tvshowid, 7);
    assert.equal(lookup.params.sort.method, 'episode');
    assert.equal(lookup.params.sort.order, 'ascending');
  });

  it('falls back to the first unwatched episode when the show has moved past it', async () => {
    const later = { ...IN_PROGRESS_EPISODE, episodeid: 22, season: 2, episode: 4, title: 'Ep Four' };
    const earliest = { ...NEXT_EPISODE, episodeid: 20, season: 2, episode: 1, title: 'Ep One' };
    const result = await makePicks(
      stubKodi(
        happyLibrary({
          'VideoLibrary.GetEpisodes': (params) =>
            params.tvshowid == null ? { episodes: [later] } : { episodes: [earliest, later] },
        }),
      ),
      { now: NOW },
    );

    assert.deepEqual(
      result.picks.map((pick) => pick.id),
      [11, 22, 20, 31, 41, 51],
      'nothing after the in-progress episode, so the earliest unwatched one is next',
    );
  });

  it('asks once per show in progress', async () => {
    const secondShow = { ...IN_PROGRESS_EPISODE, episodeid: 31, tvshowid: 8, showtitle: 'Show B', season: 1, episode: 1 };
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetEpisodes': (params) =>
          params.tvshowid == null ? { episodes: [IN_PROGRESS_EPISODE, secondShow] } : { episodes: [NEXT_EPISODE] },
      }),
    );
    await makePicks(kodi, { now: NOW, limit: 10 });

    const lookups = methodsOnly(kodi.calls, 'VideoLibrary.GetEpisodes').filter((entry) => entry.params.tvshowid != null);
    assert.deepEqual(lookups.map((entry) => entry.params.tvshowid), [7, 8]);
  });

  it('scans episodes library-wide for progress, then per show for what is next', async () => {
    const kodi = stubKodi(happyLibrary());
    await makePicks(kodi, { now: NOW });

    const [scan, lookup] = methodsOnly(kodi.calls, 'VideoLibrary.GetEpisodes');
    assert.equal(scan.params.tvshowid, undefined, 'the in-progress scan is not tied to one show');
    assert.deepEqual(scan.params.filter, { field: 'playcount', operator: 'is', value: '0' });
    assert.equal(lookup.params.tvshowid, 7);
  });
});

describe('makePicks short-item rule', () => {
  it('keeps only unwatched movies that fit the evening budget', async () => {
    const kodi = stubKodi(
      happyLibrary({
        'VideoLibrary.GetMovies': (params) =>
          params.filter?.field === 'inprogress'
            ? { movies: [] }
            : {
                movies: [
                  { movieid: 91, title: 'Exactly Budget', runtime: 5400, playcount: 0, file: '/media/a.mkv' },
                  { movieid: 92, title: 'One Second Too Long', runtime: 5401, playcount: 0, file: '/media/b.mkv' },
                  { movieid: 93, title: 'No Runtime', runtime: 0, playcount: 0, file: '/media/c.mkv' },
                  { movieid: 94, title: 'Missing Runtime', playcount: 0, file: '/media/d.mkv' },
                  { movieid: 95, title: 'Short', runtime: 1200, playcount: 0, file: '/media/e.mkv' },
                ],
              },
      }),
    );
    const result = await makePicks(kodi, { now: NOW, limit: 10 });
    const shorts = result.picks.filter((pick) => pick.reason.endsWith('fits your evening'));

    assert.deepEqual(shorts.map((pick) => pick.id), [95, 91], 'shortest first, and only what fits');

    const scan = methodsOnly(kodi.calls, 'VideoLibrary.GetMovies').find(
      (entry) => entry.params.sort?.method === 'runtime',
    );
    assert.deepEqual(scan.params.filter, { field: 'playcount', operator: 'is', value: '0' });
    assert.deepEqual(scan.params.sort, { method: 'runtime', order: 'ascending' });
  });

  it('honours an explicit evening budget', async () => {
    const result = await makePicks(stubKodi(happyLibrary()), { now: NOW, eveningMinutes: 30 });
    const shorts = result.picks.filter((pick) => pick.reason.endsWith('fits your evening'));

    assert.deepEqual(shorts, [], 'the 60 minute movie no longer fits a 30 minute evening');
  });
});

describe('makePicks against the real mock Kodi', () => {
  /**
   * A minimal JSON-RPC transport over the mock, so makePicks is exercised
   * against real Kodi wire shapes rather than hand-written ones.
   *
   * @param {string} url
   * @returns {{rpc: {call: (method: string, params?: Record<string, any>) => Promise<any>}}}
   */
  function httpKodi(url) {
    let id = 0;
    const authorization = `Basic ${Buffer.from('kodi:kodi').toString('base64')}`;
    return {
      rpc: {
        async call(method, params = {}) {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          });
          const body = await response.json();
          if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
          return body.result;
        },
      },
    };
  }

  it('produces the contracted order from the mock library', async () => {
    const mock = await startMockKodi({ port: 0, user: 'kodi', password: 'kodi' });
    try {
      const result = await makePicks(httpKodi(mock.url), { now: NOW });

      assert.deepEqual(result.picks.map((pick) => `${pick.kind}:${pick.id}`), [
        'movie:2',
        'episode:101',
        'episode:102',
        'movie:1',
        'movie:4',
        'movie:3',
      ]);
      assert.deepEqual(result.skipped, []);
      assert.equal(result.picks[0].reason, "you're 5 minutes in");
    } finally {
      await mock.close();
    }
  });

  it('keeps going when one Kodi method errors on the wire', async () => {
    const mock = await startMockKodi({ port: 0, user: 'kodi', password: 'kodi' });
    try {
      mock.setFailMode({ kind: 'rpc-error', methods: ['VideoLibrary.GetRecentlyAddedMovies'], code: -32000, message: 'no library' });
      const result = await makePicks(httpKodi(mock.url), { now: NOW });

      assert.equal(`${result.picks[0].kind}:${result.picks[0].id}`, 'movie:2');
      assert.ok(result.picks.length >= 5, 'the rest of the list survived');
      assert.match(result.skipped.join(' '), /no library/);
    } finally {
      await mock.close();
    }
  });
});
