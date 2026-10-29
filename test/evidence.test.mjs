import {
  EVIDENCE_CLASSES,
  normalize,
  validateEvidenceEntry,
  quoteAppears,
  runGate,
  corpusFromEvents,
  lanesFromEvents,
  ownCallIds
} from '../lib/evidence.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

console.log('evidence.js')

const CORPUS = [
  'user: 请把 PDF 里的表格导成 Excel，不要用 pip 装东西，用系统自带的 pdftotext 就行。',
  'tool: pdftotext -layout report.pdf -',
  'tool: wrote output.xlsx (12 rows, 4 columns)',
  'assistant: 我用 pdftotext -layout 保留了列对齐，再用 openpyxl 写出 xlsx。'
].join('\n')

// Normalization
check('collapses runs of spaces', normalize('a   b\t\tc') === 'a b c')
check('normalizes CRLF', normalize('a\r\nb') === 'a\nb')
check('preserves case', normalize('Do Not Delete') === 'Do Not Delete')

// Entry shape
{
  const ok = validateEvidenceEntry({ class: 'user', quote: '不要用 pip 装东西' })
  check('accepts a well-formed entry', ok.ok === true, JSON.stringify(ok))
  check('rejects an unknown class', validateEvidenceEntry({ class: 'vibes', quote: 'x'.repeat(20) }).ok === false)
  check('rejects a missing quote', validateEvidenceEntry({ class: 'user' }).ok === false)
  check('rejects a too-short quote', validateEvidenceEntry({ class: 'user', quote: 'ok' }).ok === false)
  check('rejects a non-object', validateEvidenceEntry('nope').ok === false)
  check('all four classes are valid', EVIDENCE_CLASSES.every((klass) =>
    validateEvidenceEntry({ class: klass, quote: 'a reasonably long quote' }).ok === true
  ))
}

// Verbatim matching
check('finds an exact quote', quoteAppears('不要用 pip 装东西', normalize(CORPUS)) === true)
check('rejects a paraphrase', quoteAppears('请不要安装 pip 包', normalize(CORPUS)) === false)
check('rejects an invented number', quoteAppears('wrote output.xlsx (14 rows, 4 columns)', normalize(CORPUS)) === false)
check('accepts the real number', quoteAppears('wrote output.xlsx (12 rows, 4 columns)', normalize(CORPUS)) === true)
check('refuses to match a too-short fragment', quoteAppears('pip', normalize(CORPUS)) === false)

// The whole gate
{
  const outcome = runGate({
    corpus: CORPUS,
    evidence: [
      { class: 'user', quote: '不要用 pip 装东西', note: 'the user forbade pip' },
      { class: 'tool', quote: 'pdftotext -layout report.pdf -' },
      { class: 'self', quote: '我用 pdftotext -layout 保留了列对齐' },
      { class: 'user', quote: '用户非常喜欢这个方案' }
    ]
  })
  check('keeps three genuine quotes', outcome.survived.length === 3, JSON.stringify(outcome.survived))
  check('drops the fabricated quote', outcome.dropped.length === 1, JSON.stringify(outcome.dropped))
  check('reports why a quote was dropped', outcome.dropped[0]?.reason.includes('verbatim'), outcome.dropped[0]?.reason)
  check('classes reflect what survived', outcome.classes.has('user') && outcome.classes.has('tool') && outcome.classes.has('self'))
  check('marks the outcome authoritative', outcome.authoritative === true)
}

// A candidate made only of self-quotes is not authoritative.
{
  const outcome = runGate({
    corpus: CORPUS,
    evidence: [{ class: 'self', quote: '我用 pdftotext -layout 保留了列对齐' }]
  })
  check('self-only evidence survives the search', outcome.survived.length === 1)
  check('self-only evidence is not authoritative', outcome.authoritative === false)
}

// A candidate whose evidence is entirely fabricated is rejected.
{
  const outcome = runGate({
    corpus: CORPUS,
    evidence: [
      { class: 'user', quote: '用户要求必须用 pandas' },
      { class: 'tool', quote: 'pandas imported successfully' }
    ]
  })
  check('all-fabricated evidence leaves nothing', outcome.survived.length === 0, JSON.stringify(outcome.survived))
  check('all-fabricated evidence is not authoritative', outcome.authoritative === false)
  check('every rejection is explained', outcome.dropped.every((entry) => entry.reason.length > 0))
}

// Empty evidence is handled.
{
  const outcome = runGate({ corpus: CORPUS, evidence: [] })
  check('empty evidence yields no survivors', outcome.survived.length === 0)
  check('empty evidence is not authoritative', outcome.authoritative === false)
}

// Reflowed whitespace still matches; reworded text does not.
{
  check('tolerates reflowed whitespace', quoteAppears('不要用  pip  装东西', normalize(CORPUS)) === true)
  check('does not tolerate a changed word', quoteAppears('不要用 uv 装东西', normalize(CORPUS)) === false)
}

// Corpus extraction from host-shaped events.
{
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '请把 PDF 表格导成 Excel' }] } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pdftotext -layout report.pdf"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'wrote output.xlsx' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已完成导出' }] } } },
    { type: 'turn/start', data: { turn: 1 } }
  ]
  const corpus = corpusFromEvents(events)
  check('collects user text', corpus.includes('请把 PDF 表格导成 Excel'))
  check('collects tool arguments', corpus.includes('pdftotext -layout report.pdf'))
  check('collects tool results', corpus.includes('wrote output.xlsx'))
  check('collects assistant text', corpus.includes('已完成导出'))
  check('survives events without text', typeof corpus === 'string')
  check('handles an empty event stream', corpusFromEvents([]) === '')
  check('handles null data without throwing', corpusFromEvents([{ type: 'x', data: null }]) === '')
}

