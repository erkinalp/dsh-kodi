/**
 * tests/service.test.mjs — KodiService behavior against tests/mock-kodi.mjs.
 *
 * Covers: start/stop lifecycle, the state cache (including the notification
 * WebSocket path with a real socket), library/search normalization, playback,
 * queue, transport, volume, remote, notifications, screenshots, the raw JSON-RPC
 * escape hatch the picks engine needs, and graceful degradation when Kodi is
 * down. No test is skipped and every case starts its own mock on an ephemeral
 * port, so the file is safe to run in parallel with the rest of the suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockKodi } from './mock-kodi.mjs';
import { KodiRpc, KodiRpcError } from '../src/rpc.mjs';
import { KodiService, normalizeItem } from '../src/kodi-service.mjs';

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `predicate` is truthy or the budget runs out.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @param {string} [what]
 * @returns {Promise<void>}
 */
async function waitUntil(predicate, timeoutMs = 3000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [what]
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, what = 'promise') {
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Start a mock Kodi plus a wired KodiService, and tear both down afterwards.
 * Polling is off by default so tests observe only the path they exercise.
 *
 * @param {import('node:test').TestContext} t
 * @param {{
 *   mock?: Parameters<typeof startMockKodi>[0],
 *   service?: Record<string, unknown>,
 * }} [options]
 * @returns {Promise<{
 *   kodi: Awaited<ReturnType<typeof startMockKodi>>,
 *   rpc: KodiRpc,
 *   service: KodiService,
 *   logs: string[],
 * }>}
 */
async function fixture(t, { mock = {}, service = {} } = {}) {
  const kodi = await startMockKodi(mock);
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'kodi', timeoutMs: 2000 });
  /** @type {string[]} */
  const logs = [];
  const kodiService = new KodiService({
    rpc,
    log: (level, message) => logs.push(`${level}: ${message}`),
    pollMs: 0,
    countsTtlMs: 60000,
    ...service,
  });
  t.after(async () => {
    await kodiService.stop();
    await kodi.close();
  });
  return { kodi, rpc, service: kodiService, logs };
}

/**
 * Assert a plain object graph carries no `undefined` value.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {void}
 */
function assertNoUndefined(value, path = 'value') {
  if (value === undefined) assert.fail(`${path} is undefined`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefined(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoUndefined(entry, `${path}.${key}`);
  }
}

test('start() pings, seeds the cache and reports library counts', async (t) => {
  const { service, kodi } = await fixture(t);

  const started = await service.start();
  assert.equal(started.ok, true);
  assert.equal(started.version, '21.3');
  assert.equal(started.apiVersion, null, 'Kodi 21 no longer exposes a JSON-RPC API version');
  assert.equal(service.connected, true);
  assert.equal(service.version, '21.3');

  const snapshot = service.snapshot();
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.playing, false);
  assert.equal(snapshot.item, null);
  assert.equal(snapshot.position, null);
  assert.equal(snapshot.speed, null);
  assert.equal(snapshot.volume, 62);
  assert.equal(snapshot.muted, false);
  assert.deepEqual(snapshot.queue, []);
  assert.deepEqual(snapshot.libraryCounts, { movies: 4, tvshows: 2, episodes: 3, artists: 2, albums: 2, songs: 3 });
  assert.match(String(snapshot.updatedAt), /^\d{4}-\d{2}-\d{2}T/);
  assertNoUndefined(snapshot, 'snapshot');

  assert.ok(kodi.findCalls('JSONRPC.Ping').length >= 1);
  assert.deepEqual(kodi.findCalls('Application.GetProperties')[0].params, { properties: ['version', 'name'] });
  assert.equal(kodi.findCalls('JSONRPC.GetVersion').length, 0, 'GetVersion must never be called');
});

