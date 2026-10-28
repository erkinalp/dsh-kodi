/**
 * src/rpc.mjs — JSON-RPC 2.0 transport for Kodi's web server (basic auth,
 * per-call timeouts, typed errors, a redacted endpoint).
 *
 * Zero dependencies: uses the global `fetch` (Node 18+) and `AbortController`.
 * Every failure is a {@link KodiRpcError} whose `kind` tells the caller what to
 * do about it: `transport` (Kodi never answered / bad HTTP), `timeout`,
 * `auth` (wrong credentials), `rpc` (Kodi answered with a JSON-RPC error) or
 * `disabled` (integration turned off).
 *
 * Secret hygiene: the password is only ever placed in the `authorization`
 * header. It is never interpolated into a message, and `endpoint` is redacted.
 * Error text is scrubbed of the password and of the composed Basic token as a
 * second line of defence.
 *
 * @module dsh-kodi/rpc
 */

/**
 * The closed set of failure kinds a caller may branch on.
 * @typedef {'transport'|'timeout'|'auth'|'rpc'|'disabled'} KodiRpcErrorKind
 */

/**
 * A typed Kodi RPC failure.
 *
 * `code` is the numeric JSON-RPC code for `kind:'rpc'` (e.g. `-32602`), and a
 * short string for the other kinds (`'ECONNREFUSED'`, `'ETIMEDOUT'`,
 * `'EAUTH'`, `'EDISABLED'`) so callers can test either field.
 */
export class KodiRpcError extends Error {
  /**
   * @param {string} message human-readable, secret-free
   * @param {{
   *   kind?: KodiRpcErrorKind,
   *   code?: number|string|null,
   *   method?: string|null,
   *   data?: unknown,
   *   cause?: unknown,
   * }} [options]
   */
  constructor(message, { kind = 'transport', code = null, method = null, data = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'KodiRpcError';
    /** @type {KodiRpcErrorKind} */
    this.kind = kind;
    /** @type {number|string|null} */
    this.code = code;
    /** @type {string|null} JSON-RPC method that failed, when known */
    this.method = method;
    /** @type {unknown} JSON-RPC `error.data`, when Kodi sent one */
    this.data = data;
  }
}

/**
 * Strip userinfo (and any accidental secret) out of a URL for display.
 * @param {unknown} raw
 * @param {string} [secret]
 * @returns {string}
 */
function redact(raw, secret = '') {
  let text = String(raw ?? '');
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    text = url.toString();
  } catch {
    // Not a URL: fall through to the regex scrub below.
    text = text.replace(/\/\/[^/@\s]*@/, '//');
  }
  if (secret) text = text.split(secret).join('***');
  return text;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Kodi JSON-RPC 2.0 client over HTTP.
 *
 * @example
 * const rpc = new KodiRpc({ url: 'http://kodi.local:8080/jsonrpc', user: 'kodi', password: 'secret' });
 * const players = await rpc.call('Player.GetActivePlayers'); // => [{ playerid: 1, type: 'video' }]
 */
export class KodiRpc {
  /** @type {string} */
  #url;
  /** @type {string} */
  #user;
  /** @type {string} */
  #password;
  /** @type {number} */
  #timeoutMs;
  /** @type {typeof globalThis.fetch} */
  #fetchImpl;
  /** @type {number} */
  #id = 0;
  /** @type {boolean} */
  #disabled;

  /**
   * @param {{
   *   url: string,
   *   user?: string,
   *   password?: string,
   *   timeoutMs?: number,
   *   fetchImpl?: typeof globalThis.fetch,
   *   disabled?: boolean,
   * }} options
   */
  constructor({ url, user = '', password = '', timeoutMs = 8000, fetchImpl = globalThis.fetch, disabled = false }) {
    this.#url = String(url ?? '').trim();
    this.#user = String(user ?? '');
    this.#password = String(password ?? '');
    this.#timeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 8000;
    this.#fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    this.#disabled = Boolean(disabled) || this.#url.length === 0;
  }

