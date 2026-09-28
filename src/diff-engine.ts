export interface DiffResult {
  html: string
  additions: number
  removals: number
}

type RunType = 'eq' | 'del' | 'ins'

/**
 * A contiguous span of tokens. `aStart` indexes the old token stream and
 * `bStart` the new one; only the stream relevant to `type` is read.
 */
interface DiffRun {
  type: RunType
  count: number
  aStart: number
  bStart: number
}

/**
 * Upper bound on the Myers edit distance.
 *
 * The backtrack trace keeps one row per distance step, so its size is
 * O(D^2) int32 — about 9 MB in the worst case at this cap. Real regex edits
 * land orders of magnitude below it because the common prefix/suffix is
 * trimmed first; anything that does exceed it falls back to replacing the
 * whole differing middle, which still renders the exact new text.
 */
const MAX_EDIT_DISTANCE = 1500

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Words are kept together, while punctuation/symbols are tokenized one
 * character at a time. This is important for regex edits such as removing
 * `*` next to `{{user}}`: the `*` is then shown as the only removal instead
 * of grouping it together with the neighboring braces.
 */
function tokenizeDiff(s: string): string[] {
  return s.match(/[\w']+|[^\w\s]|\s+/g) || []
}

/**
 * Reconstructs the edit script from the recorded forward pass.
 *
 * `trace[d]` is the furthest-reaching frontier *before* step `d` ran, so the
 * walk starts at the last recorded step and follows `prevK` back to the
 * origin.
 */
function backtrack(trace: Int32Array[], aLen: number, bLen: number): DiffRun[] {
  const runs: DiffRun[] = []
  let x = aLen
  let y = bLen

  // Steps 1..D each consume one edit, so they need the trace. Step 0 is the
  // origin diagonal and carries no edit, so whatever is left at (0, 0) is a
  // single leading equal span.
  for (let d = trace.length - 1; d >= 1; d--) {
    const v = trace[d]
    const k = x - y
    const prevK =
      k === -d || (k !== d && v[k - 1 + d] < v[k + 1 + d]) ? k + 1 : k - 1
    const prevX = v[prevK + d]
    const prevY = prevX - prevK

    // Each step consumes exactly one token as an edit and then walks a span
    // of equal tokens, so the two cursors advance by amounts that differ by
    // one. Whichever side ran further is the side that was inserted into.
    // Runs are pushed equal-span-first so the single reverse at the end
    // restores forward order for both the steps and the runs within them.
    const advancedX = x - prevX
    const advancedY = y - prevY
    let edit: DiffRun
    let eqCount: number
    let eqA: number
    let eqB: number

    if (advancedX < advancedY) {
      edit = { type: 'ins', count: 1, aStart: prevX, bStart: prevY }
      eqCount = advancedX
      eqA = prevX
      eqB = prevY + 1
    } else {
      edit = { type: 'del', count: 1, aStart: prevX, bStart: prevY }
      eqCount = advancedY
      eqA = prevX + 1
      eqB = prevY
    }

    if (eqCount > 0) {
      runs.push({ type: 'eq', count: eqCount, aStart: eqA, bStart: eqB })
    }
    runs.push(edit)

    x = prevX
    y = prevY
  }

  if (x > 0) {
    runs.push({ type: 'eq', count: x, aStart: 0, bStart: 0 })
  }

  runs.reverse()
  return coalesce(runs)
}

/** Merges adjacent same-type runs so the renderer does fewer, larger wraps. */
function coalesce(runs: DiffRun[]): DiffRun[] {
  const merged: DiffRun[] = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last && last.type === run.type) {
      last.count += run.count
    } else {
      merged.push({ ...run })
    }
  }
  return merged
}

/**
 * Myers' greedy O(ND) alignment, where D is the number of inserted plus
 * deleted tokens. D stays small for targeted edits, which keeps this near
 * linear on real card and lorebook text.
 *
 * Returns null when the edit distance would exceed `maxD`, so the caller can
 * degrade instead of grinding.
 */
