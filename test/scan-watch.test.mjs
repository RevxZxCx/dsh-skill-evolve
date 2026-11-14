import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ScanWatch, scanReading } from '../packages/ui-evolve/lib/scan-watch.js'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const pathsOf = (reading) => (Array.isArray(reading?.paths) ? reading.paths : reading)

/** A reader that answers from a queue and remembers what it was asked. */
function reader(answers) {
  const calls = []
  const queue = answers.slice()
  const read = async (cwd, since) => {
    calls.push({ cwd, since })
    const next = queue.shift()
    return next === undefined ? { paths: [], coverage: 'complete' } : next
  }
  return { read, calls }
}

// ---- a bracket that opens and closes ---------------------------------------
{
  const fake = reader([{ paths: ['/w/a.txt'], coverage: 'complete' }])
  const watch = new ScanWatch({ read: fake.read })
  watch.start('s1', 1000)
  const reading = await watch.finish('s1', '/w')
  check('what the reader found is the turn', pathsOf(reading).length === 1)
  check('and the path is the one it named', pathsOf(reading)[0] === '/w/a.txt')
  check('coverage comes through', reading.coverage === 'complete')
  check('the reader was asked once', fake.calls.length === 1)
  check('about the workspace it was given', fake.calls[0].cwd === '/w')
  check('and from the moment the turn opened', fake.calls[0].since === 1000)
}

// ---- the opening time is the turn's, not the reader's -----------------------
{
  const fake = reader([{ paths: [], coverage: 'complete' }])
  const watch = new ScanWatch({ read: fake.read })
  watch.start('s1')
  const before = Date.now()
  await watch.finish('s1', '/w')
  const asked = fake.calls[0].since
  check('without an explicit clock the opening time is now', typeof asked === 'number' && asked <= Date.now())
  check('and it is not in the future', asked <= before + 1000, String(asked))
}

// ---- a baseline describes one turn -----------------------------------------
{
  const fake = reader([
    { paths: ['/w/a.txt'], coverage: 'complete' },
    { paths: ['/w/a.txt'], coverage: 'complete' },
  ])
  const watch = new ScanWatch({ read: fake.read })
  watch.start('s1', 1000)
  await watch.finish('s1', '/w')
  const second = await watch.finish('s1', '/w')
  check('a second close has no baseline to measure against', pathsOf(second).length === 0)
  check('and the reader is not asked again', fake.calls.length === 1, String(fake.calls.length))
  check('because the baseline was consumed', watch.baselines.size === 0)

  watch.start('s1', 2000)
  await watch.finish('s1', '/w')
  check('a new turn opens a new baseline', fake.calls.length === 2)
  check('measured from its own opening time', fake.calls[1].since === 2000)
}

// ---- no baseline means no claim --------------------------------------------
{
  const fake = reader([{ paths: ['/w/a.txt'], coverage: 'complete' }])
  const watch = new ScanWatch({ read: fake.read })
  const reading = await watch.finish('never-started', '/w')
  check('a turn nobody opened contributes nothing', pathsOf(reading).length === 0)
  // `none`, not `complete`: the walk never ran, so the turn was never vouched
  // for. See git-watch.test.mjs for the same distinction.
  check('and it is not called complete either', reading.coverage === 'none')
  check('and the walk never runs', fake.calls.length === 0)
}

// ---- refusing to guess a workspace -----------------------------------------
{
  const fake = reader([{ paths: ['/w/a.txt'], coverage: 'complete' }])
  const watch = new ScanWatch({ read: fake.read })
  watch.start('s1', 1000)
  const noCwd = await watch.finish('s1', '')
  check('a session with no workspace contributes nothing', pathsOf(noCwd).length === 0)
  check('and the reader is not asked about nothing', fake.calls.length === 0)
  check('but the baseline is still consumed', watch.baselines.size === 0)
}

// ---- a reader that fails is not an error -----------------------------------
{
  const watch = new ScanWatch({ read: async () => { throw new Error('disk on fire') } })
  watch.start('s1', 1000)
  const reading = await watch.finish('s1', '/w')
  check('a reader that throws yields nothing', pathsOf(reading).length === 0)
  // A walk that threw did not see the workspace: `partial`, never `complete`.
  // Reporting a crashed scan as a clean empty turn is the one thing the coverage
  // field cannot do.
  check('and says it could not finish looking', reading.coverage === 'partial')
}

// ---- nothing configured ------------------------------------------------------
{
  const watch = new ScanWatch()
  watch.start('s1', 1000)
  const reading = await watch.finish('s1', '/w')
  check('a watch with no reader says nothing', pathsOf(reading).length === 0)
}

