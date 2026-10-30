/**
 * The HTTP surface the panel talks to.
 *
 * Three rules shape this file.
 *
 * 1. **Every payload is small and already shaped for rendering.** The client
 *    half of this plugin is a bundled script with no build step, so it must not
 *    contain business logic. Deciding what counts as "a file this turn changed"
 *    happens here, once, in a language with tests.
 * 2. **A failure is a 200 with a reason, not a 500.** The panel's job is to
 *    explain, and an error dialog in a sidebar is useless. Endpoints that cannot
 *    answer return `{ ok: true, data: { available: false, reason } }`.
 * 3. **Nothing here mutates.** The panel reads; the model writes through its
 *    tools. The single exception is the "propose a skill" button, which writes a
 *    hint into the next turn rather than touching the queue directly — the same
 *    path a detected hint takes, so it passes the same evidence gate.
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

/** Largest request body accepted, in bytes. */
/**
 * Read a dependency that may be handed over either as a live value or as a
 * function returning one.
 *
 * Both shapes appear in this codebase: `lib/index.js` passes `config` as a
 * thunk, while an object literal built with `get config()` yields the value.
 * Calling the value as a function crashed every route, so the tolerance lives
 * here rather than in the caller — a caller can regress, this cannot.
 *
 * @param {any} dependency - the value, or a function returning it.
 * @returns {any} the value.
 */
function valueOf(dependency) {
  const value = typeof dependency === 'function' ? dependency() : dependency
  // A primitive here is a wiring mistake, not a value. Returning it would turn
  // a broken dependency into "turned off in settings" — the failure would look
  // like a configuration choice, which is the one thing a person cannot debug.
  // The check has to run on the *result*: production passes a getter, so
  // inspecting the dependency would only ever see a function.
  if (value !== undefined && (typeof value !== 'object' || value === null)) {
    throw new TypeError(`expected a config object, received ${typeof value}`)
  }
  return value
}

const MAX_BODY_BYTES = 64 * 1024

/** Prefix every route lives under. */
const ROUTE_PREFIX = '/api/skill-evolve'

/**
 * Write one JSON response.
 *
 * `headOnly` exists because the client sends `HEAD` to probe a route without
 * paying for the body; answering with the body anyway breaks that contract.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} code - the status code.
 * @param {unknown} payload - the JSON body.
 * @param {boolean} [headOnly] - omit the body.
 */
function json(res, code, payload, headOnly = false) {
  if (!res || res.writableEnded || res.destroyed) return
  // A response stream can error after headers are written (client navigated
  // away mid-request). Without a listener Node treats it as an unhandled error.
  res.once('error', () => {})
  try {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      // The panel polls these; a cached answer would show a stale turn.
      'cache-control': 'no-store',
    })
    res.end(headOnly ? undefined : body)
  } catch {
    // A serialisation failure here means the payload had a cycle or a BigInt.
    // Nothing useful can be sent at this point, so the socket is dropped.
    res.destroy()
  }
}

/**
 * Reject requests that did not come from this host's own UI.
 *
 * This is not authentication — the web server already binds to loopback. What
 * it blocks is a page on another origin reaching this server through DNS
 * rebinding or a cross-site `fetch`. The plugin has no credentials to steal, but
 * the transcript it serves is the user's own conversation.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {string | undefined} a rejection reason.
 */
function checkOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (host.length === 0) return 'missing host header'
  let parsed
  try {
    parsed = new URL(`http://${host}`)
  } catch {
    return 'malformed host header'
  }
  // Loopback in any of its spellings, plus the canonical authority the host
  // itself reports. Anything else means the request arrived for a name this
  // server did not intend to serve.
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1' || parsed.hostname === 'localhost'
  const trusted = req.headers['sec-fetch-site']
  if (trusted === 'cross-site') return 'cross-site request'
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== parsed.host) return 'origin does not match host'
    } catch {
      return 'malformed origin'
    }
  }
  if (!loopback) return `unexpected host ${parsed.hostname}`
  return undefined
}

