// Guard for operator-supplied regular expressions (message.received trigger). The Workers runtime has no regex timeout,
// so a pattern like (a+)+$ against hostile text would pin the isolate. Rather than run it and hope, patterns are
// refused at publish time (graph.ts) and again at match time when they have a shape that backtracks catastrophically:
//   - a quantified group whose body itself contains a quantifier or an alternation: (a+)+  (a|a)*  (.*)*
//   - a back-reference (\1, \k<n>) or a lookbehind
//   - more than MAX_REGEX characters
// The text is also cut to MAX_MATCH_TEXT characters, which bounds even the patterns that pass.
import { LIMITS } from './types'

export type RegexCheck = { ok: true; re: RegExp } | { ok: false; reason: string }

/** Is the character at i escaped by an odd run of backslashes? */
function escapedAt(p: string, i: number): boolean {
  let n = 0
  for (let k = i - 1; k >= 0 && p[k] === '\\'; k--) n++
  return n % 2 === 1
}

interface Tok { wide: boolean; unb: boolean; lit: string | null }
const QUANT = /^\{(\d+)(,(\d*))?\}/

/** Parses the quantifier at p[i], if any: how long it is and whether it repeats without a small bound. */
function quantAt(p: string, i: number): { len: number; unb: boolean; many: boolean } | null {
  const c = p[i]
  let len = 0, unb = false, many = false
  if (c === '*' || c === '+') { len = 1; unb = true; many = true }
  else if (c === '?') { len = 1 }
  else if (c === '{') {
    const m = QUANT.exec(p.slice(i))
    if (!m) return null
    len = m[0].length
    const lo = Number(m[1]), hi = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : lo
    unb = hi === Infinity || hi >= 50
    many = hi > 1
    void lo
  } else return null
  if (p[i + len] === '?') len++ // lazy
  return { len, unb, many }
}

/**
 * Refuses the pattern shapes that backtrack badly. Polynomial blow-ups count too: \w*\w*\w*\w*! is quartic in the text
 * length. So, besides the exponential shapes above:
 *   - two unbounded repeats in a row whose atoms can overlap (wide classes, or the same literal) are refused;
 *   - at most MAX_WIDE_REPEATS unbounded repeats of a wide atom (., \w, \s, \d, [...], or a group) in the whole pattern;
 *   - a worst-case score (unbounded repeats x (1 + deepest group nesting)) above MAX_REGEX_SCORE is refused.
 */
export const MAX_WIDE_REPEATS = 2
export const MAX_REGEX_SCORE = 8
export function unsafeShape(p: string): string | null {
  if (/\\[1-9]|\\k</.test(p)) return 'back-references are not allowed'
  if (/\(\?<[=!]/.test(p)) return 'lookbehind is not allowed'
  const stack: { risky: boolean }[] = []
  const toks: Tok[] = []
  let depth = 0, maxDepth = 0
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    let tok: Tok | null = null
    if (c === '[') { // a character class is one wide atom
      let j = i + 1
      while (j < p.length && (p[j] !== ']' || escapedAt(p, j))) j++
      i = j
      tok = { wide: true, unb: false, lit: null }
    } else if (c === '\\') {
      const n = p[i + 1] ?? ''
      i++
      tok = { wide: /[wWsSdD]/.test(n), unb: false, lit: /[wWsSdD]/.test(n) ? null : '\\' + n }
    } else if (c === '(') { stack.push({ risky: false }); depth++; maxDepth = Math.max(maxDepth, depth); continue }
    else if (c === ')') {
      const g = stack.pop(); depth = Math.max(0, depth - 1)
      const q = quantAt(p, i + 1)
      if (g?.risky && q?.many) return 'a repeated group may not contain its own repeat or an alternation'
      if (g?.risky && stack.length) stack[stack.length - 1]!.risky = true
      tok = { wide: true, unb: false, lit: null }
    } else if (c === '|') { if (stack.length) stack[stack.length - 1]!.risky = true; continue }
    else if (c === '.') tok = { wide: true, unb: false, lit: null }
    else if (c === '^' || c === '$') continue
    else if (c === '*' || c === '+' || c === '?' || c === '{') continue // handled with their atom
    else tok = { wide: false, unb: false, lit: c }
    const q = quantAt(p, i + 1)
    if (q) {
      tok.unb = q.unb
      if (q.many && stack.length) stack[stack.length - 1]!.risky = true
      i += q.len
    }
    toks.push(tok)
  }
  let unb = 0, wideUnb = 0
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!
    if (!t.unb) continue
    unb++
    if (t.wide) wideUnb++
    const prev = toks[k - 1]
    if (prev?.unb && ((prev.wide && t.wide) || (prev.lit !== null && prev.lit === t.lit))) return 'two unbounded repeats in a row can backtrack for a very long time'
  }
  if (wideUnb > MAX_WIDE_REPEATS) return `at most ${MAX_WIDE_REPEATS} open-ended repeats of a wide match (. \\w \\s [...]) are allowed`
  if (unb * (1 + maxDepth) > MAX_REGEX_SCORE) return 'pattern has too many open-ended repeats'
  return null
}

export function compileSafeRegex(pattern: unknown, flags = 'i'): RegexCheck {
  if (typeof pattern !== 'string' || !pattern.trim()) return { ok: false, reason: 'pattern is empty' }
  if (pattern.length > LIMITS.MAX_REGEX) return { ok: false, reason: `pattern is over ${LIMITS.MAX_REGEX} characters` }
  const bad = unsafeShape(pattern)
  if (bad) return { ok: false, reason: bad }
  try { return { ok: true, re: new RegExp(pattern, flags) } } catch { return { ok: false, reason: 'pattern is not a valid regular expression' } }
}

export const clipText = (t: string) => (t.length > LIMITS.MAX_MATCH_TEXT ? t.slice(0, LIMITS.MAX_MATCH_TEXT) : t)