// ---- partial travels through -------------------------------------------------
{
  const fake = reader([{ paths: ['/w/a.txt'], coverage: 'partial' }])
  const watch = new ScanWatch({ read: fake.read })
  watch.start('s1', 1000)
  const reading = await watch.finish('s1', '/w')
  check('a partial read is reported as partial', reading.coverage === 'partial')
  check('but its paths still count', pathsOf(reading).length === 1)
}

// ---- a bare array is read as a complete answer ------------------------------
{
  const watch = new ScanWatch({ read: async () => ['/w/b.txt'] })
  watch.start('s1', 1000)
  const reading = await watch.finish('s1', '/w')
  check('a reader that answers with a list still works', pathsOf(reading)[0] === '/w/b.txt')
  check('and claims no caveat it never mentioned', reading.coverage === 'complete')
}

// ---- forget ------------------------------------------------------------------
{
  const fake = reader([{ paths: ['/w/a.txt'], coverage: 'complete' }])
  const watch = new ScanWatch({ read: fake.read })
  watch.start('s1', 1000)
  watch.forget('s1')
  const reading = await watch.finish('s1', '/w')
  check('a forgotten session has no baseline', pathsOf(reading).length === 0)
  check('and its reader is never called', fake.calls.length === 0)
}

// ---- bad arguments -----------------------------------------------------------
{
  const fake = reader([])
  const watch = new ScanWatch({ read: fake.read })
  watch.start('', 1000)
  watch.start(undefined, 1000)
  check('an empty session id opens nothing', watch.baselines.size === 0)
  const reading = await watch.finish('', '/w')
  check('and closing it says nothing', pathsOf(reading).length === 0)
}


// ---- the production reader ----------------------------------------------
// Everything above injects a reader, so `scanReading` itself — the one function
// that turns a walk into a `Reading` — had no assertion anywhere. That is the
// seam where a truncated walk becomes the panel's `partial`, and a seam nobody
// looks at is where the translation silently stops happening.
{
  const { mkdtemp, mkdir, writeFile, utimes, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { scanReading } = await import('../packages/ui-evolve/lib/scan-watch.js')

  const root = await mkdtemp(join(tmpdir(), 'dsse-scanread-'))
  await writeFile(join(root, 'kept.txt'), 'x')
  const nowMs = Date.now()

  const found = await scanReading(root, nowMs - 60000)
  check('the production reader finds a file inside the window', found.paths.includes(join(root, 'kept.txt')), JSON.stringify(found.paths))
  check('and claims full coverage when the walk finished', found.coverage === 'complete', String(found.coverage))

  const old = await scanReading(root, nowMs + 60000)
  check('a window that closed before the file was written sees nothing', old.paths.includes(join(root, 'kept.txt')) === false, JSON.stringify(old.paths))

  // The assertion the mutation was looking for: a walk that hit its budget must
  // arrive at the panel as `partial`, not as a clean sweep.
  await mkdir(join(root, 'many'), { recursive: true })
  for (let i = 0; i < 8; i += 1) {
    await writeFile(join(root, 'many', `f${i}.txt`), 'x')
  }
  // Driven through `scanReading`, not `scanChanges`: the claim under test is the
  // translation from a truncated walk to the panel's word `partial`. Going
  // straight to the walker would assert the fact and skip the sentence — which
  // is exactly what let this survive its mutation the first time.
  const cut = await scanReading(root, nowMs - 60000, { maxEntries: 3 })
  check('a walk that ran out of budget is reported as partial', cut.coverage === 'partial', String(cut.coverage))
  check('and it still returns what it managed to read', cut.paths.length > 0, JSON.stringify(cut.paths.length))

  await rm(root, { recursive: true, force: true })
}

// ---- the real reader is wired to the real filter ---------------------------
//
// `scanReading` is the production reader. The P0 this block closes was that it
// called `scanChanges` without a `skipDirectory`, so a `node_modules` tree spent
// the entire entry budget and the file the turn actually produced never made it
// into the answer. Asserting `scanChanges`'s own default would not have caught
// that: the gap was in the caller.
{
  const root = await mkdtemp(join(tmpdir(), 'dsev-scan-reader-'))
  const source = join(root, 'src', 'app.js')
  const dep = join(root, 'node_modules', 'lib', 'index.js')
  for (const file of [source, dep]) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'e')
    await utimes(file, new Date(5000), new Date(5000))
  }
  const reading = await scanReading(root, 4000)
  check('the production reader skips a dependency tree', reading.paths.includes(dep) === false, reading.paths.join('|'))
  check('and still reports the source file', reading.paths.includes(source), reading.paths.join('|'))
  check('so the answer is exactly one row', reading.paths.length === 1, reading.paths.join('|'))
  check('and it is not called partial', reading.coverage === 'complete', reading.coverage)
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
