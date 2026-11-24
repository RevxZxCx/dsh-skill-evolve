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
 *    tools. The one route that writes anything is `POST /propose`, which places a
 *    hint into the next turn rather than touching the queue directly — the same
 *    path a detected hint takes, so it passes the same evidence gate. The panel has
 *    no button for it any more; the route is kept as part of the service contract.
 */

import { join } from 'node:path'
import { stat as statFile } from 'node:fs/promises'
import { isDeliverable } from './deliverable.js'

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

/**
 * Prefix every route lives under.
 *
 * Renamed from `/api/skill-evolve` when the panel and the detector became
 * separate packages: the panel is about a session, not about skill evolution,
 * and a route named after the other half is the kind of string that gets
 * forgotten. The client keeps its own copy of this value inline (a bundle
 * cannot import), so the two are held together by `test/route-prefix.test.mjs`
 * rather than by hope.
 */
const ROUTE_PREFIX = '/api/ui-evolve'

/**
 * What the panel says when `@revxz/dsh-skill-evolve` is not installed.
 *
 * Named as a constant because four routes now have to say it, and because the
 * wording is the only thing telling a person that the feature they are looking
 * for belongs to a package they have not installed — rather than that their
 * queue is empty.
 */
const THE_SKILL_HALF_IS_ABSENT = 'the skill half is not installed, so the candidate queue is not available here'

/**
 * How long a long poll stays open, and how often it looks.
 *
 * The wait has to outlast the gap between two replies — a person reads one
 * answer, thinks, then types — without being an indefinitely open socket a
 * proxy will cut. Twenty-five seconds is under every common idle timeout and
 * long enough that an idle badge is a handful of requests per minute rather than
 * one every ten seconds that is always too late to be the first to know.
 *
 * The check interval is not a poll of a remote service: it reads one integer out
 * of a `Map` this process owns, so it costs less than the response it is
 * deciding not to send.
 */
const SPEED_WAIT_MS = 25 * 1000
const SPEED_WAIT_STEP_MS = 100

/**
 * Hold a request open until the number it names could have moved.
 *
 * A timer on the client discovers a change up to one interval late, and that
 * interval has to be long enough not to be traffic. This is the other way round:
 * the request waits, and answers the moment the caller's revision moves. What it
 * must never do is wait past the client's patience or into a socket that has
 * already gone — hence the deadline, and the `close` listener that ends the wait
 * the moment the browser navigates away. Without that listener the interval
 * outlives the request it belongs to, once per abandoned panel.
 *
 * The speed badge is the only caller. It is a named function anyway because these
 * four rules -- the deadline, the `close` listener, the `unref`, the interval --
 * are the part of a long poll that has been wrong before, and they are easier to
 * get right once than once per route that wants them.
 *
 * @param {() => number} read - the counter to compare against `after`.
 * @param {import('node:http').IncomingMessage} req - the request, for its close.
 * @param {URLSearchParams} params - the request's query.
 * @param {number} limit - how long to hold, in milliseconds.
 * @returns {Promise<void>} resolves when it is time to answer, however that happened.
 */
function holdRevision(read, req, params, limit) {
  const after = Number.parseInt(params.get('after') ?? '', 10)
  // No `after`, or a nonsense one: the caller asked for a plain read and gets
  // one. Answering at once is also right for a client that has just opened the
  // panel — it has nothing yet, and waiting would delay the first paint.
  if (Number.isFinite(after) === false) return Promise.resolve()

  // `after` is the caller's own reading, not a flag saying "I would like a
  // wait". Comparing against the revision at the moment the request happens to
  // arrive would treat a change that landed between two polls as no change at
  // all, and a reply that settles in that gap is the common case rather than the
  // corner one: the caller would then sit out the whole deadline for a number
  // that was already final when it asked.
  // One comparison, no branch. There used to be an `undefined` arm here for a
  // host that "cannot answer" -- no host ever did: the only implementation
  // (`speed.js`) returns `?? 0` and every test double returns a number, so the
  // arm was unreachable and no mutation could reach it either. A host without a
  // counter is answered one level up, where the dependency is checked.
  const moved = () => read() !== after
  if (moved() === true) return Promise.resolve()

  const deadline = Date.now() + limit
  return new Promise((resolve) => {
    const finish = () => {
      clearInterval(timer)
      resolve()
    }
    const timer = setInterval(() => {
      if (moved() === true || Date.now() >= deadline) finish()
    }, SPEED_WAIT_STEP_MS)
    // The interval must not be the reason this process stays alive: a plugin that
    // pinned the event loop open would keep a headless host running.
    if (typeof timer.unref === 'function') timer.unref()
    if (typeof req?.once === 'function') req.once('close', finish)
  })
}

/**
 * Hold a speed request open until the reading could say something new.
 *
 * @param {object} deps - the api dependencies.
 * @param {import('node:http').IncomingMessage} req - the request, for its close.
 * @param {string} agentId - the session being watched.
 * @param {URLSearchParams} params - the request's query.
 * @returns {Promise<void>} resolves when it is time to answer, however that happened.
 */
function speedWait(deps, req, agentId, params) {
  if (typeof deps.speedRevision !== 'function') return Promise.resolve()
  return holdRevision(() => deps.speedRevision(agentId), req, params, SPEED_WAIT_MS)
}

/**
 * Write one server-sent-event frame.
 *
 * The wire format is the one the host's own `/plugins/events` channel speaks:
 * `data: <json>\n\n`. No `event:` name and no `id:` — a client that reconnects
 * with `EventSource` asks again from scratch, and the frame carries the session
 * and its counter anyway, so a replay window would buy nothing.
 *
 * @param {import('node:http').ServerResponse} res - the stream response.
 * @param {object} frame - the JSON-able payload.
 */
function sseData(res, frame) {
  res.write(`data: ${JSON.stringify(frame)}\n\n`)
}

