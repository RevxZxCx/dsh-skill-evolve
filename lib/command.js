/**
 * Turn a shell command into the coarse action labels it performs.
 *
 * The detector in `signal.js` looks at tool *names*. That is enough for the
 * structured tools — `read`, `edit`, `grep` say what they do — but it is blind
 * to the tool that does most of the work. A session can spend two hundred calls
 * doing 截图 → 解析 → 看图 through nothing but `bash`, and name-level detection
 * reports "bash, bash, bash" or nothing at all. Replaying a real 6,145-call
 * session confirmed it: the detector fired zero times in the window where the
 * plugin was loaded, because 85% of the calls were `bash`.
 *
 * So a shell call is expanded into one label per command it runs, and those
 * labels join the same history the other tools use. The point is a *workflow
 * alphabet*: `pnpm test` and `npm test` are the same step, `git diff` and
 * `git status` are not.
 *
 * @module dsh-skill-evolve/command
 */

/** Shell tools whose `command`/`script` argument carries a command line. */
export const SHELL_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'shell', 'terminal', 'exec', 'run'])

/**
 * Coarse families. Ordered by intent, not by tool chain: the question a
 * procedure answers is "what did the work", not "which binary was on PATH".
 */
const VERB_FAMILY = {
  // packages and builds
  pnpm: 'pkg', npm: 'pkg', yarn: 'pkg',
  gradle: 'build', gradlew: 'build', mvn: 'build', make: 'build', cmake: 'build',
  tsc: 'build', rustc: 'build', go: 'build', cargo: 'cargo',
  // interpreters
  python: 'py', python3: 'py', py: 'py',
  node: 'node', deno: 'node', bun: 'node',
  // devices and services
  adb: 'adb', docker: 'container', kubectl: 'cluster',
  psql: 'db', mysql: 'db', sqlite3: 'db', 'redis-cli': 'db',
  // files
  grep: 'search', rg: 'search', ag: 'search', ack: 'search', findstr: 'search',
  find: 'search', dir: 'search',
  ls: 'list',
  cat: 'read', head: 'read', tail: 'read', less: 'read', more: 'read', type: 'read',
  sed: 'edit', awk: 'edit', perl: 'edit',
  cp: 'copy', mv: 'move', rm: 'remove', del: 'remove', mkdir: 'mkdir',
  // network
  curl: 'net', wget: 'net', ssh: 'net', scp: 'net',
  // platform
  powershell: 'pwsh', pwsh: 'pwsh',
  // misc
  tar: 'archive', zip: 'archive', unzip: 'archive', gzip: 'archive',
  chmod: 'chmod', chown: 'chmod',
  diff: 'diff', cmp: 'diff',
  wc: 'count', du: 'count', df: 'count',
  kill: 'kill', pkill: 'kill', taskkill: 'kill',
  pip: 'pip', pip3: 'pip'
}

/**
 * Families where the first bare word changes what the step means. `git commit`
 * and `git diff` are different steps; so are `pnpm test` and `pnpm build`.
 */
const SUB_VERB = new Set(['git', 'pkg', 'adb', 'build', 'container', 'cluster', 'cargo', 'pip', 'db', 'pwsh', 'go'])

/** Interpreters whose payload is program text, not further commands. */
const OPAQUE = new Set(['py', 'node'])

/** Segment glue: these are never steps of their own. */
const NOISE = new Set([
  'cd', 'echo', 'sleep', 'true', 'false', ':', 'set', 'export', 'exit', 'pwd',
  'printf', 'test', 'source', 'unset', 'alias', 'wait', 'time', 'nohup', 'env'
])

/**
 * Program syntax that ends up as the first word of a segment when a command
 * inlines a script. Dropped so `const`, `await`, `from` never become steps.
 */
const SYNTAX_WORDS = new Set([
  'const', 'let', 'var', 'await', 'async', 'function', 'return', 'import', 'from', 'export',
  'for', 'while', 'if', 'else', 'elif', 'then', 'fi', 'do', 'done', 'esac', 'case', 'in',
  'def', 'class', 'try', 'except', 'finally', 'with', 'as', 'print', 'assert', 'raise',
  'lambda', 'yield', 'global', 'nonlocal', 'pass', 'not', 'and', 'or', 'is', 'new',
  'typeof', 'instanceof', 'catch', 'switch', 'break', 'continue', 'throw', 'delete'
])