test('a disconnected service still answers snapshot() with connected:false', async (t) => {
  const rpc = new KodiRpc({ url: 'http://127.0.0.1:1/jsonrpc', user: 'kodi', password: 'kodi', timeoutMs: 500 });
  const service = new KodiService({ rpc, pollMs: 0 });
  t.after(() => service.stop());

  const started = await service.start();
  assert.equal(started.ok, false);
  assert.match(String(started.error), /Kodi is not reachable/);
  assert.equal(service.connected, false);

  const snapshot = service.snapshot();
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.item, null);
  assert.deepEqual(snapshot.queue, []);
  assertNoUndefined(snapshot, 'disconnected snapshot');

  await assert.rejects(service.status(), (error) => {
    assert.ok(error instanceof KodiRpcError);
    assert.equal(error.kind, 'transport');
    return true;
  });
  assert.equal(service.snapshot().connected, false);
});

test('ping() reports the Kodi version and marks the service connected', async (t) => {
  const { service, kodi } = await fixture(t);
  const ping = await service.ping();
  assert.deepEqual(ping, { ok: true, version: '21.3', apiVersion: null });
  assert.equal(service.snapshot().connected, true);
  assert.equal(service.snapshot().version, '21.3');
  assert.equal(kodi.findCalls('Application.GetProperties')[0].params.properties.join(','), 'version,name');
});

test('ping() surfaces the real method-not-found error instead of hiding it', async (t) => {
  const { service, kodi } = await fixture(t, { mock: { failMode: { kind: 'rpc-error', methods: ['JSONRPC.Ping'], code: -32601, message: 'Method not found.' } } });
  await assert.rejects(service.ping(), (error) => {
    assert.equal(error.kind, 'rpc');
    assert.equal(error.code, -32601);
    return true;
  });
  assert.equal(service.snapshot().connected, false);
  assert.ok(kodi.findCalls('JSONRPC.Ping').length >= 1);
});

test('search() finds titles across the video and audio libraries', async (t) => {
  const { service } = await fixture(t);

  const { results } = await service.search('sint');
  assert.ok(results.length >= 1);
  assert.equal(results[0].kind, 'movie');
  assert.equal(results[0].label, 'Sintel');
  assert.equal(results[0].id, 2);
  assert.equal(results[0].year, 2010);
  assert.equal(results[0].runtime, 888);
  assert.equal(results[0].thumbnail, 'image://https%3a//example.test/sintel.jpg/');
  assert.ok(results[0].extra.length > 0);
  assertNoUndefined(results, 'search results');

  const episodes = await service.search('earth', { kinds: ['episode'] });
  assert.equal(episodes.results[0].kind, 'episode');
  assert.equal(episodes.results[0].extra, 'Pioneer One · S01E01');

  const artists = await service.search('nine inch', { kinds: ['artist'] });
  assert.equal(artists.results[0].kind, 'artist');
  assert.equal(artists.results[0].label, 'Nine Inch Nails');

  const songs = await service.search('999', { kinds: ['song'] });
  assert.equal(songs.results[0].label, '999,999');

  const limited = await service.search('e', { limit: 2 });
  assert.ok(limited.results.length <= 2);
});

test('search() ranks prefix matches first and short-circuits an empty query', async (t) => {
  const { service, kodi } = await fixture(t);

  const before = kodi.calls.length;
  assert.deepEqual(await service.search('   '), { results: [] });
  assert.equal(kodi.calls.length, before, 'an empty query must not hit Kodi');

  // "s" is a prefix of "Sintel" and appears mid-word in the other titles;
  // alphabetical order alone would put "Elephants Dream" first.
  const { results } = await service.search('s', { kinds: ['movie'] });
  assert.equal(results[0].label, 'Sintel', 'a prefix match must outrank a mid-word match');
  assert.ok(results.some((entry) => entry.label === 'Elephants Dream'));
  assert.ok(results.some((entry) => entry.label === 'Tears of Steel'));
});

