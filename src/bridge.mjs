/**
 * @file Local HTTP bridge between the TV experience and the harness.
 *
 * The Kodi add-on (10-foot UI) and the Web panel both speak to this server. It
 * is deliberately ignorant of Cordis, agents and sessions: the harness wires a
 * single `deliver(text, { origin })` function in, and this module only shapes
 * HTTP in and out. That is what makes it testable with no harness context.
 *
 * Security posture (all of it required, none of it decorative):
 * - a non-loopback bind without a bridge token refuses to start
 *   (`E_BRIDGE_INSECURE`) instead of silently exposing the TV to the LAN;
 * - the token is compared in constant time and only ever travels in a header
 *   (`Authorization: Bearer` / `X-Bridge-Token`), never in a URL;
 * - request bodies are capped at 16 KiB;
 * - every response is JSON;
 * - CORS is limited to the single configured panel origin, never a wildcard.
 *
 * Bridge-owned state lives in the caller's `state` object so the panel and the
 * add-on observe the same ask and the same reply. The bridge writes
 * `state.pendingAsk` and `state.seenId`; it only ever reads `state.lastReply`,
 * which the harness delivery wiring owns.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/** Hard cap on a request body, in bytes. */
const BODY_LIMIT_BYTES = 16 * 1024;

/** Beyond this a body is not even drained; the socket is dropped. */
const BODY_DRAIN_LIMIT_BYTES = 64 * BODY_LIMIT_BYTES;

/** How long a body may take to arrive before the request is abandoned. */
const BODY_TIMEOUT_MS = 15_000;

/** Transport actions `/tv/action` is allowed to perform. */
const ACTIONS = Object.freeze(['play', 'pause', 'playpause', 'stop', 'seek', 'skip', 'volume', 'mute']);

/** Actions forwarded verbatim to `KodiService.transport`. */
const TRANSPORT_ACTIONS = new Set(['play', 'pause', 'playpause', 'stop', 'seek', 'skip']);

/** The only non-numeric `skip` values: these move between queue items. */
const SKIP_QUEUE_STEPS = new Set(['previous', 'prev', 'back', 'next']);

/** Addresses that only accept traffic from this machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']);

/** Which method each readable path answers. */
const ROUTES = new Map([
  ['/health', ['GET']],
  ['/tv/state', ['GET']],
  ['/tv/ask', ['POST']],
  ['/tv/reply', ['GET']],
  ['/tv/action', ['POST']],
  ['/tv/seen', ['POST']],
]);

/** Default port when the caller does not configure one. */
const DEFAULT_PORT = 8765;

/** Default bind address: this machine only. */
const DEFAULT_BIND = '127.0.0.1';

/** How long a produced pick list is reused before asking Kodi again. */
const DEFAULT_PICKS_TTL_MS = 30_000;

/**
 * Start the bridge.
 *
 * @param {object} options
 * @param {object} [options.config] Harness plugin config. Recognised keys:
 *   `bridgeBind`, `bridgePort`, `bridgeToken`, `panelOrigin` (string or array),
 *   `picksTtlMs`.
 * @param {object|null} [options.kodi] The `KodiService`. Only `snapshot()`,
 *   `transport()`, `volume()` and `version` are used; every call is guarded, so
 *   an unreachable Kodi is a reported state rather than an error.
 * @param {(() => Promise<{picks?: unknown[]}>|{picks?: unknown[]})|{picks?: unknown[]}|null} [options.picks]
 *   `makePicks` (or an equivalent) as a function, or a precomputed result.
 * @param {((text: string, meta: {origin: string}) => Promise<{id: string|number, sessionId?: string}>) | null} [options.deliver]
 *   Injects one turn into the agent and resolves with the message id. Owning it
 *   is the harness's job; the bridge never imports one.
 * @param {((message: string) => void)|{info?: Function, warn?: Function}|null} [options.log]
 *   Sink for start/stop/failure lines. Never receives the token.
 * @param {object|null} [options.state] Caller-owned shared state:
 *   `pendingAsk` (written here), `lastReply` (read only), `seenId` (written here).
 * @returns {Promise<{close: () => Promise<void>, url: string, port: number, bind: string}>}
 *   `url` carries no credentials; `port` is the bound port, so `0` resolves to
 *   the real one.
 * @throws {Error & {code: 'E_BRIDGE_INSECURE'}} When the bind address is not
 *   loopback and no `bridgeToken` is configured.
 */
