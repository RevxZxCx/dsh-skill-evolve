/**
 * The live stream: hub semantics, and the route that carries them.
 *
 * Two things are being tested and they fail differently. The hub is pure state —
 * who is listening, and what happens to a listener that throws. The route is a
 * long-lived response, which is the part that is easy to get wrong and hard to
 * notice: a stream that never flushes looks like a stream that works until the
 * client asks why nothing happened, and a stream that is not torn down leaks one
 * socket per conversation the person visits.
 */

import { createPanelApi, ROUTE_PREFIX } from '../packages/ui-evolve/lib/api.js'
import { LiveHub } from '../packages/ui-evolve/lib/live.js'
import { TranscriptStore } from '../packages/ui-evolve/lib/transcript.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

{
  const hub = new LiveHub()
  const heard = []
  const stop = hub.subscribe('s1', () => heard.push('a'))
  check('a session with a listener is watched', hub.watching('s1') === 1, String(hub.watching('s1')))
  check('another session is not', hub.watching('s2') === 0, String(hub.watching('s2')))

  const told = hub.publish('s1')
  check('publishing tells the listener', told === 1, String(told))
  check('and the listener ran', heard.length === 1, JSON.stringify(heard))
  check('a publish with nobody listening tells nobody', hub.publish('s2') === 0)
  stop()
  check('after the teardown nothing is watched', hub.watching('s1') === 0, String(hub.watching('s1')))
  check('and publishing reaches nobody', hub.publish('s1') === 0)
}

{
  // Two streams for one session both have to hear it. This is the ordinary case:
  // the panel is open in two tabs, or a window was reloaded before the old
  // socket died.
  const hub = new LiveHub()
  const heard = []
  const stopA = hub.subscribe('s1', () => heard.push('a'))
  const stopB = hub.subscribe('s1', () => heard.push('b'))
  check('two listeners are both counted', hub.watching('s1') === 2, String(hub.watching('s1')))
  hub.publish('s1')
  check('and both hear the publish', heard.join(',') === 'a,b', JSON.stringify(heard))
  stopA()
  stopA()
  stopA()
  check('a teardown called three times removes one listener', hub.watching('s1') === 1, String(hub.watching('s1')))
  heard.length = 0
  hub.publish('s1')
  check('and the other stream still hears it', heard.join(',') === 'b', JSON.stringify(heard))
  stopB()
  check('the session is forgotten with its last listener', hub.watching('s1') === 0, String(hub.watching('s1')))
  // The lookup reads zero either way. What this catches is the map entry that
  // outlives the last listener: the plugin keeps one hub for the life of the
  // process, so a per-conversation entry that is never dropped grows for as
  // long as the app stays open.
  check('and the entry leaves the map with it', hub.byAgent.size === 0, String(hub.byAgent.size))
}

{
  // A listener that throws is a half-closed socket. It must not take the host's
  // event dispatch down with it, and it must not keep being called.
  const logs = []
  const hub = new LiveHub({ log: (message) => logs.push(message) })
  let calls = 0
  hub.subscribe('s1', () => {
    calls += 1
    throw new Error('socket is gone')
  })
  const heard = []
  hub.subscribe('s1', () => heard.push('survivor'))

  let thrown
  try {
    hub.publish('s1')
  } catch (error) {
    thrown = error
  }
  check('a throwing listener does not throw out of publish', thrown === undefined, String(thrown))
  check('the other listener still heard it', heard.length === 1, JSON.stringify(heard))
  check('the failure was logged', logs.length === 1 && logs[0].includes('socket is gone'), JSON.stringify(logs))
  check('and the throwing listener was dropped', hub.watching('s1') === 1, String(hub.watching('s1')))
  // Guarded too: the whole point is that a bad listener cannot throw, so the
  // second publish has to be observed the same way as the first. An unguarded
  // call here would turn a regression into a crashed suite, which reads as a
  // broken test rather than a broken hub.
  let again
  try {
    hub.publish('s1')
  } catch (error) {
    again = error
  }
  check('and a second publish does not throw either', again === undefined, String(again))
  check('it is not called a second time', calls === 1, String(calls))
}

{
  // Publishing is only counted when somebody heard it: `published` is what a
  // diagnostic reads to answer "is this thing doing anything", and counting
  // publishes that reached nobody would make a dead stream look alive.
  const hub = new LiveHub()
  hub.publish('nobody')
  check('a publish with no listeners does not count', hub.published === 0, String(hub.published))
  const stop = hub.subscribe('s1', () => {})
  hub.publish('s1')
  check('a publish that landed counts', hub.published === 1, String(hub.published))
  stop()
}

