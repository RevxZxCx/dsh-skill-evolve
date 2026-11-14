/**
 * Read the files a shell command writes.
 *
 * The panel's file card was built on the assumption that files are written by
 * the file tools: `edit`, `write`, `ops_write_file` and friends all name their
 * target in an argument. Measured against real sessions, that assumption is
 * mostly false. One 175-file session contained zero `node_modules` entries and
 * zero lockfiles — not because the classifier was wrong but because it never saw
 * them: `cat > scripts/probe.py <<'EOF'` writes a file through `bash`, and a
 * shell call's arguments name a *command*, not a path. The card showed the
 * edits and silently omitted everything the session actually produced with a
 * redirect.
 *
 * So this module recovers the targets. It is deliberately narrow: it reads
 * output redirections, `tee`, and the destination of `cp`/`mv`, and it ignores
 * everything else. A command like `python build.py` may write a hundred files
 * and this module will name none of them — guessing from a program's name is
 * how a card starts claiming files that were never touched.
 *
 * @module @revxz/dsh-evolve-core/shellpaths
 */

/** More than this many targets in one command means we are reading prose, not a pipeline. */
const MAX_TARGETS_PER_COMMAND = 20

/**
 * Redirect targets that are not files anyone can open.
 *
 * `2>/dev/null` appears in a large share of real commands, and a row that says
 * "null · 0 B" is noise the reader has to work around every single turn.
 */
const DEVICE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero', 'nul', 'con', 'prn'])

/** A whole-token redirection operator: `>`, `>>`, `2>`, `2>>`, `&>`, `&>>`, `>|`. */
const REDIRECT_OPERATOR = /^(?:\d+|&)?>>?\|?$/

/** An operator glued to its target: `>out.txt`, `>>out.txt`, `2>err.txt`. */
const REDIRECT_GLUED = /^(?:\d+|&)?>>?\|?(.+)$/

/** `2>&1` is a descriptor duplicate, not a file. */
const DESCRIPTOR_DUPLICATE = /^&\d+$|^&$/

/** Words that separate one command from the next inside a single shell call. */
const SEGMENT_SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n'])

/** Commands whose last non-flag argument is the file they produce. */
const COPY_LIKE = new Set(['cp', 'mv', 'install', 'rsync', 'ln'])

/** Commands that take one or more files to create or update. */
const TARGET_ARG_COMMANDS = new Set(['tee', 'touch'])

/**
 * Drop heredoc bodies. They are program text, and splitting them into
 * "commands" produced 16,718 bogus labels on one real session before this was
 * added.
 *
 * Moved here from `@revxz/dsh-skill-evolve`'s command module: both the workflow
 * alphabet and the file card need to read a command without its body, and two
 * copies of this scan would eventually disagree about the same command.
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
 * Split a command line into words, honouring quotes and backslashes.
 *
 * Doing this before looking for redirections is what keeps `echo "a > b"` from
 * naming a file called `b`: the `>` is inside a quoted token, so it never
 * reaches the operator scan as a token of its own.
 *
 * @param {string} text
 * @returns {string[]} the words, with quotes removed and escapes resolved.
 */
function tokenize(text) {
  const tokens = []
  let current = ''
  let started = false
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === quote) { quote = ''; continue }
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { current += text[i + 1]; i += 1; continue }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === '\\' && i + 1 < text.length) { current += text[i + 1]; i += 1; started = true; continue }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (started) { tokens.push(current); current = ''; started = false }
      // A newline ends a command the same way `;` does, and keeping it as its own
      // token is what lets the segment scan below see the boundary.
      if (ch === '\n') tokens.push('\n')
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * Group words into the individual commands a shell call runs.
 *
 * @param {string[]} tokens
 * @returns {string[][]} one entry per command.
 */
function segmentsOf(tokens) {
  const segments = [[]]
  for (const token of tokens) {
    if (SEGMENT_SEPARATORS.has(token)) {
      segments.push([])
      continue
    }
    segments[segments.length - 1].push(token)
  }
  return segments.filter((segment) => segment.length > 0)
}

/**
 * Whether a candidate is a path a person could open.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function recordable(candidate) {
  if (candidate.length === 0) return false
  if (DEVICE_TARGETS.has(candidate.toLowerCase())) return false
  if (DESCRIPTOR_DUPLICATE.test(candidate)) return false
  // A bare flag after a redirect is a typo in the command, not a file name.
  return candidate.startsWith('-') === false
}

/**
 * Read every file path one shell command writes.
 *
 * Returns the paths exactly as the command spelled them — relative stays
 * relative. Resolving against the workspace happens in the caller, which is the
 * only place that knows the session's working directory.
 *
 * @param {unknown} command - the `command` argument of a shell tool call.
 * @returns {string[]} the paths, in the order the command names them.
 */
export function writtenPaths(command) {
  if (typeof command !== 'string' || command.length === 0) return []
  const out = []
  const seen = new Set()
  const add = (candidate) => {
    if (out.length >= MAX_TARGETS_PER_COMMAND) return
    if (recordable(candidate) === false) return
    // `&&`/`;` can arrive glued to a target when there is no space around them.
    const cleaned = candidate.replace(/[;&|]+$/, '')
    if (cleaned.length === 0 || recordable(cleaned) === false) return
    if (seen.has(cleaned)) return
    seen.add(cleaned)
    out.push(cleaned)
  }

  for (const segment of segmentsOf(tokenize(stripHeredocs(command)))) {
    // Skip leading `FOO=bar` assignments; the command name is the first word
    // that is not one.
    let start = 0
    while (start < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[start])) start += 1
    const name = segment[start] ?? ''
    const args = segment.slice(start + 1)

    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]
      if (REDIRECT_OPERATOR.test(token)) {
        const next = args[i + 1]
        if (next !== undefined) add(next)
        i += 1
        continue
      }
      const glued = token.match(REDIRECT_GLUED)
      if (glued !== null) add(glued[1])
    }

    if (TARGET_ARG_COMMANDS.has(name)) {
      for (const arg of args) {
        if (arg.startsWith('-')) continue
        if (REDIRECT_OPERATOR.test(arg) || REDIRECT_GLUED.test(arg)) break
        add(arg)
      }
    }

    if (COPY_LIKE.has(name)) {
      // Everything but the last word is a source; the last one is what appears.
      const operands = args.filter((arg) => arg.startsWith('-') === false && arg.startsWith('$') === false)
      if (operands.length >= 2) add(operands[operands.length - 1])
    }
  }
  return out
}