export async function startBridge({ config = {}, kodi = null, picks = null, deliver = null, log = null, state = null } = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  const bind = resolveBind(settings);
  const requestedPort = resolvePort(settings);
  const token = resolveToken(settings);
  const panelOrigins = resolvePanelOrigins(settings);
  const picksTtlMs = Number.isFinite(Number(settings.picksTtlMs)) ? Math.max(0, Number(settings.picksTtlMs)) : DEFAULT_PICKS_TTL_MS;
  const shared = state && typeof state === 'object' ? state : {};

  if (!isLoopback(bind) && token == null) {
    const error = /** @type {Error & {code: string}} */ (
      new Error(
        `Refusing to bind the TV bridge to non-loopback address "${bind}" without a bridge token: ` +
          'anyone on the network could drive your TV or ask your agent. Set config.bridgeToken to a long random ' +
          'string to allow LAN access, or set config.bridgeBind to "127.0.0.1" to stay local.',
      )
    );
    error.code = 'E_BRIDGE_INSECURE';
    throw error;
  }

  const info = (message) => writeLog(log, 'info', message, 'kodi bridge:');
  const warn = (message) => writeLog(log, 'warn', message, 'kodi bridge:');

  /** Last snapshot that could be read, so a dead Kodi still reports something. */
  let cachedSnapshot = null;
  /** Produced pick list, reused for `picksTtlMs`. */
  let picksCache = { at: 0, list: /** @type {unknown[]} */ ([]) };

  /** @type {import('node:http').Server} */
  let server;

  /**
   * Read the current TV state without ever throwing.
   *
   * @returns {Promise<Record<string, any>>}
   */
  const safeSnapshot = async () => {
    try {
      if (kodi && typeof kodi.snapshot === 'function') {
        const value = kodi.snapshot();
        const snapshot = value && typeof value.then === 'function' ? await value : value;
        if (snapshot && typeof snapshot === 'object') {
          cachedSnapshot = snapshot;
          return snapshot;
        }
      }
    } catch (error) {
      warn(`snapshot failed: ${messageOf(error)}`);
    }
    if (cachedSnapshot) return { ...cachedSnapshot, connected: false };
    const version = typeof kodi?.version === 'string' ? kodi.version : null;
    return { connected: false, version };
  };

  /**
   * The pick list the TV should show right now, minus anything already acked.
   *
   * @returns {Promise<unknown[]>}
   */
  const currentPicks = async () => {
    const now = Date.now();
    if (picksTtlMs > 0 && picksCache.at !== 0 && now - picksCache.at < picksTtlMs) {
      return withoutSeen(picksCache.list);
    }
    try {
      const produced = typeof picks === 'function' ? await picks() : picks;
      const list = Array.isArray(produced) ? produced : Array.isArray(produced?.picks) ? produced.picks : [];
      picksCache = { at: now, list };
      return withoutSeen(list);
    } catch (error) {
      warn(`picks failed: ${messageOf(error)}`);
      return withoutSeen(picksCache.list);
    }
  };

  /**
   * @param {unknown[]} list
   * @returns {unknown[]}
   */
  const withoutSeen = (list) => {
    const seen = seenIds(shared);
    return (Array.isArray(list) ? list : [])
      .filter((item) => item && typeof item === 'object' && /** @type {any} */ (item).id != null)
      .filter((item) => !seen.has(String(/** @type {any} */ (item).id)))
      .slice(0, 24);
  };

  /**
   * Write one JSON response.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} payload
   * @param {{origin?: string|null, headers?: Record<string, string>}} [options]
   */
  const respond = (res, status, payload, options = {}) => {
    if (res.headersSent || res.writableEnded) return;
    const body = Buffer.from(`${JSON.stringify(payload ?? {})}`, 'utf8');
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', String(body.length));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    for (const [name, value] of Object.entries(corsHeaders(panelOrigins, options.origin ?? null))) {
      res.setHeader(name, value);
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.end(body);
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://bridge.invalid');
    const path = normalizePath(url.pathname);
    const method = (req.method ?? 'GET').toUpperCase();
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;

    // Preflight never carries credentials, so it is answered before auth. The
    // browser only proceeds when the configured panel origin is echoed back.
    if (method === 'OPTIONS') {
      respond(res, 200, { ok: true }, { origin });
      return;
    }

    if (!isAuthorized(req, token)) {
      respond(
        res,
        401,
        { ok: false, error: 'missing or invalid bridge token' },
        { origin, headers: { 'www-authenticate': 'Bearer realm="dsh-kodi"' } },
      );
      return;
    }

    if (path === '/health' && method === 'GET') {
      const snapshot = await safeSnapshot();
      const address = server.address();
      respond(res, 200, {
        ok: true,
        kodi: { connected: snapshot?.connected === true, version: snapshot?.version ?? null },
        bridge: {
          port: typeof address === 'object' && address ? address.port : requestedPort,
          authed: token != null,
          bind,
        },
      }, { origin });
      return;
    }

    if (path === '/tv/state' && method === 'GET') {
      const snapshot = await safeSnapshot();
      const item = snapshot?.item && typeof snapshot.item === 'object' ? snapshot.item : null;
      const playing = snapshot?.playing === true;
      const reply = replyOf(shared);
      const pending = pendingOf(shared);
      const queue = queueOf(snapshot);
      respond(
        res,
        200,
        {
          ok: true,
          connected: snapshot?.connected === true,
          version: snapshot?.version ?? null,
          updatedAt: snapshot?.updatedAt ?? null,
          nowPlaying: item || playing
            ? {
                playing,
                item,
                position: numOrNull(snapshot?.position),
                percentage: numOrNull(snapshot?.percentage),
                totaltime: numOrNull(snapshot?.totaltime),
                speed: numOrNull(snapshot?.speed),
              }
            : null,
          volume: numOrNull(snapshot?.volume),
          muted: typeof snapshot?.muted === 'boolean' ? snapshot.muted : null,
          queue: queue.items,
          queueCurrent: queue.current,
          picks: await currentPicks(),
          lastReply: reply,
          pendingAsk: pending ? { id: pending.id, at: pending.at, text: pending.text } : null,
        },
        { origin },
      );
      return;
    }

    if (path === '/tv/ask' && method === 'POST') {
      const body = await readJson(req);
      if (body.status !== 200) {
        respond(res, body.status, body.payload, { origin });
        return;
      }
      const text = typeof body.value?.text === 'string' ? body.value.text.trim() : '';
      if (text === '') {
        respond(res, 400, { ok: false, error: 'text is required' }, { origin });
        return;
      }
      if (typeof deliver !== 'function') {
        respond(res, 503, { ok: false, error: 'agent delivery is not wired into the bridge' }, { origin });
        return;
      }
      const pending = pendingOf(shared);
      if (pending) {
        respond(
          res,
          429,
          {
            ok: false,
            error: 'a previous ask is still waiting for a reply',
            pendingId: pending.id,
            pending: { id: pending.id, at: pending.at, text: pending.text },
          },
          { origin, headers: { 'retry-after': '1' } },
        );
        return;
      }

      // Reserve before awaiting delivery: a second ask inside the delivery
      // window must see "in flight" rather than racing a second agent turn.
      const askedAt = new Date().toISOString();
      shared.pendingAsk = { id: null, at: askedAt, text };
      let result;
      try {
        result = await deliver(text, { origin: 'tv' });
      } catch (error) {
        shared.pendingAsk = null;
        respond(res, 502, { ok: false, error: `agent delivery failed: ${messageOf(error)}` }, { origin });
        return;
      }
      const id = result?.id;
      if (id == null) {
        shared.pendingAsk = null;
        respond(res, 502, { ok: false, error: 'agent delivery returned no message id' }, { origin });
        return;
      }
      shared.pendingAsk = { id: String(id), at: askedAt, text };
      respond(res, 200, { ok: true, id: String(id), sessionId: result?.sessionId ?? null }, { origin });
      return;
    }

    if (path === '/tv/reply' && method === 'GET') {
      const after = url.searchParams.get('after');
      const reply = replyOf(shared);
      if (!reply) {
        respond(res, 200, { reply: null }, { origin });
        return;
      }
      // A reply is correlatable only through the ask it answers: the harness
      // wiring stamps `lastReply.id` with that ask's id. Without an `after`
      // query this is a "what is the newest reply?" read.
      const matches = after == null || after === '' || (reply.id != null && String(reply.id) === String(after));
      respond(res, 200, { reply: matches ? reply : null }, { origin });
      return;
    }

    if (path === '/tv/action' && method === 'POST') {
      const body = await readJson(req);
      if (body.status !== 200) {
        respond(res, body.status, body.payload, { origin });
        return;
      }
      const action = typeof body.value?.action === 'string' ? body.value.action.trim().toLowerCase() : '';
      if (!ACTIONS.includes(action)) {
        respond(
          res,
          400,
          { ok: false, error: `unknown action${action ? ` "${action}"` : ''}`, allowlist: [...ACTIONS] },
          { origin },
        );
        return;
      }
      if (!kodi || typeof kodi !== 'object') {
        respond(res, 502, { ok: false, error: 'Kodi is not configured' }, { origin });
        return;
      }
      const raw = body.value?.value;
      const problem = actionValueProblem(action, raw);
      if (problem) {
        respond(res, 400, { ok: false, ...problem }, { origin });
        return;
      }
      try {
        const result = await performAction(kodi, action, raw, () => safeSnapshot());
        respond(res, 200, { ok: true, action, result: result ?? null }, { origin });
      } catch (error) {
        // The service uses RangeError for "your argument is wrong" and typed
        // KodiRpcError for "Kodi refused/cannot". The panel needs to tell the
        // difference: one is fixable by the caller, the other is not.
        if (error instanceof RangeError) {
          respond(res, 400, { ok: false, error: messageOf(error) }, { origin });
          return;
        }
        respond(res, 502, { ok: false, error: `Kodi refused ${action}: ${messageOf(error)}` }, { origin });
      }
      return;
    }

    if (path === '/tv/seen' && method === 'POST') {
      const body = await readJson(req);
      if (body.status !== 200) {
        respond(res, body.status, body.payload, { origin });
        return;
      }
      const id = body.value?.id;
      if (id == null || (typeof id !== 'string' && typeof id !== 'number')) {
        respond(res, 400, { ok: false, error: 'id is required' }, { origin });
        return;
      }
      shared.seenId = String(id);
      respond(res, 200, { ok: true, seenId: shared.seenId }, { origin });
      return;
    }

    if (ROUTES.has(path)) {
      respond(res, 405, { ok: false, error: `method ${method} not allowed on ${path}`, allow: ROUTES.get(path) }, { origin });
      return;
    }

    respond(res, 404, { ok: false, error: `no such endpoint: ${path}` }, { origin });
  };

  server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      warn(`request failed: ${messageOf(error)}`);
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      respond(res, 500, { ok: false, error: 'internal bridge error' }, { origin: typeof req.headers.origin === 'string' ? req.headers.origin : null });
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
  });

  await new Promise((resolve, reject) => {
    /** @param {Error} error */
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: bind, port: requestedPort });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  const url = `http://${urlHost(bind)}:${port}`;
  info(`listening on ${url} (${token == null ? 'loopback only, no token' : 'token required'}); endpoints: ${[...ROUTES.keys()].join(' ')}`);

  return {
    url,
    port,
    bind,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      info('stopped');
    },
  };
}