  /**
   * The endpoint as it may safely appear in a log or a tool error: scheme,
   * host, port and path only — userinfo removed, password scrubbed.
   * @returns {string}
   */
  get endpoint() {
    if (!this.#url) return '(no endpoint configured)';
    return redact(this.#url, this.#password);
  }

  /**
   * The same endpoint rewritten as a WebSocket URL, for Kodi's notification
   * stream. Credentials are deliberately not embedded: they travel in the
   * `authorization` header of the upgrade request.
   * @returns {string|null}
   */
  get wsUrl() {
    if (!this.#url) return null;
    try {
      const url = new URL(this.#url);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.username = '';
      url.password = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  /**
   * The `Authorization` header value for Kodi, or `null` when no credentials
   * are configured. Used for the notification WebSocket upgrade; treat it as a
   * secret and never log it.
   * @returns {string|null}
   */
  get authHeader() {
    if (!this.#user && !this.#password) return null;
    return `Basic ${Buffer.from(`${this.#user}:${this.#password}`, 'utf8').toString('base64')}`;
  }

  /** @returns {boolean} true when calls short-circuit with `kind:'disabled'`. */
  get disabled() {
    return this.#disabled;
  }

  /** Turn the integration off: every subsequent call throws `kind:'disabled'`. */
  disable() {
    this.#disabled = true;
  }

  /** Turn the integration back on (does not verify reachability). */
  enable() {
    this.#disabled = this.#url.length === 0;
  }

  /**
   * Perform one JSON-RPC call and return its `result`.
   *
   * @template T
   * @param {string} method e.g. `'Player.GetActivePlayers'`
   * @param {Record<string, unknown>} [params]
   * @param {{ timeoutMs?: number }} [options] per-call timeout override
   * @returns {Promise<T>}
   * @throws {KodiRpcError} kind `transport` | `timeout` | `auth` | `rpc` | `disabled`
   */
  async call(method, params = {}, options = {}) {
    if (this.#disabled) {
      throw new KodiRpcError('Kodi integration is disabled (no endpoint configured)', {
        kind: 'disabled',
        code: 'EDISABLED',
        method,
      });
    }
    this.#id += 1;
    const id = this.#id;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(0, Number(options.timeoutMs)) : this.#timeoutMs;

    /** @type {AbortController} */
    const controller = new AbortController();
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
      // A pending per-call timeout must not keep the process alive.
      if (typeof timer.unref === 'function') timer.unref();
    }

    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    const authHeader = this.authHeader;
    if (authHeader) headers.authorization = authHeader;

    /** @type {Response} */
    let response;
    try {
      response = await this.#fetchImpl(this.#url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
        signal: controller.signal,
      });
    } catch (error) {
      const cause = /** @type {{name?: unknown, code?: unknown, message?: unknown, cause?: {code?: unknown}}} */ (error);
      const aborted = controller.signal.aborted || cause?.name === 'AbortError' || cause?.name === 'TimeoutError';
      if (aborted) {
        throw new KodiRpcError(`Kodi did not answer ${method} in time (${timeoutMs}ms) at ${this.endpoint}`, {
          kind: 'timeout',
          code: 'ETIMEDOUT',
          method,
          cause: error,
        });
      }
      const reason = this.#shortCause(cause);
      throw new KodiRpcError(`Kodi is not reachable at ${this.endpoint} (${method}: ${reason})`, {
        kind: 'transport',
        code: String(cause?.code ?? 'ETRANSPORT'),
        method,
        cause: error,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new KodiRpcError(`Kodi rejected the credentials for ${this.endpoint} (HTTP 401)`, {
        kind: 'auth',
        code: 'EAUTH',
        method,
      });
    }
    if (!response.ok) {
      throw new KodiRpcError(`Kodi answered HTTP ${response.status} for ${method} at ${this.endpoint}`, {
        kind: 'transport',
        code: `HTTP_${response.status}`,
        method,
      });
    }

    /** @type {unknown} */
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new KodiRpcError(`Kodi returned a non-JSON body for ${method} at ${this.endpoint}`, {
        kind: 'transport',
        code: 'EBADJSON',
        method,
        cause: error,
      });
    }

    if (!isRecord(payload)) {
      throw new KodiRpcError(`Kodi returned an unexpected JSON-RPC envelope for ${method}`, {
        kind: 'transport',
        code: 'EBADENVELOPE',
        method,
      });
    }

    if (payload.error !== undefined && payload.error !== null) {
      const error = isRecord(payload.error) ? payload.error : {};
      const code = typeof error.code === 'number' ? error.code : null;
      const message = this.#scrub(String(error.message ?? 'unknown JSON-RPC error'));
      throw new KodiRpcError(`Kodi RPC error${code === null ? '' : ` ${code}`} for ${method}: ${message}`, {
        kind: 'rpc',
        code,
        method,
        data: error.data ?? null,
      });
    }

    if (!('result' in payload)) {
      throw new KodiRpcError(`Kodi returned no result for ${method}`, {
        kind: 'transport',
        code: 'ENORESULT',
        method,
      });
    }

    return /** @type {T} */ (payload.result);
  }

  /**
   * Short, secret-free description of a fetch rejection.
   * @param {{code?: unknown, message?: unknown, cause?: {code?: unknown}}} cause
   * @returns {string}
   */
  #shortCause(cause) {
    const code = typeof cause?.code === 'string' ? cause.code : '';
    const nested = typeof cause?.cause?.code === 'string' ? cause.cause.code : '';
    const detail = code || nested || (typeof cause?.message === 'string' ? cause.message : 'unknown error');
    return this.#scrub(detail);
  }

  /**
   * Remove the password and the composed Basic token from arbitrary text.
   * @param {string} text
   * @returns {string}
   */
  #scrub(text) {
    let out = text;
    if (this.#password) out = out.split(this.#password).join('***');
    const token = this.authHeader;
    if (token) {
      const hash = token.slice('Basic '.length);
      out = out.split(hash).join('***');
    }
    return out;
  }
}