/**
 * How often a stream says nothing, on purpose.
 *
 * A long-lived response with no bytes on it is indistinguishable from a dead one
 * to anything in the middle, and the middle is where the idle timeouts live: a
 * reverse proxy's read timeout is the usual sixty seconds, and an IDE's port
 * forward is often shorter. Thirty seconds is half of that, so one dropped
 * heartbeat still leaves the connection alive.
 */
const HEARTBEAT_MS = 30 * 1000

/**
 * Turn one request into a live push stream of "this session's payload could have
 * changed" notices.
 *
 * This is deliberately the same shape the host's own `/plugins/events` channel
 * uses (`dsh-client-hmr`): `writeHead(200, text/event-stream)` plus a comment to
 * commit the headers, a `Set` of open responses, and removal on `close`. Doing
 * anything else here would be a second long-lived-connection protocol in one
 * page for no reason.
 *
 * Why push rather than wait: the panel's previous life was an eight-second timer,
 * which is a round trip to say "still the same" four hundred and fifty times an
 * hour. A parked request (what this replaced) is better, but it still has to be
 * re-asked after every answer, which is a poll wearing a longer interval. A
 * stream is opened once and stays; the host writes when it has something to say.
 *
 * @param {object} deps - the api dependencies.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {string} agentId - the session to watch.
 * @param {Set<() => void>} openStreams - every live stream, so a plugin dispose can
 *   end them. A set that is only cleared is not enough: the responses have to be
 *   destroyed as well, or the browser keeps a healthy-looking connection to a
 *   route that no longer exists. That is not a theoretical difference -- measured
 *   against a real socket, a dispose that only unhooked the listeners left the
 *   client's `read()` pending forever and the server still holding the TCP
 *   connection, with the set already empty and no way left to reach it.
 * @returns {() => void} a stop that is safe to call more than once.
 */
function openEventStream(deps, req, res, agentId, openStreams) {
  // Two different ways for a response to be gone, and `writableEnded` only
  // answers one of them. After a client abort Node reports `destroyed === true`
  // while `writableEnded` stays false and `write()` returns false without
  // throwing -- so a guard written only against `writableEnded` lets a frame be
  // written into a dead socket and dropped. Cheap to test both.
  const finished = () => res.destroyed === true || res.writableEnded === true

  // HEAD and other methods are handled before this is called: a stream has no
  // head, and a POST body has nothing to do with a push channel.
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    // `no-cache` rather than `no-store`: the browser may keep the response, it
    // just must not reuse it for a later request. `keep-alive` is what tells
    // every proxy between here and the page not to close an idle connection.
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Belt and braces for a proxied deployment: this response must not be
    // buffered anywhere, or the whole point of a push channel is lost.
    'x-accel-buffering': 'no',
  })
  // The stop is built first, before the frame, the subscription and the beat,
  // so that the registration below really is ahead of everything that can throw.
  // It used to come last, under a comment claiming otherwise: a `send()` or a
  // `panelSubscribe` that threw left a response with SSE headers already
  // committed, absent from the set, unreachable by `closeStreams()` and with the
  // route's `catch` about to append a JSON body to it.
  //
  // `unsubscribe` and `heartbeat` are filled in after registration, so both
  // start as placeholders. No re-check of `stopped` is needed after them: this
  // function is synchronous, so nothing can close the stream while it runs. The
  // two such checks that were here were unreachable, which is exactly the kind of
  // branch this change has been removing elsewhere. `heartbeat` still needs its
  // `undefined` guard, because a throw on the way up leaves it unassigned while
  // the stop is already in the set.
  let stopped = false
  let heartbeat = undefined
  let unsubscribe = () => {}

  // Every exit has to unhook both sides. `close` covers a client that goes away
  // and a socket that dies; `error` covers the write that discovers it. Neither
  // fires reliably without the other, and a missed unhook is a listener leak on
  // a per-session counter that outlives the page.
  //
  // Idempotent on purpose: this runs from the client going away, from a write
  // that discovers the socket is gone, and from a plugin dispose, and more than
  // one of those can happen for the same stream.
  const stop = () => {
    if (stopped === true) return
    stopped = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    openStreams.delete(stop)
    unsubscribe()
    if (typeof req.removeListener === 'function') req.removeListener('close', stop)
    if (typeof res.removeListener === 'function') {
      res.removeListener('close', stop)
      res.removeListener('error', stop)
    }
    // Destroy rather than end. An ordinary EOF tells `EventSource` the stream is
    // over, and it reconnects a few seconds later -- to a route that a dispose
    // has just removed, so it costs a 404 and a retry storm for an answer this
    // side already knows. A destroyed socket surfaces as a network error, which
    // is the branch the client reads as fatal (`readyState === CLOSED`) and stops
    // on. Skipped when the socket is already gone: `destroy()` on a destroyed
    // response is harmless, but on the ordinary client-close path there is
    // nothing left to tell.
    if (typeof res.destroy === 'function' && finished() === false) res.destroy()
  }
  // The set is the only record a stream has, so it goes in before anything else
  // can go wrong.
  openStreams.add(stop)
  if (typeof req.once === 'function') req.once('close', stop)
  if (typeof res.once === 'function') res.once('close', stop)
  if (typeof res.on === 'function') res.on('error', stop)

  // A comment line is the cheapest way to commit the headers. Without it the
  // browser may not treat the stream as open until the first real frame, which
  // could be minutes away — and `EventSource` would look dead in the meantime.
  res.write(': connected\n\n')

  const send = () => {
    if (finished() === true) return
    sseData(res, { agent: agentId, revision: deps.panelRevision(agentId) })
  }
  // The current number goes out at once, so a client that opens the stream does
  // not have to also ask `/panel` for it, and cannot miss an event that lands
  // between the two.
  send()

  // `?? (() => {})` because `panelSubscribe` is an injection point: a host that
  // returns nothing is saying "there is nothing to undo", which is a legal
  // answer -- and `stop` runs from a `close` handler, so an undefined call here
  // would throw inside an event callback and reach the process as an uncaught
  // exception rather than as anything the panel could report.
  const subscribed =
    (typeof deps.panelSubscribe === 'function'
      ? deps.panelSubscribe((changed, revision) => {
          if (changed !== agentId) return
          if (finished() === true) return
          sseData(res, { agent: changed, revision })
        })
      : undefined) ?? (() => {})
  unsubscribe = subscribed

  // A stream that has nothing to say for an hour is a connection every proxy
  // between here and the page has a reason to drop, and `EventSource` would then
  // reconnect in a loop. A comment frame is a byte that says nothing to the
  // client and everything to the middlebox. Thirty seconds: comfortably under
  // nginx's sixty-second `proxy_read_timeout`, which is the tightest default in
  // common use.
  //
  // The interval is injectable so a test can watch a beat without sleeping for
  // one. Not a test-only seam: `deps` is the same object every other timing
  // decision in this module comes from (`SPEED_WAIT_STEP_MS` is a constant only
  // because nothing has needed to vary it).
  const beatMs = typeof deps.heartbeatMs === 'number' && deps.heartbeatMs > 0 ? deps.heartbeatMs : HEARTBEAT_MS
  const beat = setInterval(() => {
    if (stopped === true) return
    if (finished() === true) return
    res.write(': heartbeat\n\n')
  }, beatMs)
  if (typeof beat.unref === 'function') beat.unref()
  heartbeat = beat

  return stop
}

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
      // The panel reads these repeatedly; a cached answer would show a stale turn.
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
 * Turn the panel's own file list into the order the card draws.
 *
 * The two sources disagree about direction. `deps.filesSeen` walks session
 * state's path map backwards, so it already hands back "most recently edited
 * first"; `previous.paths` is the transcript's per-turn list, appended in call
 * order, so it reads oldest-first. Reversing here is what makes the fallback
 * mean the same thing as the primary source — without it a turn that touched
 * four files would list them backwards the one time the session list is empty.
 *
 * String entries and `{ path }` objects both pass through: the fallback comes
 * from the transcript as bare strings, and the primary source as objects.
 *
 * @param {Array<string | { path: string }>} paths - paths in the order they were written.
 * @param {boolean} newestFirst - whether `paths` is already newest-first.
 * @returns {Array<string | { path: string }>} the list in newest-first order.
 */