/**
 * Perform one allow-listed action against Kodi.
 *
 * `play` has two meanings on purpose: with no target it resumes the player
 * (the remote's play button), and with `{kind, id}` or `{file}` it opens that
 * specific item (a pick clicked on the TV).
 *
 * @param {any} kodi
 * @param {string} action
 * @param {unknown} value
 * @param {() => Promise<Record<string, any>>} snapshot
 * @returns {Promise<unknown>}
 */
async function performAction(kodi, action, value, snapshot) {
  if (action === 'play' && isPlayTarget(value)) {
    if (typeof kodi.play !== 'function') throw new Error('this Kodi service cannot play a specific item');
    return kodi.play(playTarget(value));
  }
  if (action === 'volume') return kodi.volume(volumeRequest(value));
  if (action === 'mute') {
    if (typeof value === 'boolean') return kodi.volume({ mute: value });
    if (value === 'true' || value === 'on' || value === 1) return kodi.volume({ mute: true });
    if (value === 'false' || value === 'off' || value === 0) return kodi.volume({ mute: false });
    // No explicit target means "flip it", which is what a remote's mute button does.
    const current = await snapshot();
    return kodi.volume({ mute: current?.muted !== true });
  }
  if (!TRANSPORT_ACTIONS.has(action)) throw new Error(`unsupported action ${action}`);
  return kodi.transport(action, { value: transportValue(action, value) });
}