/** A plausible bare command name. */
const COMMAND_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * Shapes that identify a device or installation handle rather than a
 * subcommand: `emulator-5554`, `192.168.1.5:5555`, `R58M1234ABC`.
 */
const DEVICE_SPEC = /(?:^emu\w*-\d+$|^\d+\.\d+\.\d+\.\d+(?::\d+)?$|^[A-Z0-9]{6,}$)/

/** Relative and absolute paths are commands too: `./gradlew`, `F:/sdk/adb.exe`. */
const PATH_COMMAND = /^(?:\.{1,2}[/\\]|[A-Za-z]:[/\\]|\/)?[A-Za-z_][A-Za-z0-9_.-]*(?:[/\\][A-Za-z0-9_.-]+)*$/

/** Control words that may prefix the real command on a segment. */
const CONTROL_PREFIX = /^(?:do|then|else|elif)\s+/i

/**
 * Flags whose following token is a value, not a subcommand.
 *
 * Only the ones that show up in the tools this plugin actually watches. A flag
 * not listed here is treated as a plain switch, which is the safe default:
 * the worst case is one extra token being considered as a subcommand, and the
 * checks around it (digits, device serials, paths) reject most values anyway.
 */
const FLAG_TAKES_VALUE = /^-(?:[sSpPeEnNmMoOfFcCbBhH]|remote|device|user|port|target|filter|format|config|dir)$/

const PATHISH = /[/\\]/

/**
 * Drop heredoc bodies. They are program text, and splitting them into "steps"
 * produced 16,718 bogus labels on one real session before this was added.
 *
 * @param {string} command
 * @returns {string}
 */
export function stripHeredocs(command) {
  let out = ''
  let rest = String(command)
  for (;;) {
    const m = rest.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/)
    if (m === null) return out + rest
    out += rest.slice(0, m.index)
    const marker = m[2]
    const bodyStart = m.index + m[0].length
    const lines = rest.slice(bodyStart).split('\n')
    let consumed = 0
    let found = false
    for (let i = 0; i < lines.length; i += 1) {
      consumed += lines[i].length + 1
      if (lines[i].trim() === marker) { found = true; break }
    }
    // An unterminated heredoc means the rest of the input is body.
    if (!found) return out
    rest = rest.slice(bodyStart + consumed)
  }
}

/**
 * Reduce a token to the executable's name: strip quotes, directories and a
 * Windows extension.
 *
 * @param {string} token
 * @returns {string}
 */