test('search() falls back to local matching when Kodi rejects the filter', async (t) => {
  const { service, kodi } = await fixture(t);
  kodi.setState({ rejectFilters: true });

  const { results } = await service.search('bunny', { kinds: ['movie'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'Big Buck Bunny');
  assert.ok(kodi.findCalls('VideoLibrary.GetMovies').length >= 2, 'the unfiltered fallback must have been tried');
});

test('library() lists, filters and reports limits/total', async (t) => {
  const { service } = await fixture(t);

  const all = await service.library('movies', { sort: 'title' });
  assert.equal(all.total, 4);
  assert.equal(all.items.length, 4);
  assert.deepEqual(all.limits, { start: 0, end: 4, total: 4 });
  assert.deepEqual(
    all.items.map((item) => item.label),
    ['Big Buck Bunny', 'Elephants Dream', 'Sintel', 'Tears of Steel'],
  );
  assertNoUndefined(all.items, 'library items');

  const filtered = await service.library('movies', { filter: 'sintel' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, 2);
  assert.equal(filtered.items[0].kind, 'movie');

  const page = await service.library('episodes', { limit: 2, start: 1 });
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.limits, { start: 1, end: 3, total: 3 });

  const counts = await service.library('songs', { forceUnused: true });
  assert.equal(counts.total, 3);
});

test('library() maps unsupported sorts and rejects unknown kinds', async (t) => {
  const { service, kodi } = await fixture(t);

  // songs do not accept "sorttitle"; the service must fall back to "title".
  const songs = await service.library('songs', { sort: 'sorttitle' });
  assert.equal(songs.items.length, 3);
  const [songCall] = kodi.findCalls('AudioLibrary.GetSongs');
  assert.equal(songCall.params.sort.method, 'title');

  await assert.rejects(service.library('podcasts'), RangeError);
});

test('play() opens a library item, a file, or appends to the queue', async (t) => {
  const { service, kodi } = await fixture(t);

  const played = await service.play({ kind: 'movie', id: 1 });
  assert.deepEqual(played, { ok: true, playing: true });
  assert.deepEqual(kodi.findCalls('Player.Open')[0].params.item, { movieid: 1 });

  const snapshot = service.snapshot();
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.playing, true);
  assert.equal(snapshot.speed, 1);
  assert.equal(snapshot.position, 1, 'queue positions are 1-based');
  assert.equal(snapshot.item?.id, 1);
  assert.equal(snapshot.item?.kind, 'movie');
  assert.equal(snapshot.item?.title, 'Big Buck Bunny');
  assert.equal(snapshot.item?.runtime, 596);
  assert.equal(snapshot.item?.year, 2008);
  assertNoUndefined(snapshot.item, 'playing item');

  await service.play({ file: '/media/movies/extra.mkv' });
  assert.deepEqual(kodi.findCalls('Player.Open')[1].params.item, { file: '/media/movies/extra.mkv' });

  const queued = await service.play({ kind: 'song', id: 2 }, { queue: true });
  assert.deepEqual(queued, { ok: true, playing: true, queued: true, playlistid: 0 });
  assert.deepEqual(kodi.findCalls('Playlist.Add')[0].params, { playlistid: 0, item: { songid: 2 } });

  await assert.rejects(service.play({ kind: 'podcast', id: 1 }), RangeError);
  await assert.rejects(service.play({}), RangeError);
});

test('queueList() and queue() drive the playlist', async (t) => {
  const { service, kodi } = await fixture(t);

  const added = await service.queue('add', { items: [{ kind: 'movie', id: 1 }, { kind: 'movie', id: 2 }] });
  assert.equal(added.length, 2);
  assert.equal(added.playlistid, 1);
  assert.deepEqual(kodi.findCalls('Playlist.Add').map((call) => call.params.item), [{ movieid: 1 }, { movieid: 2 }]);

  const list = await service.queueList();
  assert.deepEqual(list.items.map((item) => item.id), [1, 2]);
  assert.equal(list.current, null);
  assert.equal(list.items[0].kind, 'movie');

  // 1-based: insert before item 1 and jump to item 2.
  const inserted = await service.queue('insert', { items: [{ kind: 'movie', id: 4 }], position: 1 });
  assert.equal(inserted.length, 3);
  assert.deepEqual((await service.queueList()).items.map((item) => item.id), [4, 1, 2]);

  const jumped = await service.queue('jump', { position: 2 });
  assert.equal(jumped.current, 2);
  assert.deepEqual(kodi.findCalls('Player.Open')[0].params.item, { playlistid: 1, position: 1 });
  assert.equal(service.snapshot().playing, true);
  assert.equal(service.snapshot().position, 2);

  const removed = await service.queue('remove', { position: 1 });
  assert.equal(removed.length, 2);
  await assert.rejects(service.queue('remove', { position: 0 }), RangeError);

  const cleared = await service.queue('clear');
  assert.equal(cleared.length, 0);
  assert.deepEqual((await service.queueList()).items, []);

  await assert.rejects(service.queue('shuffle'), RangeError);
  await assert.rejects(service.queue('jump', {}), RangeError);
});

test('transport() play/pause/seek/skip/speed and its no-player behaviour', async (t) => {
  const { service, kodi } = await fixture(t);

  // Nothing loaded: pause/stop are no-ops, seek/skip/speed are typed errors.
  assert.deepEqual(await service.transport('pause'), { ok: true, playing: false, position: null, speed: null });
  assert.deepEqual(await service.transport('stop'), { ok: true, playing: false, position: null, speed: null });
  await assert.rejects(service.transport('seek', { value: 10 }), (error) => {
    assert.ok(error instanceof KodiRpcError);
    assert.equal(error.kind, 'rpc');
    assert.equal(error.code, 'ENOPLAYER');
    assert.equal(error.message, 'Nothing is playing on the TV.');
    return true;
  });
  await assert.rejects(service.transport('dance'), RangeError);

  await service.play({ kind: 'movie', id: 1 });
  await service.play({ kind: 'movie', id: 2 }, { queue: true });

  const paused = await service.transport('playpause');
  assert.equal(paused.playing, false);
  assert.equal(paused.speed, 0);

  const resumed = await service.transport('playpause');
  assert.equal(resumed.playing, true);
  assert.equal(resumed.speed, 1);

  assert.equal((await service.transport('pause')).playing, false);
  assert.equal((await service.transport('play')).playing, true);

  await service.transport('seek', { value: 100 });
  assert.equal(service.snapshot().percentage, 16.8);
  assert.equal(kodi.findCalls('Player.Seek')[0].params.value.seconds, 100);

  await service.transport('seek', { value: '25%' });
  assert.equal(service.snapshot().percentage, 25);

  await service.transport('seek', { value: { step: 'smallforward' } });
  assert.ok(service.snapshot().percentage > 25);

  // The model-facing contract: "skip 30 seconds" is a relative jump.
  // Before this the position is 25% of 596s plus one 10s step = 159s.
  await service.transport('skip', { value: 30 });
  assert.equal(kodi.findCalls('Player.Seek').at(-1).params.value.seconds, 189);
  assert.equal(service.snapshot().percentage, 31.7);

  await service.transport('skip', { value: -10 });
  assert.equal(kodi.findCalls('Player.Seek').at(-1).params.value.seconds, 179);
  assert.equal(service.snapshot().percentage, 30);

  // Strings still change queue item.
  await service.transport('skip', { value: 'next' });
  assert.equal(service.snapshot().position, 2);
  assert.equal(kodi.findCalls('Player.GoTo').at(-1).params.to, 'next');

  await service.transport('skip', { value: 'previous' });
  assert.equal(service.snapshot().position, 1);
  assert.equal(kodi.findCalls('Player.GoTo').at(-1).params.to, 'previous');

  await service.transport('speed', { value: 2 });
  assert.equal(service.snapshot().speed, 2);

  await assert.rejects(service.transport('seek', { value: 'sideways' }), RangeError);
  await assert.rejects(service.transport('speed'), RangeError);
  assert.equal((await service.transport('stop')).playing, false);
});

test('volume() sets, nudges, mutes, toggles and clamps', async (t) => {
  const { service, kodi } = await fixture(t);

  assert.deepEqual(await service.volume({ set: 30 }), { volume: 30, muted: false });
  assert.equal(kodi.state.volume, 30);

  assert.deepEqual(await service.volume({ delta: 5 }), { volume: 35, muted: false });

  assert.deepEqual(await service.volume({ mute: true }), { volume: 35, muted: true });
  assert.deepEqual(await service.volume({ mute: 'toggle' }), { volume: 35, muted: false });

  assert.deepEqual(await service.volume({ set: 500 }), { volume: 100, muted: false });
  assert.deepEqual(await service.volume({ set: -20 }), { volume: 0, muted: false });
  assert.equal(service.snapshot().volume, 0);
});

test('remote() sends D-pad keys, Kodi actions and text', async (t) => {
  const { service, kodi } = await fixture(t);

  assert.deepEqual(await service.remote('up'), { ok: true, action: 'up' });
  assert.deepEqual(await service.remote('select'), { ok: true, action: 'select' });
  assert.deepEqual(await service.remote('back'), { ok: true, action: 'back' });
  assert.deepEqual(await service.remote('context'), { ok: true, action: 'context' });
  assert.deepEqual(await service.remote('key', { value: 'screenshot' }), { ok: true, action: 'key', executed: 'screenshot' });
  assert.deepEqual(await service.remote('sendtext', { value: 'hello' }), { ok: true, action: 'sendtext' });

  assert.deepEqual(
    kodi.state.inputCalls.map((call) => call.method),
    ['Input.Up', 'Input.Select', 'Input.Back', 'Input.ContextMenu', 'Input.ExecuteAction', 'Input.SendText'],
  );
  assert.equal(kodi.state.inputCalls.at(-1).params.text, 'hello');

  await assert.rejects(service.remote('teleport'), RangeError);
  await assert.rejects(service.remote('key'), RangeError);
});

test('notify() shows a Kodi notification with milliseconds display time', async (t) => {
  const { service, kodi } = await fixture(t);

  assert.deepEqual(await service.notify({ title: 'Hi', message: 'There', time: 5 }), { ok: true });
  assert.deepEqual(kodi.state.notifications[0], { title: 'Hi', message: 'There', displaytime: 5000, at: kodi.state.notifications[0].at });

  await service.notify({ message: 'no title' });
  assert.equal(kodi.state.notifications[1].title, 'DeepSeek Harness');
  assert.equal(kodi.state.notifications[1].displaytime, undefined);
});

test('screenshot() triggers the action and locates the newest file', async (t) => {
  const { service, kodi } = await fixture(t);

  const shot = await service.screenshot();
  assert.equal(shot.path, 'special://temp/screenshot0001.png');
  assert.ok(shot.file?.startsWith(`http://127.0.0.1:${kodi.port}/vfs/`));
  assert.ok(shot.file?.includes('screenshot0001.png'));
  assert.deepEqual(kodi.findCalls('Input.ExecuteAction')[0].params, { action: 'screenshot' });
});

test('the notification socket refreshes the snapshot, and unsubscribe stops delivery', async (t) => {
  const { kodi, service } = await fixture(t, {
    service: { pollMs: 0, debounceMs: 20, notificationUrl: undefined },
  });
  // notificationUrl is derived from the rpc client's WebSocket URL, so the
  // default code path (rpc endpoint → ws://) is what gets exercised here.
  await service.start();
  await waitUntil(() => kodi.clientCount() === 1, 3000, 'the notification socket to connect');

  /** @type {Array<Record<string, any>>} */
  const events = [];
  /** @type {() => void} */
  let unsubscribe = () => {};
  const episode = kodi.state.library.episodes[0];
  const playingEpisode = new Promise((resolve) => {
    unsubscribe = service.onState((snapshot) => {
      events.push(snapshot);
      if (snapshot.playing && snapshot.item?.label === episode.label) resolve(snapshot);
    });
  });

  // The TV starts an episode; Kodi announces it and the service catches up.
  kodi.state.playlists[1] = [{ ...episode, id: episode.episodeid, type: 'episode' }];
  kodi.state.activePlayers = [{ playerid: 1, type: 'video', speed: 1, position: 0, positionSeconds: 120 }];
  const changesBefore = kodi.findCalls('Player.GetActivePlayers').length;
  kodi.emit('Player.OnPlay', { data: { item: { type: 'episode', id: episode.episodeid } } });

  const snapshot = /** @type {any} */ (await withTimeout(playingEpisode, 3000, 'a notification-driven snapshot'));
  assert.equal(snapshot.playing, true);
  assert.equal(snapshot.item.title, 'Earth');
  assert.equal(snapshot.item.kind, 'episode');
  assert.equal(snapshot.item.show, 'Pioneer One');
  assert.equal(snapshot.item.season, 1);
  assert.equal(snapshot.item.episode, 1);
  assert.equal(snapshot.playerType, 'video');
  assert.equal(snapshot.position, 1, 'the first queue item is position 1');
  assert.equal(snapshot.percentage, 6.7);
  assert.equal(snapshot.queue.length, 1);
  assert.ok(kodi.findCalls('Player.GetActivePlayers').length > changesBefore, 'the notification must have caused a refresh');

  // Unsubscribe: further notifications refresh Kodi but reach no listener.
  unsubscribe();
  const delivered = events.length;
  kodi.state.activePlayers = [];
  const polled = kodi.findCalls('Player.GetActivePlayers').length;
  kodi.emit('Player.OnStop', { data: {} });
  await waitUntil(() => kodi.findCalls('Player.GetActivePlayers').length > polled, 3000, 'the post-unsubscribe refresh');
  await sleep(100);
  assert.equal(events.length, delivered, 'an unsubscribed listener must not receive snapshots');
});

test('stop() closes the notification socket and marks the service disconnected', async (t) => {
  const { kodi, service } = await fixture(t, { service: { pollMs: 0, debounceMs: 10 } });
  await service.start();
  await waitUntil(() => kodi.clientCount() === 1, 3000, 'the notification socket to connect');

  await service.stop();
  await waitUntil(() => kodi.clientCount() === 0, 3000, 'the notification socket to close');
  assert.equal(service.snapshot().connected, false);

  // Idempotent, and it must not throw when already stopped.
  await service.stop();
  assert.equal(service.snapshot().connected, false);
});

test('the raw JSON-RPC escape hatch serves the picks engine', async (t) => {
  const { service, rpc } = await fixture(t);
  assert.equal(service.rpc, rpc, 'the raw client is exposed for method-level calls');

  // GetInProgress* are gone from Kodi 21; picks use the virtual filter instead.
  await assert.rejects(service.call('VideoLibrary.GetInProgressMovies'), (error) => {
    assert.equal(error.kind, 'rpc');
    assert.equal(error.code, -32601);
    return true;
  });
  const inProgress = await service.call('VideoLibrary.GetMovies', {
    properties: ['title', 'resume', 'playcount'],
    filter: { field: 'inprogress', operator: 'is', value: 'true' },
  });
  assert.equal(inProgress.movies.length, 1);
  assert.equal(inProgress.movies[0].movieid, 2);
  assert.equal(inProgress.movies[0].resume.position, 300);
  assert.equal(inProgress.movies[0].resume.total, 888);

  const episodes = await service.call('VideoLibrary.GetEpisodes', {
    tvshowid: 1,
    filter: { field: 'playcount', operator: 'is', value: '0' },
  });
  assert.deepEqual(episodes.episodes.map((row) => row.episodeid), [101, 102]);

  const unwatched = await service.call('VideoLibrary.GetMovies', {
    filter: { field: 'playcount', operator: 'is', value: '0' },
    sort: { method: 'runtime', order: 'ascending' },
  });
  assert.deepEqual(unwatched.movies.map((row) => row.movieid), [1, 4, 2]);
  assert.deepEqual(unwatched.movies.map((row) => row.runtime), [596, 654, 888]);

  await assert.rejects(service.call('VideoLibrary.GetNothing'), (error) => {
    assert.equal(error.kind, 'rpc');
    assert.equal(error.code, -32601);
    return true;
  });
});

test('status() throws a typed error when Kodi dies, and the cache goes disconnected', async (t) => {
  const { service, kodi } = await fixture(t, { service: { pollMs: 0 } });
  await service.start();
  assert.equal(service.snapshot().connected, true);

  kodi.setFailMode('destroy');
  await assert.rejects(service.status(), (error) => {
    assert.ok(error instanceof KodiRpcError);
    assert.equal(error.kind, 'transport');
    return true;
  });
  assert.equal(service.snapshot().connected, false);
  assert.equal(service.snapshot().playing, false);
});

test('play() does not report success before a player actually exists', async (t) => {
  const { service, kodi } = await fixture(t, { service: { startupWait: { attempts: 3, delayMs: 10 } } });
  kodi.setState({ silentOpen: true }); // Player.Open answers "OK", no player ever appears

  const played = await service.play({ kind: 'movie', id: 1 });
  assert.deepEqual(played, {
    ok: false,
    playing: false,
    error: 'Kodi accepted the request, but no player started on the TV.',
  });
  assert.equal(service.snapshot().playing, false);
  assert.equal(service.snapshot().item, null);
  assert.ok(kodi.findCalls('Player.GetActivePlayers').length >= 3, 'play() must poll for the player');
});

test('play() waits for a late player and for the new item, not the previous one', async (t) => {
  const { service, kodi } = await fixture(t, { service: { startupWait: { attempts: 20, delayMs: 25 } } });
  // Measured live: Open returns before the player exists, and GetItem can still
  // answer with the previous/empty item for the first read.
  kodi.setState({ deferPlayerMs: 80, staleItemReads: 1 });

  const played = await service.play({ kind: 'movie', id: 2 });
  assert.deepEqual(played, { ok: true, playing: true });
  const snapshot = service.snapshot();
  assert.equal(snapshot.playing, true);
  assert.equal(snapshot.item?.id, 2);
  assert.equal(snapshot.item?.title, 'Sintel');
  assert.equal(kodi.state.staleItem.remaining, 0, 'the stale item read was consumed');
});

test('play() with queue:true stays successful while the TV is idle', async (t) => {
  const { service } = await fixture(t, { service: { startupWait: { attempts: 1, delayMs: 0 } } });
  const queued = await service.play({ kind: 'movie', id: 3 }, { queue: true });
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  assert.equal(service.snapshot().item, null, 'queueing must not pretend something is playing');
});

test('seek() returns the post-seek state even when Kodi still reports the old one', async (t) => {
  const { service, kodi } = await fixture(t);
  await service.play({ kind: 'movie', id: 1 }); // 596 s
  kodi.setState({ staleSeekReads: 2 }); // the first two reads after the seek are stale

  await service.transport('seek', { value: 100 });

  assert.equal(service.snapshot().percentage, 16.8, 'the pre-seek 0% must not survive');
  assert.equal(service.snapshot().position, 1);
  assert.equal(kodi.state.staleSeek.remaining, 0, 'the service polled past the stale reads');

  // A relative skip settles the same way.
  kodi.setState({ staleSeekReads: 1 });
  await service.transport('skip', { value: 60 });
  assert.equal(service.snapshot().percentage, 26.8);
});

test('Kodi -32100 on a player command reads as a sentence, not a number', async (t) => {
  const { service, kodi } = await fixture(t);
  await service.play({ kind: 'movie', id: 1 });
  kodi.setFailMode({ kind: 'rpc-error', methods: ['Player.Seek'], code: -32100, message: 'Failed to execute method' });

  await assert.rejects(service.transport('seek', { value: 30 }), (error) => {
    assert.ok(error instanceof KodiRpcError);
    assert.equal(error.message, 'Nothing is playing on the TV.');
    assert.equal(error.kind, 'rpc', 'the wire kind is kept for logs');
    assert.equal(error.code, -32100, 'the wire code is kept for logs');
    assert.equal(error.method, 'Player.Seek');
    return true;
  });
});

test('play({playlistid, position}) also takes a 1-based position', async (t) => {
  const { service, kodi } = await fixture(t);
  // Queue two movies, then ask for the second one by its 1-based position.
  await service.queue('add', { items: [{ kind: 'movie', id: 1 }, { kind: 'movie', id: 2 }] });
  const played = await service.play({ playlistid: 1, position: 2 });
  assert.equal(played.ok, true);
  assert.deepEqual(kodi.findCalls('Player.Open').at(-1).params.item, { playlistid: 1, position: 1 });
  assert.equal(service.snapshot().item?.id, 2);
});

test('queue jump converts the 1-based position to Kodi 0-based to/position', async (t) => {
  const { service, kodi } = await fixture(t);
  await service.play({ kind: 'movie', id: 1 }); // queue: [1]
  await service.queue('add', { items: [{ kind: 'movie', id: 2 }, { kind: 'movie', id: 3 }] }); // [1,2,3]

  kodi.setState({ staleItemReads: 1 }); // GoTo updates the index before the item
  const jumped = await service.queue('jump', { position: 2 });

  assert.equal(jumped.current, 2);
  assert.deepEqual(kodi.findCalls('Player.GoTo').at(-1).params, { playerid: 1, to: 1 });
  assert.equal(service.snapshot().position, 2);
  assert.equal(service.snapshot().item?.id, 2, 'the snapshot shows the item GoTo actually selected');
  assert.equal(kodi.state.staleItem.remaining, 0);
});

test('normalizeItem() turns Kodi -1 sentinels into null', () => {
  // Measured live: a movie row carries season:-1, episode:-1.
  const movie = normalizeItem({ movieid: 1, label: 'Clock Face', title: 'Clock Face', year: 2017, runtime: 60, season: -1, episode: -1, type: 'movie' });
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.season, null);
  assert.equal(movie.episode, null);
  assert.equal(movie.year, 2017);
  assert.equal(movie.runtime, 60);

  const unknownYear = normalizeItem({ movieid: 2, label: 'Untitled', year: 0, runtime: -1 });
  assert.equal(unknownYear.year, null, 'year 0 means "unknown" in Kodi');
  assert.equal(unknownYear.runtime, null);

  const episode = normalizeItem({ episodeid: 101, title: 'Earth', showtitle: 'Pioneer One', season: 1, episode: 2, runtime: 1800, type: 'episode' });
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.season, 1);
  assert.equal(episode.episode, 2);
  assert.equal(episode.show, 'Pioneer One');

  const negativeId = normalizeItem({ movieid: -1, label: 'Nothing' });
  assert.equal(negativeId.id, null);
});