/**
 * Whether a `play` value names a specific item rather than "resume".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlayTarget(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (/** @type {any} */ (value).id != null || /** @type {any} */ (value).file != null)
  );
}

/**
 * Build the target `KodiService.play` expects, omitting what was not given.
 *
 * @param {any} value
 * @returns {Record<string, unknown>}
 */
function playTarget(value) {
  /** @type {Record<string, unknown>} */
  const target = {};
  if (value.file != null) target.file = value.file;
  if (value.id != null) target.id = value.id;
  if (value.kind != null) target.kind = value.kind;
  return target;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function volumeRequest(value) {
  // Explicit intent wins: `{set: 42}` from a slider, `{delta: -5}` from a
  // volume button. This mirrors `KodiService.volume`'s own option object.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const source = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const request = {};
    if (numOrNull(source.set) != null) request.set = numOrNull(source.set);
    if (numOrNull(source.delta) != null) request.delta = numOrNull(source.delta);
    if (typeof source.mute === 'boolean') request.mute = source.mute;
    return request;
  }
  // Strings are checked before the numeric path on purpose: "+5" means "five
  // louder", and must not be read as an absolute level of 5.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]\d+$/.test(trimmed)) return { delta: Number(trimmed) };
    if (/^\d+$/.test(trimmed)) return { set: Number(trimmed) };
  }
  const absolute = numOrNull(value);
  if (absolute != null) return { set: absolute };
  // No value: report the level instead of guessing one.
  return {};
}

