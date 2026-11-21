// ---------------------------------------------------------------------------
// What counts as a deliverable.
//
// The card answers one question: which documents did this session hand over for
// a person to read. Not "which files changed" -- that question has four answers
// that all disagree, and every one of them put source code on a card nobody
// wanted to read.
//
// A deliverable is a document, an image, a sheet, a deck or a video: the
// formats a person opens to look at, as opposed to the ones a program opens to
// run. That is the whole filter, and it is why the nine noise tables this file
// used to carry are gone -- none of their subjects can reach a card any more.
//
// The list is Qoder's, copied rather than invented. It was measured against 31
// real deliverables across 14 real sessions and scored 31 of 31 with no false
// positive; a list re-derived from taste would have to earn that score again.
//
// This lives on its own because two modules ask the question at two moments.
// `api.js` asks it on the way out, when it decides whether a row is worth a
// `stat` and whether the card may show it at all. The transcript asks it when a
// turn ends, to decide which of that turn's two lists speaks -- see
// {@link chooseRows} in `transcript.js`. A second copy of the list would answer
// the two ends of one pipeline differently, and nothing would report the
// disagreement: the card would just go quiet for a kind of file one copy knew
// and the other did not.
// ---------------------------------------------------------------------------

const DELIVERABLE_SUFFIXES = new Set([
  'pdf', 'doc', 'docx', 'md', 'markdown', 'txt',
  'xls', 'xlsx', 'xlsm', 'csv', 'tsv',
  'ppt', 'pptx', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'mp4', 'webm',
])

// Names that are never a hand-over, whatever the extension says: Office lock
// files (`~$Report.docx`) and the truncated temporaries some editors leave
// (`~WRL0001.tmp`). A person never opens one, and they sit beside the real file
// under a name that sorts next to it.
const TEMPORARY_NAME = /^(?:~\$|\.~|~)/u

// Directory segments that never hold a deliverable, wherever they sit in the
// path. Two groups, both defensible without knowing which project this is:
// dependency and build scratch (Qoder's own list), and the directories whose
// contents are either secrets or another program's private state.
//
// What is deliberately absent: this repository's own scratch trees -- `_tmp-test`,
// `_qoder_rev`, `.review` -- and the prefix rules that grew around them. Those
// suppressed rows the four collectors produced in bulk. The only source now is a
// declaration, which is the model saying "this is for you"; a table about the
// author's directory habits has no business overriding an explicit act. If a
// declared file lives somewhere odd, showing it is the honest answer.
const UNDELIVERABLE_DIRS = new Set([
  '.cache', 'cache', 'tmp', 'temp', 'node_modules', '__pycache__',
  '.git', '.ssh', '.aws', '.qoder', '.qoder-cn', '.lingma',
])

/**
 * Whether this path is a document a person could open.
 *
 * Case-insensitive on the extension, because Windows and macOS write `PDF` and
 * `pdf` for the same file and the list is written in lower case.
 *
 * @param {string} path - an absolute path, in either slash style.
 * @returns {boolean} whether the card may show it.
 */
function isDeliverable(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  const slashed = path.replace(/\\/gu, '/')
  // A trailing separator says "this is a directory" and nothing else. Splitting
  // and filtering empty segments would throw that away and let `report.pdf/`
  // through as a document, which is how a directory ends up on a card.
  if (slashed.endsWith('/') === true) return false
  const segments = slashed.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return false
  const name = segments[segments.length - 1]
  if (TEMPORARY_NAME.test(name) === true) return false
  for (const segment of segments.slice(0, -1)) {
    const folded = segment.toLowerCase()
    if (UNDELIVERABLE_DIRS.has(folded) === true) return false
  }
  const dot = name.lastIndexOf('.')
  // No extension at all is not a document: a `Makefile` or a `LICENSE` is a
  // project file, and the card is not a project browser.
  if (dot <= 0) return false
  return DELIVERABLE_SUFFIXES.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Whether any path in this list is a document a person could open.
 *
 * Asked instead of "is this list empty" where the answer that matters is
 * whether the list will leave a row behind. A declaration can be non-empty and
 * still produce nothing on the card -- `present` accepts any file, including
 * the script the turn happened to write -- and a turn whose whole declaration
 * is one such file must not silence the list next to it.
 *
 * @param {Array<string | undefined>} paths - paths in any slash style.
 * @returns {boolean} whether at least one of them is a deliverable.
 */
function hasDeliverable(paths) {
  if (Array.isArray(paths) === false) return false
  for (const path of paths) {
    if (isDeliverable(path) === true) return true
  }
  return false
}

export { DELIVERABLE_SUFFIXES, TEMPORARY_NAME, UNDELIVERABLE_DIRS, isDeliverable, hasDeliverable }
