/**
 * @file Spec for the TV bridge (`src/bridge.mjs`).
 *
 * Everything here goes over real HTTP against a server bound to `127.0.0.1:0`,
 * so the tests exercise the same framing, headers and status codes the Kodi
 * add-on and the Web panel will see. The Kodi service itself is a recording
 * stub: the bridge only ever touches `snapshot`, `transport` and `volume`, and a
 * stub is what lets one test make `snapshot()` throw on purpose.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { startBridge } from '../src/bridge.mjs';

/** The panel origin every CORS assertion is about. */
const PANEL = 'http://127.0.0.1:3080';

/** A token used by the authenticated suites. */
const TOKEN = 'correct-horse-battery-staple';

/** Two picks, in the shape `makePicks` produces. */
const PICKS = [
  { id: 11, kind: 'movie', title: 'Sintel', reason: "you're 5 minutes in", runtime: 888, resumeAt: 300, thumbnail: 'image://sintel/' },
  { id: 21, kind: 'episode', title: 'Pioneer One - Earth (S01E01)', reason: 'next unwatched episode of Pioneer One', runtime: 1800, resumeAt: null, thumbnail: null },
];

/** A playing snapshot, in the shape `KodiService.snapshot()` promises. */
function playingSnapshot() {
  return {
    connected: true,
    version: '20.5.0',
    updatedAt: '2026-03-10T18:00:00.000Z',
    playing: true,
    item: {
      id: 2,
      kind: 'movie',
      label: 'Sintel',
      title: 'Sintel',
      subtitle: null,
      year: 2010,
      runtime: 888,
      thumbnail: 'image://sintel/',
      file: '/media/movies/sintel.mkv',
      show: null,
      season: null,
      episode: null,
    },
    position: 300,
    speed: 1,
    volume: 40,
    muted: false,
    queue: [{ id: 2, kind: 'movie', label: 'Sintel', title: 'Sintel' }],
    libraryCounts: { movies: 4, episodes: 3 },
  };
}

/**
 * A recording `KodiService` stub.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function stubKodi(overrides = {}) {
  /** @type {Array<unknown[]>} */
  const calls = [];
  return {
    calls,
    connected: true,
    version: '20.5.0',
    snapshot: () => playingSnapshot(),
    play: async (target) => {
      calls.push(['play', target]);
      return { ok: true, playing: true };
    },
    transport: async (action, options) => {
      calls.push(['transport', action, options]);
      return { ok: true, playing: true, position: 300, speed: 1 };
    },
    volume: async (options) => {
      calls.push(['volume', options]);
      return { volume: 42, muted: false };
    },
    ...overrides,
  };
}

/**
 * Start a bridge, run the body, always shut the server down.
 *
 * @param {Record<string, any>} options
 * @param {(context: {bridge: {url: string, port: number, close: Function}, state: Record<string, any>, kodi: any}) => Promise<void>} run
 * @returns {Promise<void>}
 */
async function withBridge(options, run) {
  const state = options.state ?? {};
  const kodi = options.kodi ?? stubKodi();
  const bridge = await startBridge({
    config: { bridgeBind: '127.0.0.1', bridgePort: 0, panelOrigin: PANEL, ...options.config },
    kodi,
    picks: 'picks' in options ? options.picks : () => ({ picks: PICKS }),
    deliver: 'deliver' in options ? options.deliver : async () => ({ id: 'msg-1', sessionId: 'sess-1' }),
    log: null,
    state,
  });
  try {
    await run({ bridge, state, kodi });
  } finally {
    await bridge.close();
  }
}

/**
 * @param {{url: string}} bridge
 * @param {string} path
 * @param {Record<string, string>} [headers]
 */
function get(bridge, path, headers = {}) {
  return fetch(`${bridge.url}${path}`, { headers });
}

