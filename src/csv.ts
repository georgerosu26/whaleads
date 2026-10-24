// RFC 4180 CSV: a streaming-friendly serialiser and a strict-enough parser (quotes, "" escapes, newlines in
// quoted cells, CRLF, BOM, comma / semicolon / tab delimiters). Spreadsheet formula injection is guarded on the way out
// and the guard is removed on the way in.

/** A leading =, @, tab or CR makes Excel/Sheets run the cell as a formula; so do +/- followed by non-numeric text.
 *  The guard is one apostrophe in front. A cell that already starts with apostrophes followed by a trigger character
 *  (a legitimate `'=x`) gets one more, so unguardCell, which strips exactly one, restores it byte for byte. */
const NUMERIC = /^[+-]?[\d\s().,-]+$/
const QUOTED_TRIGGER = /^'+[=@+\-\t\r]/
export function guardCell(s: string): string {
  if (!s) return s
  const c = s[0]
  if (c === '=' || c === '@' || c === '\t' || c === '\r') return "'" + s
  if ((c === '+' || c === '-') && !NUMERIC.test(s)) return "'" + s
  if (QUOTED_TRIGGER.test(s)) return "'" + s
  return s
}
/** Inverse of guardCell: strips exactly one leading apostrophe when apostrophes are followed by a trigger character. */
export function unguardCell(s: string): string {
  return QUOTED_TRIGGER.test(s) ? s.slice(1) : s
}

export function csvCell(v: unknown, guard = true): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (guard) s = guardCell(s)
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
export const csvRow = (cells: unknown[], guard = true): string => cells.map((c) => csvCell(c, guard)).join(',') + '\r\n'

export function detectDelimiter(head: string): string {
  const first = head.split(/\r?\n/, 1)[0] ?? ''
  let best = ',', n = -1
  for (const d of [',', ';', '\t']) {
    // count delimiters outside quotes
    let q = false, k = 0
    for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch === d) k++ }
    if (k > n) { n = k; best = d }
  }
  return best
}

/** Parses the text into rows of cells. Fully blank lines are skipped. Stops as soon as `maxRows` rows are read, so an
 *  oversized file costs only as much as the limit allows. */
export function parseCsv(text: string, delimiter?: string, maxRows = Infinity): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const d = delimiter ?? detectDelimiter(text)
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false, i = 0
  const n = text.length
  const push = () => { row.push(cell); cell = '' }
  const endRow = () => { push(); if (!(row.length === 1 && row[0] === '')) rows.push(row); row = [] }
  const full = () => rows.length >= maxRows
  while (i < n && !full()) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue } q = false; i++; continue }
      cell += ch; i++; continue
    }
    if (ch === '"' && cell === '') { q = true; i++; continue }
    if (ch === d) { push(); i++; continue }
    if (ch === '\r') { endRow(); i += text[i + 1] === '\n' ? 2 : 1; continue }
    if (ch === '\n') { endRow(); i++; continue }
    cell += ch; i++
  }
  if (!full() && (cell !== '' || row.length)) endRow()
  return rows
}