test('normalizeItem() fills every field with null instead of undefined', () => {
  const empty = normalizeItem(null);
  assert.deepEqual(Object.keys(empty).sort(), [
    'episode',
    'file',
    'id',
    'kind',
    'label',
    'runtime',
    'season',
    'show',
    'subtitle',
    'thumbnail',
    'title',
    'year',
  ]);
  assertNoUndefined(empty, 'empty item');
  assert.ok(Object.values(empty).every((value) => value === null));

  const movie = normalizeItem(
    {
      movieid: 7,
      label: 'Arrival',
      title: 'Arrival',
      year: 2016,
      runtime: 6960,
      art: { poster: 'image://poster/', thumb: 'image://thumb/' },
      file: '/movies/arrival.mkv',
    },
    'movie',
  );
  assert.equal(movie.id, 7);
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.runtime, 6960);
  assert.equal(movie.thumbnail, 'image://thumb/');
  assert.equal(movie.show, null);
  assert.equal(movie.season, null);
  assert.equal(movie.subtitle, null);

  const episode = normalizeItem({ episodeid: 9, title: 'Pilot', showtitle: 'Show', season: 1, episode: 2, runtime: 42 }, 'episode');
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.subtitle, 'Show');
  assert.equal(episode.show, 'Show');
  assert.equal(episode.season, 1);
  assert.equal(episode.episode, 2);

  const song = normalizeItem({ songid: 3, label: 'Track', duration: 200, artist: ['A', 'B'], album: 'LP' }, 'song');
  assert.equal(song.runtime, 200, 'song duration is exposed as runtime seconds');
  assert.equal(song.subtitle, 'LP');
});