{
  // Both guards below are observed *before* the teardown runs. The obvious
  // version — subscribe, call the returned function, assert nothing is watched —
  // passes for a hub that accepted the subscription, because the teardown it
  // hands back removes it again. The question is whether the bad subscription
  // was refused, so it has to be asked while it would still be in effect.
  const hub = new LiveHub()
  const reached = []
  const stopEmpty = hub.subscribe('', () => reached.push('empty'))
  check('an empty session id cannot be subscribed', hub.watching('') === 0 && hub.byAgent.has('') === false, String(hub.watching('')))
  check('and a publish cannot reach it', hub.publish('') === 0, String(hub.publish('')))
  check('and it never ran', reached.length === 0, JSON.stringify(reached))
  stopEmpty()

  const stopNull = hub.subscribe('s1', 'not a function')
  check('a sink that is not a function is refused', hub.watching('s1') === 0, String(hub.watching('s1')))
  check('and publishing to it does not throw', hub.publish('s1') === 0, String(hub.publish('s1')))
  stopNull()

  const stopUndefined = hub.subscribe('s1', undefined)
  check('so is an absent one', hub.watching('s1') === 0, String(hub.watching('s1')))
  stopUndefined()
}

{
  // `published` is the counter a diagnostic reads to answer "is this stream doing
  // anything". A publish whose every listener threw reached nobody, so counting
  // it would make a dead stream report itself alive — the exact reading the
  // counter exists to prevent.
  const logs = []
  const hub = new LiveHub({ log: (message) => logs.push(message) })
  hub.subscribe('s1', () => {
    throw new Error('gone')
  })
  // Guarded, and for the reason the other throwing-listener block already spells
  // out: every statement here is a claim that a bad listener cannot escape, so an
  // unguarded call would let the assertion under test crash the suite instead of
  // failing it — and a crashed suite reports no tally at all, which reads as a
  // broken test rather than a broken hub.
  let told
  try {
    told = hub.publish('s1')
  } catch (error) {
    told = error
  }
  check('a publish that reached only a throwing listener counts nothing', hub.published === 0, String(hub.published))
  check('and reports nobody told', told === 0, String(told))
  void logs
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** A response that behaves enough like a socket for `streamLive`. */
function fakeRes() {
  const chunks = []
  const res = {
    statusCode: undefined,
    headers: undefined,
    chunks,
    ended: false,
    destroyed: false,
    writableEnded: false,
    flushed: 0,
    listeners: [],
    once(event, handler) {
      res.listeners.push([event, handler])
      return res
    },
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
      return res
    },
    write(text) {
      chunks.push(text)
      return true
    },
    flush() {
      res.flushed += 1
    },
    end(body) {
      res.ended = true
      res.writableEnded = true
      res.endedWith = body
      return res
    },
    destroy() {
      res.destroyed = true
      return res
    },
    fire(event) {
      for (const [name, handler] of res.listeners) if (name === event) handler()
    },
  }
  // `text` is the stream so far; `endedWith` is a JSON body, if the route chose
  // to answer instead of streaming. They are separate because the two are
  // different kinds of answer and one must never be read as the other.
  res.text = {
    get value() {
      return chunks.join('')
    },
  }
  return res
}

function fakeReq({ url = '/', method = 'GET', headers = {} } = {}) {
  const merged = { host: '127.0.0.1:19387', ...headers }
  const res = {
    url,
    method,
    headers: merged,
    listeners: [],
    once(event, handler) {
      res.listeners.push([event, handler])
      return res
    },
    fire(event) {
      for (const [name, handler] of res.listeners) if (name === event) handler()
    },
  }
  return res
}

function deps(overrides = {}) {
  return {
    config: () => ({}),
    transcripts: { view: () => undefined },
    summariser: { summarise: async () => ({ enabled: true, reason: 'stub' }), reset: () => {} },
    execFor: () => ({}),
    skills: () => undefined,
    isOwned: () => false,
    cwdFor: () => process.cwd(),
    requestProposal: () => {},
    mcpTools: () => new Set(),
    modelCatalog: () => [],
    pendingCandidates: async () => 0,
    log: () => {},
    ...overrides,
  }
}