/**
 * Read a JSON request body with a hard size cap.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<{ ok: true, value: any } | { ok: false, code: string, error: string, status: number }>} the body.
 */
async function readJsonBody(req) {
  // A body is only parsed when it announced itself as JSON. Without this check a
  // cross-site `<form enctype="text/plain">` can POST here: form posts are not
  // preflighted, and `sec-fetch-site` is not sent by every browser, so neither of
  // the other two guards catches it. `+json` covers the structured-suffix types a
  // future client may use without opening the door to form encodings.
  const declaredType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const isJson = declaredType === 'application/json' || (declaredType.startsWith('application/') && declaredType.endsWith('+json'))
  if (declaredType.length > 0 && !isJson) {
    return { ok: false, status: 415, code: 'error.body.not-json', error: `a JSON body is required, got ${declaredType}` }
  }
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, status: 413, code: 'error.body.too-large', error: 'request body is too large' }
  const chunks = []
  let total = 0
  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_BODY_BYTES) return { ok: false, status: 413, code: 'error.body.too-large', error: 'request body is too large' }
      chunks.push(chunk)
    }
  } catch (error) {
    return { ok: false, status: 400, code: 'error.body.unreadable', error: `could not read the request body: ${error?.message ?? error}` }
  }
  if (total === 0) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, status: 400, code: 'error.body.malformed', error: 'request body is not valid JSON' }
  }
}

/**
 * Pick the files a turn touched that actually exist and are worth listing.
 *
 * A path recorded from a tool call is a claim, not a fact: an `edit` may have
 * been rejected, a `write` may have failed, and the recorded string may be
 * relative to a directory that is not the one the panel is looking at. Rather
 * than guess, this resolves each one against the session's cwd and keeps only
 * what is really on disk.
 *
 * @param {object} input - the request.
 * @param {string[]} input.paths - the candidate paths.
 * @param {string} [input.cwd] - the directory relative paths resolve against.
 * @returns {Promise<Array<{ path: string, bytes: number, mtimeMs: number }>>} the existing files.
 */
async function statTouchedFiles({ paths, cwd }) {
  const seen = new Set()
  const out = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const absolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) ? raw : join(cwd ?? process.cwd(), raw)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    try {
      const { stat } = await import('node:fs/promises')
      const info = await stat(absolute)
      if (!info.isFile()) continue
      out.push({ path: absolute, bytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // Not there, or not readable. The panel says "edited", not "exists", so a
      // missing file is a legitimate answer and needs no warning.
    }
  }
  return out
}

/**
 * Describe the skills this session actually loaded.
 *
 * The list is a record of use, not a catalogue. A skill appears because the
 * model called the `skill` tool for it or a person typed `/name`, and for no
 * other reason — whether a skill *could* be invoked has nothing to do with
 * whether it *was*, so filtering by invocation policy would answer a question
 * nobody asked.
 *
 * `snapshot()` is still the source of truth for the row itself (description,
 * ownership, ordering): a plugin that re-walked the skill roots would
 * eventually disagree with the host about shadowing.
 *
 * @param {object} input - the request.
 * @param {any} input.skills - the host's `skills` service, or undefined.
 * @param {object} input.exec - the agent scope options.
 * @param {(name: string) => boolean} input.isOwned - whether this plugin wrote it.
 * @param {Map<string, 'tool' | 'gesture'> | undefined} [input.used] - names
 *   loaded this session, each with the path that loaded it.
 * @returns {Promise<object>} the module payload.
 */
