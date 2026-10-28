/**
 * Unit spec for the twelve `kodi_*` agent tools.
 *
 * The boundary under test is the tool surface, not Kodi: a plain fake service
 * object stands in for KodiService (its shape is CONTRACTS.md § src/kodi-service.mjs)
 * and `hooks.makePicks` stands in for src/recommend.mjs, so this spec passes
 * whether or not the bridge modules have landed. tests/mock-kodi.mjs is the
 * fixture for the JSON-RPC and service specs; it is the wrong level here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerTools, TOOL_NAMES } from '../src/tools.mjs'

/** One normalized library item, in the shape the service promises. */
const MOVIE = Object.freeze({
  id: 1,
  kind: 'movie',
  label: 'Big Buck Bunny',
  title: 'Big Buck Bunny',
  subtitle: null,
  year: 2008,
  runtime: 596,
  thumbnail: null,
  file: '/media/movies/big-buck-bunny.mkv',
  show: null,
  season: null,
  episode: null,
})

/** Capture registrations and disposals exactly as ToolsService would. */
function makeContext() {
  const registry = new Map()
  const disposals = []
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(typeof definition.name, 'string')
        assert.ok(!registry.has(definition.name), `duplicate registration: ${definition.name}`)
        registry.set(definition.name, definition)
        return () => {
          disposals.push(definition.name)
          registry.delete(definition.name)
        }
      },
    },
  }
  return { ctx, registry, disposals }
}

/** Methods the service exposes asynchronously; every call is recorded. */
const ASYNC_METHODS = new Set([
  'status', 'search', 'library', 'play', 'queueList', 'queue',
  'transport', 'volume', 'remote', 'notify', 'screenshot',
])

/**
 * A fake Kodi service. Overrides replace one method; every asynchronous call is
 * appended to `calls` as `[method, ...args]` so tests can prove what was asked.
 */
function makeKodi(overrides = {}, calls = []) {
  const implementation = {
    endpoint: 'http://127.0.0.1:8080/jsonrpc',
    status: async () => ({
      connected: true,
      version: '21.1',
      updatedAt: '2026-10-28T12:00:00Z',
      playing: true,
      item: MOVIE,
      position: 72,
      speed: 1,
      volume: 65,
      muted: false,
      queue: [MOVIE],
      libraryCounts: { movies: 12, episodes: 40 },
    }),
    search: async () => ({ results: [MOVIE] }),
    library: async () => ({ items: [MOVIE], total: 1 }),
    play: async () => ({ ok: true, playing: true }),
    // `current` is 1-based, as the service reports it.
    queueList: async () => ({ items: [MOVIE], current: 1 }),
    queue: async () => ({ ok: true, length: 1, current: 1 }),
    transport: async () => ({ ok: true, playing: false, position: 72, speed: 1 }),
    volume: async () => ({ ok: true, volume: 65, muted: false }),
    remote: async () => ({ ok: true }),
    notify: async () => ({ ok: true }),
    screenshot: async () => ({ path: 'special://temp/screenshot0001.png', file: null }),
    snapshot: () => ({ item: MOVIE }),
    ...overrides,
  }
  const kodi = {}
  for (const [key, value] of Object.entries(implementation)) {
    kodi[key] = ASYNC_METHODS.has(key)
      ? async (...args) => {
        calls.push([key, ...args])
        return value(...args)
      }
      : value
  }
  return kodi
}

/** Register the tools against a fake service and hand back the registry. */
function setup({ overrides = {}, hooks, kodi, log } = {}) {
  const context = makeContext()
  const calls = []
  const service = kodi ?? makeKodi(overrides, calls)
  const dispose = registerTools(context.ctx, service, log, hooks)
  return { ...context, calls, dispose, kodi: service, tool: (name) => context.registry.get(name) }
}

