// dsh-kodi — Web UI panel for the Kodi integration (client half).
//
// A compact card above the composer that keeps the television one glance away
// while working in the laptop UI:
//
//   now playing   title, show/season/episode, progress bar, elapsed/total
//   transport     play/pause, stop, -10 s, +10 s, volume down/up
//   queue         the next three items, numbered
//   picks         three suggestions with the reason the agent chose them
//   ask dsh       one question to the agent, with sending/waiting states and
//                 the agent's answer when it arrives
//   offline       a plain notice while the bridge or Kodi is unreachable
//
// Every fact comes from the TV bridge over HTTP (default
// http://127.0.0.1:8760): GET /health, GET /tv/state, POST /tv/ask,
// GET /tv/reply?after=, POST /tv/action. The bridge authenticates a token
// header only (Authorization: Bearer <token> or X-Bridge-Token: <token>); the
// panel sends the first when localStorage["dsh-kodi-token"] is non-empty and
// sends no auth header otherwise, because a loopback bridge without a token
// expects none. `?token=` in the URL is refused by design, so it is never used.
//
// Polling is bounded on purpose: /tv/state is read at most every 3 s, only
// while the card is mounted, and only while document.visibilityState is
// "visible" — the interval is cleared on unmount and on visibilitychange.
// A pending ask additionally polls /tv/reply?after=<id> at the same cadence
// until the answer arrives or the wait times out.
//
// This file is the package's `./client` entry: a classic script registering a
// lazy factory through the browser module table, so it requests nothing beyond
// the shell-seeded React and cannot break the shared module table. All
// registrations happen inside `apply` on the plugin fiber (styles, the locale
// dictionary, the slot entry); the factory itself only builds the exports.
//
// Copy: every visible string is resolved through the Client locale service
// (namespace `dsh-kodi`). The dictionaries below are the bundle's copy of
// locale/en.json, locale/tr.json and locale/zh.json — a browser bundle cannot
// read its own package files at runtime, so the copies must stay in step; the
// JSON files remain the source of truth for the keys and for the Plugin
// Manager's meta.title/meta.description.

