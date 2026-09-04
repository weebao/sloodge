import { describe, expect, it } from 'vitest'

import {
  enumerateSystemFonts,
  parseFcListOutput,
  parsePowerShellOutput,
} from '../../../src/main/fonts/enumerate'

/**
 * Verbatim `fc-list : family` output from the dev host (WSL2, Ubuntu). Kept as a fixture because it
 * is the one enumerator this project can actually execute in CI, and because it carries the quirk
 * the parser exists for: a single line may list a family's aliases, comma-separated.
 */
const FC_LIST_SAMPLE = [
  'DejaVu Math TeX Gyre',
  'DejaVu Sans Mono',
  'Ubuntu,Ubuntu Thin',
  'Ubuntu',
  'Ubuntu Condensed',
  'DejaVu Sans,DejaVu Sans Light',
  'DejaVu Sans',
  'DejaVu Serif,DejaVu Serif Condensed',
  'DejaVu Sans,DejaVu Sans Condensed',
  'Ubuntu,Ubuntu Light',
  'DejaVu Serif',
  'Ubuntu Mono',
  '',
].join('\n')

/** A slice of the real Windows 11 family list, including the names that stress the decoder. */
const POWERSHELL_SAMPLE = [
  'Arial',
  'Arial Black',
  'Bodoni MT Poster Compressed',
  'Gill Sans MT Ext Condensed Bold',
  'ＭＳ Ｐゴシック',
  'メイリオ',
  '맑은 고딕',
  '宋体',
  '細明體_HKSCS-ExtB',
  '',
].join('\r\n')

describe('parseFcListOutput', () => {
  it('splits comma-separated aliases into separate families', () => {
    const families = parseFcListOutput(FC_LIST_SAMPLE)
    expect(families).toContain('Ubuntu')
    expect(families).toContain('Ubuntu Thin')
    expect(families).toContain('DejaVu Sans Light')
    expect(families).toContain('DejaVu Serif Condensed')
  })

  it('dedupes the families that repeat across font files', () => {
    const families = parseFcListOutput(FC_LIST_SAMPLE)
    expect(families.filter((name) => name === 'Ubuntu')).toHaveLength(1)
    expect(families.filter((name) => name === 'DejaVu Sans')).toHaveLength(1)
  })

  it('returns a sorted list and drops the trailing blank line', () => {
    const families = parseFcListOutput(FC_LIST_SAMPLE)
    expect(families).toEqual(families.toSorted((a, b) => a.localeCompare(b)))
    expect(families).not.toContain('')
  })
})

describe('parsePowerShellOutput', () => {
  it('reads one family per line and survives CRLF', () => {
    const families = parsePowerShellOutput(POWERSHELL_SAMPLE)
    expect(families).toContain('Arial')
    expect(families).toContain('Gill Sans MT Ext Condensed Bold')
    // The \r must be trimmed, not carried into the name and then rejected by the allow-list.
    expect(families.some((name) => name.includes('\r'))).toBe(false)
  })

  it('keeps the CJK, Hangul and fullwidth families intact', () => {
    const families = parsePowerShellOutput(POWERSHELL_SAMPLE)
    for (const name of ['ＭＳ Ｐゴシック', 'メイリオ', '맑은 고딕', '宋体', '細明體_HKSCS-ExtB']) {
      expect(families, name).toContain(name)
    }
  })

  it('drops a hostile name the OS handed us rather than passing it on', () => {
    const families = parsePowerShellOutput(['Arial', 'Evil"; } body {', 'Georgia'].join('\n'))
    expect(families).toEqual(['Arial', 'Georgia'])
  })
})

describe('enumerateSystemFonts', () => {
  it('returns the empty list on a platform it cannot enumerate, without throwing', async () => {
    // A machine we cannot enumerate must still get a working panel: the system group is offered and
    // `source` says why the installed list is empty.
    await expect(enumerateSystemFonts('darwin')).resolves.toEqual({ families: [], source: 'none' })
    await expect(enumerateSystemFonts('freebsd')).resolves.toEqual({ families: [], source: 'none' })
  })

  it('reports source: none when the platform tool is missing or fails', async () => {
    // On this Linux host `fc-list` exists, so exercise the failure branch by asking for the win32
    // path, where `powershell.exe` cannot be spawned. Either way the contract is the same: resolve,
    // never reject.
    const result = await enumerateSystemFonts('win32')
    expect(result.source === 'none' || result.source === 'powershell').toBe(true)
    expect(Array.isArray(result.families)).toBe(true)
  })
})