{
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const req = fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` })
  const res = fakeRes()
  await api(req, res)

  check('the stream answers 200', res.statusCode === 200, String(res.statusCode))
  check('as an event stream', String(res.headers?.['content-type'] ?? '').startsWith('text/event-stream'), String(res.headers?.['content-type']))
  check('that no cache may keep', String(res.headers?.['cache-control'] ?? '').includes('no-store'), String(res.headers?.['cache-control']))
  check('and no proxy may buffer', String(res.headers?.['cache-control'] ?? '').includes('no-transform') && res.headers?.['x-accel-buffering'] === 'no', JSON.stringify(res.headers))
  check('the first bytes are written before anything happens', res.chunks.length === 1 && res.chunks[0].startsWith(':'), JSON.stringify(res.chunks))
  check('and each write is flushed', res.flushed === res.chunks.length, `${res.flushed} of ${res.chunks.length}`)
  check('the stream is subscribed to that session', hub.watching('s1') === 1, String(hub.watching('s1')))
  check('and it has not ended', res.ended === false)
}

{
  // What the client actually keys on: a named event. A comment line (the ping)
  // must not be mistaken for one, which is why the payload is an event and not a
  // bare write.
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const res = fakeRes()
  await api(fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` }), res)
  const before = res.chunks.length
  hub.publish('s1')
  check('a publish writes one more chunk', res.chunks.length === before + 1, `${before} -> ${res.chunks.length}`)
  const frame = res.chunks.at(-1)
  check('the chunk is a named panel event', frame.startsWith('event: panel\n'), JSON.stringify(frame))
  check('and it ends the frame', frame.endsWith('\n\n'), JSON.stringify(frame))
  check('a publish for another session writes nothing', (hub.publish('s2'), res.chunks.length === before + 1), String(res.chunks.length))
}

{
  // Ending the response is what tells the browser the conversation is over.
  // Without it a closed socket is a network fault, and `EventSource` retries
  // against a session that has gone away, forever.
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const req = fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` })
  const res = fakeRes()
  await api(req, res)
  req.fire('close')
  check('closing the request ends the response', res.ended === true, String(res.ended))
  check('and unsubscribes', hub.watching('s1') === 0, String(hub.watching('s1')))
}

{
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const res = fakeRes()
  await api(fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` }), res)
  res.fire('close')
  check('closing the response also unsubscribes', hub.watching('s1') === 0, String(hub.watching('s1')))
  check('and ends it', res.ended === true, String(res.ended))
}

{
  // The heartbeat is invisible from the outside: a stream that never pings and a
  // stream that pings look identical until a proxy drops the connection after a
  // minute of silence. And `unref` is invisible too — without it a client that
  // vanished mid-stream holds the whole process open. Both are only observable
  // at the timer, so the timer is what this block watches.
  const beats = []
  const cleared = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => {
    const record = { fn, ms, unrefCalls: 0 }
    record.unref = () => {
      record.unrefCalls += 1
    }
    beats.push(record)
    return record
  }
  globalThis.clearInterval = (handle) => {
    cleared.push(handle)
  }
  try {
    const hub = new LiveHub()
    const api = createPanelApi(deps({ live: hub }))
    const req = fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` })
    const res = fakeRes()
    await api(req, res)

    const beat = beats.at(-1)
    check('the stream schedules a heartbeat', beat !== undefined, String(beats.length))
    // Long enough to be invisible, short enough that a proxy idle timeout (60s
    // is the common one) never expires first.
    check('far enough apart not to be traffic', beat?.ms === 25000, String(beat?.ms))
    check('and it does not keep the process alive', beat?.unrefCalls === 1, String(beat?.unrefCalls))

    const before = res.chunks.length
    beat?.fn()
    check('the heartbeat writes one line', res.chunks.length === before + 1, `${before} -> ${res.chunks.length}`)
    const ping = String(res.chunks.at(-1))
    check('which is a comment, not an event', ping.startsWith(':') && ping.endsWith('\n\n'), JSON.stringify(ping))

    req.fire('close')
    check('closing the stream stops the heartbeat', cleared.includes(beat), String(cleared.length))
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

{
  // Both directions fire for one close in the host. The second one must not
  // delete a listener that a *different* stream registered for the session.
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const first = fakeRes()
  const firstReq = fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` })
  await api(firstReq, first)
  const second = fakeRes()
  const secondReq = fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` })
  await api(secondReq, second)
  check('two streams for one session are two listeners', hub.watching('s1') === 2, String(hub.watching('s1')))
  firstReq.fire('close')
  first.fire('close')
  check('closing one leaves the other', hub.watching('s1') === 1, String(hub.watching('s1')))
  check('and the other still streams', (hub.publish('s1'), second.chunks.length === 2), String(second.chunks.length))
  secondReq.fire('close')
}

{
  // A host without the hub cannot stream. Saying so as JSON is what lets the
  // client fall back to polling instead of waiting for an event that will never
  // come.
  const api = createPanelApi(deps())
  const res = fakeRes()
  await api(fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` }), res)
  const payload = res.endedWith === undefined ? undefined : JSON.parse(res.endedWith)
  check('a host with no hub answers with JSON', payload?.ok === false, String(res.endedWith))
  check('and names the reason', payload?.code === 'error.live.absent', String(payload?.code))
}