/**
 * The play queue, tolerating either a bare array or the
 * `{ items, current }` shape a service may cache.
 *
 * @param {Record<string, any>|null|undefined} snapshot
 * @returns {{items: unknown[], current: unknown}}
 */
function queueOf(snapshot) {
  const raw = snapshot?.queue;
  let items = [];
  let current = numOrNull(snapshot?.queueCurrent) ?? numOrNull(snapshot?.current);
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).items)) {
    items = /** @type {any} */ (raw).items;
    current = numOrNull(/** @type {any} */ (raw).current) ?? current;
  }
  // `KodiService.snapshot()` does not expose a queue cursor, so derive the hint
  // by locating the playing item. Two queue rows for the same library item are
  // genuinely ambiguous, so that case answers null rather than guessing.
  if (current == null) current = playingQueueIndex(items, snapshot?.item);
  return { items, current };
}

/**
 * 1-based queue position of the playing item, or null when it is absent or the
 * queue holds the same item more than once.
 *
 * @param {unknown[]} items
 * @param {Record<string, any>|null|undefined} item
 * @returns {number|null}
 */
function playingQueueIndex(items, item) {
  if (!Array.isArray(items) || !item || item.id == null) return null;
  /** @type {number[]} */
  const matches = [];
  items.forEach((entry, index) => {
    const row = /** @type {any} */ (entry);
    if (!row || row.id == null) return;
    if (String(row.id) !== String(item.id)) return;
    if (item.kind != null && row.kind != null && String(row.kind) !== String(item.kind)) return;
    matches.push(index + 1);
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Normalise the value of a transport action for `KodiService.transport`.
 *
 * The vocabularies are the service's, not invented here:
 * - `seek`: seconds (number or numeric string), `"25%"`, a step name
 *   (`smallforward`/`bigforward`/`smallbackward`/`bigbackward`) or
 *   `{seconds|percentage|step}` - all forwarded for the service to resolve;
 * - `skip`: a number of SECONDS to jump by (negative goes back), or the queue
 *   step `previous`/`next`. A number must survive this function: dropping it
 *   turns "jump back ten seconds" into "change item".
 *
 * @param {string} action
 * @param {unknown} value
 * @returns {unknown}
 */
function transportValue(action, value) {
  if (value == null) return undefined;
  if (action === 'seek') return numOrNull(value) ?? value;
  if (action === 'skip') {
    const seconds = numOrNull(value);
    if (seconds != null) return seconds;
    return typeof value === 'string' ? value.trim().toLowerCase() : value;
  }
  return value;
}

/**
 * Reject a value that the transport would silently reinterpret.
 *
 * `KodiService.transport('skip', ...)` treats every non-numeric value other than
 * `previous`/`prev`/`back` as "next item", so `skip: 'smallforward'` would
 * change episode instead of stepping ten seconds. Refusing it here turns a
 * wrong action on the TV into a correctable error.
 *
 * @param {string} action
 * @param {unknown} value
 * @returns {{error: string, hint: string}|null}
 */
function actionValueProblem(action, value) {
  if (action !== 'skip' || value == null) return null;
  if (numOrNull(value) != null) return null;
  if (typeof value === 'string' && SKIP_QUEUE_STEPS.has(value.trim().toLowerCase())) return null;
  return {
    error: `skip takes a number of seconds or one of ${[...SKIP_QUEUE_STEPS].join(', ')}`,
    hint: 'For a time step use action "seek" with a step name: smallforward, bigforward, smallbackward, bigbackward.',
  };
}

/**
 * Read and parse a JSON request body, enforcing the size cap and the timeout.
 *
 * Oversized bodies are drained rather than cut off, so the client actually sees
 * the 413 instead of a reset connection.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{status: 200, value: any} | {status: number, payload: Record<string, unknown>}>}
 */
function readJson(req) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
      // Drain (bounded) so the response is readable, then refuse.
      drain(req);
      resolve({ status: 413, payload: { ok: false, error: `request body exceeds ${BODY_LIMIT_BYTES} bytes`, limit: BODY_LIMIT_BYTES } });
      return;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;

    /** @param {{status: number, value?: any, payload?: Record<string, unknown>}} outcome */
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      resolve(/** @type {any} */ (outcome));
    };

    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      total += chunk.length;
      if (total > BODY_DRAIN_LIMIT_BYTES) {
        settle({ status: 413, payload: { ok: false, error: `request body exceeds ${BODY_LIMIT_BYTES} bytes`, limit: BODY_LIMIT_BYTES } });
        return;
      }
      if (total > BODY_LIMIT_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (tooLarge) {
        settle({ status: 413, payload: { ok: false, error: `request body exceeds ${BODY_LIMIT_BYTES} bytes`, limit: BODY_LIMIT_BYTES } });
        return;
      }
      const raw = Buffer.concat(chunks, total).toString('utf8').trim();
      if (raw === '') {
        settle({ status: 200, value: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        settle({ status: 200, value: parsed && typeof parsed === 'object' ? parsed : {} });
      } catch {
        settle({ status: 400, payload: { ok: false, error: 'request body is not valid JSON' } });
      }
    };

    /** @param {Error} error */
    const onError = (error) => settle({ status: 400, payload: { ok: false, error: `request body could not be read: ${messageOf(error)}` } });
    const onAborted = () => settle({ status: 400, payload: { ok: false, error: 'request aborted' } });
    const timer = setTimeout(
      () => settle({ status: 408, payload: { ok: false, error: 'request body timed out' } }),
      BODY_TIMEOUT_MS,
    );

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * Discard at most the drain limit of a request body without buffering it.
 *
 * @param {import('node:http').IncomingMessage} req
 */
function drain(req) {
  let seen = 0;
  req.on('data', (chunk) => {
    seen += chunk.length;
    if (seen > BODY_DRAIN_LIMIT_BYTES) req.destroy();
  });
  req.resume();
}

/**
 * Constant-time token check. Both sides are hashed first so the comparison is
 * independent of the presented length.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string|null} token
 * @returns {boolean}
 */
function isAuthorized(req, token) {
  if (token == null) return true;
  const presented = presentedToken(req);
  if (presented == null) return false;
  return timingSafeEqual(digest(presented), digest(token));
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Read the token from a header. Query strings are intentionally not accepted:
 * a token in a URL leaks into logs, history and proxies.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
function presentedToken(req) {
  const header = req.headers['x-bridge-token'];
  if (typeof header === 'string' && header !== '') return header;
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * @param {string[]} allowed
 * @param {string|null} origin
 * @returns {Record<string, string>}
 */
function corsHeaders(allowed, origin) {
  if (origin == null || allowed.length === 0 || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-bridge-token',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/**
 * @param {string} pathname
 * @returns {string}
 */
function normalizePath(pathname) {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * @param {object} settings
 * @returns {string}
 */
function resolveBind(settings) {
  const raw = settings.bridgeBind ?? settings.bind;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_BIND;
  return raw.trim();
}

/**
 * @param {object} settings
 * @returns {number}
 */
function resolvePort(settings) {
  const raw = settings.bridgePort ?? settings.port;
  const value = numOrNull(raw);
  if (value == null || value < 0 || value > 65_535) return DEFAULT_PORT;
  return Math.floor(value);
}

/**
 * @param {object} settings
 * @returns {string|null}
 */
function resolveToken(settings) {
  const raw = settings.bridgeToken;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * @param {object} settings
 * @returns {string[]}
 */
function resolvePanelOrigins(settings) {
  const raw = settings.panelOrigin ?? settings.panelOrigins;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((value) => typeof value === 'string' && value !== '');
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isLoopback(host) {
  const value = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (LOOPBACK_HOSTS.has(value)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Turn a bind address into something callable. A wildcard bind is reachable on
 * loopback, which is what a local URL should point at.
 *
 * @param {string} bind
 * @returns {string}
 */
function urlHost(bind) {
  const value = bind.trim().toLowerCase();
  if (value === '0.0.0.0' || value === '' || value === '*') return '127.0.0.1';
  if (value === '::' || value === '[::]') return '[::1]';
  if (value === '::1' || value.includes(':')) return `[${value.replace(/^\[/, '').replace(/\]$/, '')}]`;
  return value;
}

/**
 * @param {object} shared
 * @returns {{id: string|null, at: string|null, text: string}|null}
 */
function pendingOf(shared) {
  const value = shared.pendingAsk;
  if (!value || typeof value !== 'object') return null;
  return {
    id: value.id == null ? null : String(value.id),
    at: typeof value.at === 'string' ? value.at : null,
    text: typeof value.text === 'string' ? value.text : '',
  };
}

/**
 * The reply the harness wiring published, in the contracted shape.
 *
 * @param {object} shared
 * @returns {{id: string, text: string, at: string|null}|null}
 */
function replyOf(shared) {
  const value = shared.lastReply;
  if (!value || typeof value !== 'object') return null;
  return {
    id: value.id == null ? null : String(value.id),
    text: typeof value.text === 'string' ? value.text : String(value.text ?? ''),
    at: typeof value.at === 'string' ? value.at : value.at == null ? null : String(value.at),
  };
}

/**
 * Pick ids the TV has already acknowledged, from `state.seenId` (one id or a
 * list of ids).
 *
 * @param {object} shared
 * @returns {Set<string>}
 */
function seenIds(shared) {
  const raw = shared.seenId;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return new Set(list.filter((value) => value != null).map((value) => String(value)));
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function numOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

/**
 * @param {any} log
 * @param {'info'|'warn'} level
 * @param {string} message
 * @param {string} prefix
 */
function writeLog(log, level, message, prefix) {
  if (typeof log === 'function') {
    log(`${prefix} ${message}`);
    return;
  }
  const sink = level === 'warn' ? log?.warn : log?.info;
  if (typeof sink === 'function') sink.call(log, `${prefix} ${message}`);
}