/**
 * @param {{url: string}} bridge
 * @param {string} path
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function post(bridge, path, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return fetch(`${bridge.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });
}

describe('startBridge binding and security', () => {
  it('binds an ephemeral port on loopback and reports the real port', async () => {
    await withBridge({}, async ({ bridge }) => {
      assert.equal(bridge.bind, '127.0.0.1');
      assert.ok(bridge.port > 0, 'port 0 resolves to a real port');
      assert.equal(bridge.url, `http://127.0.0.1:${bridge.port}`);

      const response = await get(bridge, '/health');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);

      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['bridge', 'kodi', 'ok']);
      assert.equal(body.ok, true);
      assert.deepEqual(body.kodi, { connected: true, version: '20.5.0' });
      assert.equal(body.bridge.port, bridge.port);
      assert.equal(body.bridge.authed, false);
    });
  });

  it('refuses a non-loopback bind without a token', async () => {
    for (const bind of ['0.0.0.0', '192.168.1.50', '::', '10.0.0.1']) {
      await assert.rejects(
        startBridge({
          config: { bridgeBind: bind, bridgePort: 0 },
          kodi: stubKodi(),
          picks: () => ({ picks: PICKS }),
          state: {},
        }),
        (error) => {
          assert.equal(error.code, 'E_BRIDGE_INSECURE');
          assert.match(error.message, /bridgeToken/, 'the message names the setting that fixes it');
          assert.match(error.message, /127\.0\.0\.1/, 'the message names the alternative');
          return true;
        },
        `bind ${JSON.stringify(bind)} must be refused`,
      );
    }
  });

  it('treats an unset bind as loopback rather than as "everything"', async () => {
    // `''` is what an unset setting looks like; it must land on 127.0.0.1, not
    // on a wildcard, or the guard above would be trivially bypassed.
    const bridge = await startBridge({
      config: { bridgeBind: '', bridgePort: 0 },
      kodi: stubKodi(),
      picks: () => ({ picks: PICKS }),
      state: {},
    });
    try {
      assert.equal(bridge.bind, '127.0.0.1');
      assert.equal((await get(bridge, '/health')).status, 200, 'no token needed, because it is loopback');
    } finally {
      await bridge.close();
    }
  });

  it('accepts a non-loopback bind once a token is configured', async () => {
    const bridge = await startBridge({
      config: { bridgeBind: '0.0.0.0', bridgePort: 0, bridgeToken: TOKEN },
      kodi: stubKodi(),
      picks: () => ({ picks: PICKS }),
      state: {},
    });
    try {
      assert.ok(bridge.port > 0);
      const response = await fetch(`http://127.0.0.1:${bridge.port}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).bridge.authed, true);
    } finally {
      await bridge.close();
    }
  });

  it('demands the token as a header, and treats missing and wrong alike', async () => {
    await withBridge({ config: { bridgeToken: TOKEN } }, async ({ bridge }) => {
      const missing = await get(bridge, '/health');
      const wrong = await get(bridge, '/health', { authorization: 'Bearer not-the-token' });
      assert.equal(missing.status, 401);
      assert.equal(wrong.status, 401);
      assert.deepEqual(await missing.json(), await wrong.json(), 'no oracle distinguishing a wrong token from an absent one');
      assert.match(missing.headers.get('www-authenticate') ?? '', /Bearer/);

      assert.equal((await get(bridge, '/health', { authorization: `Bearer ${TOKEN}` })).status, 200);
      assert.equal((await get(bridge, '/health', { 'x-bridge-token': TOKEN })).status, 200);
      assert.equal((await get(bridge, '/health', { authorization: `Bearer ${TOKEN}x` })).status, 401);

      // Tokens must not travel in a URL: they end up in logs and history.
      assert.equal((await get(bridge, `/health?token=${TOKEN}`)).status, 401);
      assert.equal((await get(bridge, '/health', { authorization: TOKEN })).status, 401, 'the scheme is required');
    });
  });

  it('answers CORS preflight for the configured panel origin only', async () => {
    await withBridge({ config: { bridgeToken: TOKEN } }, async ({ bridge }) => {
      const preflight = await fetch(`${bridge.url}/tv/ask`, {
        method: 'OPTIONS',
        headers: {
          origin: PANEL,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, authorization',
        },
      });
      assert.equal(preflight.status, 200, 'preflight works without a token, as browsers never send one');
      assert.equal(preflight.headers.get('access-control-allow-origin'), PANEL);
      assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
      assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), null, 'no cookie sharing');
    });
  });

  it('echoes CORS only for the configured origin, and keeps 401s readable', async () => {
    await withBridge({ config: { bridgeToken: TOKEN } }, async ({ bridge }) => {
      const allowed = await get(bridge, '/tv/state', { origin: PANEL, authorization: `Bearer ${TOKEN}` });
      assert.equal(allowed.headers.get('access-control-allow-origin'), PANEL);
      assert.equal(allowed.headers.get('vary'), 'Origin');

      const foreign = await get(bridge, '/tv/state', { origin: 'http://evil.test', authorization: `Bearer ${TOKEN}` });
      assert.equal(foreign.headers.get('access-control-allow-origin'), null);

      const unauthorized = await get(bridge, '/tv/state', { origin: PANEL });
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers.get('access-control-allow-origin'), PANEL, 'the panel can read why it failed');
    });
  });
});

describe('POST /tv/ask one-at-a-time contract', () => {
  it('asks, refuses a second ask with the pending id, then accepts after the reply', async () => {
    /** @type {Array<{text: string, meta: any}>} */
    const delivered = [];
    await withBridge(
      {
        state: {},
        deliver: async (text, meta) => {
          delivered.push({ text, meta });
          return { id: `ask-${delivered.length}`, sessionId: 'sess-1' };
        },
      },
      async ({ bridge, state }) => {
        const first = await post(bridge, '/tv/ask', { text: '  what should I watch?  ' });
        assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), { ok: true, id: 'ask-1', sessionId: 'sess-1' });
        assert.deepEqual(delivered[0], { text: 'what should I watch?', meta: { origin: 'tv' } });
        assert.equal(state.pendingAsk.id, 'ask-1');
        assert.equal(state.pendingAsk.text, 'what should I watch?');
        assert.equal(typeof state.pendingAsk.at, 'string');
        assert.match(state.pendingAsk.at, /^\d{4}-\d{2}-\d{2}T/);

        const second = await post(bridge, '/tv/ask', { text: 'and now?' });
        assert.equal(second.status, 429);
        const refused = await second.json();
        assert.equal(refused.ok, false);
        assert.equal(refused.pendingId, 'ask-1', 'the refusal names the ask that is still open');
        assert.equal(refused.pending.id, 'ask-1');
        assert.equal(delivered.length, 1, 'the refused ask never reached the agent');

        // The harness delivery wiring answers by publishing the reply and
        // releasing the ask; the bridge reads both, it does not invent them.
        state.lastReply = { id: 'ask-1', text: 'Sintel is already 5 minutes in.', at: '2026-03-10T18:00:05.000Z' };
        state.pendingAsk = null;

        const reply = await (await get(bridge, '/tv/reply?after=ask-1')).json();
        assert.deepEqual(reply.reply, { id: 'ask-1', text: 'Sintel is already 5 minutes in.', at: '2026-03-10T18:00:05.000Z' });

        const third = await post(bridge, '/tv/ask', { text: 'thanks' });
        assert.equal(third.status, 200);
        assert.equal((await third.json()).id, 'ask-2');
      },
    );
  });

  it('reserves the ask before delivery, so two asks cannot both reach the agent', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await withBridge(
      {
        deliver: async () => {
          calls += 1;
          await gate;
          return { id: 'ask-slow' };
        },
      },
      async ({ bridge }) => {
        const first = post(bridge, '/tv/ask', { text: 'first' });
        await new Promise((resolve) => setTimeout(resolve, 40));
        const second = await post(bridge, '/tv/ask', { text: 'second' });
        assert.equal(second.status, 429, 'the in-flight ask already occupies the slot');

        release();
        assert.equal((await first).status, 200);
        assert.equal(calls, 1);
      },
    );
  });

  it('rejects an empty or missing ask text before anything else happens', async () => {
    let calls = 0;
    await withBridge(
      {
        deliver: async () => {
          calls += 1;
          return { id: 'never' };
        },
      },
      async ({ bridge, state }) => {
        for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }]) {
          const response = await post(bridge, '/tv/ask', body);
          assert.equal(response.status, 400, `body ${JSON.stringify(body)} is not a question`);
          assert.equal((await response.json()).ok, false);
        }
        assert.equal(calls, 0);
        assert.equal(state.pendingAsk, undefined);
      },
    );
  });

  it('reports a delivery failure as 502 and releases the ask', async () => {
    let fail = true;
    await withBridge(
      {
        deliver: async () => {
          if (fail) throw new Error('agent runtime is busy');
          return { id: 'ask-2' };
        },
      },
      async ({ bridge, state }) => {
        const response = await post(bridge, '/tv/ask', { text: 'hello' });
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.match(body.error, /agent runtime is busy/);
        assert.equal(state.pendingAsk, null, 'a failed delivery must not wedge the ask slot');

        fail = false;
        assert.equal((await post(bridge, '/tv/ask', { text: 'hello again' })).status, 200);
      },
    );
  });

  it('treats a delivery without an id as a failure', async () => {
    await withBridge(
      { deliver: async () => ({ sessionId: 'sess-1' }) },
      async ({ bridge, state }) => {
        const response = await post(bridge, '/tv/ask', { text: 'hello' });
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /no message id/);
        assert.equal(state.pendingAsk, null);
      },
    );
  });

  it('reports an unwired delivery surface instead of pretending', async () => {
    await withBridge({ deliver: null }, async ({ bridge }) => {
      const response = await post(bridge, '/tv/ask', { text: 'hello' });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /not wired/);
    });
  });
});

