/**
 * Path spelling and heredoc scanning, shared by the packages that need them.
 *
 * This module used to be a shell command reader as well: `writtenPaths` parsed
 * redirections, `tee`, `cp` and `cd` to guess which files a `bash` call wrote.
 * It existed for a card that listed everything a turn touched. That card now
 * lists what a turn delivered, and a delivery is a declaration rather than an
 * inference, so the parser is gone rather than dormant — a live-looking module
 * nothing calls is how the next reader ends up believing it is part of the
 * pipeline.
 *
 * What is left is used: `canonicalPath` by the transcript that records a
 * declaration, `stripHeredocs` by the workflow command reader.
 *
 * @module @revxz/dsh-evolve-core/shellpaths
 */

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
