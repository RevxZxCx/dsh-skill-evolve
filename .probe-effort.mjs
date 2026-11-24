const gateway = 'http://127.0.0.1:3425/v1/chat/completions'
const prompt = 'Answer with strict JSON {"suggestions":["..."]} for the next step after: user asked 1+1, assistant said 2.'
for (const effort of [undefined, 'low', 'medium']) {
  const started = Date.now()
  const body = { model: 'my-api/claude-haiku-5.5', max_tokens: 700, messages: [{ role: 'user', content: prompt }] }
  if (effort !== undefined) body.reasoning_effort = effort
  const r = await fetch(gateway, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local' }, body: JSON.stringify(body) })
  const j = await r.json()
  const c = j?.choices?.[0]
  console.log(String(effort).padEnd(7), 'ms=' + String(Date.now() - started).padStart(6), 'finish=' + c?.finish_reason, 'reasoning=' + (j?.usage?.completion_tokens_details?.reasoning_tokens ?? '?'), 'text=' + JSON.stringify((c?.message?.content ?? '').slice(0, 60)))
}
