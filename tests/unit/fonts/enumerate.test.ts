import { describe, expect, it } from 'vitest'

import {
  ENUMERATE_TIMEOUT_MS,
  enumerateSystemFonts,
  parseFcListOutput,
  parsePowerShellOutput,
} from '../../../src/main/fonts/enumerate'
import {
  MAX_SYSTEM_FONT_FAMILIES,
  isValidFontFamilyName,
  normalizeFontFamilies,
} from '../../../src/shared/fonts/family'

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

  it(
    'always resolves with an already-normalised result, whatever the platform tool does',
    async () => {
      // Asserted as invariants rather than as a fixed list, because this one really does run the
      // Windows enumerator where the host can reach it (under WSL, `powershell.exe` resolves through
      // interop and answers in ~0.5 s with the Windows host's families) and fails to spawn anywhere
      // else. Both outcomes must be well-formed: a rejected promise would leave the dropdown stuck on
      // "loading", and an unnormalised one would put OS-authored strings into slide CSS.
      const result = await enumerateSystemFonts('win32')
      expect(['powershell', 'none']).toContain(result.source)
      expect(result.families.length).toBeLessThanOrEqual(MAX_SYSTEM_FONT_FAMILIES)
      for (const name of result.families) {
        expect(isValidFontFamilyName(name), name).toBe(true)
      }
      // Idempotent under normalisation: already sorted, deduped and allow-listed.
      expect([...result.families]).toEqual(normalizeFontFamilies(result.families))
    },
    // The "times out" outcome is one of the ones under test, and it takes the enumerator's own
    // timeout to arrive — under a loaded host, interop `powershell.exe` has taken longer than
    // vitest's 5 s default and this test died before its subject had answered.
    ENUMERATE_TIMEOUT_MS + 2_000,
  )
})