describe('GET /tv/reply correlation', () => {
  it('returns only the reply that answers the asked id', async () => {
    await withBridge({ state: { lastReply: { id: 'ask-7', text: 'here you go', at: '2026-03-10T18:00:00.000Z' } } }, async ({ bridge }) => {
      assert.deepEqual((await (await get(bridge, '/tv/reply?after=ask-7')).json()).reply, {
        id: 'ask-7',
        text: 'here you go',
        at: '2026-03-10T18:00:00.000Z',
      });
      assert.equal((await (await get(bridge, '/tv/reply?after=ask-8')).json()).reply, null, 'another id is not this reply');
      assert.equal((await (await get(bridge, '/tv/reply?after=')).json()).reply.id, 'ask-7', 'no cursor means "the newest"');
      assert.equal((await (await get(bridge, '/tv/reply')).json()).reply.id, 'ask-7');
    });
  });

  it('never returns a volunteered reply (id null) for a correlation query', async () => {
    await withBridge({ state: { lastReply: { id: null, text: 'unprompted', at: '2026-03-10T18:00:00.000Z' } } }, async ({ bridge }) => {
      assert.equal((await (await get(bridge, '/tv/reply?after=ask-1')).json()).reply, null);
      assert.equal((await (await get(bridge, '/tv/reply')).json()).reply.text, 'unprompted', 'still readable as the latest');
    });
  });

  it('returns null when no reply has been published yet', async () => {
    await withBridge({ state: {} }, async ({ bridge }) => {
      assert.deepEqual(await (await get(bridge, '/tv/reply?after=ask-1')).json(), { reply: null });
      assert.deepEqual(await (await get(bridge, '/tv/reply')).json(), { reply: null });
    });
  });
});