/** Execute one tool with arguments and return its canonical value. */
async function run(harness, name, args = {}) {
  const definition = harness.registry.get(name)
  assert.ok(definition, `${name} is not registered`)
  return definition.execute(args, {})
}

/** Render one completed call as the model would see it. */
function render(harness, name, args, value) {
  const blocks = harness.registry.get(name).output.render(args, value)
  assert.ok(Array.isArray(blocks), 'render must return an array of content blocks')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(typeof blocks[0].text, 'string')
  return blocks[0].text
}

// ---- registration ---------------------------------------------------------

test('registers exactly the twelve kodi tools', () => {
  const harness = setup()
  assert.equal(harness.registry.size, 12)
  assert.deepEqual(
    [...harness.registry.keys()],
    [...TOOL_NAMES],
    'registration order and names must match the documented surface',
  )
  assert.deepEqual(
    [...TOOL_NAMES].sort(),
    [
      'kodi_library', 'kodi_notify', 'kodi_picks', 'kodi_play', 'kodi_queue',
      'kodi_remote', 'kodi_say', 'kodi_screenshot', 'kodi_search', 'kodi_status',
      'kodi_transport', 'kodi_volume',
    ],
    'TOOL_NAMES must be the twelve names CONTRACTS.md lists',
  )
})

test('every tool declares a valid parameter schema and the contracted result envelope', () => {
  const harness = setup()
  for (const [name, definition] of harness.registry) {
    const { parameters } = definition
    assert.equal(parameters.type, 'object', `${name} parameters must be an object schema`)
    assert.equal(typeof parameters.properties, 'object', `${name} must declare properties`)
    assert.equal(parameters.additionalProperties, false, `${name} must reject undeclared arguments`)
    if (parameters.required !== undefined) {
      assert.ok(Array.isArray(parameters.required), `${name} required must be an array`)
      for (const key of parameters.required) {
        assert.ok(
          Object.hasOwn(parameters.properties, key),
          `${name} requires "${key}" but does not declare it`,
        )
      }
    }
    // Every declared property must be one of the keywords the harness enforces
    // (a oneOf union is allowed when every branch is a supported scalar type).
    const scalar = ['string', 'integer', 'number', 'boolean']
    for (const [key, node] of Object.entries(parameters.properties)) {
      const branches = node.type === undefined && Array.isArray(node.oneOf) ? node.oneOf : [node]
      assert.ok(branches.length > 0, `${name}.${key} declares no type`)
      for (const branch of branches) {
        assert.ok(
          [...scalar, 'array'].includes(branch.type),
          `${name}.${key} has unsupported schema type ${String(branch.type)}`,
        )
      }
      assert.equal(typeof node.description, 'string', `${name}.${key} needs a description`)
      assert.ok(node.description.length > 10, `${name}.${key} description is too thin`)
    }

    assert.deepEqual(definition.output.schema, {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: true,
    })
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('descriptions name what happens on the TV, never the transport', () => {
  const harness = setup()
  const transportVocabulary = /\b(jsonrpc|json-rpc|http|https|endpoint|rpc|api|socket|payload)\b/i
  for (const [name, definition] of harness.registry) {
    const description = definition.description
    assert.equal(typeof description, 'string', `${name} needs a description`)
    assert.ok(description.length >= 60, `${name} description is too thin to guide a model`)
    assert.match(description, /^[A-Z]/, `${name} description must start like a sentence`)
    assert.match(description, /\.$/, `${name} description must end with a period`)
    assert.doesNotMatch(description, transportVocabulary, `${name} description leaks transport vocabulary`)
  }
  assert.match(harness.registry.get('kodi_play').description, /Start playback on the TV/)
  assert.match(harness.registry.get('kodi_say').description, /Show a message on the TV/)
})

test('the disposer unregisters every tool exactly once', () => {
  const harness = setup()
  assert.equal(harness.registry.size, 12)
  assert.equal(harness.disposals.length, 0)

  harness.dispose()
  assert.equal(harness.disposals.length, 12, 'every registration must be disposed')
  assert.deepEqual([...harness.disposals].sort(), [...TOOL_NAMES].sort())
  assert.equal(harness.registry.size, 0)

  harness.dispose()
  assert.equal(harness.disposals.length, 12, 'a second dispose must not double-dispose')
})

test('registration refuses a context without a tool registry', () => {
  assert.throws(() => registerTools({}, makeKodi()), /ctx\.tools\.register/)
  assert.throws(() => registerTools({ tools: { register() {} } }, null), /Kodi service/)
})

test('a registration failure leaves nothing half-registered', () => {
  const disposed = []
  let calls = 0
  const ctx = {
    tools: {
      register() {
        calls += 1
        const id = calls
        if (id === 2) throw new Error('tool "kodi_search" is already registered')
        return () => disposed.push(id)
      },
    },
  }
  assert.throws(() => registerTools(ctx, makeKodi()), /already registered/)
  assert.deepEqual(disposed, [1], 'the tool registered before the failure must be disposed')
})

// ---- list truncation ------------------------------------------------------

test('kodi_search summarizes at most ten rows and counts the remainder', async () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    ...MOVIE,
    id: index + 1,
    title: `Library title ${index + 1}`,
  }))
  const harness = setup({ overrides: { search: async () => ({ results: many }) } })

  const result = await run(harness, 'kodi_search', { query: 'library' })
  assert.equal(result.ok, true)
  assert.equal(result.query, 'library')
  assert.equal(result.count, 25)
  assert.equal(result.results.length, 25, 'the structured value keeps every row')

  const text = render(harness, 'kodi_search', { query: 'library' }, result)
  const lines = text.split('\n')
  assert.equal(lines[0], '25 matches for "library":')
  assert.equal(lines.filter((line) => /^\d+\. /.test(line)).length, 10)
  assert.ok(lines.includes('… and 15 more'), `missing remainder line in:\n${text}`)
  assert.ok(!text.includes('11. '), 'row eleven must not be rendered')
  assert.doesNotMatch(text, /[{}]/, 'the summary must not be a JSON dump')
})