// A quote drawn from tool arguments passes the gate against the real corpus.
{
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '不要用 pip，用系统自带的 pdftotext' }] } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pdftotext -layout report.pdf -"}' } }
  ]
  const corpus = corpusFromEvents(events)
  const outcome = runGate({
    corpus,
    evidence: [
      { class: 'user', quote: '不要用 pip，用系统自带的 pdftotext' },
      { class: 'action', quote: 'pdftotext -layout report.pdf' }
    ]
  })
  check('a real session corpus passes real quotes', outcome.survived.length === 2, JSON.stringify(outcome.dropped))
  check('a surviving user quote makes it authoritative', outcome.authoritative === true)
  check('action evidence alone is not authoritative', runGate({
    corpus,
    evidence: [{ class: 'action', quote: 'pdftotext -layout report.pdf' }]
  }).authoritative === false)
}

// Numbers without a tool quote are a class of error the gate must catch.
{
  const corpus = 'user: 导出了 12 行\nassistant: 我导出了 300 行'
  const outcome = runGate({
    corpus,
    evidence: [{ class: 'tool', quote: '我导出了 300 行' }]
  })
  check('an assistant claim tagged as tool evidence still has to match', outcome.survived.length === 1)
  check('but a number in user text is not tool-backed', runGate({
    corpus: 'user: 12 行',
    evidence: [{ class: 'tool', quote: '一共 9999 行数据' }]
  }).survived.length === 0)
}

// The gate must not be able to prove a quote with its own refusal text. This
// is the one bug that made every other rule pointless: the model only has to
// re-read the error message to find its invented sentence sitting in the
// machine lane. No malice required — retrying after an error is default
// behaviour.
{
  const INVENTED = 'This fabricated observation was never made by any user or external tool.'
  const base = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] } }
  ]

  check('an invented quote is rejected before any echo', runGate({
    evidence: [{ class: 'tool', quote: INVENTED }],
    lanes: lanesFromEvents(base)
  }).survived.length === 0)

  // Exactly what the host records when the model submits, is refused, and tries
  // the same sentence again. The result uses the host's real nesting: the id is
  // in `data.message`, not at the top of `data`. A flat fixture passed through
  // the fallback branch and proved nothing about the echo check.
  const echoed = [
    ...base,
    { type: 'tool/call', data: { callId: 'call-1', name: 'skill_candidate_submit', arguments: '{"name":"alpha"}' } },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { callId: 'call-1' },
          toolCallId: 'call-1',
          isError: true,
          content: [{ type: 'text', text: `skill_candidate_submit failed: no-verified-evidence. Could not verify tool quote: "${INVENTED}"` }],
          id: 'm-1'
        }
      }
    }
  ]

  check('our own refusal text is not machine evidence', runGate({
    evidence: [{ class: 'tool', quote: INVENTED }],
    lanes: lanesFromEvents(echoed)
  }).survived.length === 0)

  check('the refusal text is still quotable as this plugin talking', lanesFromEvents(echoed).tool.includes('no-verified-evidence') === false)

  // The fix must not shrink the lane for real observations. A bash result in
  // the same session still proves a number. This fixture uses the host's real
  // nesting too: a flat one would fall through to the fallback branch and pass
  // no matter how the echo check was written, so it would not guard against the
  // failure it exists to catch — dropping every real result from the lane.
  const withRealTool = [
    ...echoed,
    { type: 'tool/call', data: { callId: 'call-2', name: 'bash', arguments: '{"command":"npm test"}' } },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { callId: 'call-2' },
          toolCallId: 'call-2',
          isError: false,
          content: [{ type: 'text', text: '12 tests passed, 0 failed' }],
          id: 'm-2'
        }
      }
    }
  ]
  const real = runGate({
    evidence: [{ class: 'tool', quote: '12 tests passed, 0 failed' }],
    lanes: lanesFromEvents(withRealTool)
  })
  check('a real tool result still verifies', real.survived.length === 1 && real.authoritative === true)

  // A result whose call the host did not record stays usable: refusing to use
  // it would let a missing event silently disable legitimate evidence. The
  // result still has the real nesting; what is missing is the matching call.
  const orphan = [
    ...base,
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { callId: 'call-x' },
          toolCallId: 'call-x',
          isError: false,
          content: [{ type: 'text', text: 'disk was full at that point' }],
          id: 'm-x'
        }
      }
    }
  ]
  check('a result with no visible call is still machine evidence',
    lanesFromEvents(orphan).tool.includes('disk was full at that point'))

  check('ownCallIds only names our tools', [...ownCallIds([
    { type: 'tool/call', data: { callId: 'a', name: 'skill_candidate_submit' } },
    { type: 'tool/call', data: { callId: 'b', name: 'bash' } },
    { type: 'tool/call', data: { callId: 'c', name: 'skill_market_install' } },
    { type: 'tool/call', data: { name: 'skill_feedback' } }
  ])].join(',') === 'a,c')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