describe('GET /tv/state', () => {
  it('composes now playing, queue, picks and the last reply', async () => {
    await withBridge({ state: { lastReply: { id: 'ask-1', text: 'on it', at: '2026-03-10T18:00:00.000Z' } } }, async ({ bridge }) => {
      const response = await get(bridge, '/tv/state');
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.ok, true);
      assert.equal(body.connected, true);
      assert.equal(body.version, '20.5.0');
      assert.equal(body.nowPlaying.playing, true);
      assert.equal(body.nowPlaying.item.title, 'Sintel');
      assert.equal(body.nowPlaying.position, 300, 'position is elapsed seconds, not a percentage');
      assert.equal(body.nowPlaying.speed, 1);
      assert.equal(body.volume, 40);
      assert.equal(body.muted, false);
      assert.equal(body.queue.length, 1);
      assert.equal(body.queueCurrent, 1, 'the playing movie is the only queue entry');
      assert.deepEqual(body.picks.map((pick) => pick.id), [11, 21]);
      assert.equal(body.lastReply.text, 'on it');
      assert.equal(body.pendingAsk, null);
    });
  });

  it('reports an offline Kodi without throwing and keeps the picks', async () => {
    const kodi = stubKodi({
      snapshot: () => ({ connected: false, version: null, updatedAt: null, playing: false, item: null, queue: [] }),
    });
    await withBridge({ kodi }, async ({ bridge }) => {
      const response = await get(bridge, '/tv/state');
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.connected, false);
      assert.equal(body.nowPlaying, null);
      assert.equal(body.volume, null);
      assert.deepEqual(body.queue, []);
      assert.deepEqual(body.picks.map((pick) => pick.id), [11, 21], 'the TV still shows something to watch');
    });
  });

  it('falls back to the last known state when snapshot() itself throws', async () => {
    let boom = false;
    const kodi = stubKodi({
      snapshot: () => {
        if (boom) throw new Error('rpc exploded');
        return playingSnapshot();
      },
    });
    await withBridge({ kodi }, async ({ bridge }) => {
      assert.equal((await (await get(bridge, '/tv/state')).json()).nowPlaying.playing, true);

      boom = true;
      const response = await get(bridge, '/tv/state');
      assert.equal(response.status, 200, 'a broken snapshot must not become a 500');
      const body = await response.json();
      assert.equal(body.connected, false);
      assert.equal(body.nowPlaying.item.title, 'Sintel', 'cached state is still reported');

      assert.equal((await (await get(bridge, '/health')).json()).kodi.connected, false);
    });
  });

  it('derives the queue position of the playing item, and admits when it cannot', async () => {
    const queue = [
      { id: 1, kind: 'movie', label: 'First', title: 'First' },
      { id: 2, kind: 'movie', label: 'Sintel', title: 'Sintel' },
      { id: 3, kind: 'episode', label: 'Third', title: 'Third' },
    ];
    const nowPlaying = playingSnapshot().item;

    for (const [label, snapshotQueue, item, expected] of [
      ['second of three', queue, nowPlaying, 2],
      ['same item queued twice is ambiguous', [...queue, { ...queue[1] }], nowPlaying, null],
      ['playing item is not queued', queue.slice(0, 1), nowPlaying, null],
      ['nothing playing', queue, null, null],
    ]) {
      const kodi = stubKodi({ snapshot: () => ({ ...playingSnapshot(), queue: snapshotQueue, item }) });
      await withBridge({ kodi }, async ({ bridge }) => {
        const body = await (await get(bridge, '/tv/state')).json();
        assert.equal(body.queueCurrent, expected, label);
      });
    }
  });

  it('survives a picks producer that throws', async () => {
    await withBridge(
      {
        picks: () => {
          throw new Error('library unavailable');
        },
      },
      async ({ bridge }) => {
        const response = await get(bridge, '/tv/state');
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).picks, []);
      },
    );
  });

  it('hides a pick the TV has acknowledged', async () => {
    await withBridge({}, async ({ bridge, state }) => {
      const seen = await post(bridge, '/tv/seen', { id: 11 });
      assert.equal(seen.status, 200);
      assert.deepEqual(await seen.json(), { ok: true, seenId: '11' });
      assert.equal(state.seenId, '11');

      assert.deepEqual((await (await get(bridge, '/tv/state')).json()).picks.map((pick) => pick.id), [21]);
      assert.equal(state.lastReply, undefined, 'seen must not touch the reply');
    });
  });
});

