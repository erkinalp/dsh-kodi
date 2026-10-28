/**
 * dsh-kodi — host half of the Kodi integration.
 *
 * One row carries the whole Host side: the `kodi` JSON-RPC service, the
 * `kodi_*` agent tools, and the local TV bridge that the Kodi add-on and the
 * Web panel call. The client half renders the now-playing panel and is declared
 * separately through `dsh.client` in package.json.
 *
 * Agent delivery: a TV question becomes one ordinary follow-up turn on a
 * Session, injected through `sessionController.prompt`. The answer reaches the
 * TV through the `kodi_say` tool, so the reply path never depends on reading
 * assistant prose back out of the Session log.
 */

import { randomUUID } from 'node:crypto'

import { KodiRpc } from './src/rpc.mjs'
import { KodiService } from './src/kodi-service.mjs'
import { registerTools } from './src/tools.mjs'
import { makePicks } from './src/recommend.mjs'
import { startBridge } from './src/bridge.mjs'

export const name = 'dsh-kodi'

/** Services this plugin contributes to without which no tool would work. */
export const inject = ['tools', 'systemPrompt']

/** Deployment defaults; every one is overridable from the cordis row. */
const DEFAULTS = Object.freeze({
  url: 'http://127.0.0.1:8080/jsonrpc',
  user: 'kodi',
  password: '',
  timeoutMs: 8000,
  bridgePort: 8760,
  bridgeBind: '127.0.0.1',
  bridgeToken: '',
  sessionId: '',
  panelOrigin: 'http://127.0.0.1:3080',
  picksLimit: 6,
  logLevel: 'info',
})

/**
 * Merge row config over the defaults and reject values that would fail later
 * with a confusing error (a non-numeric port, a non-http URL).
 * @param config - raw cordis row config.
 * @returns validated settings.
 */
function resolveSettings(config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  if (typeof settings.url !== 'string' || !/^https?:\/\//u.test(settings.url)) {
    throw new Error(`dsh-kodi: url must be an http(s) JSON-RPC endpoint, got ${JSON.stringify(settings.url)}`)
  }
  const port = Number(settings.bridgePort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`dsh-kodi: bridgePort must be a TCP port, got ${JSON.stringify(settings.bridgePort)}`)
  }
  settings.bridgePort = port
  settings.timeoutMs = Number(settings.timeoutMs)
  settings.picksLimit = Number(settings.picksLimit)
  return settings
}