test('kodi_library renders a page header and truncates long sections', async () => {
  const items = Array.from({ length: 14 }, (_, index) => ({ ...MOVIE, id: index + 1, title: `Movie ${index + 1}` }))
  const harness = setup({ overrides: { library: async () => ({ items, total: 120 }) } })

  const result = await run(harness, 'kodi_library', { kind: 'movies' })
  assert.equal(result.ok, true)
  assert.equal(result.total, 120)
  assert.equal(result.start, 0)

  const text = render(harness, 'kodi_library', { kind: 'movies' }, result)
  assert.equal(text.split('\n')[0], 'Movies 1–14 of 120:')
  assert.equal(text.split('\n').filter((line) => /^\d+\. /.test(line)).length, 10)
  assert.match(text, /… and 4 more/)
})

// ---- playback resolution --------------------------------------------------

test('kodi_play refuses an ambiguous phrase and lists the candidates', async () => {
  const results = [
    { ...MOVIE, id: 11, title: 'Big Buck Bunny' },
    { ...MOVIE, id: 12, title: 'Bunny Girl' },
    { ...MOVIE, id: 13, title: 'Bunny and Clyde' },
  ]
  const harness = setup({ overrides: { search: async () => ({ results }) } })

  const result = await run(harness, 'kodi_play', { query: 'bunny' })
  assert.equal(result.ok, false)
  assert.match(result.error, /matches 3 different titles/)
  assert.match(result.error, /Say which one you mean/)
  assert.equal(result.candidates.length, 3)
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), [11, 12, 13])
  assert.deepEqual(result.candidates.map((candidate) => candidate.title), ['Big Buck Bunny', 'Bunny Girl', 'Bunny and Clyde'])

  // Nothing was played on a guess, and the refusal reaches the model as prose.
  assert.equal(harness.calls.filter(([method]) => method === 'play').length, 0)
  const text = render(harness, 'kodi_play', { query: 'bunny' }, result)
  assert.match(text, /matches 3 different titles/)
})

