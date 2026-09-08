import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

/**
 * The real-run tests below all decide their expectation from a **probe**: the platform tool run
 * directly by the test, never through the module under test. That is what makes them able to fail.
 * The earlier shape here — `expect(['powershell', 'none']).toContain(result.source)` — accepted
 * total feature failure as a pass, so on a host without the tool it asserted nothing at all
 * (M3.10 review r16). Now the probe says which of the two answers is the correct one for *this*
 * host, and only that one passes: on a host with the tool a broken enumerator reports `none` and
 * reds; on a host without it, an enumerator that somehow claims success also reds.
 */
async function probe(file: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(file, [...args], {
      timeout: ENUMERATE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    return stdout
  } catch {
    return null
  }
}

/** The invariants every result must satisfy, whichever branch produced it. */
function expectWellFormed(result: { families: readonly string[] }): void {
  expect(result.families.length).toBeLessThanOrEqual(MAX_SYSTEM_FONT_FAMILIES)
  for (const name of result.families) {
    expect(isValidFontFamilyName(name), name).toBe(true)
  }
  // Idempotent under normalisation: already sorted, deduped and allow-listed.
  expect([...result.families]).toEqual(normalizeFontFamilies(result.families))
}

describe('enumerateSystemFonts', () => {
  it('returns the empty list on a platform it cannot enumerate, without throwing', async () => {
    // A machine we cannot enumerate must still get a working panel: the system group is offered and
    // `source` says why the installed list is empty.
    await expect(enumerateSystemFonts('darwin')).resolves.toEqual({ families: [], source: 'none' })
    await expect(enumerateSystemFonts('freebsd')).resolves.toEqual({ families: [], source: 'none' })
  })

  it(
    'really enumerates linux through fc-list, and matches what fc-list itself printed',
    async () => {
      // linux is the platform this repo's CI and dev hosts actually execute, so this is the branch
      // that gets the genuine end-to-end run rather than a faked `execFile`.
      const stdout = await probe('fc-list', [':', 'family'])
      const result = await enumerateSystemFonts('linux')
      expectWellFormed(result)

      if (stdout === null) {
        // fc-list is genuinely unreachable here. Then `none` is not merely allowed, it is required:
        // an enumerator reporting `fc-list` without fc-list would be reporting a lie.
        expect(result).toEqual({ families: [], source: 'none' })
        return
      }

      expect(result.source).toBe('fc-list')
      // Derived from the tool's raw bytes, so swapping in the PowerShell parser (no comma split)
      // or changing the argv away from `: family` cannot agree with it.
      expect([...result.families]).toEqual(
        normalizeFontFamilies(stdout.split('\n').flatMap((line) => line.split(','))),
      )
      // The aliases fc-list only ever prints after a comma — `DejaVu Sans,DejaVu Sans Light`. These
      // exist in the result only if the comma split really ran on this host's real output.
      const aliasOnly = [
        ...new Set(
          stdout
            .split('\n')
            .flatMap((line) => line.split(',').slice(1))
            .map((name) => name.trim())
            .filter((name) => name.length > 0 && isValidFontFamilyName(name)),
        ),
      ].filter((name) => !stdout.split('\n').some((line) => line.trim() === name))
      expect(result.families).toEqual(expect.arrayContaining(aliasOnly))
    },
    ENUMERATE_TIMEOUT_MS + 2_000,
  )

  it(
    'really enumerates win32 through powershell.exe where the host can reach it',
    async () => {
      // Under WSL `powershell.exe` resolves through interop and answers in ~0.5 s with the Windows
      // host's families; on a bare Linux CI runner it is absent. The probe decides which.
      const stdout = await probe('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '1',
      ])
      const result = await enumerateSystemFonts('win32')
      expectWellFormed(result)

      if (stdout === null) {
        expect(result).toEqual({ families: [], source: 'none' })
        return
      }

      // powershell.exe runs here, so the enumerator has no excuse for an empty list: a broken
      // `-EncodedCommand` payload lands in the catch and reports `none`, which now reds.
      expect(result.source).toBe('powershell')
      expect(result.families.length).toBeGreaterThan(0)
    },
    // The "times out" outcome is one of the ones under test, and it takes the enumerator's own
    // timeout to arrive — under a loaded host, interop `powershell.exe` has taken longer than
    // vitest's 5 s default and this test died before its subject had answered.
    2 * ENUMERATE_TIMEOUT_MS + 4_000,
  )
})