async function describeSkills({ skills, exec, isOwned, used, recency }) {
  if (skills === undefined || typeof skills.snapshot !== 'function') {
    return { available: false, reason: 'this host does not expose a skill registry', skills: [] }
  }
  let snapshot
  try {
    snapshot = await skills.snapshot(exec ?? {})
  } catch (error) {
    return { available: false, reason: `could not read the skill registry: ${error?.message ?? error}`, skills: [] }
  }
  const rows = Array.isArray(snapshot?.skills) ? snapshot.skills : []
  // `snapshot()` is not documented to return rows sorted; the panel claims a
  // "most recent first" order below, so sort here rather than trusting it.
  const byName = new Map()
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name : ''
    if (name.length > 0 && !byName.has(name)) byName.set(name, row)
  }
  // A gesture only loads a skill the host considers user-invocable: it runs
  // `if (skill === void 0 || !isUserInvocable(skill)) continue` before injecting
  // anything, so a gesture at a model-only skill loaded nothing and must not be
  // reported as a load. A skill that arrived through the `skill` tool is held
  // to the other half of the same policy, which the tool itself enforces.
  const loaded = []
  const walks = used instanceof Map ? used.entries() : []
  for (const [name, via] of walks) {
    const row = byName.get(name)
    if (row === undefined) continue
    const policy = row.invocation
    if (via === 'gesture') {
      const userInvocable = typeof policy?.userInvocable === 'boolean' ? policy.userInvocable : true
      if (!userInvocable) continue
    }
    loaded.push(name)
  }
  // `isOwned` reads a file, so it answers with a Promise. Awaiting here matters
  // more than it looks: a Promise in the payload serialises to `{}`, which is
  // truthy in the client, so a sync map would have marked every skill as one of
  // ours rather than none.
  const listed = await Promise.all(
    loaded.map(async (name) => {
      const row = byName.get(name)
      let owned = false
      try {
        owned = (await isOwned(name)) === true
      } catch {
        owned = false
      }
      // The host reports invocation as `{ modelInvocable, userInvocable }`.
      // Reading it as a string (as an earlier version did) always produced
      // `undefined`, so the client could never tell the two apart.
      const policy = row?.invocation
      const modelInvocable = typeof policy?.modelInvocable === 'boolean' ? policy.modelInvocable : true
      return {
        name,
        description: typeof row?.description === 'string' ? row.description : '',
        modelInvocable,
        owned,
        lastUsed: recency instanceof Map ? recency.get(`skill:${name}`) ?? 0 : 0,
      }
    }),
  )
  // Most recently loaded first: the module answers "what has this session been
  // leaning on", and the newest load is the most likely answer.
  listed.reverse()
  return { available: true, complete: snapshot?.complete !== false, skills: listed }
}

/**
 * List the MCP servers that actually contributed tools to this session.
 *
 * Deliberately *not* read from the connector's own config: a configured server
 * that failed to connect is not a capability the model has, and the panel is
 * describing what is available now. Seeing an `mcp__<name>__` tool in the
 * transcript is proof that server is up.
 *
 * @param {Set<string>} seen - MCP tool names observed this session.
 * @returns {Array<{ server: string, tools: number, used: boolean }>} the servers.
 */