test('kodi_play plays the one exact title match among several results', async () => {
  const results = [
    { ...MOVIE, id: 21, title: 'Bunny' },
    { ...MOVIE, id: 22, title: 'Bunny Girl' },
  ]
  const harness = setup({ overrides: { search: async () => ({ results }) } })

  const result = await run(harness, 'kodi_play', { query: 'Bunny' })
  assert.equal(result.ok, true)
  assert.equal(result.title, 'Bunny')
  assert.deepEqual(result.target, { kind: 'movie', id: 21 })

  const plays = harness.calls.filter(([method]) => method === 'play')
  assert.equal(plays.length, 1)
  assert.deepEqual(plays[0][1], { kind: 'movie', id: 21 })
  assert.deepEqual(plays[0][2], { queue: false })

  const text = render(harness, 'kodi_play', { query: 'Bunny' }, result)
  assert.equal(text, 'Playing "Bunny" on the TV.')
})

test('kodi_play plays by id and can queue instead, and needs a target otherwise', async () => {
  const harness = setup()

  const byId = await run(harness, 'kodi_play', { kind: 'episode', id: 7 })
  assert.equal(byId.ok, true)
  assert.deepEqual(harness.calls.at(-1), ['play', { kind: 'episode', id: 7 }, { queue: false }])

  const queued = await run(harness, 'kodi_play', { file: '/media/clip.mp4', queue: true })
  assert.equal(queued.ok, true)
  assert.equal(queued.queued, true)
  assert.deepEqual(harness.calls.at(-1), ['play', { file: '/media/clip.mp4' }, { queue: true }])
  assert.match(render(harness, 'kodi_play', {}, queued), /^Queued /)

  const empty = await run(harness, 'kodi_play', {})
  assert.equal(empty.ok, false)
  assert.match(empty.error, /needs one of: query, id with kind, or file/)
})

test('kodi_play does not claim playback the service says did not start', async () => {
  // Player.Open is asynchronous on real Kodi; the service must say when no
  // player appeared, and the tool must report that instead of "Playing ...".
  const harness = setup({
    overrides: {
      play: async () => ({ ok: true, playing: false }),
    },
  })

  const result = await run(harness, 'kodi_play', { id: 9 })
  assert.equal(result.ok, false)
  assert.match(result.error, /Kodi accepted the request, but no player started/)
  assert.match(render(harness, 'kodi_play', {}, result), /no player started/)

  // A queued add is still a success while the TV is idle.
  const queued = await run(harness, 'kodi_play', { id: 9, queue: true })
  assert.equal(queued.ok, true)
  assert.equal(queued.queued, true)
})

// ---- the unreachable path -------------------------------------------------

test('an unreachable Kodi returns the fixed sentence instead of throwing', async () => {
  const harness = setup({
    overrides: {
      status: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
          kind: 'transport',
          code: 'ECONNREFUSED',
        })
      },
    },
  })

  const result = await run(harness, 'kodi_status', {})
  assert.deepEqual(result, {
    ok: false,
    error: 'Kodi is not reachable at http://127.0.0.1:8080/jsonrpc: connect ECONNREFUSED 127.0.0.1:8080',
  })
  const text = render(harness, 'kodi_status', {}, result)
  assert.equal(text, result.error, 'the failure line is the reason the model needs')
})