/**
 * One Cordis row: service, tools, bridge, and the model-facing guidance that
 * teaches the agent when the television is the right output.
 * @param ctx - plugin context.
 * @param config - cordis row config (see cordis.patch.yml).
 * @returns disposers for every registered resource.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const disposers = []

  const log = (level, message) => {
    const rank = { debug: 10, info: 20, warn: 30, error: 40 }
    if ((rank[level] ?? 20) < (rank[settings.logLevel] ?? 20)) return
    const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    write(`dsh-kodi: ${message}`)
  }

  const state = { pendingAsk: null, lastReply: null, seenId: null }

  const rpc = new KodiRpc({
    url: settings.url,
    user: settings.user,
    password: settings.password,
    timeoutMs: settings.timeoutMs,
  })
  const kodi = new KodiService({ rpc, log: (message) => log('debug', message) })

  // The service owns a notification socket; it must close with the row.
  disposers.push(ctx.effect(() => {
    kodi.start().catch((error) => {
      log('warn', `Kodi is not reachable at ${rpc.endpoint}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { kodi.stop() }
  }, 'dsh-kodi.service'))

  disposers.push(kodi.onState(() => {
    // State transitions are the panel's content; nothing else to do here.
  }))

  // ---- agent delivery: one TV question becomes one follow-up turn ----------
  let sessionController
  ctx.inject(['sessionController'], (child) => {
    child.effect(() => {
      sessionController = child.sessionController
      return () => { sessionController = undefined }
    }, 'dsh-kodi.session-controller')
  })

  /**
   * Resolve the Session a TV question belongs to: the configured one, else the
   * most recently active visible Session.
   * @returns the session id.
   */
  async function targetSession() {
    if (settings.sessionId !== '') return settings.sessionId
    const listed = await sessionController.list({}, new AbortController().signal)
    const first = listed?.items?.[0]
    if (first === undefined) {
      throw new Error('no Session is available to receive a TV question; open a chat first')
    }
    return first.sessionId
  }

  /**
   * Wrap the spoken question so the model knows the audience is a television
   * and that its answer only becomes visible through kodi_say.
   * @param text - what was said on the TV.
   * @returns prompt text.
   */
  function tvPrompt(text) {
    return [
      `Someone asked this from the Kodi TV: "${text}"`,
      'Answer for a television audience: a few short sentences, no markdown, no code.',
      'The chat answer is not visible on the TV — call kodi_say with the answer you want shown there.',
    ].join('\n')
  }

  /**
   * Inject one TV question as an ordinary follow-up turn.
   * @param text - the question spoken or typed on the TV.
   * @param meta - origin metadata from the bridge.
   * @returns the ask identity the bridge reports.
   */
  async function deliver(text, meta) {
    if (sessionController === undefined) {
      throw new Error('agent delivery is unavailable: this Harness has no sessionController service')
    }
    const truncated = String(text ?? '').trim().slice(0, 2000)
    if (truncated === '') throw new Error('the TV question was empty')
    const id = randomUUID()
    const sessionId = await targetSession()
    try {
      await sessionController.prompt({
        requestId: id,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: tvPrompt(truncated) }],
      }, new AbortController().signal)
    } catch (error) {
      throw new Error(`could not hand the TV question to the agent: ${error instanceof Error ? error.message : String(error)}`)
    }
    log('info', `TV question ${id.slice(0, 8)} delivered to Session ${String(sessionId).slice(0, 8)} (${meta?.origin ?? 'tv'})`)
    return { id, sessionId }
  }

  /**
   * The kodi_say hook: publish text to the TV and settle the pending ask.
   * @param text - what the TV should display.
   * @returns the acknowledgement the tool reports.
   */
  function say({ text }) {
    const clean = String(text ?? '').trim()
    if (clean === '') return { ok: false, error: 'text was empty' }
    state.lastReply = { id: state.pendingAsk?.id ?? null, text: clean, at: new Date().toISOString() }
    state.pendingAsk = null
    log('info', `TV display: ${clean.slice(0, 60)}`)
    return { ok: true }
  }

  const picks = () => makePicks(kodi, { limit: settings.picksLimit })

  disposers.push(registerTools(ctx, kodi, log, { say }))

  // ---- TV bridge ----------------------------------------------------------
  let bridge
  const bridgeReady = startBridge({ config: settings, kodi, picks, deliver, log, state })
    .then((started) => {
      bridge = started
      log('info', `TV bridge listening on ${started.url}`)
      return started
    })
    .catch((error) => {
      log('error', `TV bridge did not start: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
  disposers.push(ctx.effect(() => () => {
    void bridgeReady.then((started) => started?.close())
  }, 'dsh-kodi.bridge'))

  // ---- model-facing guidance ---------------------------------------------
  disposers.push(ctx.systemPrompt.section({
    name: 'tool:kodi',
    order: 150,
    text: [
      'The kodi_* tools drive a Kodi media center on the TV: kodi_status, kodi_search, kodi_library, kodi_play, kodi_queue, kodi_transport, kodi_volume, kodi_remote, kodi_notify, kodi_picks, kodi_screenshot, kodi_say.',
      'Playback is a side effect the user sees immediately: confirm what you are about to play, and prefer kodi_play with a specific id from kodi_search over a free-text guess.',
      'kodi_say is the only way text reaches the TV. When a message begins "Someone asked this from the Kodi TV", the user is looking at the TV: keep the answer short, and call kodi_say with it.',
      'kodi_picks ranks in-progress titles first and explains each reason; offer them when the user asks what to watch instead of inventing titles.',
      'When Kodi is unreachable the tools return ok:false with the endpoint and reason; report that instead of retrying blindly.',
    ].join('\n'),
  }))

  return disposers
}