function alignTokens(a: string[], b: string[], maxD: number): DiffRun[] | null {
  const aLen = a.length
  const bLen = b.length
  const bound = Math.min(maxD, aLen + bLen)

  // Frontier indexed by diagonal k, stored at k + bound.
  const v = new Int32Array(2 * bound + 1)
  const trace: Int32Array[] = []

  for (let d = 0; d <= bound; d++) {
    // Snapshot step d-1, which lives on diagonals -(d-1)..d-1. The forward
    // loop below reads diagonals of d's own parity, so copying those instead
    // would capture the wrong frontier entirely.
    const snapshot = new Int32Array(2 * d + 1)
    for (let k = -(d - 1); k <= d - 1; k += 2) {
      snapshot[k + d] = v[k + bound]
    }
    trace.push(snapshot)

    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + bound] < v[k + 1 + bound])) {
        x = v[k + 1 + bound]
      } else {
        x = v[k - 1 + bound] + 1
      }

      let y = x - k
      while (x < aLen && y < bLen && a[x] === b[y]) {
        x++
        y++
      }

      v[k + bound] = x
      if (x >= aLen && y >= bLen) {
        return backtrack(trace, aLen, bLen)
      }
    }
  }

  return null
}

/**
 * Word-level diff of two strings, rendered as ready-to-inject HTML.
 *
 * The common prefix and suffix are stripped before alignment, so an edit that
 * touches a handful of tokens inside a long field only pays for the tokens in
 * between. That trim is what makes a single-character replacement in a
 * 5,000-token description cheap rather than quadratic.
 */
export function computeWordDiff(oldStr: string, newStr: string): DiffResult {
  const oldTokens = tokenizeDiff(oldStr)
  const newTokens = tokenizeDiff(newStr)

  const overlap = Math.min(oldTokens.length, newTokens.length)

  let prefix = 0
  while (prefix < overlap && oldTokens[prefix] === newTokens[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < overlap - prefix &&
    oldTokens[oldTokens.length - 1 - suffix] ===
      newTokens[newTokens.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldMid = oldTokens.slice(prefix, oldTokens.length - suffix)
  const newMid = newTokens.slice(prefix, newTokens.length - suffix)

  const runs: DiffRun[] = []
  if (prefix > 0) {
    runs.push({ type: 'eq', count: prefix, aStart: 0, bStart: 0 })
  }

  if (oldMid.length === 0 || newMid.length === 0) {
    if (oldMid.length > 0) {
      runs.push({ type: 'del', count: oldMid.length, aStart: prefix, bStart: prefix })
    }
    if (newMid.length > 0) {
      runs.push({ type: 'ins', count: newMid.length, aStart: prefix, bStart: prefix })
    }
  } else {
    const middle = alignTokens(oldMid, newMid, MAX_EDIT_DISTANCE)
    if (middle) {
      for (const run of middle) {
        runs.push({
          type: run.type,
          count: run.count,
          aStart: run.aStart + prefix,
          bStart: run.bStart + prefix,
        })
      }
    } else {
      // Over the distance cap: swap the whole differing middle. The rendered
      // text is still exact, only the granularity is coarser.
      runs.push({ type: 'del', count: oldMid.length, aStart: prefix, bStart: prefix })
      runs.push({ type: 'ins', count: newMid.length, aStart: prefix, bStart: prefix })
    }
  }

  if (suffix > 0) {
    runs.push({
      type: 'eq',
      count: suffix,
      aStart: oldTokens.length - suffix,
      bStart: newTokens.length - suffix,
    })
  }

  let html = ''
  let additions = 0
  let removals = 0

  for (const run of runs) {
    if (run.type === 'eq') {
      html += escapeHtml(oldTokens.slice(run.aStart, run.aStart + run.count).join(''))
    } else if (run.type === 'del') {
      // Removals read from the old stream...
      for (const token of oldTokens.slice(run.aStart, run.aStart + run.count)) {
        removals += token.length
        html += `<del style="background: rgba(239, 68, 68, 0.25); color: #f87171; text-decoration: line-through; border-radius: 2px; padding: 0 2px;">${escapeHtml(token)}</del>`
      }
    } else {
      // ...while additions read from the new one, so they index by bStart.
      for (const token of newTokens.slice(run.bStart, run.bStart + run.count)) {
        additions += token.length
        html += `<ins style="background: rgba(34, 197, 94, 0.25); color: #4ade80; text-decoration: none; border-radius: 2px; padding: 0 2px; font-weight: 500;">${escapeHtml(token)}</ins>`
      }
    }
  }

  return { html, additions, removals }
}