test('a refused login and a nameless address each read correctly', async () => {
  const denied = setup({
    overrides: {
      status: async () => {
        throw Object.assign(new Error('Unauthorized'), { kind: 'auth' })
      },
    },
  })
  const refused = await run(denied, 'kodi_status', {})
  assert.equal(refused.ok, false)
  assert.match(refused.error, /^Kodi rejected the login at http:\/\/127\.0\.0\.1:8080\/jsonrpc: Unauthorized/)

  const nameless = setup({
    overrides: {
      status: async () => {
        throw new TypeError('fetch failed')
      },
    },
  })
  delete nameless.kodi.endpoint
  const unreachable = await run(nameless, 'kodi_status', {})
  assert.equal(unreachable.ok, false)
  assert.match(unreachable.error, /^Kodi is not reachable at the configured Kodi address: fetch failed$/)
})

test('a transport sentence that already names the endpoint is not wrapped twice', async () => {
  // The shipped transport answers in full sentences; the tool must not restate it.
  const sentence = 'Kodi is not reachable at http://127.0.0.1:8080/jsonrpc (Player.Open: ECONNREFUSED)'
  const harness = setup({
    overrides: {
      status: async () => {
        throw Object.assign(new Error(sentence), { kind: 'transport' })
      },
    },
  })
  const result = await run(harness, 'kodi_status', {})
  assert.equal(result.error, sentence)
  assert.equal(result.error.split('Kodi is not reachable').length - 1, 1, 'the failure must not be restated')
})

