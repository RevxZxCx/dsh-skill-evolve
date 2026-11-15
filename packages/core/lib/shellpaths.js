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
    // `;` `&&` `||` `|` are boundaries whether or not a space follows them, and a
    // command written without spaces (`cd x&&cat > y`) is common enough that
    // missing it silently mis-resolved every target after the boundary.
    //
    // `&` and `|` are the two that cannot be split blindly. `&` sits inside
    // `2>&1` and `&>file`; `|` sits inside `>|` (the noclobber override) and its
    // relatives `>>|`, `2>|`, `&>|`. Both spellings are listed as redirect
    // operators downstream, so splitting them made the operator unreachable and
    // the target disappeared from the card altogether. A `&` that neither
    // follows nor precedes a `>` is a background marker, and a `|` whose
    // predecessor is not `>` is a pipe; both end the command.
    if (ch === ';' || ch === '|' || ch === '&') {
      const next = text[i + 1]
      const paired = next === ch
      const redirectAmpersand = ch === '&' && (text[i - 1] === '>' || next === '>')
      const redirectPipe = ch === '|' && text[i - 1] === '>'
      if (redirectAmpersand === true || redirectPipe === true) {
        // `&>file` is a single operator, and the word in front of it ends here:
        // in `cmd&>file` the `&` belongs to the redirect, not to the command name.
        if (ch === '&' && next === '>' && started === true) {
          tokens.push(current)
          current = ''
        }
        current += ch
        started = true
        continue
      }
      if (started) { tokens.push(current); current = ''; started = false }
      tokens.push(paired === true ? ch + ch : ch)
      if (paired === true) i += 1
      continue
    }
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
  // Each segment carries the separator that ended it, because `|` and `&` change
  // what the segment's `cd` means: the left side of a pipe runs in a subshell, so
  // a directory it moves to does not follow the rest of the line.
  const segments = []
  let current = []
  for (const token of tokens) {
    if (SEGMENT_SEPARATORS.has(token)) {
      if (current.length > 0) segments.push({ words: current, endedBy: token })
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) segments.push({ words: current, endedBy: '' })
  return segments
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
    // A closing paren is a different story: it is handled where the segment is
    // read, because only the one word it is glued to loses it, and only while a
    // subshell scope is open.
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
    // Filter here, on the text the command spelled -- not inside add(), after
    // resolution. Every test in recordable() inspects the start of the string:
    // `&1` begins with `&`, `NUL` is a device name, `-a` begins with `-`.
    // Resolving first turns `&1` into `F:\\work\\app\\&1`, which begins with `F`,
    // so the filter lets it through and the card offers to open a file that was
    // never named.
    if (recordable(spelled) === false) return
    // A target holding an unexpanded substitution names a file this module
    // cannot place: joining the base to `$OUT/x.txt` yields
    // `F:\\repo\\app\\$OUT\\x.txt`, and the backtick form resolved just as
    // confidently, both naming nothing. The rule is the one the `cd` branch
    // already follows -- when the location is not in the command, say so rather
    // than guess, and let the card report the row as unplaceable.
    //
    // The test looks anywhere in the token, not just at the front, because a
    // substitution can sit in the middle (`a$X.txt`) or be spelled with a
    // backtick. It is deliberately wide: by this point tokenize() has stripped
    // quotes, so a file genuinely named `a$b.txt` looks the same as a variable.
    // Treating it as unplaceable is the safe direction -- the row says so, and
    // reading the command settles it; a resolved guess cannot be detected later.
    const unexpanded = spelled.includes('$') || spelled.includes('`') || spelled.startsWith('~')
    if (cwd === undefined || unexpanded === true) {
      add(spelled)
      return
    }
    add(isAbsolute(spelled) === true ? spelled : join(cwd, spelled))
  }

  // A subshell is a scope, not a property of the command. `(` opens one and the
  // matching `)` arrives glued to the last word inside, so only that word is
  // trimmed -- and only while a scope is open. A real file may end in a paren
  // (`cp app.zip "release (final)"`), and this module has no business renaming it
  // just because some other segment happened to open a subshell.
  const scopes = []

  for (const { words: segment, endedBy } of segmentsOf(tokenize(stripHeredocs(command)))) {
    // Skip leading `FOO=bar` assignments; the command name is the first word
    // that is not one.
    // A leading `FOO=bar` is an assignment, not a command -- unless the value
    // contains a command substitution, in which case the command being run is
    // inside it and the words after it are that command's arguments.
    let start = 0
    while (
      start < segment.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[start]) === true &&
      segment[start].includes('$(') === false
    ) {
      start += 1
    }
    const head = segment[start] ?? ''
    const marker = head.indexOf('$(')
    const substituted = marker >= 0
    const raw = substituted === true ? head.slice(marker + 2) : head
    // `((count++))` is arithmetic, not a subshell: it neither opens nor closes a
    // scope, and treating it as one silently dropped the directory for the rest
    // of the line.
    const opens = substituted === true || (raw.startsWith('(') === true && raw.startsWith('((') === false)
    if (opens === true) scopes.push(cwd)
    const word = opens === false ? raw : raw.replace(/^\(+/, '')
    const closes = scopes.length > 0 && segment.length > 0 && segment[segment.length - 1].endsWith(')') === true
    // Only the word the parenthesis is glued to loses it.
    const bare = (candidate, index) =>
      closes === true && index === segment.length - 1 ? candidate.replace(/\)+$/, '') : candidate
    const args = segment.slice(start + 1).map((arg, offset) => bare(arg, start + 1 + offset))
    const before = cwd

    // The directory move is decided here and applied after the redirects, because
    // a shell opens the redirect in the directory that was current before the
    // `cd`. `null` means "this segment does not move", `undefined` means "the
    // command moved somewhere this module cannot name".
    let moveTo = null
    if (word === 'cd' || word === 'pushd') {
      const spelled = args.find((arg) => arg.startsWith('-') === false)
      const destination = spelled === undefined ? undefined : windowsDrive(spelled) ?? spelled
      const knowable =
        destination !== undefined &&
        destination.startsWith('$') === false &&
        destination.startsWith('~') === false &&
        destination !== '-'
      if (knowable === false) {
        // `cd $DIR`, `cd ~/x`, `cd -`, a bare `cd`: the result is not in this
        // command. Staying put would resolve later targets against a directory
        // the shell has already left, which is how a wrong absolute path gets
        // written with full confidence.
        moveTo = undefined
      } else if (cwd !== undefined) {
        moveTo = resolve(cwd, destination)
      } else if (isAbsolute(destination) === true) {
        // Resolved, not kept: a bare `/tmp` handed on as-is is not recognised as
        // absolute downstream (no drive, no leading slash after normalisation),
        // so the card would join it to the session root and invent a directory.
        moveTo = resolve(destination)
      } else {
        moveTo = undefined
      }
    } else if (word === 'popd') {
      // Returning to a remembered directory needs a stack, and no stack is kept.
      // Guessing "back to the base" is right only for a single pushd.
      moveTo = undefined
    }
    // `dirs` prints the stack; it does not move. Treating it as a move made the
    // rest of the line unplaceable for no reason.

    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]
      if (REDIRECT_OPERATOR.test(token)) {
        const next = args[i + 1]
        if (next !== undefined) remember(next)
        i += 1
        continue
      }
      // `>&name` and `&>name` both mean "send both streams there". A number after
      // `>&` duplicates a descriptor instead, and treating `1` as a filename is
      // how `&1` used to reach the card.
      const both = token.match(/^>>?&(.+)$/)
      if (both !== null && /^[0-9]+$/u.test(both[1]) === false) {
        remember(both[1])
        continue
      }
      const glued = token.match(REDIRECT_GLUED)
      if (glued !== null) remember(glued[1])
    }

    if (TARGET_ARG_COMMANDS.has(word)) {
      for (const arg of args) {
        if (arg.startsWith('-')) continue
        if (REDIRECT_OPERATOR.test(arg) || REDIRECT_GLUED.test(arg)) break
        remember(arg)
      }
    }

    if (COPY_LIKE.has(word)) {
      // Everything but the last word is a source; the last one is what appears.
      const operands = args.filter((arg) => arg.startsWith('-') === false && arg.startsWith('$') === false)
      if (operands.length >= 2) remember(operands[operands.length - 1])
    }

    if (moveTo !== null) cwd = moveTo

    // Leaving the scope puts the directory back where it was when the scope
    // opened -- not where it was when this segment started, which is a directory
    // the subshell itself may have just cd'd into.
    if (closes === true) cwd = scopes.pop()
    // The left side of a pipe or a background job runs in a subshell of its own,
    // so a `cd` there does not follow the rest of the line.
    if (endedBy === '|' || endedBy === '&') cwd = before
  }
  return out
}