{
  // A hub that exists but cannot be subscribed to is the same failure wearing a
  // different shape — a half-provided service. Writing `text/event-stream`
  // headers for it would leave the client waiting on a stream nobody publishes
  // to, which is strictly worse than the JSON that lets it poll instead.
  const api = createPanelApi(deps({ live: { watching: () => 0 } }))
  const res = fakeRes()
  await api(fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` }), res)
  const payload = res.endedWith === undefined ? undefined : JSON.parse(res.endedWith)
  check('a hub that cannot subscribe is refused too', payload?.ok === false, String(res.endedWith))
  // The tell is not the header shape (JSON answers carry headers too) but that
  // nothing was streamed: a refused stream ends a body, it does not write chunks
  // and then stay open.
  check('and the answer is JSON, not a stream', res.chunks.length === 0 && res.ended === true, JSON.stringify(res.chunks))
}

{
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const res = fakeRes()
  await api(fakeReq({ url: `${ROUTE_PREFIX}/live` }), res)
  const payload = res.endedWith === undefined ? undefined : JSON.parse(res.endedWith)
  check('the stream refuses an empty session id', payload?.ok === false && payload?.code === 'error.agent.missing', String(res.endedWith))
  check('with a 400', res.statusCode === 400, String(res.statusCode))
  check('and subscribes nothing', hub.byAgent.size === 0, String(hub.byAgent.size))
}

{
  // `?agent=` parses to the empty string, not to `undefined`. That one case is
  // the whole reason the route checks the length as well as the type: a client
  // that builds its URL wrong gets a 400 instead of a stream keyed on "".
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const res = fakeRes()
  await api(fakeReq({ url: `${ROUTE_PREFIX}/live?agent=` }), res)
  const payload = res.endedWith === undefined ? undefined : JSON.parse(res.endedWith)
  check('an empty agent parameter is not a session', payload?.code === 'error.agent.missing', String(res.endedWith))
  check('and it opens no stream', res.chunks.length === 0 && hub.byAgent.size === 0, JSON.stringify(res.chunks))
}

{
  // HEAD is how a health check, a proxy or `curl -I` asks whether a route is
  // there. Every other route in this handler answers it with a 200 and no body,
  // so answering 404 here would report the plugin missing from a route that
  // plainly exists — and answering it by opening a stream would leak one
  // subscription per probe, since nothing ever closes a HEAD.
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const res = fakeRes()
  await api(fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1`, method: 'HEAD' }), res)
  check('a head request to the stream answers 200', res.statusCode === 200, String(res.statusCode))
  check('and it opens no stream', res.chunks.length === 0, JSON.stringify(res.chunks))
  check('and it subscribes nobody', hub.byAgent.size === 0, String(hub.byAgent.size))
  check('and it ends straight away', res.ended === true, String(res.ended))
}

{
  // A write that throws (the socket died between the check and the write) must
  // not escape into the host's dispatch.
  const hub = new LiveHub()
  const api = createPanelApi(deps({ live: hub }))
  const res = fakeRes()
  res.write = () => {
    throw new Error('EPIPE')
  }
  let thrown
  try {
    await api(fakeReq({ url: `${ROUTE_PREFIX}/live?agent=s1` }), res)
    hub.publish('s1')
  } catch (error) {
    thrown = error
  }
  check('a dead socket does not throw out of the route', thrown === undefined, String(thrown))
}

// ---------------------------------------------------------------------------
// Only the events a card draws from are worth a notification
//
// The host sends every event through `session/event`, including the ones that
// change nothing the panel shows (token accounting, plan updates, whatever the
// host adds next). Waking the client for those would make the stream a slower
// poll with extra steps. `record` is the filter, and this is the assertion that
// it is still one.
// ---------------------------------------------------------------------------

{
  const store = new TranscriptStore()
  const drawn = [
    { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'go' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'went' }] } } },
    { type: 'tool/call', data: { name: 'bash', callId: 'c1', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', data: { callId: 'c1', isError: false } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  let told = 0
  for (const event of drawn) if (store.record('s1', event) === true) told += 1
  check('every event a card draws from is reported', told === drawn.length, `${told} of ${drawn.length}`)

  const ignored = [
    { type: 'session/token', data: { tokens: 12 } },
    { type: 'plan/update', data: { steps: [] } },
    { type: 'tool/call', data: { arguments: '{}' } },
    { type: 'user/message', data: { source: { kind: 'tool' } } },
    { type: 'assistant/thinking', data: { text: 'hmm' } },
  ]
  let noise = 0
  for (const event of ignored) if (store.record('s2', event) === true) noise += 1
  check('an event no card draws from is not reported', noise === 0, String(noise))
}

console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