function describeMcp(seen, recency) {
  const counts = new Map()
  for (const name of seen) {
    // Requires the full `mcp__<server>__<tool>` shape. Accepting a bare name too
    // would make `bash` look like an MCP server, so the collector stores the
    // whole tool name and this side only splits it.
    if (typeof name !== 'string' || !name.startsWith('mcp__')) continue
    const rest = name.slice('mcp__'.length)
    const cut = rest.indexOf('__')
    if (cut <= 0) continue
    const server = rest.slice(0, cut)
    if (server.length === 0) continue
    counts.set(server, (counts.get(server) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([server, tools]) => ({
      server,
      tools,
      used: true,
      lastUsed: recency instanceof Map ? recency.get(`mcp:${server}`) ?? 0 : 0,
    }))
    .sort((a, b) => (b.lastUsed - a.lastUsed) || a.server.localeCompare(b.server))
}

/**
 * Build the route handler.
 *
 * @param {object} deps - dependencies.
 * @param {() => object} deps.config - live plugin config.
 * @param {any} deps.transcripts - the `TranscriptStore`.
 * @param {any} deps.summariser - the `Summariser`.
 * @param {(agentId: string) => object} deps.execFor - options for one agent.
 * @param {() => any} deps.skills - the host's `skills` service accessor.
 * @param {(name: string) => boolean} deps.isOwned - whether this plugin wrote a skill.
 * @param {(agentId: string) => string | undefined} deps.cwdFor - the session cwd.
 * @param {(agentId: string) => { provider: string, model: string } | undefined} [deps.routeFor] -
 *   the route the session is running on, so a summary can borrow a known-good one.
 * @param {(agentId: string) => Map<string, 'tool' | 'gesture'> | undefined}
 *   [deps.skillsUsed] - names this session loaded, each with its path.
 * @param {(agentId: string, skill: string) => void} deps.requestProposal - queue a hint.
 * @param {() => Set<string>} deps.mcpTools - MCP tool names seen this session.
 * @param {() => Array<{ provider: string, models: Array<{ id: string, name: string }> }>} deps.modelCatalog - available routes.
 * @param {() => Promise<number>} [deps.pendingCandidates] - how many candidates await approval.
 * @param {() => Promise<Array<object>>} [deps.listCandidates] - the queue, shaped for the card.
 * @param {(name: string, agent: any, id?: string) => Promise<object>} [deps.approveCandidate] - approve one candidate.
 *   The id, when given, is the row the card was pointing at; a name alone resolves to
 *   whichever row `findByName` prefers, which is not always the one on screen.
 * @param {(name: string, id?: string) => Promise<object>} [deps.discardCandidate] - discard one candidate.
 *   Same id-then-name rule as `approveCandidate`.
 * @param {(message: string) => void} [deps.log] - diagnostics.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
function createPanelApi(deps) {
  /**
   * Route one request.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  return async function handle(req, res) {
    const rejected = checkOrigin(req)
    if (rejected !== undefined) {
      json(res, 403, { ok: false, code: 'error.origin.forbidden', error: rejected })
      return
    }
    const headOnly = req.method === 'HEAD'
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      json(res, 405, { ok: false, code: 'error.method.unsupported', error: `${req.method} is not supported` })
      return
    }

    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      json(res, 400, { ok: false, code: 'error.url.malformed', error: 'the request URL could not be parsed' })
      return
    }
    const path = url.pathname.replace(/\/+$/, '')
    const agentId = url.searchParams.get('agent') ?? undefined

    try {
      if (path === `${ROUTE_PREFIX}/panel`) return json(res, 200, { ok: true, data: await readPanel(deps, agentId) }, headOnly)
      if (path === `${ROUTE_PREFIX}/models`) return json(res, 200, { ok: true, data: { providers: deps.modelCatalog() } }, headOnly)
      // `config` is a read on GET/HEAD and a write on POST. The read is checked
      // by method as well as path: matching on the path alone made the write
      // branch below unreachable, so the panel's switches answered "saved" and
      // changed nothing.
      if (path === `${ROUTE_PREFIX}/config` && req.method !== 'POST') {
        return json(res, 200, { ok: true, data: readConfig(deps) }, headOnly)
      }
      // The queue, for the hover card. Reading it here rather than in the
      // client keeps the "which entries count as live" rule in one place:
      // a stale candidate is still listed (so a person can discard it) but
      // carries its reason, and the client only has to render.
      if (path === `${ROUTE_PREFIX}/candidates` && req.method !== 'POST') {
        return json(res, 200, { ok: true, data: await readCandidates(deps) }, headOnly)
      }
      if (path === `${ROUTE_PREFIX}/candidates` && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body.ok === false) return json(res, body.status, { ok: false, code: body.code, error: body.error })
        return json(res, 200, { ok: true, data: await decideCandidate(deps, body.value, agentId) })
      }
      if (path === `${ROUTE_PREFIX}/propose` && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body.ok === false) return json(res, body.status, { ok: false, code: body.code, error: body.error })
        return json(res, 200, { ok: true, data: propose(deps, body.value, agentId) })
      }
      if (path === `${ROUTE_PREFIX}/config` && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body.ok === false) return json(res, body.status, { ok: false, code: body.code, error: body.error })
        return json(res, 200, { ok: true, data: writeConfig(deps, body.value) })
      }
      json(res, 404, { ok: false, code: 'error.route.unknown', error: `${path} is not a route this plugin serves` })
    } catch (error) {
      deps.log?.(`panel api ${path}: ${error?.message ?? error}`)
      json(res, 200, { ok: false, code: 'error.internal', error: `the panel could not be built: ${error?.message ?? error}` })
    }
  }
}


/**
 * The candidate queue, shaped for the hover card.
 *
 * `name` and `description` are what the card lists; `body`, `evidence` and
 * `whenToUse` are what its detail panel expands. Everything is pre-truncated
 * here rather than in the client: the client is a bundled script with no tests
 * of its own, so a size limit written there would be a size limit nobody could
 * test.
 *
 * @param {object} deps - the API dependencies.
 * @returns {Promise<object>} the payload.
 */
async function readCandidates(deps) {
  if (typeof deps.listCandidates !== 'function') {
    return { available: false, reason: 'the candidate queue is not wired up', candidates: [] }
  }
  try {
    const rows = await deps.listCandidates()
    return {
      available: true,
      candidates: rows.map((row) => ({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        description: clampText(row.description, 160),
        kind: row.kind === 'update' ? 'update' : 'create',
        // A stale row is listed, not hidden: hiding it would leave a person
        // unable to discard the entry that is blocking the name.
        stale: row.stale === undefined || row.stale === null ? undefined : { reason: String(row.stale.reason ?? row.stale) },
        whenToUse: row.whenToUse === undefined ? undefined : clampText(row.whenToUse, 200),
        body: clampText(row.body, 4000),
        evidence: Array.isArray(row.evidence)
          ? row.evidence.slice(0, 6).map((entry) => ({
              class: String(entry?.class ?? 'tool'),
              quote: clampText(entry?.quote, 300),
            }))
          : [],
      })),
    }
  } catch (error) {
    deps.log?.(`panel api /candidates: ${error?.message ?? error}`)
    return { available: false, reason: `the candidate queue could not be read: ${error?.message ?? error}`, candidates: [] }
  }
}

/**
 * Approve or discard one candidate by name.
 *
 * Both paths delegate to the functions the slash commands already use, so the
 * evidence gate and the confirm handshake are not re-implemented here. A route
 * that wrote the file itself would be a second way in that skips both.
 *
 * @param {object} deps - the API dependencies.
 * @param {any} body - `{ name, action, id? }`. `action` is `"approve"` or `"discard"`;
 *   `id` identifies the exact queue row, which matters when two rows share a name.
 * @param {string | undefined} agentId - the session the panel belongs to.
 * @returns {Promise<object>} the outcome.
 */
async function decideCandidate(deps, body, agentId) {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const id = typeof body?.id === 'string' && body.id.length > 0 ? body.id : undefined
  const action = typeof body?.action === 'string' ? body.action : ''
  if (name.length === 0 && id === undefined) {
    return { ok: false, code: 'no-name', error: 'a candidate name is required' }
  }
  if (action !== 'approve' && action !== 'discard') {
    return { ok: false, code: 'no-action', error: 'action must be "approve" or "discard"' }
  }
  if (action === 'discard') {
    if (typeof deps.discardCandidate !== 'function') {
      return { ok: false, code: 'unavailable', error: 'discarding is not wired up' }
    }
    try {
      return await deps.discardCandidate(name, id)
    } catch (error) {
      deps.log?.(`panel api discard ${name}: ${error?.message ?? error}`)
      return { ok: false, code: 'error.internal', error: String(error?.message ?? error) }
    }
  }
  if (typeof deps.approveCandidate !== 'function') {
    return { ok: false, code: 'unavailable', error: 'approving is not wired up' }
  }
  try {
    return await deps.approveCandidate(name, agentId, id)
  } catch (error) {
    // The evidence gate refuses with a message meant to be read by a person,
    // so it travels back as data rather than as a 500 the card would render as
    // "unknown error".
    deps.log?.(`panel api approve ${name}: ${error?.message ?? error}`)
    return { ok: false, code: 'error.internal', error: String(error?.message ?? error) }
  }
}

/**
 * Cut a long string to fit a card, on a word boundary where there is one.
 *
 * @param {any} value - the text.
 * @param {number} limit - maximum length.
 * @returns {string} the shortened text.
 */
function clampText(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`
}

/**
 * Assemble everything the panel draws.
 *
 * One request rather than three: the three modules share a turn number, and
 * fetching them separately would let the panel render a summary of turn 3 next
 * to a file list from turn 4.
 *
 * @param {object} deps - the API dependencies.
 * @param {string | undefined} agentId - which agent to describe.
 * @returns {Promise<object>} the payload.
 */
async function readPanel(deps, agentId) {
  const config = valueOf(deps.config)
  const id = agentId ?? ''
  const view = id.length > 0 ? deps.transcripts.view(id) : undefined
  const previous = view?.previous

  let summary = { enabled: config.panelSummary === true, reason: 'no completed turn yet' }
  if (config.panelSummary === true && previous !== undefined) {
    // The session's own route first: a route this session is already running on
    // is proven reachable and authorised against this account, whereas the
    // catalogue only proves that an adapter advertised it.
    const sessionRoute = typeof deps.routeFor === 'function' ? deps.routeFor(id) : undefined
    summary = await deps.summariser.summarise({ agentId: id, snapshot: previous, sessionRoute })
  } else if (config.panelSummary !== true) {
    summary = { enabled: false, reason: 'turned off in settings' }
  }

  const recency = typeof deps.recentUse === 'function' ? deps.recentUse() : undefined
  const skills = await describeSkills({
    skills: deps.skills(),
    exec: id.length > 0 ? deps.execFor(id) : undefined,
    isOwned: deps.isOwned,
    used: typeof deps.skillsUsed === 'function' ? deps.skillsUsed(id) : undefined,
    recency,
  })
  const files = previous === undefined ? [] : await statTouchedFiles({ paths: previous.paths ?? [], cwd: deps.cwdFor(id) })

  return {
    agent: id,
    turn: view?.turns ?? 0,
    summary,
    skills,
    mcp: describeMcp(deps.mcpTools(), recency),
    files,
    commands: previous?.commands ?? [],
    tools: previous?.tools ?? [],
    calls: previous?.calls ?? 0,
    failed: previous?.failed ?? 0,
    pendingCandidates: (await deps.pendingCandidates?.()) ?? 0,
  }
}

/**
 * The settings the panel can change from inside itself.
 *
 * Only three, and all three are about the panel. Everything that governs the
 * detector lives in the host's own settings UI, where changing it is a decision
 * with a diff.
 *
 * @param {object} deps - the API dependencies.
 * @returns {object} the payload.
 */
function readConfig(deps) {
  const config = valueOf(deps.config)
  return {
    panelSummary: config.panelSummary === true,
    panelSummaryProvider: config.summaryProvider ?? '',
    panelSummaryModel: config.summaryModel ?? '',
    // The panel reads these to decide where to draw and whether to start
    // collapsed. Leaving them out of the payload made both settings inert: the
    // client's guards never fired, so `side` stayed 'left' for everyone.
    panelSide: config.panelSide === 'right' ? 'right' : 'left',
    panelCollapsed: config.panelCollapsed === true,
  }
}

/**
 * Ask the plugin to propose a skill on the panel's behalf.
 *
 * This is deliberately indirect. The panel does not know what the reusable
 * procedure was — only the model does. So the button writes a hint into the next
 * turn's context, and the model decides whether there is something to submit.
 * A button that filed a candidate itself would produce an empty skill.
 *
 * @param {object} deps - the API dependencies.
 * @param {any} body - the request body.
 * @param {string | undefined} agentId - which agent to hint.
 * @returns {object} the result.
 */
function propose(deps, body, agentId) {
  const id = typeof body?.agent === 'string' && body.agent.length > 0 ? body.agent : agentId
  if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'the request did not say which session to hint' }
  if (deps.requestProposal === undefined) return { ok: false, reason: 'this host cannot deliver a hint to a running session' }
  try {
    const outcome = deps.requestProposal(id, typeof body?.skill === 'string' ? body.skill : undefined)
    // `publish` reports whether the text will actually be shown. Saying "ok"
    // for a hint that was held, deduplicated or refused leaves the person
    // watching the panel waiting for a model response that was never asked for.
    if (outcome === 'off') return { ok: false, reason: 'the plugin is set to off, so no hint was queued' }
    if (outcome === 'held') return { ok: false, reason: 'a reflection is currently holding the hint channel; ask again in a few steps' }
    if (outcome === 'duplicate') return { ok: false, reason: 'this request was already shown in this session' }
    if (outcome === 'exhausted') return { ok: false, reason: 'this session has used all its hints' }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `could not queue the hint: ${error?.message ?? error}` }
  }
}

/**
 * Persist a settings change made in the panel.
 *
 * The host owns the config file, and this plugin has no business rewriting it:
 * a plugin that edits the host's configuration can corrupt every other plugin's
 * settings. So the panel's switches are honoured for this process through an
 * in-memory override, and the user is told to change the real setting for it to
 * survive a restart. The override object is returned so the client can show it
 * took effect.
 *
 * @param {object} deps - the API dependencies.
 * @param {any} body - the request body.
 * @returns {object} the applied values.
 */
function writeConfig(deps, body) {
  // The reply is the *config*, not a receipt. The client stores whatever comes
  // back as its config state, so returning `{ok, applied, note}` made every
  // switch fall back to undefined and visually spring open again one render
  // after being saved.
  if (deps.applyOverride === undefined) {
    return { ...readConfig(deps), ok: false, reason: 'this host cannot apply an override' }
  }
  const patch = {}
  if (typeof body?.panelSummary === 'boolean') patch.panelSummary = body.panelSummary
  if (typeof body?.summaryProvider === 'string') patch.summaryProvider = body.summaryProvider
  if (typeof body?.summaryModel === 'string') patch.summaryModel = body.summaryModel
  // Like every other panel switch these land in the process-local override, so
  // they apply immediately and last until the host restarts. To persist them,
  // set `panelSide` / `panelCollapsed` in the plugin's own settings. Writing the
  // host's config file from here would let one plugin rewrite another's settings.
  if (body?.panelSide === 'left' || body?.panelSide === 'right') patch.panelSide = body.panelSide
  if (typeof body?.panelCollapsed === 'boolean') patch.panelCollapsed = body.panelCollapsed
  if (Object.keys(patch).length === 0) {
    return { ...readConfig(deps), ok: false, reason: 'nothing to change' }
  }
  deps.applyOverride(patch)
  if (patch.summaryProvider !== undefined || patch.summaryModel !== undefined) deps.summariser.reset()
  return {
    ...readConfig(deps),
    ok: true,
    applied: patch,
    note: 'this applies until the host restarts; set it in the plugin settings to keep it',
  }
}

export {
  createPanelApi,
  readPanel,
  describeSkills,
  describeMcp,
  statTouchedFiles,
  checkOrigin,
  readJsonBody,
  json,
  ROUTE_PREFIX,
  readCandidates,
  decideCandidate,
  clampText,
  MAX_BODY_BYTES,
}
