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

import { isAbsolute, join, resolve } from 'node:path'

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

/** A Windows path with a drive letter, in either slash. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/

/**
 * Put a path into the one spelling this project stores.
 *
 * The file list is a map keyed by path, so two spellings of one file are two
 * entries that both get stat-ed, both get drawn, and — when one of them was
 * resolved against the wrong base — one of them is reported as deleted. Only
 * the drive-letter form is folded, so POSIX paths keep their own separators.
 *
 * @param {string} path - a path in either spelling.
 * @returns {string} the same path with forward slashes replaced.
 */
export function canonicalPath(path) {
  if (typeof path !== 'string' || path.length === 0) return path
  if (DRIVE_PATH.test(path) === false) return path
  return path.split('/').join('\\')
}

/** `/f/x` is how a POSIX shell spells `F:/x`; the drive letter is the whole trick. */
const POSIX_DRIVE = /^\/([A-Za-z])(\/|$)/

/**
 * Rewrite a POSIX-spelled Windows path into the form the filesystem uses.
 *
 * Only meaningful on Windows, and only for the drive-letter form. A command
 * written for Git Bash (`cd /f/repo && cat > notes.txt`) names the same file as
 * `cd F:/repo && cat > notes.txt`, and a card that shows `F:\f\repo\notes.txt`
 * is showing a file that has never existed.
 *
 * @param {string} candidate
 * @returns {string|undefined} the Windows spelling, or `undefined` when the
 *   input is not one of these paths.
 */
function windowsDrive(candidate) {
  if (process.platform !== 'win32') return undefined
  const matched = candidate.match(POSIX_DRIVE)
  if (matched === null) return undefined
  const rest = candidate.slice(2)
  return `${matched[1].toUpperCase()}:${rest.length === 0 ? '/' : rest}`
}

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
 * Without a base directory the paths come back exactly as the command spelled
 * them. With one, the command's own `cd` is followed and every relative target
 * is resolved against the directory that was current when it was named.
 *
 * The base is what the caller knows and this module does not. A redirect in
 * `cd sub && cat > notes.txt` names a file under `sub`, and resolving it against
 * the session root instead recorded a path that never existed — the card then
 * drew that file struck through, as though the session had deleted it.
 *
 * @param {unknown} command - the `command` argument of a shell tool call.
 * @param {string} [base] - the directory the command runs in. When given,
 *   relative targets are resolved against it (and against any `cd` inside the
 *   command); when absent the paths come back exactly as written.
 * @returns {string[]} the paths, in the order the command names them.
 */
export function writtenPaths(command, base) {
  if (typeof command !== 'string' || command.length === 0) return []
  const out = []
  const seen = new Set()
  const add = (candidate) => {
    if (out.length >= MAX_TARGETS_PER_COMMAND) return
    if (recordable(candidate) === false) return
    // `&&`/`;` can arrive glued to a target when there is no space around them.
    const cleaned = canonicalPath(candidate.replace(/[;&|]+$/, ''))
    if (cleaned.length === 0 || recordable(cleaned) === false) return
    if (seen.has(cleaned)) return
    seen.add(cleaned)
    out.push(cleaned)
  }

  // The directory the command is running in, as far as this command says. It
  // starts at the caller's answer and moves when the command moves. `undefined`
  // means "nobody told me", and then nothing is resolved — a guess about which
  // directory a path meant is how a card starts naming files that do not exist.
  let cwd = windowsDrive(typeof base === 'string' ? base : '') ?? (typeof base === 'string' && base.length > 0 ? base : undefined)
  const remember = (target) => {
    const spelled = windowsDrive(target) ?? target
    if (cwd === undefined) {
      add(spelled)
      return
    }
    add(isAbsolute(spelled) === true ? spelled : join(cwd, spelled))
  }

  for (const segment of segmentsOf(tokenize(stripHeredocs(command)))) {
    // Skip leading `FOO=bar` assignments; the command name is the first word
    // that is not one.
    let start = 0
    while (start < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[start])) start += 1
    const name = segment[start] ?? ''
    const args = segment.slice(start + 1)

    // `cd x` moves the directory the rest of the call runs in, and since
    // segments are executed in order the move applies to every segment after
    // this one. Only a plain directory literal is followed: `cd -`, `cd $DIR`
    // and `cd ~/x` are left alone, because resolving them wrongly writes a
    // confident absolute path, which is worse than the relative one it replaced.
    if (name === 'cd' || name === 'pushd') {
      const spelled = args.find((arg) => arg.startsWith('-') === false)
      const destination = spelled === undefined ? undefined : windowsDrive(spelled) ?? spelled
      if (destination !== undefined && destination.startsWith('$') === false && destination.startsWith('~') === false && destination !== '-') {
        if (cwd !== undefined) cwd = resolve(cwd, destination)
        else if (isAbsolute(destination) === true) cwd = destination
      }
      continue
    }

    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]
      if (REDIRECT_OPERATOR.test(token)) {
        const next = args[i + 1]
        if (next !== undefined) remember(next)
        i += 1
        continue
      }
      const glued = token.match(REDIRECT_GLUED)
      if (glued !== null) remember(glued[1])
    }

    if (TARGET_ARG_COMMANDS.has(name)) {
      for (const arg of args) {
        if (arg.startsWith('-')) continue
        if (REDIRECT_OPERATOR.test(arg) || REDIRECT_GLUED.test(arg)) break
        remember(arg)
      }
    }

    if (COPY_LIKE.has(name)) {
      // Everything but the last word is a source; the last one is what appears.
      const operands = args.filter((arg) => arg.startsWith('-') === false && arg.startsWith('$') === false)
      if (operands.length >= 2) remember(operands[operands.length - 1])
    }
  }
  return out
}