describe('POST /tv/action', () => {
  it('maps transport actions onto the Kodi service', async () => {
    await withBridge({}, async ({ bridge, kodi }) => {
      assert.deepEqual(await (await post(bridge, '/tv/action', { action: 'play' })).json(), {
        ok: true,
        action: 'play',
        result: { ok: true, playing: true, position: 300, speed: 1 },
      });
      await post(bridge, '/tv/action', { action: 'seek', value: 120 });
      await post(bridge, '/tv/action', { action: 'seek', value: 'smallbackward' });
      await post(bridge, '/tv/action', { action: 'seek', value: '25%' });
      await post(bridge, '/tv/action', { action: 'skip', value: -10 });
      await post(bridge, '/tv/action', { action: 'skip', value: 'next' });
      await post(bridge, '/tv/action', { action: 'PAUSE' });

      assert.deepEqual(kodi.calls, [
        ['transport', 'play', { value: undefined }],
        ['transport', 'seek', { value: 120 }],
        ['transport', 'seek', { value: 'smallbackward' }],
        ['transport', 'seek', { value: '25%' }],
        ['transport', 'skip', { value: -10 }],
        ['transport', 'skip', { value: 'next' }],
        ['transport', 'pause', { value: undefined }],
      ]);
    });
  });

  it('forwards a numeric skip as seconds instead of dropping it', async () => {
    // Regression: a dropped number reaches transport() as `undefined`, which the
    // service reads as "next item" - a rewind button that changes episode.
    await withBridge({}, async ({ bridge, kodi }) => {
      await post(bridge, '/tv/action', { action: 'skip', value: -10 });
      await post(bridge, '/tv/action', { action: 'skip', value: 30 });
      await post(bridge, '/tv/action', { action: 'skip', value: '-15' });

      assert.deepEqual(kodi.calls, [
        ['transport', 'skip', { value: -10 }],
        ['transport', 'skip', { value: 30 }],
        ['transport', 'skip', { value: -15 }],
      ]);
    });
  });

  it('refuses a skip value that Kodi would turn into an item change', async () => {
    await withBridge({}, async ({ bridge, kodi }) => {
      for (const value of ['smallforward', 'bigbackward', 'rewind', 'previousish']) {
        const response = await post(bridge, '/tv/action', { action: 'skip', value });
        assert.equal(response.status, 400, `skip ${JSON.stringify(value)} must be refused`);
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.match(body.error, /skip takes a number of seconds/);
        assert.match(body.hint, /seek.*smallforward.*bigforward.*smallbackward.*bigbackward/);
      }
      assert.deepEqual(kodi.calls, [], 'a refused value never reaches Kodi');
    });
  });

  it('reports a caller mistake as 400 and a Kodi refusal as 502', async () => {
    const kodi = stubKodi({
      transport: async (action) => {
        if (action === 'seek') throw new RangeError('seek needs seconds (number), a percentage string ("25%"), a step name or {seconds|percentage|step}');
        throw new Error('Player.GoTo failed: no player');
      },
    });
    await withBridge({ kodi }, async ({ bridge }) => {
      const bad = await post(bridge, '/tv/action', { action: 'seek', value: 'sideways' });
      assert.equal(bad.status, 400, 'a bad argument is the caller\'s to fix');
      assert.match((await bad.json()).error, /seek needs seconds/);

      const refused = await post(bridge, '/tv/action', { action: 'pause' });
      assert.equal(refused.status, 502, 'a Kodi failure is not the caller\'s fault');
      assert.match((await refused.json()).error, /Kodi refused pause/);
    });
  });

  it('plays the item named by the action instead of resuming the current one', async () => {
    await withBridge({}, async ({ bridge, kodi }) => {
      const response = await post(bridge, '/tv/action', { action: 'play', value: { kind: 'episode', id: 21 } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, action: 'play', result: { ok: true, playing: true } });
      assert.deepEqual(kodi.calls, [['play', { kind: 'episode', id: 21 }]], 'a targeted play never goes through transport()');

      const byFile = await post(bridge, '/tv/action', { action: 'play', value: { file: '/media/movies/pick.mkv' } });
      assert.equal(byFile.status, 200);
      assert.deepEqual(kodi.calls[1], ['play', { file: '/media/movies/pick.mkv' }]);

      // A value that names nothing is still the remote's play button: resume.
      await post(bridge, '/tv/action', { action: 'play', value: 'whatever' });
      assert.deepEqual(kodi.calls[2], ['transport', 'play', { value: 'whatever' }]);
    });
  });

  it('reports a targeted play that the service cannot perform', async () => {
    const kodi = stubKodi({ play: undefined });
    await withBridge({ kodi }, async ({ bridge }) => {
      const response = await post(bridge, '/tv/action', { action: 'play', value: { id: 21 } });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /cannot play a specific item/);
    });
  });

  it('accepts absolute and relative volume, and toggles mute', async () => {
    await withBridge({}, async ({ bridge, kodi }) => {
      await post(bridge, '/tv/action', { action: 'volume', value: 55 });
      await post(bridge, '/tv/action', { action: 'volume', value: { delta: -5 } });
      await post(bridge, '/tv/action', { action: 'volume', value: '+5' });
      await post(bridge, '/tv/action', { action: 'volume' });
      await post(bridge, '/tv/action', { action: 'mute' });
      await post(bridge, '/tv/action', { action: 'mute', value: false });

      assert.deepEqual(kodi.calls, [
        ['volume', { set: 55 }],
        ['volume', { delta: -5 }],
        ['volume', { delta: 5 }],
        ['volume', {}],
        ['volume', { mute: true }],
        ['volume', { mute: false }],
      ]);
    });
  });

  it('refuses anything outside the allowlist and says what is allowed', async () => {
    await withBridge({}, async ({ bridge, kodi }) => {
      const response = await post(bridge, '/tv/action', { action: 'reboot' });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /unknown action "reboot"/);
      assert.deepEqual(body.allowlist, ['play', 'pause', 'playpause', 'stop', 'seek', 'skip', 'volume', 'mute']);
      assert.deepEqual(kodi.calls, [], 'nothing reached Kodi');

      assert.equal((await post(bridge, '/tv/action', {})).status, 400, 'a missing action is not a default action');
    });
  });

  it('reports a Kodi refusal as 502 instead of throwing', async () => {
    const kodi = stubKodi({
      transport: async () => {
        throw new Error('Kodi is not reachable at http://127.0.0.1:8080/jsonrpc: ECONNREFUSED');
      },
    });
    await withBridge({ kodi }, async ({ bridge }) => {
      const response = await post(bridge, '/tv/action', { action: 'play' });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /Kodi is not reachable/);
    });
  });
});