function baseName(token) {
  const cleaned = token.replace(/^["']|["']$/g, '')
  const parts = cleaned.split(PATHISH)
  const last = parts[parts.length - 1] || cleaned
  return last.replace(/\.(exe|cmd|bat|sh|ps1)$/i, '').toLowerCase()
}

/**
 * Split a command line on `&&`, `||`, `;` and newlines, ignoring separators
 * that sit inside quotes.
 *
 * Quote awareness is not cosmetic. `node -e "a(); b()"` is one call, and a
 * naive split turns its program text into steps: a real session produced
 * `n.cd`, `['+n.cd+']')).slice(0,54).padEnd(56)` and thirty more like it
 * before this was added. Those become hint text, so they must never be recorded.
 *
 * @param {string} text
 * @returns {string[]} segments, still quoted and unescaped.
 */
export function splitSegments(text) {
  /** @type {string[]} */
  const segments = []
  let current = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      current += ch
      if (ch === '\\' && quote === '"') {
        // Keep the escaped character with the text it escapes.
        current += text[i + 1] ?? ''
        i += 1
      } else if (ch === quote) {
        quote = ''
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '\\' && text[i + 1] === '\n') {
      // Line continuation is whitespace, not a separator.
      current += ' '
      i += 1
      continue
    }
    const pair = text.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    // A single pipe is deliberately NOT a separator. The right-hand side is
    // almost always a filter or a display step (`| head`, `| grep -v`, `| wc -l`)
    // that describes how output was shown, not what the procedure did. The
    // left-hand side already carries that meaning, and splitting would add a
    // `read`/`count` step to every chain that pipes.
    if (ch === ';' || ch === '\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments
}

/**
 * Expand one shell command into the action labels it performs.
 *
 * One `bash` call is often a whole procedure by itself (`pnpm test && git diff`),
 * so each joined segment becomes its own label. Runner verbs that only wrap
 * another command are unwrapped, so `npx tsc` reports the build rather than the
 * launcher.
 *
 * @param {string} command - the raw command line.
 * @returns {string[]} labels, in execution order; empty when nothing recognisable ran.
 */
export function signatureOf(command) {
  const text = stripHeredocs(command ?? '')
  const segments = splitSegments(text)
  /** @type {string[]} */
  const labels = []
  for (const raw of segments) {
    let seg = raw.trim()
    if (seg.length === 0) continue

    // A loop header introduces a command the body repeats; the body is the step.
    if (/^(?:for|while|until|if)\s/i.test(seg)) continue
    seg = seg.replace(CONTROL_PREFIX, '').trim()
    if (seg.length === 0) continue

    // Subshell wrappers and leading `VAR=value` assignments. A closing paren
    // is stripped too: `(git status)` leaves `git status)` behind otherwise,
    // and the dangling brace hides the subcommand from the family lookup.
    for (;;) {
      const m = seg.match(/^(?:\(|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)/)
      if (m === null) break
      seg = seg.slice(m[0].length).trim()
    }
    seg = seg.replace(/[)\]]+$/, '').trim()
    if (seg.length === 0 || seg.startsWith('#')) continue

    const tokens = seg.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue

    const head = tokens[0]
    const quoted = head.startsWith('"') || head.startsWith("'")
    if (!quoted && !COMMAND_NAME.test(head) && !PATH_COMMAND.test(head)) continue

    let verb = baseName(head)
    if (SYNTAX_WORDS.has(verb)) continue
    let args = tokens.slice(1)

    // `npx tsc --noEmit` is a build step, not an "npx" step.
    if (verb === 'npx' && args.length > 0) {
      verb = baseName(args[0])
      args = args.slice(1)
    }
    if (NOISE.has(verb)) continue

    const family = VERB_FAMILY[verb] ?? verb
    if (OPAQUE.has(family)) {
      labels.push(family)
      continue
    }

    let label = family
    if (SUB_VERB.has(family)) {
      let sub
      // Flags that take a value consume the next token, and that value is data
      // (`-s emulator-5554`), not a subcommand. Treating it as one made every
      // attached device look like a distinct procedure on a real transcript.
      let skipNext = false
      for (const token of args) {
        if (skipNext) {
          skipNext = false
          continue
        }
        if (token.startsWith('-')) {
          skipNext = FLAG_TAKES_VALUE.test(token)
          continue
        }
        if (PATHISH.test(token) || !COMMAND_NAME.test(token)) continue
        if (/^\d+$/.test(token)) continue
        if (DEVICE_SPEC.test(token)) continue
        sub = token
        break
      }
      if (sub !== undefined) label = `${family} ${sub.toLowerCase()}`
    }
    labels.push(label)
  }
  return labels
}

/**
 * The history key for one tool call.
 *
 * Structured tools keep their own name. Shell calls become their labels — zero
 * labels means the command was pure glue (`cd`, `echo`), which is dropped rather
 * than recorded as an opaque `bash`.
 *
 * @param {string} toolName
 * @param {unknown} rawArguments - the `arguments` field from `tool/call`, a JSON string.
 * @returns {string[]} keys to record, in order.
 */
export function stepsFor(toolName, rawArguments) {
  if (!SHELL_TOOLS.has(toolName)) return [toolName]

  let parsed
  if (typeof rawArguments === 'string') {
    try { parsed = JSON.parse(rawArguments) }
    catch { return [toolName] }
  } else if (rawArguments !== null && typeof rawArguments === 'object') {
    parsed = rawArguments
  } else {
    return [toolName]
  }

  const command = parsed?.command ?? parsed?.script ?? parsed?.input
  if (typeof command !== 'string' || command.trim().length === 0) return [toolName]

  const labels = signatureOf(command)
  return labels.length > 0 ? labels : []
}