window.__ModuleLoader__.load({
  id: 'dsh-kodi',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const name = 'dsh-kodi'

    /** Slot: full-width entries above the composer card (additive list seat). */
    const SLOT = 'conversation.input.dock'
    /** Entry id inside that list; a fresh id sits beside the shipped docks. */
    const SLOT_ID = 'kodi'
    /** Locale namespace owning this panel's copy. */
    const LOCALE_NS = 'dsh-kodi'
    /** TV bridge base URL; the plugin's bridgePort default is 8760. */
    const BRIDGE = 'http://127.0.0.1:8760'
    /** Optional bridge token; empty means the loopback bridge is unauthenticated. */
    const TOKEN_KEY = 'dsh-kodi-token'
    /** Collapsed-body preference (UI-local, never sent anywhere). */
    const COLLAPSE_KEY = 'dsh-kodi-collapsed'
    /** Slowest cadence the brief allows; state and reply polling share it. */
    const POLL_MS = 3000
    /** A request that hangs must not wedge the card forever. */
    const REQUEST_TIMEOUT_MS = 8000
    /** How long the panel waits for the agent before giving up visibly. */
    const REPLY_TIMEOUT_MS = 120000
    const STYLE_ID = 'dsh-kodi-panel-style'

    /** Per-volume-button and per-seek-step increments. */
    const VOLUME_STEP = 5
    /** Kodi's own ten-second transport steps for the -10 s / +10 s buttons. */
    const SEEK_BACK_STEP = 'smallbackward'
    const SEEK_FORWARD_STEP = 'smallforward'

    /**
     * The panel's copy, nested exactly like locale/en.json, locale/tr.json and
     * locale/zh.json (the plugin manifest's metadata format). `{name}`
     * placeholders are filled by the locale service's translate function, so no
     * visible text is assembled from fragments in JSX.
     */
    const DICTIONARIES = {
      en: {
        meta: {
          title: 'Kodi',
          description: 'Control the Kodi TV, curate the library, and turn the remote into a conversation with the agent.',
        },
        panel: {
          nowPlaying: 'Now playing',
          nothingPlaying: 'Nothing playing',
          paused: 'Paused',
          queue: 'Queue',
          queueEmpty: 'The queue is empty.',
          upNext: 'Up next {n}',
          picks: 'Tonight\'s picks',
          ask: 'Ask DSH',
          askPlaceholder: 'Play something funny for 40 minutes',
          send: 'Send',
          sending: 'Sending to the agent…',
          waiting: 'Waiting for the agent…',
          reply: 'Agent reply',
          askBusy: 'An earlier question is still waiting for the agent.',
          askFailed: 'The question did not reach the agent.',
          askTimeout: 'The agent did not answer in time.',
          offline: 'Kodi is not reachable',
          actionFailed: 'Kodi refused that command.',
          play: 'Play',
          playPause: 'Play or pause',
          stop: 'Stop',
          back10: 'Back 10 seconds',
          forward10: 'Forward 10 seconds',
          volumeDown: 'Volume down',
          volumeUp: 'Volume up',
          progress: 'Playback progress',
          episode: 'S{season}E{episode}',
          collapse: 'Collapse the Kodi panel',
          expand: 'Expand the Kodi panel',
        },
      },
      tr: {
        meta: {
          title: 'Kodi',
          description: 'Kodi televizyonunu yönet, kütüphaneyi düzenle ve kumandayı ajanla sohbete dönüştür.',
        },
        panel: {
          nowPlaying: 'Şimdi oynuyor',
          nothingPlaying: 'Bir şey oynamıyor',
          paused: 'Duraklatıldı',
          queue: 'Kuyruk',
          queueEmpty: 'Kuyruk boş.',
          upNext: 'Sıradaki {n}',
          picks: 'Bu akşamın seçkisi',
          ask: 'DSH\'ye sor',
          askPlaceholder: '40 dakikalık komik bir şey oynat',
          send: 'Gönder',
          sending: 'Ajana gönderiliyor…',
          waiting: 'Ajan bekleniyor…',
          reply: 'Ajan yanıtı',
          askBusy: 'Önceki soru hâlâ ajanın yanıtını bekliyor.',
          askFailed: 'Soru ajana ulaşmadı.',
          askTimeout: 'Ajan zamanında yanıt vermedi.',
          offline: 'Kodi\'ye ulaşılamıyor',
          actionFailed: 'Kodi bu komutu reddetti.',
          play: 'Oynat',
          playPause: 'Oynat veya duraklat',
          stop: 'Durdur',
          back10: '10 saniye geri',
          forward10: '10 saniye ileri',
          volumeDown: 'Sesi azalt',
          volumeUp: 'Sesi artır',
          progress: 'Oynatma ilerlemesi',
          episode: 'S{season}B{episode}',
          collapse: 'Kodi panelini daralt',
          expand: 'Kodi panelini genişlet',
        },
      },
      zh: {
        meta: {
          title: 'Kodi',
          description: '控制 Kodi 电视、整理媒体库,并把遥控器变成与智能体的对话。',
        },
        panel: {
          nowPlaying: '正在播放',
          nothingPlaying: '未在播放',
          paused: '已暂停',
          queue: '播放队列',
          queueEmpty: '播放队列为空。',
          upNext: '接下来 {n}',
          picks: '今晚推荐',
          ask: '询问 DSH',
          askPlaceholder: '播放 40 分钟轻松搞笑的内容',
          send: '发送',
          sending: '正在发送给智能体…',
          waiting: '等待智能体…',
          reply: '智能体回复',
          askBusy: '上一个问题还在等待智能体回答。',
          askFailed: '问题未能送达智能体。',
          askTimeout: '智能体没有及时回答。',
          offline: '无法连接 Kodi',
          actionFailed: 'Kodi 拒绝了这个命令。',
          play: '播放',
          playPause: '播放或暂停',
          stop: '停止',
          back10: '后退 10 秒',
          forward10: '前进 10 秒',
          volumeDown: '降低音量',
          volumeUp: '提高音量',
          progress: '播放进度',
          episode: '第{season}季第{episode}集',
          collapse: '收起 Kodi 面板',
          expand: '展开 Kodi 面板',
        },
      },
    }


    /**
     * Copy one nested dictionary into the flat dotted-key object the client
     * locale service looks up (`locales.get(locale)[key]`, no path walking), so
     * the readable nested form above stays the only hand-maintained source.
     * @param {object} source - nested dictionary.
     * @param {string} [prefix] - key prefix accumulated so far.
     * @param {object} [into] - accumulator.
     * @returns {object} flat `{ 'panel.nowPlaying': '…' }` object.
     */
    function flattenDictionary(source, prefix, into) {
      const target = into === undefined ? {} : into
      const lead = prefix === undefined ? '' : prefix
      for (const [key, value] of Object.entries(source)) {
        const path = lead === '' ? key : `${lead}.${key}`
        if (value !== null && typeof value === 'object') flattenDictionary(value, path, target)
        else target[path] = value
      }
      return target
    }

    /**
     * Flatten every registered locale.
     * @param {Record<string, object>} byLocale - nested dictionaries per locale.
     * @returns {Record<string, object>} flat dictionaries per locale.
     */
    function flattenDictionaries(byLocale) {
      const flat = {}
      for (const [locale, dictionary] of Object.entries(byLocale)) flat[locale] = flattenDictionary(dictionary)
      return flat
    }

    /** Registered copy: flat dotted keys, which is what the locale service reads. */
    const DICTS = flattenDictionaries(DICTIONARIES)

    /**
     * Stylesheet for the card. Only theme aliases are used for colour, so the
     * panel follows light and dark themes and the host's own tokens.
     */
    const CSS = `
      .dsh-kodi-panel {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin: 8px 0;
        padding: 10px 12px;
        box-sizing: border-box;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2));
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1, transparent);
        color: var(--dsw-alias-label-primary, inherit);
        font-size: var(--dsw-font-xs-13-font-size, 13px);
      }
      .dsh-kodi-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .dsh-kodi-heading {
        font-weight: 600;
        font-size: var(--dsw-font-s-14-font-size, 14px);
      }
      .dsh-kodi-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .dsh-kodi-muted {
        color: var(--dsw-alias-label-tertiary, inherit);
      }
      .dsh-kodi-label {
        color: var(--dsw-alias-label-secondary, inherit);
        font-size: var(--dsw-font-xxs-12-font-size, 12px);
      }
      .dsh-kodi-now {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .dsh-kodi-title {
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .dsh-kodi-progress {
        height: 6px;
        border-radius: 999px;
        overflow: hidden;
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.2));
      }
      .dsh-kodi-progress-fill {
        height: 100%;
        border-radius: inherit;
        background: var(--dsw-alias-state-business-primary, currentColor);
        transition: width 0.3s ease;
      }
      .dsh-kodi-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
      }
      .dsh-kodi-transport {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .dsh-kodi-button {
        min-height: 28px;
        padding: 2px 10px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2));
        border-radius: var(--dsw-radius-sm, 8px);
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .dsh-kodi-button:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
      }
      .dsh-kodi-button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .dsh-kodi-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .dsh-kodi-item {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
      }
      .dsh-kodi-index {
        flex: none;
        color: var(--dsw-alias-label-tertiary, inherit);
        font-variant-numeric: tabular-nums;
      }
      .dsh-kodi-ellipsis {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsh-kodi-pick {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
        width: 100%;
        padding: 4px 8px;
        box-sizing: border-box;
        text-align: left;
        border: 1px solid transparent;
        border-radius: var(--dsw-radius-sm, 8px);
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .dsh-kodi-pick:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
        border-color: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2));
      }
      .dsh-kodi-pick:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .dsh-kodi-reason {
        color: var(--dsw-alias-label-tertiary, inherit);
        font-size: var(--dsw-font-xxs-12-font-size, 12px);
      }
      .dsh-kodi-ask {
        display: flex;
        gap: 6px;
      }
      .dsh-kodi-input {
        flex: 1;
        min-width: 0;
        min-height: 28px;
        padding: 2px 8px;
        box-sizing: border-box;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35));
        border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-base, transparent);
        color: inherit;
        font: inherit;
      }
      .dsh-kodi-reply {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .dsh-kodi-notice {
        color: var(--dsw-alias-label-secondary, inherit);
      }
      .dsh-kodi-error {
        color: var(--dsw-alias-state-error-primary, inherit);
      }
    `

    /** Bound translate function installed by `apply` (locale service). */
    let translate = (key) => key

    /**
     * Read the optional bridge token. Storage can be unavailable (private mode
     * or a policy) — that is the same situation as "no token configured".
     * @returns the token, or '' when none is stored.
     */
    function bridgeToken() {
      try {
        return window.localStorage.getItem(TOKEN_KEY) ?? ''
      } catch {
        return ''
      }
    }

    /**
     * Headers for one bridge request: JSON in and out, plus the bearer token
     * when one is stored (the bridge compares token headers only).
     * @param {Record<string, string>} extra - additional headers.
     * @returns {Record<string, string>} the request headers.
     */
    function bridgeHeaders(extra) {
      const headers = Object.assign({ accept: 'application/json' }, extra)
      const token = bridgeToken()
      if (token !== '') headers.authorization = `Bearer ${token}`
      return headers
    }

    /**
     * Abort a request that does not answer in time, so one hung socket cannot
     * stall the panel. Browsers without AbortSignal.timeout simply do not time
     * out the request.
     * @returns {AbortSignal|undefined} the timeout signal.
     */
    function timeoutSignal() {
      if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
      return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }

    /**
     * Perform one bridge request and parse its JSON body.
     * @param {string} pathWithQuery - path and query, starting with '/'.
     * @param {object} [init] - fetch init (method, body).
     * @returns {Promise<any>} the parsed body.
     * @throws {Error} with `.status` and `.body` when the bridge refuses.
     */
    async function bridgeFetch(pathWithQuery, init) {
      const settings = Object.assign({ method: 'GET', cache: 'no-store' }, init)
      settings.headers = bridgeHeaders(settings.body === undefined ? {} : { 'content-type': 'application/json' })
      const signal = timeoutSignal()
      if (signal !== undefined) settings.signal = signal
      const response = await fetch(`${BRIDGE}${pathWithQuery}`, settings)
      let body = null
      try {
        body = await response.json()
      } catch {
        // A non-JSON body is still a failed request; the status decides.
        body = null
      }
      if (!response.ok) {
        const error = new Error(`bridge answered ${response.status} for ${pathWithQuery}`)
        error.status = response.status
        error.body = body
        throw error
      }
      return body
    }

    /**
     * @param {string} pathWithQuery - bridge read path.
     * @returns {Promise<any>} parsed body.
     */
    function bridgeGet(pathWithQuery) {
      return bridgeFetch(pathWithQuery)
    }

    /**
     * @param {string} pathWithQuery - bridge mutating path.
     * @param {object} payload - JSON body.
     * @returns {Promise<any>} parsed body.
     */
    function bridgePost(pathWithQuery, payload) {
      return bridgeFetch(pathWithQuery, { method: 'POST', body: JSON.stringify(payload) })
    }

    /**
     * Post one allow-listed transport/volume action.
     * @param {string} action - playpause | play | pause | stop | seek | volume | mute.
     * @param {unknown} [value] - action payload (step name, {delta}, {kind,id}).
     * @returns {Promise<any>} parsed body.
     */
    function postAction(action, value) {
      return bridgePost('/tv/action', value === undefined ? { action } : { action, value })
    }

    /**
     * Read a duration that may arrive as seconds or as a "h:mm:ss" string.
     * @param {unknown} value - candidate duration.
     * @returns {number|null} seconds, or null when unparseable.
     */
    function secondsOf(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      if (typeof value !== 'string') return null
      const text = value.trim()
      if (text === '') return null
      if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
      const parts = text.split(':')
      if (parts.length < 2 || parts.length > 3) return null
      let total = 0
      for (const part of parts) {
        const number = Number(part)
        if (!Number.isFinite(number)) return null
        total = total * 60 + number
      }
      return total
    }

    /**
     * Format a duration as the clock form a player shows.
     * @param {unknown} value - seconds or "h:mm:ss".
     * @returns {string} "m:ss" or "h:mm:ss"; '' when unknown.
     */
    function formatTime(value) {
      const seconds = secondsOf(value)
      if (seconds === null || seconds < 0) return ''
      const total = Math.floor(seconds)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const rest = total % 60
      const pad = (number) => String(number).padStart(2, '0')
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
    }

    /**
     * @param {number} value - raw percentage.
     * @returns {number} the same percentage clamped to 0..100 and rounded.
     */
    function percentOf(value) {
      return Math.max(0, Math.min(100, Math.round(value)))
    }

    /**
     * @param {...unknown} values - candidates in priority order.
     * @returns {number|null} the first finite number.
     */
    function firstNumber(...values) {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return null
    }

    /**
     * Playback progress for the bar, from either wire form: the bridge reports
     * `nowPlaying.position` as seconds next to `item.runtime`, while a richer
     * position object may carry `percent` (or elapsed/total) directly.
     * @param {any} nowPlaying - the bridge's nowPlaying record.
     * @returns {number|null} 0..100, or null when the length is unknown.
     */
    function progressOf(nowPlaying) {
      if (nowPlaying === null || typeof nowPlaying !== 'object') return null
      // The bridge sends Kodi's own percentage (0..100) beside the elapsed
      // seconds; read it first and keep the derived forms for other senders.
      const direct = firstNumber(nowPlaying.percentage, nowPlaying.percent)
      if (direct !== null) return percentOf(direct)
      const raw = nowPlaying.position
      if (raw !== null && typeof raw === 'object') {
        const percent = firstNumber(raw.percent, raw.percentage, raw.pct)
        if (percent !== null) return percentOf(percent)
        const elapsed = secondsOf(raw.elapsed ?? raw.seconds ?? raw.time)
        const total = secondsOf(raw.total ?? raw.duration)
        if (elapsed !== null && total !== null && total > 0) return percentOf((elapsed / total) * 100)
        return null
      }
      const position = secondsOf(raw)
      const total = secondsOf(nowPlaying.totaltime) ?? secondsOf(nowPlaying.item?.runtime)
      if (position === null || total === null || total <= 0) return null
      return percentOf((position / total) * 100)
    }

    /**
     * @param {any} item - a normalized Kodi item.
     * @returns {string} the best human title available, '' when none.
     */
    function titleOf(item) {
      if (item === null || typeof item !== 'object') return ''
      for (const candidate of [item.title, item.label]) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
      }
      return ''
    }

    /**
     * Show name plus season/episode, with the season/episode pattern coming from
     * the locale dictionary so the notation is not hardcoded English.
     * @param {any} item - a normalized Kodi item.
     * @param {(key: string, params?: object) => string} t - translate function.
     * @returns {string} the secondary line, '' when the item has neither part.
     */
    function subtitleOf(item, t) {
      if (item === null || typeof item !== 'object') return ''
      const parts = []
      if (typeof item.show === 'string' && item.show.trim() !== '') parts.push(item.show)
      const season = item.season
      const episode = item.episode
      if (season !== null && season !== undefined || episode !== null && episode !== undefined) {
        parts.push(t('panel.episode', {
          season: season ?? '?',
          episode: episode ?? '?',
        }))
      }
      return parts.join(' · ')
    }

    /**
     * Poll the bridge while the component is mounted and the document visible.
     * The interval is the only timer the panel owns: it is created when the
     * card becomes visible and cleared on unmount or when the tab is hidden.
     * @returns {{phase: string, health: any, state: any, error: string|null}} the latest read.
     */
    function useBridgeState() {
      const [reading, setReading] = React.useState({ phase: 'loading', health: null, state: null, error: null })

      React.useEffect(() => {
        let disposed = false
        let timer = null
        let inFlight = false

        const read = async () => {
          if (inFlight) return
          inFlight = true
          try {
            const [health, state] = await Promise.all([bridgeGet('/health'), bridgeGet('/tv/state')])
            if (disposed) return
            setReading({ phase: 'ready', health, state, error: null })
          } catch (error) {
            if (disposed) return
            setReading({ phase: 'offline', health: null, state: null, error: error instanceof Error ? error.message : String(error) })
          } finally {
            inFlight = false
          }
        }

        const start = () => {
          if (timer !== null) return
          void read()
          timer = window.setInterval(() => { void read() }, POLL_MS)
        }

        const stop = () => {
          if (timer === null) return
          window.clearInterval(timer)
          timer = null
        }

        const onVisibility = () => {
          if (document.visibilityState === 'visible') start()
          else stop()
        }

        if (document.visibilityState === 'visible') start()
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
          disposed = true
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      return reading
    }

    /**
     * One question to the agent, with the two in-flight states and the answer.
     * A pending ask polls /tv/reply?after=<id> at the shared cadence; the wait
     * ends on the answer, on the timeout, or when the component unmounts.
     * @param {(key: string, params?: object) => string} t - translate function.
     * @param {string|null} externalPendingId - id of an ask another surface left
     *   waiting (the bridge's `pendingAsk`); the panel waits for its answer too
     *   instead of discovering the refusal with a 429.
     * @returns {object} the ask state, the effective pending id, and submit.
     */
    function useAsk(t, externalPendingId) {
      const [status, setStatus] = React.useState('idle')
      const [askId, setAskId] = React.useState(null)
      const [reply, setReply] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      // The locale seat is a new function on every locale revision; the pending
      // ask must not restart its wait when the language changes.
      const translateRef = React.useRef(t)
      translateRef.current = t

      const pendingId = askId === null ? externalPendingId : askId

      React.useEffect(() => {
        if (pendingId === null) return undefined
        let disposed = false
        let timer = null
        const startedAt = Date.now()

        const poll = async () => {
          try {
            const body = await bridgeGet(`/tv/reply?after=${encodeURIComponent(pendingId)}`)
            if (disposed) return
            const answer = body?.reply
            if (answer !== null && typeof answer === 'object' && typeof answer.text === 'string') {
              setReply(answer)
              setStatus('idle')
              setAskId(null)
              return
            }
            if (Date.now() - startedAt > REPLY_TIMEOUT_MS) {
              setError(translateRef.current('panel.askTimeout'))
              setStatus('idle')
              setAskId(null)
            }
          } catch {
            // A refused poll is transient: the next tick retries, and the
            // /tv/state read in the parent already shows an offline notice.
          }
        }

        void poll()
        timer = window.setInterval(() => { void poll() }, POLL_MS)

        return () => {
          disposed = true
          if (timer !== null) window.clearInterval(timer)
        }
      }, [pendingId])

      const submit = React.useCallback(async () => {
        const clean = String(draft ?? '').trim()
        if (clean === '' || status !== 'idle' || externalPendingId !== null) return
        setError(null)
        setStatus('sending')
        try {
          const body = await bridgePost('/tv/ask', { text: clean })
          const id = body?.id
          if (id === null || id === undefined) {
            setStatus('idle')
            return
          }
          // Accepted: the text now lives in the bridge's pending ask.
          setDraft('')
          setAskId(String(id))
          setStatus('waiting')
        } catch (failure) {
          // 429 means an earlier ask is still unanswered: adopt it and wait,
          // which is what the viewer's next question would do anyway.
          const pendingId = failure?.body?.pending?.id
          if (failure?.status === 429 && pendingId !== null && pendingId !== undefined) {
            setAskId(String(pendingId))
            setStatus('waiting')
            return
          }
          setStatus('idle')
          setError(failure?.status === 429 ? t('panel.askBusy') : t('panel.askFailed'))
        }
      }, [draft, externalPendingId, status, t])

      return { status, reply, error, draft, setDraft, submit, pendingId }
    }

    /**
     * Collapsed-body preference. The card sits above the composer in every
     * session, so the viewer can fold it away; the choice survives a reload.
     * @returns {[boolean, () => void]} collapsed flag and its toggle.
     */
    function useCollapsed() {
      const [collapsed, setCollapsed] = React.useState(() => {
        try {
          return window.localStorage.getItem(COLLAPSE_KEY) === '1'
        } catch {
          return false
        }
      })
      const toggle = React.useCallback(() => {
        setCollapsed((previous) => {
          const next = !previous
          try {
            window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
          } catch {
            // Storage is unavailable; the fold still applies for this render.
          }
          return next
        })
      }, [])
      return [collapsed, toggle]
    }

    /**
     * One transport button.
     * @param {object} props - label, disabled flag, click handler.
     * @returns {object} the button element.
     */
    function TransportButton({ label, disabled, onClick }) {
      return h('button', {
        type: 'button',
        className: 'dsh-kodi-button',
        'aria-label': label,
        title: label,
        disabled,
        onClick,
      }, label)
    }

    /**
     * The panel card.
     * @param {object} props - framework props; `t` is the locale seat.
     * @returns {object} the card element.
     */
    function KodiPanel(props) {
      const t = typeof props.t === 'function' ? props.t : translate
      const reading = useBridgeState()
      const [collapsed, toggleCollapsed] = useCollapsed()
      const [actionError, setActionError] = React.useState(false)
      // One question at a time: our own ask, or one the TV or another surface
      // left pending (the bridge reports it, so the 429 becomes a fallback).
      const pendingAskId = typeof reading.state?.pendingAsk?.id === 'string' && reading.state.pendingAsk.id !== ''
        ? reading.state.pendingAsk.id
        : null
      const ask = useAsk(t, pendingAskId)

      const state = reading.state
      const health = reading.health
      const nowPlaying = state?.nowPlaying ?? null
      const item = nowPlaying?.item ?? null
      // The queue includes the playing item. `queueCurrent` is the bridge's own
      // 1-based position of it — duplicate-aware (it reports null exactly when
      // the same kind+id appears twice), so it leads. When it is absent, a
      // unique kind+id match identifies the item; with several copies and no
      // hint the position is genuinely unknowable, so the first entry is taken
      // as the current one. "Up next" starts immediately after it.
      const queueAll = Array.isArray(state?.queue) ? state.queue : []
      const playingId = item === null || item === undefined ? null : item.id ?? null
      const playingKind = item === null || item === undefined ? null : item.kind ?? null
      const matches = playingId === null
        ? []
        : queueAll.reduce((found, entry, index) => (
          entry?.id === playingId && (playingKind === null || entry?.kind === playingKind)
            ? found.concat(index)
            : found
        ), [])
      const hinted = typeof state?.queueCurrent === 'number' && Number.isFinite(state.queueCurrent)
        ? Math.max(0, state.queueCurrent)
        : 0
      const queueStart = hinted > 0
        ? hinted
        : matches.length === 1 ? matches[0] + 1 : (nowPlaying === null ? 0 : 1)
      const queue = queueAll.slice(queueStart, queueStart + 3)
      const picks = Array.isArray(state?.picks) ? state.picks.slice(0, 3) : []
      const bridgeUp = reading.phase === 'ready'
      // /health is the authoritative connection verdict; /tv/state repeats it.
      const kodiUp = bridgeUp && (health?.kodi === undefined || health?.kodi === null
        ? state?.connected === true
        : health.kodi.connected === true)
      const offline = !bridgeUp || !kodiUp
      const percent = progressOf(nowPlaying)
      const position = nowPlaying === null || typeof nowPlaying !== 'object' ? null : secondsOf(nowPlaying.position)
      const runtime = nowPlaying === null || typeof nowPlaying !== 'object'
        ? null
        : (secondsOf(nowPlaying.totaltime) ?? (item === null || typeof item !== 'object' ? null : secondsOf(item.runtime)))
      const playing = nowPlaying?.playing === true
      const title = titleOf(item)
      const subtitle = subtitleOf(item, t)
      const elapsedText = formatTime(position)
      const totalText = formatTime(runtime)
      const timingText = elapsedText !== '' && totalText !== ''
        ? `${elapsedText} / ${totalText}`
        : elapsedText !== '' ? elapsedText : totalText

      const transport = (action, value) => {
        setActionError(false)
        void postAction(action, value).catch(() => { setActionError(true) })
      }

      const playPick = (pick) => {
        setActionError(false)
        // The bridge's play action takes the library target; without it the
        // television keeps whatever it was already playing.
        void postAction('play', { kind: pick.kind, id: pick.id }).catch(() => { setActionError(true) })
      }

      const askBusy = ask.status !== 'idle' || ask.pendingId !== null
      // Transport and picks need a reachable Kodi; only the ask box also waits
      // for the previous question's answer.
      const controlsDisabled = offline
      const askDisabled = offline || askBusy

      const header = h('div', { className: 'dsh-kodi-header' },
        h('span', { className: 'dsh-kodi-heading' }, t('meta.title')),
        h('button', {
          type: 'button',
          className: 'dsh-kodi-button',
          'aria-expanded': collapsed ? 'false' : 'true',
          'aria-label': t(collapsed ? 'panel.expand' : 'panel.collapse'),
          title: t(collapsed ? 'panel.expand' : 'panel.collapse'),
          onClick: toggleCollapsed,
        }, collapsed ? '▸' : '▾'),
      )

      const nowPlayingRow = h('div', { className: 'dsh-kodi-now' },
        h('span', { className: 'dsh-kodi-label' }, t('panel.nowPlaying')),
        title === ''
          ? h('span', { className: 'dsh-kodi-muted' }, t('panel.nothingPlaying'))
          : h('span', { className: 'dsh-kodi-title' }, title),
        subtitle === '' ? null : h('span', { className: 'dsh-kodi-muted' }, subtitle),
        title !== '' && !playing ? h('span', { className: 'dsh-kodi-muted' }, t('panel.paused')) : null,
        percent === null ? null : h('div', {
          className: 'dsh-kodi-progress',
          role: 'progressbar',
          'aria-label': t('panel.progress'),
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': percent,
        }, h('div', { className: 'dsh-kodi-progress-fill', style: { width: `${percent}%` } })),
        timingText === '' ? null : h('span', { className: 'dsh-kodi-muted' }, timingText),
      )

      const transportRow = h('div', { className: 'dsh-kodi-transport' },
        h(TransportButton, {
          label: t('panel.playPause'),
          disabled: controlsDisabled,
          onClick: () => { transport('playpause') },
        }),
        h(TransportButton, {
          label: t('panel.stop'),
          disabled: controlsDisabled,
          onClick: () => { transport('stop') },
        }),
        h(TransportButton, {
          label: t('panel.back10'),
          disabled: controlsDisabled,
          onClick: () => { transport('seek', SEEK_BACK_STEP) },
        }),
        h(TransportButton, {
          label: t('panel.forward10'),
          disabled: controlsDisabled,
          onClick: () => { transport('seek', SEEK_FORWARD_STEP) },
        }),
        h(TransportButton, {
          label: t('panel.volumeDown'),
          disabled: controlsDisabled,
          onClick: () => { transport('volume', { delta: -VOLUME_STEP }) },
        }),
        h(TransportButton, {
          label: t('panel.volumeUp'),
          disabled: controlsDisabled,
          onClick: () => { transport('volume', { delta: VOLUME_STEP }) },
        }),
      )

      const queueSection = queue.length === 0 ? null : h('div', null,
        h('span', { className: 'dsh-kodi-label' }, t('panel.queue')),
        h('ul', { className: 'dsh-kodi-list' },
          queue.map((entry, index) => h('li', { key: `${entry?.id ?? 'item'}-${index}`, className: 'dsh-kodi-item' },
            h('span', { className: 'dsh-kodi-index' }, t('panel.upNext', { n: index + 1 })),
            h('span', { className: 'dsh-kodi-ellipsis' }, titleOf(entry) || ''),
          )),
        ),
      )

      const picksSection = picks.length === 0 ? null : h('div', null,
        h('span', { className: 'dsh-kodi-label' }, t('panel.picks')),
        h('ul', { className: 'dsh-kodi-list' },
          picks.map((pick, index) => h('li', { key: `${pick?.id ?? 'pick'}-${index}` },
            h('button', {
              type: 'button',
              className: 'dsh-kodi-pick',
              disabled: controlsDisabled,
              onClick: () => { playPick(pick) },
            },
            h('span', { className: 'dsh-kodi-ellipsis' }, pick?.title ?? ''),
            typeof pick?.reason === 'string' && pick.reason !== ''
              ? h('span', { className: 'dsh-kodi-reason' }, pick.reason)
              : null,
            ),
          )),
        ),
      )

      const askSection = h('div', null,
        h('span', { className: 'dsh-kodi-label' }, t('panel.ask')),
        h('form', {
          className: 'dsh-kodi-ask',
          onSubmit: (event) => {
            event.preventDefault()
            void ask.submit()
          },
        },
        h('input', {
          className: 'dsh-kodi-input',
          type: 'text',
          name: 'question',
          value: ask.draft,
          placeholder: t('panel.askPlaceholder'),
          'aria-label': t('panel.ask'),
          disabled: askDisabled,
          onChange: (event) => { ask.setDraft(event.target.value) },
        }),
        h('button', {
          type: 'submit',
          className: 'dsh-kodi-button',
          disabled: askDisabled,
        }, t('panel.send')),
        ),
        ask.status === 'sending'
          ? h('span', { className: 'dsh-kodi-muted' }, t('panel.sending'))
          : (ask.pendingId === null ? null : h('span', { className: 'dsh-kodi-muted' }, t('panel.waiting'))),
        ask.error === null ? null : h('span', { className: 'dsh-kodi-error' }, ask.error),
        ask.reply === null ? null : h('div', null,
          h('span', { className: 'dsh-kodi-label' }, t('panel.reply')),
          h('p', { className: 'dsh-kodi-reply' }, ask.reply.text),
        ),
      )

      const body = collapsed ? null : h('div', { className: 'dsh-kodi-body' },
        offline ? h('span', { className: 'dsh-kodi-error', role: 'status' }, t('panel.offline')) : null,
        nowPlayingRow,
        transportRow,
        actionError ? h('span', { className: 'dsh-kodi-error' }, t('panel.actionFailed')) : null,
        queueSection,
        picksSection,
        askSection,
      )

      return h('section', {
        className: 'dsh-kodi-panel',
        role: 'region',
        'aria-label': t('meta.title'),
      }, header, body)
    }

    /**
     * Attach the panel's stylesheet, replacing a copy left by an earlier
     * generation so HMR cannot stack two stylesheets.
     * @returns {() => void} cleanup removing this element.
     */
    function injectStyles() {
      if (typeof document === 'undefined') return () => {}
      const previous = document.getElementById(STYLE_ID)
      if (previous !== null) previous.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    /**
     * Plugin body: register every resource on the fiber and mount the card into
     * the composer dock. Each registration is owned by this fiber, so disabling
     * the plugin removes the stylesheet, the dictionary and the entry.
     * @param {object} ctx - client cordis context.
     * @returns {void}
     */
    function apply(ctx) {
      if (typeof document === 'undefined') return

      ctx.effect(() => injectStyles(), 'dsh-kodi panel styles')
      ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTS), 'dsh-kodi panel dictionaries')

      translate = ctx.locale.bind(LOCALE_NS)

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: SLOT_ID,
        order: 20,
        locale: LOCALE_NS,
      }, KodiPanel))

      // Small surface for tests and for a future host tool to inspect the
      // panel's pure decisions without rendering it.
      window.__dshKodiPanel = {
        slot: SLOT,
        localeNamespace: LOCALE_NS,
        bridgeUrl: BRIDGE,
        formatTime,
        progressOf,
        secondsOf,
        titleOf,
        subtitleOf,
      }
    }

    exports.name = name
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