describe('request hygiene', () => {
  it('rejects a body over 16 KiB with 413', async () => {
    await withBridge({}, async ({ bridge }) => {
      const response = await post(bridge, '/tv/ask', { text: 'x'.repeat(20_000) });
      assert.equal(response.status, 413);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.limit, 16 * 1024);
    });
  });

  it('rejects malformed JSON with 400', async () => {
    await withBridge({}, async ({ bridge }) => {
      const response = await post(bridge, '/tv/action', '{"action": ');
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /not valid JSON/);
    });
  });

  it('answers every unknown endpoint with JSON, not HTML', async () => {
    await withBridge({}, async ({ bridge }) => {
      for (const path of ['/nope', '/tv', '/tv/state/extra']) {
        const response = await get(bridge, path);
        assert.equal(response.status, 404);
        assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
        assert.equal((await response.json()).ok, false);
      }
    });
  });

  it('distinguishes a wrong method from an unknown endpoint', async () => {
    await withBridge({}, async ({ bridge }) => {
      const response = await get(bridge, '/tv/ask');
      assert.equal(response.status, 405);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.deepEqual(body.allow, ['POST']);
    });
  });

  it('accepts a trailing slash and a query string on reads', async () => {
    await withBridge({}, async ({ bridge }) => {
      assert.equal((await get(bridge, '/health/')).status, 200);
      assert.equal((await get(bridge, '/tv/state?cacheBust=1')).status, 200);
    });
  });

  it('stops serving once closed', async () => {
    const bridge = await startBridge({
      config: { bridgeBind: '127.0.0.1', bridgePort: 0 },
      kodi: stubKodi(),
      picks: () => ({ picks: PICKS }),
      state: {},
    });
    const { url } = bridge;
    await bridge.close();
    await assert.rejects(fetch(`${url}/health`));
  });

  it('serves a real KodiService against the shared mock Kodi', async () => {
    // The seam that matters most: this bridge reads `snapshot()` only, so a
    // renamed field over there must show up here rather than silently turning
    // into nulls. Imported lazily so the rest of this file does not depend on
    // the service module loading.
    const [{ KodiRpc }, { KodiService }, { startMockKodi }] = await Promise.all([
      import('../src/rpc.mjs'),
      import('../src/kodi-service.mjs'),
      import('./mock-kodi.mjs'),
    ]);

    const mock = await startMockKodi({ port: 0, user: 'kodi', password: 'kodi' });
    const service = new KodiService({ rpc: new KodiRpc({ url: mock.url, user: 'kodi', password: 'kodi' }) });
    await service.start();
    const bridge = await startBridge({
      config: { bridgeBind: '127.0.0.1', bridgePort: 0, panelOrigin: PANEL },
      kodi: service,
      picks: () => ({ picks: PICKS }),
      state: {},
    });
    try {
      const body = await (await get(bridge, '/tv/state')).json();
      assert.equal(body.ok, true);
      assert.equal(body.connected, true, 'the bridge sees the service, not a dead socket');
      assert.equal(typeof body.volume, 'number', 'volume comes through snapshot()');
      assert.equal(typeof body.muted, 'boolean');
      assert.ok(Array.isArray(body.queue), 'queue is an array, not a {items,current} wrapper');
      assert.deepEqual(body.picks.map((pick) => pick.id), [11, 21]);
      assert.equal((await (await get(bridge, '/health')).json()).kodi.connected, true);
    } finally {
      await bridge.close();
      await service.stop();
      await mock.close();
    }
  });

  it('never writes the token into a logged line', async () => {
    /** @type {string[]} */
    const lines = [];
    const bridge = await startBridge({
      config: { bridgeBind: '127.0.0.1', bridgePort: 0, bridgeToken: TOKEN },
      kodi: stubKodi(),
      picks: () => ({ picks: PICKS }),
      log: (line) => lines.push(String(line)),
      state: {},
    });
    try {
      await get(bridge, '/health');
    } finally {
      await bridge.close();
    }
    assert.ok(lines.length >= 2, 'the bridge narrates start and stop');
    assert.ok(lines.every((line) => !line.includes(TOKEN)), 'the token stays out of the log');
  });
});