test('a Kodi refusal passes through with ok:false and its own reason', async () => {
  const harness = setup({
    overrides: {
      play: async () => ({ ok: false, error: 'Item is not playable' }),
    },
  })
  const result = await run(harness, 'kodi_play', { id: 5 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'Item is not playable')
})

test('every tool answers ok:false instead of throwing when Kodi is absent', async () => {
  const context = makeContext()
  const calls = []
  // A service object with no methods at all, plus a picks hook that also fails.
  const dispose = registerTools(context.ctx, {}, undefined, {
    makePicks: async () => {
      throw new Error('recommendation data unavailable')
    },
  })
  try {
    for (const name of TOOL_NAMES) {
      const result = await context.registry.get(name).execute({ query: 'x', title: 'x', text: 'x', action: 'playpause', kind: 'movies', id: 1 }, {})
      assert.equal(result.ok, false, `${name} must fail softly without a service`)
      assert.equal(typeof result.error, 'string', `${name} must explain the failure`)
      assert.ok(result.error.length > 0, `${name} error must not be empty`)
    }
  } finally {
    dispose()
  }
  assert.equal(context.registry.size, 0)
  assert.equal(calls.length, 0)
})

// ---- picks delegation -----------------------------------------------------

test('kodi_picks delegates ranking to the recommendation module', async () => {
  const seen = []
  const picks = [
    {
      id: 3,
      kind: 'episode',
      title: 'The One With the List',
      reason: "you're 24 minutes in",
      runtime: 1320,
      resumeAt: 1440,
      thumbnail: null,
    },
  ]
  const harness = setup({
    hooks: {
      makePicks: async (kodi, options) => {
        seen.push({ kodi, options })
        return { generatedAt: '2026-10-28T12:00:00Z', picks }
      },
    },
  })

  const result = await run(harness, 'kodi_picks', {})
  assert.equal(result.ok, true)
  assert.equal(result.picks.length, 1)
  assert.equal(result.generatedAt, '2026-10-28T12:00:00Z')
  assert.equal(seen.length, 1, 'the module must be asked exactly once')
  assert.equal(seen[0].kodi, harness.kodi, 'the module ranks against the live service')
  assert.equal(seen[0].options.limit, 6, 'the documented default limit is 6')

  const text = render(harness, 'kodi_picks', {}, result)
  assert.match(text, /^Tonight's picks:/)
  assert.match(text, /The One With the List/)
  assert.match(text, /you're 24 minutes in/)
  assert.match(text, /22:00, from 24:00/)

  const one = await run(harness, 'kodi_picks', { limit: 2 })
  assert.equal(one.ok, true)
  assert.equal(seen.at(-1).options.limit, 2)
})

test('kodi_picks falls back to the contracted ranking module', async () => {
  // No hook: the tool must reach src/recommend.mjs itself. This fake service
  // exposes no JSON-RPC surface, so the real module answers with no picks
  // instead of throwing — which is exactly the behaviour the tool wraps.
  const harness = setup()
  const result = await run(harness, 'kodi_picks', {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.picks, [])
  assert.equal(typeof result.generatedAt, 'string')
  assert.match(render(harness, 'kodi_picks', {}, result), /^No picks tonight/)
})

test('kodi_picks fails softly when the recommendation module cannot answer', async () => {
  const harness = setup({
    hooks: {
      makePicks: async () => {
        throw new Error('no library index')
      },
    },
  })
  const result = await run(harness, 'kodi_picks', {})
  assert.equal(result.ok, false)
  assert.match(result.error, /^Tonight's picks could not be built: no library index\.$/)
})

// ---- kodi_say -------------------------------------------------------------

test('kodi_say reports a missing bridge and never pretends the TV saw it', async () => {
  const harness = setup()
  const result = await run(harness, 'kodi_say', { text: 'Dinner is ready' })
  assert.deepEqual(result, {
    ok: false,
    error: 'The TV bridge is not running; nothing can be shown on the TV.',
  })
})

test('kodi_say hands the text to the bridge and renders the first line', async () => {
  const shown = []
  const harness = setup({
    hooks: {
      say: async ({ text }) => {
        shown.push(text)
        return { ok: true }
      },
    },
  })

  const result = await run(harness, 'kodi_say', { text: 'Dinner is ready\nCome to the table.' })
  assert.equal(result.ok, true)
  assert.deepEqual(shown, ['Dinner is ready\nCome to the table.'])
  assert.equal(
    render(harness, 'kodi_say', { text: 'Dinner is ready\nCome to the table.' }, result),
    'Shown on the TV: Dinner is ready',
  )

  const empty = await run(harness, 'kodi_say', { text: '   ' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /needs text/)

  const long = await run(harness, 'kodi_say', { text: 'x'.repeat(2001) })
  assert.equal(long.ok, false)
  assert.match(long.error, /2000 characters/)
})

test('kodi_say reports a bridge failure without throwing', async () => {
  const harness = setup({
    hooks: {
      say: async () => {
        throw new Error('bridge listener closed')
      },
    },
  })
  const result = await run(harness, 'kodi_say', { text: 'Hello' })
  assert.equal(result.ok, false)
  assert.match(result.error, /bridge listener closed/)
})

// ---- compact summaries ----------------------------------------------------

test('kodi_status reads as a short now-playing summary', async () => {
  const harness = setup()
  const result = await run(harness, 'kodi_status', {})
  assert.equal(result.ok, true)

  const text = render(harness, 'kodi_status', {}, result)
  const lines = text.split('\n')
  assert.equal(lines[0], 'Playing "Big Buck Bunny" — 1:12 of 9:56')
  assert.ok(lines.includes('Volume 65.'), text)
  assert.ok(lines.includes('1 item in the queue.'), text)
  assert.ok(lines.includes('Library: 12 movies, 40 episodes.'), text)
  assert.ok(!text.includes('{'), 'the summary must not be a JSON dump')
})

test('kodi_queue lists the queue and passes an add in the documented shape', async () => {
  const harness = setup()
  const listed = await run(harness, 'kodi_queue', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.action, 'list')
  assert.equal(listed.items.length, 1)
  const text = render(harness, 'kodi_queue', {}, listed)
  assert.match(text, /^1 item in the queue:/)
  assert.match(text, /Now: Big Buck Bunny/)

  const added = await run(harness, 'kodi_queue', { action: 'add', kind: 'episode', ids: [7, 9] })
  assert.equal(added.ok, true)
  const queuedCall = harness.calls.filter(([method]) => method === 'queue').at(-1)
  assert.deepEqual(queuedCall, ['queue', 'add', { items: [{ kind: 'episode', id: 7 }, { kind: 'episode', id: 9 }] }])

  const jumpWithoutPosition = await run(harness, 'kodi_queue', { action: 'jump' })
  assert.equal(jumpWithoutPosition.ok, false)
  assert.match(jumpWithoutPosition.error, /needs position/)
})

test('kodi_volume validates the range and kodi_remote needs a key name', async () => {
  const harness = setup()
  const tooLoud = await run(harness, 'kodi_volume', { set: 140 })
  assert.equal(tooLoud.ok, false)
  assert.match(tooLoud.error, /between 0 and 100/)

  const muted = await run(harness, 'kodi_volume', { mute: true })
  assert.equal(muted.ok, true)
  assert.equal(render(harness, 'kodi_volume', {}, { ok: true, volume: 65, muted: true }), 'The TV is muted at volume 65.')

  const noKey = await run(harness, 'kodi_remote', { action: 'key' })
  assert.equal(noKey.ok, false)
  assert.match(noKey.error, /needs the key name/)
})

test('a sloppy service value is normalized to lossless JSON', async () => {
  const harness = setup({
    overrides: {
      status: async () => ({
        connected: true,
        playing: true,
        item: { ...MOVIE, title: undefined },
        position: Number.NaN,
        volume: 10,
        muted: false,
        queue: [],
        version: '21.1',
      }),
    },
  })

  const result = await run(harness, 'kodi_status', {})
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the canonical value must round-trip')
  assert.equal(Object.hasOwn(result.item, 'title'), false, 'undefined fields are dropped')
  assert.equal(result.position, null, 'NaN becomes null so materialization cannot fail')
  assert.match(render(harness, 'kodi_status', {}, result), /Playing "Big Buck Bunny"/)
})

test('kodi_transport covers the actions the service actually implements', async () => {
  const harness = setup()

  // skip with no value is the next item; with a number it is a relative jump
  // in seconds; with a word it changes item.
  const skipped = await run(harness, 'kodi_transport', { action: 'skip' })
  assert.equal(skipped.ok, true)
  assert.deepEqual(harness.calls.at(-1), ['transport', 'skip', {}])
  assert.equal(render(harness, 'kodi_transport', { action: 'skip' }, skipped), 'Skipped to the next item on the TV.')

  const back = await run(harness, 'kodi_transport', { action: 'skip', value: -30 })
  assert.equal(back.ok, true)
  assert.deepEqual(harness.calls.at(-1), ['transport', 'skip', { value: -30 }])
  assert.equal(
    render(harness, 'kodi_transport', { action: 'skip', value: -30 }, back),
    'Went back 30 seconds on the TV.',
  )
  assert.equal(
    render(harness, 'kodi_transport', { action: 'skip', value: 45 }, back),
    'Skipped forward 45 seconds on the TV.',
  )

  const previous = await run(harness, 'kodi_transport', { action: 'skip', value: 'previous' })
  assert.equal(previous.ok, true)
  assert.deepEqual(harness.calls.at(-1), ['transport', 'skip', { value: 'previous' }])
  assert.equal(
    render(harness, 'kodi_transport', { action: 'skip', value: 'previous' }, previous),
    'Went back to the previous item on the TV.',
  )

  const nonsense = await run(harness, 'kodi_transport', { action: 'skip', value: 'sideways' })
  assert.equal(nonsense.ok, false)
  assert.match(nonsense.error, /needs value to be seconds, "previous", or "next"/)

  // seek and speed cannot do anything sensible without a value.
  const seekWithout = await run(harness, 'kodi_transport', { action: 'seek' })
  assert.equal(seekWithout.ok, false)
  assert.match(seekWithout.error, /needs value/)

  const halfSpeed = await run(harness, 'kodi_transport', { action: 'speed', value: 0.5 })
  assert.equal(halfSpeed.ok, true)
  assert.deepEqual(harness.calls.at(-1), ['transport', 'speed', { value: 0.5 }])

  const seek = await run(harness, 'kodi_transport', { action: 'seek', value: 600 })
  assert.equal(seek.ok, true)
  assert.deepEqual(harness.calls.at(-1), ['transport', 'seek', { value: 600 }])
  assert.equal(render(harness, 'kodi_transport', { action: 'seek' }, { ok: true, action: 'seek', position: 600 }), 'Jumped to 10:00 on the TV.')
})

test('kodi_notify passes a duration in seconds and renders the banner', async () => {
  const harness = setup()
  const result = await run(harness, 'kodi_notify', { title: 'Pizza is here', message: 'Come to the door', time: 8 })
  assert.equal(result.ok, true)
  assert.deepEqual(harness.calls.at(-1), ['notify', { title: 'Pizza is here', message: 'Come to the door', time: 8 }])
  assert.equal(render(harness, 'kodi_notify', {}, result), 'Shown on the TV: Pizza is here — Come to the door.')

  const titleOnly = await run(harness, 'kodi_notify', { title: 'Back in five' })
  assert.equal(titleOnly.ok, true)
  assert.deepEqual(harness.calls.at(-1), ['notify', { title: 'Back in five', message: 'Back in five' }])

  const noTitle = await run(harness, 'kodi_notify', {})
  assert.equal(noTitle.ok, false)
  assert.match(noTitle.error, /needs a title/)
})

test('kodi_screenshot prefers a downloadable URL over Kodi\'s internal path', async () => {
  const harness = setup()
  const result = await run(harness, 'kodi_screenshot', {})
  assert.equal(result.ok, true)
  assert.equal(result.path, 'special://temp/screenshot0001.png')
  assert.equal(render(harness, 'kodi_screenshot', {}, result), 'Screenshot of the TV saved to special://temp/screenshot0001.png.')

  const served = render(harness, 'kodi_screenshot', {}, {
    ok: true,
    path: 'special://temp/screenshot0002.png',
    file: 'http://127.0.0.1:8080/vfs/temp/screenshot0002.png',
  })
  assert.equal(served, 'Screenshot of the TV saved to http://127.0.0.1:8080/vfs/temp/screenshot0002.png.')
})

test('search rows show the result extra a search carries', async () => {
  const episode = {
    ...MOVIE,
    id: 5,
    kind: 'episode',
    title: 'Pilot',
    year: 2008,
    runtime: 3480,
    extra: 'Breaking Bad · S01E01',
    show: null,
    season: null,
    episode: null,
  }
  const harness = setup({ overrides: { search: async () => ({ results: [episode] }) } })
  const result = await run(harness, 'kodi_search', { query: 'pilot' })
  const text = render(harness, 'kodi_search', { query: 'pilot' }, result)
  assert.equal(text.split('\n')[1], '1. Pilot [episode, Breaking Bad · S01E01, 2008] (58:00)')
})

// ---- renders are total ----------------------------------------------------

test('every render is total: unknown or failed values never throw', () => {
  const harness = setup()
  const values = [
    { ok: true },
    { ok: false, error: 'Something went wrong.' },
    { ok: true, items: null, results: null, picks: null, queue: null },
    Object.freeze({ ok: true }),
  ]
  for (const [name, definition] of harness.registry) {
    for (const value of values) {
      const blocks = definition.output.render({}, value)
      assert.equal(blocks.length, 1, `${name} must render exactly one block`)
      assert.equal(blocks[0].type, 'text')
      assert.equal(typeof blocks[0].text, 'string')
      assert.ok(blocks[0].text.length > 0, `${name} rendered nothing for ${JSON.stringify(value)}`)
      assert.doesNotMatch(blocks[0].text, /undefined|NaN|\[object Object\]/, `${name} leaked a raw value`)
    }
    // A thrown renderer is the one thing the model must never see.
    const broken = definition.output.render(null, { ok: true, error: null })
    assert.equal(broken[0].type, 'text')
  }
})