function newestFirstOf(paths, newestFirst) {
  return newestFirst === true ? paths : paths.slice().reverse()
}

/**
 * The address that opens this file in the Host's right sidebar.
 *
 * Mirrors the Host's own `fileAddressFor`: a path inside the session's working
 * directory becomes `dsh-resource://file/session/<id>/<relative>`, and anything
 * else is sent as a normalised absolute path. The panel already holds absolute
 * paths, so this is the one place that knows `cwd` and can decide.
 *
 * Encoding follows the Host too — `encodeURIComponent` per segment with the
 * drive colon put back, so `F:/work/a b.md` survives the round trip.
 *
 * @param {string} sessionId - the session the preview belongs to.
 * @param {string} cwd - the session's working directory, if known.
 * @param {string} path - an absolute path.
 * @returns {string} the resource address.
 */
function resourceAddress(sessionId, cwd, path) {
  const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
  const normalized = path.replace(/\\/g, '/')
  const root = typeof cwd === 'string' && cwd.length > 0 ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  let relative = normalized
  if (root.length > 0) {
    if (normalized === root) relative = ''
    else if (normalized.startsWith(`${root}/`)) relative = normalized.slice(root.length + 1)
  }
  const encoded = relative.split('/').map(encodeSegment).join('/')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`
}

/**
 * Whether a recorded spelling can name a file at all.
 *
 * These rows are not a rendering accident. The collector once took a descriptor for a
 * target -- `2>&1` leaves `&1` behind, `cmd > out 2>&1` can leave `&1)`, and a glob in an
 * argument (`--include=*.md`) can arrive as a target. The parser no longer produces them,
 * but the state file is append-only, so they have to be refused on the way out or they
 * outlive the bug that made them.
 *
 * The test is narrow on purpose. A false refusal silently hides a real file, which is a
 * worse failure than the row it prevents, so each clause names something that cannot be a
 * file name: `>` `|` `*` `?` are how a shell spells an operator and are illegal on
 * Windows, and `&1` is a descriptor. `&` alone *is* legal inside a file name, so only the
 * descriptor form is refused -- `a&b.txt` stays.
 *
 * On POSIX those four characters are legal in a file name, so this is narrower than it
 * looks: the caller only consults it once `stat` has said the path is absent, which
 * means a file the session really did write and the user later deleted is withheld
 * instead of reported as `missing`. That is the accepted cost -- on Windows, where the
 * card is read, such names cannot exist, so nothing real is ever hidden there. It is
 * recorded here because it is conditional on the platform, not free.
 *
 * @param {string} path - a path as the record spelled it.
 * @returns {boolean}
 */
function cannotBeAPath(path) {
  if (typeof path !== 'string' || path.length === 0) return true
  if (/[>|*?]/.test(path) === true) return true
  // `/dev/null` is a device rather than a file, and its glued-paren spelling `/dev/null)`
  // is what a redirection inside a subshell leaves behind. The prefix makes this safe to
  // refuse: `/dev/` is the POSIX device directory and a project file lives elsewhere,
  // while a rule on the bare word `null` would hide a file anyone may legitimately name.
  //
  // What this does not do: on POSIX, plain `/dev/null` still exists, so `stat` succeeds
  // and the row is reported as a device instead of being refused here. Only the paren
  // spelling dies of absence. On Windows every `/dev/...` path is absent, so the clause
  // does fire -- which is the platform the card is read on.
  if (path.startsWith('/dev/') === true) return true
  // `&` followed by digits is the descriptor form; trailing parens are what a subshell
  // leaves behind. Digits are required: a bare `&` is a legal file name on every platform
  // this runs on, so requiring the digits is what keeps the rule pointed at descriptors.
  const tail = path.split(/[\\/]/u).pop() ?? ''
  return /^&\d+\)*$/u.test(tail)
}

/**
 * Resolve the files a session remembers against the disk, keeping what is gone.
 *
 * A path recorded from a tool call is a claim, not a fact: an `edit` may have
 * been rejected, a `write` may have failed, and the recorded string may be
 * relative to a directory that is not the one the panel is looking at. Each
 * candidate is therefore resolved against the session's cwd and asks the
 * filesystem what it is now.
 *
 * What comes back is a **status**, not a filter. This function used to drop
 * anything `stat` refused, which made "you edited this and then deleted it"
 * indistinguishable from "you never touched it": the row simply was not there.
 * The card is a list of what the session did, and deleting a file does not undo
 * having written it. So a path that is gone comes back as `missing`, a path that
 * exists but cannot be read as `invalid`, and only a real file as `available`.
 *
 * The distinction between the last two is the one the reader can act on:
 * `missing` is something they did on purpose and may want to undo, `invalid` is
 * a permissions or device problem they probably cannot.
 *
 * Each file also carries the flags the card groups by. `turn` says the turn that
 * just ended wrote it — resolved from the number recorded when the file was
 * remembered, falling back to comparing paths for records written before the
 * number was kept. `noise` says a tool wrote it rather than a person.
 *
 * @param {object} input - the request.
 * @param {Array<{ path: string, turn?: number, at?: number } | string>} input.paths - the candidates, newest first.
 * @param {string} [input.cwd] - the directory relative paths resolve against.
 * @param {string} [input.sessionId] - the session the addresses belong to.
 * @param {Set<string>} [input.turnPaths] - normalised paths the last turn wrote.
 * @param {number} [input.turnNow] - the number of the turn that just ended.
 * `stale` answers a third question about the same rows: a person wrote it, but
 * the session has not touched it in a long time. It is derived from `at` — the
 * moment this session last recorded the path — rather than from the file's own
 * mtime. A file's mtime says when some program last wrote it, which on a shared
 * checkout can be a teammate's commit, a `git checkout`, or a build; the question
 * the card asks is "is this still part of what I am doing", and only the session
 * can answer that.
 *
 * @param {(path: string) => Promise<{ isFile: () => boolean, size: number, mtimeMs: number }>} [input.readStat] - how to stat a path, for tests. `isFile()` returning false is not a failure: it is how a folder is told apart from an unreadable path, and the row reports it as `folder`.
 * @param {number} [input.now] - the clock `stale` is measured against, for tests.
 * @param {boolean} [input.onlyDeliverable] - drop rows the card would discard before statting them. Off by default: the contract is to answer for every path given.
 * @returns {Promise<Array<{ path: string, status: 'available' | 'missing' | 'invalid' | 'unresolved' | 'folder', bytes: number | null, mtimeMs: number | null, at: number | null, address: string, turn: boolean, deliverable: boolean }>>} one row per candidate.
 */

// Mirrors `MAX_PATHS` in session-state.js on purpose: the list that comes from
// session state is already this long, so the fallback should not be allowed to
// ask about more than the primary source would.
const MAX_TOUCHED_FILES = 200

async function statTouchedFiles({ paths, cwd, sessionId, turnPaths, turnNow, readStat, now, onlyDeliverable = false }) {
  const clock = Number.isFinite(now) ? now : Date.now()
  const seen = new Set()
  const out = []
  // One `stat` per path, awaited in sequence, was measured at 17.5ms for two
  // hundred paths against 2.6ms for the same set issued together. This runs on
  // every panel read -- once per pushed frame, and on the 60-second floor
  // behind them -- so the difference lands on every refresh.
  //
  // Concurrency changes *when* the filesystem is asked, not *what* is reported:
  // the loop below only collects, the results are assembled in the original
  // order afterwards, and every skip condition keeps its meaning.
  //
  // The cap is here, not only upstream, because the two callers disagree about
  // their own bounds. The session-state list is already trimmed to `MAX_PATHS`
  // on the way in, but the fallback is the transcript's per-turn path list,
  // which has no bound at all -- a command that writes many files appends every
  // one of them. Issuing everything at once over that list would turn a large
  // turn into a large burst of concurrent `stat` calls on the same thread pool
  // the rest of the host is using. Trimming to the same number the other source
  // already uses keeps the two callers equivalent.
  // Note what the cap counts when `onlyDeliverable` is on: rows that will be
  // reported, not paths that were handed over. A two-hundred-path record whose
  // last entry is the only document still answers with that one row, which is
  // the point of the switch.
  const pending = []
  for (const raw of paths) {
    if (pending.length >= MAX_TOUCHED_FILES) break
    // Two shapes arrive here: the objects `pathsSeen` returns, and the bare
    // strings `previous.paths` holds. Accepting both keeps the fallback path
    // working without a second function, and a bare string means exactly what an
    // object with nothing but a path means.
    const path = typeof raw === 'string' ? raw : raw?.path
    if (typeof path !== 'string' || path.length === 0) continue
    const isAbsolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
    const absolute = isAbsolute === true ? path : join(cwd ?? process.cwd(), path)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    const recordedTurn = typeof raw === 'object' && raw !== null ? raw.turn : undefined
    const recordedAt = typeof raw === 'object' && raw !== null ? raw.at : undefined
    // What the model said about this file, carried through unchanged. A bare
    // string and an object without a description both mean "nothing was said",
    // which is one value, not two.
    const recordedDescription = typeof raw === 'object' && raw !== null && typeof raw.description === 'string' ? raw.description : ''
    // "This turn" means the turn the card is describing, and the card describes
    // `previous` — its head counts and its path list both come from there. So the
    // path comparison answers whenever a snapshot exists.
    //
    // The stored number is only a fallback, for a document whose `previous` has no
    // path list. It deliberately does not outvote the snapshot: it is a counter
    // from whichever process wrote it, and a restart replays events before the
    // panel is ever polled, so a live `previous.turn` can be a small number (1)
    // that collides with stamps written under a much later turn by the process
    // before it. Trusting the number first promoted old files into "this turn",
    // and could equally veto a file the snapshot had just listed.
    const turn =
      turnPaths !== undefined
        ? turnPaths.has(absolute)
        : Number.isFinite(recordedTurn) && Number.isFinite(turnNow)
          ? recordedTurn === turnNow
          : false
    const base = {
      path: absolute,
      address: resourceAddress(sessionId ?? '', cwd, absolute),
      turn,
      at: Number.isFinite(recordedAt) ? recordedAt : null,
      description: recordedDescription,
      // Asked here, on the way out, rather than at collection time. Two reasons.
      //
      // The list this reads is a session's own history, and a session that ran
      // before the card meant "delivered documents" recorded source files in it.
      // Those records are still on disk and still arrive here, so the question
      // has to be answered again on every read or the card keeps showing what the
      // old rule let in.
      //
      // And it is the only place that sees the absolute path. The record stores
      // what the model declared, which is usually absolute already but need not
      // be; a whitelist applied before the join would be judging a fragment.
      deliverable: isDeliverable(absolute),
    }
    // Asked for by the panel, and only by the panel. The card answers one
    // question -- which documents were handed over -- so a row it will discard
    // is a `stat` nobody asked for. Measured on this machine's worst real
    // session: 38 recorded paths, 5 of them deliverables, 1.02ms against
    // 0.13ms. Not a switch on by default, because the contract here is "answer
    // for what you were given" and a caller that wants everything must keep
    // getting everything.
    //
    // Placed after `base` is built, not before it: `deliverable` is what
    // `isDeliverable` says about the *absolute* path, and the whitelist has to
    // judge the whole path rather than the fragment the record holds.
    if (onlyDeliverable === true && base.deliverable === false) continue
    pending.push({ path, absolute, isAbsolute, base })
  }
  // Phase two: ask about every path at once, then put the answers back in the
  // order the loop found them. `Promise.all` preserves index order regardless of
  // which `stat` finishes first, so the card's rows are identical to the ones the
  // sequential version produced.
  //
  // A path that must be withheld answers `null` rather than skipping a push; the
  // filter below drops it. Returning null keeps the "did not yield a row" cases
  // sitting next to their reasons, which is where they were before.
  const rows = await Promise.all(pending.map(async (entry) => {
    const { path, absolute, isAbsolute, base } = entry
    let info
    try {
      if (typeof readStat === 'function') {
        info = await readStat(absolute)
      } else {
        // Resolved once at module load, not once per path. The dynamic import sat
        // inside this loop and ran two hundred times per refresh while the module
        // cache made it cheap; the cost was never the point — a filesystem call in
        // a hot loop should not also be a module lookup.
        info = await statFile(absolute)
      }
    } catch (error) {
      // Three answers, not two. Not there, not readable, and "this path was
      // assembled from a record that never learned which directory it was
      // relative to" — the last one is not knowable from here, and reporting it
      // as deleted turned a file the turn had just written into a row with a
      // line through it.
      const gone = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      // A record can outlive the parser that wrote it. When the filesystem also says
      // there is nothing there and the spelling could not be a path anyway, the record
      // is a mis-parse rather than a deleted file -- drawing it would say "you deleted
      // this" about something that was never a name. The state file is append-only, so
      // the record survives for whoever works out later what the command meant; only
      // the row is withheld.
      //
      // This sits here, after `stat`, and not before it: a real file may legitimately be
      // called `a*b.txt`, `stat` would have found it, and refusing up front would hide a
      // file the session had written -- the same lie in the opposite direction.
      if (gone === true && cannotBeAPath(path) === true) return null
      const status = gone === false ? 'invalid' : isAbsolute === true ? 'missing' : 'unresolved'
      return { ...base, status, bytes: null, mtimeMs: null }
    }
    // Something is at this path and it is not a file. The awkward part is that
    // this used to say `missing`, and `missing` is a claim about the past: "what
    // you wrote is not here". That claim is false — a folder is there. It showed
    // up in a real session as `F:\dsh-plugin\` struck through and labelled
    // 已删除, which is the card telling someone their working directory had been
    // deleted.
    //
    // `unresolved` is not the answer either. That word means the record lost its
    // base and the path could not be looked at; here it was looked at and the
    // answer was "a folder". Two different answers must not share a word, or
    // neither of them can be reported honestly. So: a fifth status, which says
    // exactly what was found.
    if (!info.isFile()) {
      return { ...base, status: 'folder', bytes: null, mtimeMs: null }
    }
    return { ...base, status: 'available', bytes: info.size, mtimeMs: info.mtimeMs }
  }))
  for (const row of rows) {
    if (row !== null) out.push(row)
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
 * @param {(agentId: string) => Map<string, number> | undefined} [deps.recentUse] -
 *   the recency clock this session's skills and MCP servers share.
 * @param {(agentId: string, skill: string) => void} deps.requestProposal - queue a hint.
 * @param {(agentId: string) => Set<string>} deps.mcpTools - MCP tool names this session called.
 * @param {() => Array<{ provider: string, models: Array<{ id: string, name: string }> }>} deps.modelCatalog - available routes.
 * @param {() => Promise<number>} [deps.pendingCandidates] - how many candidates await approval.
 * @param {() => Promise<Array<object>>} [deps.listCandidates] - the queue, shaped for the card.
 * @param {(name: string, agent: any, id?: string) => Promise<object>} [deps.approveCandidate] - approve one candidate.
 *   The id, when given, is the row the card was pointing at; a name alone resolves to
 *   whichever row `findByName` prefers, which is not always the one on screen.
 * @param {(name: string, id?: string) => Promise<object>} [deps.discardCandidate] - discard one candidate.
 *   Same id-then-name rule as `approveCandidate`.
 * @param {any} [deps.sessionState] - the persisted per-session state, read when memory has nothing.
 * @param {(req: import('node:http').IncomingMessage) => number | undefined} [deps.admission] -
 *   the host's own answer for "may this request be served": an HTTP status to
 *   refuse with, or `undefined` to allow. Absent when the host has no connection
 *   service, in which case the origin check above is the whole story.
 * @param {(message: string) => void} [deps.log] - diagnostics.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
function createPanelApi(deps) {
  // One set for the whole plugin: the point of it is that a dispose can reach
  // streams opened by requests that are no longer on the stack.
  const openStreams = new Set()

  /**
   * Route one request.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  async function handle(req, res) {
    const rejected = checkOrigin(req)
    if (rejected !== undefined) {
      json(res, 403, { ok: false, code: 'error.origin.forbidden', error: rejected })
      return
    }
    // The host's admission, not this plugin's opinion.
    //
    // `checkOrigin` above answers a different question: "did this arrive from a
    // page that is allowed to talk to this server". It says nothing about who is
    // asking, and a loopback listener is reachable by every process and every
    // user on the machine. Everything below it serves the person's own
    // conversation, so the same admission the host's `/api` route applies has to
    // apply here too — otherwise the panel is a hole in an otherwise closed door.
    //
    // `admission` is optional because a host without a connection service cannot
    // answer. That case stays open rather than shutting the panel off for
    // everybody: the plugin cannot invent an identity check it was not given.
    // A host that *can* answer and then fails is refused instead — a route that
    // serves private conversation must not fall open because the question was
    // hard.
    if (typeof deps.admission === 'function') {
      let refusal
      try {
        refusal = deps.admission(req)
      } catch (error) {
        deps.log?.(`panel: admission check failed, refusing: ${error?.message ?? error}`)
        refusal = 401
      }
      if (typeof refusal === 'number') {
        json(res, refusal, { ok: false, code: 'error.auth.required', error: 'this route needs the host to vouch for the request' })
        return
      }
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
      if (path === `${ROUTE_PREFIX}/panel`) {
        // The read itself is deliberately *not* made to wait. A wait answers
        // "has anything changed since the reading you hold", and the answer has
        // to be useful to a caller that wants the payload too. So the shape is
        // two routes: `/events` holds a connection and writes a frame when the
        // counter moves, `/panel` fetches. The client opens the stream once and
        // fetches on each frame.
        // `headOnly` used to decide only whether the body was written, so a
        // probe that asked for headers paid for the whole read: one `stat` per
        // recorded path, every time. The client never sends HEAD; anything that
        // does only wants to know the route is there.
        if (headOnly === true) return json(res, 200, { ok: true }, true)
        return json(res, 200, { ok: true, data: await readPanel(deps, agentId) })
      }
      // The push channel: one open connection per watched session, answering
      // the moment the counter moves rather than when a timer next asks.
      //
      // One route per concern, not folded into `/panel`: a change notice and a
      // document are different sizes and different lifetimes, and merging them
      // would mean either re-sending a hundred kilobytes because a counter moved
      // or holding a document open for twenty-five seconds so it can expire in
      // the socket.
      if (path === `${ROUTE_PREFIX}/events`) {
        if (typeof agentId !== 'string' || agentId.length === 0) {
          return json(res, 400, { ok: false, code: 'error.agent.missing', error: 'the events route needs a session id' }, headOnly)
        }
        if (headOnly === true) {
          // A HEAD cannot carry a stream. Answering 200 with no body is the
          // honest reply, and it lets the client discover the route without
          // opening a connection it would then have to close.
          return json(res, 200, { ok: true, data: { agent: agentId, streaming: true } }, headOnly)
        }
        // The shared method gate lets POST through because most routes take a
        // body. This one does not, and a POST here would park an open stream on
        // a request whose body is never read -- the host would wait for it while
        // the response wrote frames.
        if (req.method !== 'GET') {
          return json(res, 405, { ok: false, code: 'error.method.unsupported', error: `${req.method} is not supported on a stream` })
        }
        openEventStream(deps, req, res, agentId, openStreams)
        return undefined
      }
      if (path === `${ROUTE_PREFIX}/models`) return json(res, 200, { ok: true, data: { providers: deps.modelCatalog() } }, headOnly)
      // A speed is a reading of the last two seconds, not a document. It is a
      // route rather than a field on `/panel` because the two are polled on
      // different clocks: the panel changes when a turn ends, this changes while
      // one is arriving, and folding them together would mean either dragging the
      // panel down to the badge's quarter-second beat (four requests a second for
      // numbers that cannot change that often) or leaving the speed up to eight
      // seconds stale, which is the whole generation.
      if (path === `${ROUTE_PREFIX}/speed`) {
        if (typeof agentId !== 'string' || agentId.length === 0) {
          return json(res, 400, { ok: false, code: 'error.agent.missing', error: 'the speed route needs a session id' }, headOnly)
        }
        if (typeof deps.speedOf !== 'function') {
          return json(res, 200, { ok: false, code: 'error.speed.absent', error: 'this panel does not measure output speed' }, headOnly)
        }
        // The long poll. A badge that asks on a timer discovers a reply up to one
        // interval late, and the interval has to be long enough not to be traffic
        // — which was ten seconds, longer than most replies. `wait` turns the
        // question around: the request stays open until the reading could say
        // something new, then answers. It never waits on HEAD (a probe has no
        // body to fill) and never waits when the client did not ask.
        if (headOnly !== true) await speedWait(deps, req, agentId, url.searchParams)
        return json(res, 200, { ok: true, data: deps.speedOf(agentId) }, headOnly)
      }
      // "What should I do next". A read, and the only route in this plugin that
      // reaches a model on behalf of a turn that has already finished.
      //
      // It is its own route rather than a field on `/panel` for two reasons, and
      // the second is the important one. The panel is polled on a clock, and
      // this call takes hundreds of milliseconds; folding them together would
      // either slow every poll down or let the panel's own deadline cancel the
      // call. And the panel is asked about sessions nobody is watching — the
      // route is only ever asked by a composer, which exists for the one session
      // in front of a person. That is what makes "not being looked at" cost
      // nothing (see `lib/suggest.js`), and it is why this route may sit behind
      // an ordinary request with no further gate than its own cache.
      if (path === `${ROUTE_PREFIX}/suggestions`) {
        // No switch branch here: the route answers even when suggestions are
        // turned off, because "off" is a fact the composer has to be able to
        // read. A 404 would leave it retrying, and an empty list with no reason
        // would leave it unable to tell "off" from "nothing yet" — the two cases
        // that differ in whether the next turn's chip row ever appears.
        //
        // The one route here that reaches a model on a read is also the one that
        // says so: the shared method gate lets POST through because most routes
        // take a body, and a POST to this one would buy a set of chips for a
        // caller that is not a composer.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return json(res, 405, { ok: false, code: 'error.method.unsupported', error: `${req.method} is not supported on a read` })
        }
        if (typeof agentId !== 'string' || agentId.length === 0) {
          return json(res, 400, { ok: false, code: 'error.agent.missing', error: 'the suggestions route needs a session id' }, headOnly)
        }
        if (typeof deps.suggestor?.suggestions !== 'function') {
          return json(res, 200, { ok: true, data: { enabled: false, items: [], reason: 'this panel does not suggest' } }, headOnly)
        }
        // A probe learns only that the route exists. Answering it fully would
        // mean a paid call for a HEAD, and the client's health check does not
        // ask with one.
        if (headOnly === true) return json(res, 200, { ok: true, data: { enabled: true, items: [] } }, true)
        const view = await viewOf(deps, agentId)
        // The session's own route first, exactly as the summary does: a route
        // this session is already running on is proven reachable and authorised
        // for this account, while a catalogue entry only proves some adapter
        // advertised it.
        const sessionRoute = typeof deps.routeFor === 'function' ? deps.routeFor(agentId) : undefined
        const answer = await deps.suggestor.suggestions({ agentId, view, sessionRoute })
        return json(res, 200, { ok: true, data: answer })
      }
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
        const decision = await decideCandidate(deps, body.value, agentId)
        // Approving or discarding moves `pendingCandidates`, which is part of the
        // panel payload -- and this path goes nowhere near a session event, so
        // nothing else would notice. Without the bump a second tab on the same
        // conversation keeps showing the old count until the minute clock.
        if (decision?.ok !== false && typeof deps.panelBump === 'function') deps.panelBump(agentId)
        return json(res, 200, { ok: true, data: decision })
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

  /**
   * End every live stream.
   *
   * Called from the plugin's dispose: the route is about to stop existing, and a
   * browser left holding an open response would sit on a connection that will
   * never carry another frame. Destroying the response is what tells it to give
   * up rather than wait.
   */
  handle.closeStreams = () => {
    for (const stop of [...openStreams]) stop()
    openStreams.clear()
  }

  /**
   * How many streams are open right now.
   *
   * The set is the only record of them, so a stream that closes without removing
   * itself is a leak nothing else would notice: `stop` is idempotent, so a stale
   * entry costs nothing until the process has been open long enough to hold
   * thousands of them. Exposed so a test can see the difference between "closed"
   * and "forgotten", which the observable behaviour cannot distinguish.
   *
   * @returns {number} the count.
   */
  handle.openStreamCount = () => openStreams.size

  return handle
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
    // A wired-up dependency that answers `undefined` means the package that owns
    // the queue is not installed. That is a different fact from "the queue is
    // empty", and the card has a distinct state for it, so it must not be
    // reported as `available: true` with zero rows.
    if (Array.isArray(rows) === false) {
      return { available: false, reason: THE_SKILL_HALF_IS_ABSENT, candidates: [] }
    }
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
      const outcome = await deps.discardCandidate(name, id)
      if (outcome === undefined) return { ok: false, code: 'unavailable', error: THE_SKILL_HALF_IS_ABSENT }
      return outcome
    } catch (error) {
      deps.log?.(`panel api discard ${name}: ${error?.message ?? error}`)
      return { ok: false, code: 'error.internal', error: String(error?.message ?? error) }
    }
  }
  if (typeof deps.approveCandidate !== 'function') {
    return { ok: false, code: 'unavailable', error: 'approving is not wired up' }
  }
  try {
    const outcome = await deps.approveCandidate(name, agentId, id)
    if (outcome === undefined) return { ok: false, code: 'unavailable', error: THE_SKILL_HALF_IS_ABSENT }
    return outcome
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
 * One session's panel view, from memory or from the last snapshot written.
 *
 * The fallback is what makes the panel describe a conversation rather than a
 * process. A host restart, a reload, a panel opened on a session that has not
 * emitted an event since this process started: in all three the transcript map
 * has nothing, and answering "no completed turn yet" for a conversation with
 * twenty turns is the bug this exists to remove.
 *
 * Disk is read once per session, not once per request. The load installs what it
 * found into the transcript store, so the second poll finds it in memory like
 * any other live session — and a session that had nothing stored is remembered
 * as empty rather than re-read on every poll.
 *
 * A failure here is not a panel failure: the conversation is still there, so the
 * view degrades to whatever memory has and the poll answers.
 *
 * @param {object} deps - the API dependencies.
 * @param {string} agentId - the session.
 * @returns {Promise<object | undefined>} the view, or undefined when nothing is known.
 */
async function viewOf(deps, agentId) {
  const state = deps.sessionState
  if (state === undefined || typeof state.load !== 'function') return deps.transcripts.view(agentId)
  // Nothing here asks whether memory already holds a transcript. It almost
  // always does: `record()` builds one from the first event, and the host
  // replays a session's events before anything polls the panel. Answering from
  // memory in that case skipped the read for the rest of the process, so a
  // conversation that had reached turn seven showed as turn one until its next
  // turn ended — the exact window in which someone opens the panel.
  //
  // `load()` is the one that knows whether the disk still needs reading: it
  // returns false for a record that has already read, so every read after the
  // first one costs a map lookup.
  try {
    await state.load(agentId)
  } catch (error) {
    if (typeof deps.log === 'function') deps.log(`panel: could not read the stored state — ${error?.message ?? error}`)
  }
  return deps.transcripts.view(agentId)
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
  // Served once, so this session has a reader. The summariser only warms turns
  // for sessions it has actually been asked about, and this is the only place
  // that knows the difference between "a session that exists" and "a session
  // somebody is watching". Recorded before the summary branch below, because
  // the panel was opened whether or not a summary is configured.
  if (id.length > 0 && deps.summariser?.markViewed !== undefined) deps.summariser.markViewed(id)
  const view = id.length > 0 ? await viewOf(deps, id) : undefined
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

  const recency = typeof deps.recentUse === 'function' ? deps.recentUse(id) : undefined
  const skills = await describeSkills({
    skills: deps.skills(),
    exec: id.length > 0 ? deps.execFor(id) : undefined,
    isOwned: deps.isOwned,
    used: typeof deps.skillsUsed === 'function' ? deps.skillsUsed(id) : undefined,
    recency,
  })
  // The output card lists the session's work in newest-first order, not the turn
  // that just ended. `previous.paths` was the old source and it described one
  // turn: a turn that touched nothing emptied the card, and a turn that re-edited
  // one file hid the other nineteen. The cumulative list lives in session state
  // and survives both the turn ending and a restart; the transcript stays the
  // source of truth for the turn itself, which is what the previous-turn card
  // shows.
  //
  // The order comes from the sources, not from the filesystem. `filesSeen` is
  // already newest-first (it walks the path map backwards), which is the order
  // the conversation wrote them in; `mtime` would be a second answer to the same
  // question and a different one — a build step touching an old file would jump
  // it to the top of a list about editing.
  const remembered = typeof deps.filesSeen === 'function' ? deps.filesSeen(id) : []
  const fallback = newestFirstOf(previous === undefined ? [] : (previous.paths ?? []), false)
  const cwd = deps.cwdFor(id)
  // Which of those files the turn that just ended wrote. Resolved the same way
  // `statTouchedFiles` resolves them, because the transcript records what the
  // tool was handed — often a relative path — while the session list holds the
  // absolute one, and a raw string comparison would answer "none of them".
  const turnPaths = new Set()
  for (const raw of Array.isArray(previous?.paths) ? previous.paths : []) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    turnPaths.add(raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) ? raw : join(cwd ?? process.cwd(), raw))
  }
  const files = await statTouchedFiles({
    paths: remembered.length > 0 ? remembered : fallback,
    cwd,
    sessionId: id,
    turnPaths,
    // The card discards every row that is not a document, so asking the disk
    // about the others is work with no reader. Measured on this machine's worst
    // real session: 38 recorded paths, 5 documents, 1.02ms against 0.13ms.
    onlyDeliverable: true,
    // The remembered number is preferred inside `statTouchedFiles`; this is what
    // a record without one is compared against.
    turnNow: Number.isFinite(previous?.turn) ? previous.turn : undefined,
  })

  return {
    agent: id,
    turn: view?.turns ?? 0,
    summary,
    skills,
    mcp: describeMcp(typeof deps.mcpTools === 'function' ? deps.mcpTools(id) : new Set(), recency),
    files,
    // The card shows a directory under each name rather than the whole path,
    // which it can only do by subtracting this. Sending it is cheaper than
    // sending a pre-relative string per file and keeps the absolute path — the
    // only thing that can be opened, copied, or compared — on every row.
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
    // The count beside 调用 and 命令 on the previous-turn card. Those two come
    // from `previous` and describe the turn that just ended; the file count has
    // to describe the same turn or the three numbers read as one set while one
    // of them is about the whole session. The cumulative list is `files`.
    turnFiles: Array.isArray(previous?.paths) ? previous.paths.length : 0,
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
 * Five, and all five are about the panel. Everything that governs the detector
 * lives in the host's own settings UI, where changing it is a decision with a
 * diff.
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
    // The monitor column. `monitorWidth` goes out as `null` rather than `0` when
    // the setting is not a number: the client treats a finite value as "start at
    // this width" and anything else as "use the designed default", and `0` is a
    // finite value that would collapse the column on the first measurement.
    monitorColumn: config.monitorColumn !== false,
    monitorWidth: Number.isFinite(config.monitorWidth) ? config.monitorWidth : null,
    // The next-step switches. `panelSuggestions` is read by the panel's own
    // settings row, so "off" has to survive the round trip to the switches that
    // turned it off; `suggestionCount` follows `monitorWidth` in going out as
    // `null` rather than a substituted number when the setting is not a number,
    // because the client treats a finite value as the answer and anything else
    // as "use the designed default".
    panelSuggestions: config.panelSuggestions !== false,
    suggestionCount: Number.isFinite(config.suggestionCount) ? config.suggestionCount : null,
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
    // `undefined` is "the package that queues hints is not installed", not one of
    // the four refusals below. Without this branch it fell through to the success
    // return and the button claimed a hint had been queued.
    if (outcome === undefined) return { ok: false, reason: THE_SKILL_HALF_IS_ABSENT }
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
  // they apply immediately and last until the host restarts. Writing the host's
  // config file from here would let one plugin rewrite another's settings.
  // The monitor column's width is dragged, so it changes far more often than the
  // other switches and has to survive a restart to be worth anything. It still
  // goes through the same override as its neighbours: writing the host's config
  // file from here would let one plugin rewrite another's settings.
  if (typeof body?.monitorColumn === 'boolean') patch.monitorColumn = body.monitorColumn
  if (Number.isFinite(body?.monitorWidth)) patch.monitorWidth = body.monitorWidth
  if (typeof body?.panelSuggestions === 'boolean') patch.panelSuggestions = body.panelSuggestions
  if (Number.isFinite(body?.suggestionCount)) patch.suggestionCount = body.suggestionCount
  if (Object.keys(patch).length === 0) {
    return { ...readConfig(deps), ok: false, reason: 'nothing to change' }
  }
  deps.applyOverride(patch)
  if (patch.summaryProvider !== undefined || patch.summaryModel !== undefined) deps.summariser.reset()
  // A suggestion says "given these turns, do this next". Turning the feature off
  // and on again, or changing how many chips are asked for, changes the question
  // — but the cache is keyed by turn and text, so a stale answer would survive
  // both. Dropping it costs at most one call on the next turn, and the
  // alternative is a switch that appears not to have worked.
  if (patch.panelSuggestions !== undefined || patch.suggestionCount !== undefined) deps.suggestor?.reset?.()
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
  isDeliverable,
}
