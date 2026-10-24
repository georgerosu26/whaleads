import { describe, expect, it } from 'vitest'
import { csvCell, csvRow, detectDelimiter, guardCell, parseCsv, unguardCell } from '../src/csv'

describe('csv serialiser', () => {
  it('quotes commas, quotes, newlines and edge spaces; doubles inner quotes', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"')
    expect(csvCell(' padded ')).toBe('" padded "')
    expect(csvCell(null)).toBe('')
    expect(csvCell(0)).toBe('0')
  })
  it('keeps unicode as is', () => {
    expect(csvCell('Zoë 李雷 😀')).toBe('Zoë 李雷 😀')
    expect(csvRow(['a', 'é,ü', 'x"y'])).toBe('a,"é,ü","x""y"\r\n')
  })
  it('guards spreadsheet formulas but not phone numbers or plain negatives', () => {
    expect(guardCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(guardCell('@cmd')).toBe("'@cmd")
    expect(guardCell('+cmd|calc')).toBe("'+cmd|calc")
    expect(guardCell('-2+3x')).toBe("'-2+3x")
    expect(guardCell('+15550000101')).toBe('+15550000101')
    expect(guardCell('-12.5')).toBe('-12.5')
    expect(guardCell('normal = text')).toBe('normal = text')
    expect(unguardCell("'=SUM(A1)")).toBe('=SUM(A1)')
    expect(unguardCell("it's fine")).toBe("it's fine")
    expect(unguardCell("'quoted")).toBe("'quoted")
  })
  it('a legitimate leading apostrophe survives the round trip', () => {
    for (const v of ["'=x", "''=x", "'@x", "'+cmd|a", "'-5", "'\tx", '=x', '@x', '+cmd|a', '-2+3x', "'plain", "it's", '+15550000101', '-12.5', '']) {
      expect(unguardCell(guardCell(v)), JSON.stringify(v)).toBe(v)
      expect(parseCsv(csvRow([v, 'z'])).flat()[0]).toBe(v === '' ? '' : guardCell(v))
    }
    expect(guardCell("'=x")).toBe("''=x")
  })
  it('parseCsv stops at maxRows', () => {
    const text = 'h\n' + 'a\n'.repeat(100000)
    expect(parseCsv(text, ',', 5002).length).toBe(5002)
    expect(parseCsv('h\na\nb\n', ',', 2)).toEqual([['h'], ['a']])
    expect(parseCsv('h\na\nb', ',', 10).length).toBe(3)
  })
})

describe('csv parser', () => {
  it('reads quotes, escaped quotes, commas and newlines inside cells', () => {
    const t = 'a,b,c\r\n1,"x,y","he said ""no"""\r\n2,"two\nlines",z\r\n'
    expect(parseCsv(t)).toEqual([['a', 'b', 'c'], ['1', 'x,y', 'he said "no"'], ['2', 'two\nlines', 'z']])
  })
  it('handles LF, CR, BOM, a missing final newline and blank lines', () => {
    expect(parseCsv('﻿a,b\n1,2\n\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
    expect(parseCsv('a,b\r1,2\r')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('keeps empty cells and a trailing empty cell', () => {
    expect(parseCsv('a,b,c\n,,\n1,,')).toEqual([['a', 'b', 'c'], ['', '', ''], ['1', '', '']])
  })
  it('detects semicolon and tab delimiters outside quotes', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a\tb\tc')).toBe('\t')
    expect(detectDelimiter('"a,b,c";d')).toBe(';')
    expect(parseCsv('name;phone\nA;+1\n')).toEqual([['name', 'phone'], ['A', '+1']])
  })
  it('round-trips awkward values', () => {
    const rows = [['id', 'text'], ['1', 'a,"b"\nc'], ['2', 'Zoë 李雷 😀'], ['3', ' lead '], ['4', '']]
    const text = rows.map((r) => csvRow(r, false)).join('')
    expect(parseCsv(text)).toEqual(rows)
  })
})
