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
 * (M3.10 review r16). Now the probe says which answer is the correct one for *this* host, and only
 * that one passes: on a host with the tool a broken enumerator reports `none` and reds; on a host
 * without it, an enumerator that somehow claims success also reds.
 *
 * **The probe must do the same work as the subject, and must be given longer to do it.** M9.0's
 * release failure is what taught this. The win32 probe used to be `powershell.exe -Command 1`,
 * which proves the shell starts and nothing more, on the enumerator's own timeout. So it could
 * report only two states — "starts" and "does not start" — while the enumerator's cost is
 * dominated by a third thing the probe never ran: loading `System.Drawing`. A cold `windows-latest`
 * runner therefore probed green in milliseconds and then had its enumerator SIGTERM'd at 10 s,
 * and the suite reported a product defect where the truth was a budget that was too small.
 *
 * Hence: the probe runs the **real payload**, on a budget several times the subject's, and there
 * are **three** outcomes rather than two — cannot run (`none` required), runs inside
 * `ENUMERATE_TIMEOUT_MS` (`powershell` with the tool's own families required), and runs but too
 * slowly (fail, naming both durations, because the budget is the thing that is wrong). The third
 * is the one that cannot be expressed at all by a probe sharing the subject's timeout.
 */

/**
 * The probe's own budget, deliberately far larger than the enumerator's. A probe that shared
 * `ENUMERATE_TIMEOUT_MS` could never distinguish "this host cannot run the tool" from "this host is
 * slower than the enumerator allows", because both arrive as the same null at the same instant —
 * which is exactly how the M9.0 `windows-latest` failure presented (a legitimately slow cold host
 * read as a broken enumerator). Only a probe with headroom over the subject can measure the third
 * outcome and name it.
 */
const PROBE_TIMEOUT_MS = 120_000

interface Probe {
  /** The tool's stdout, or `null` if it could not be run to completion here. */
  readonly stdout: string | null
  /** Wall-clock the probe took. A lower bound only when `timedOut`. */
  readonly ms: number
  /** True when `null` is "too slow for even the probe", not "cannot run at all". */
  readonly timedOut: boolean
}

/**
 * Run a platform tool directly, timed. Never through `enumerateSystemFonts`: routing the probe
 * through the module under test would make every assertion below tautological, which is the shape
 * M3.10 review r15 rejected.
 */
async function probe(file: string, args: readonly string[]): Promise<Probe> {
  const startedAt = Date.now()
  try {
    const { stdout } = await promisify(execFile)(file, [...args], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    return { stdout, ms: Date.now() - startedAt, timedOut: false }
  } catch (error) {
    // `execFile` reports its own timeout kill as `killed: true`; anything else (ENOENT, a non-zero
    // exit) means the tool genuinely cannot run here. The two demand opposite verdicts, so they are
    // separated at the source rather than guessed at from the elapsed time.
    const killed =
      typeof error === 'object' && error !== null && 'killed' in error
        ? Boolean((error as { killed?: unknown }).killed)
        : false
    return { stdout: null, ms: Date.now() - startedAt, timedOut: killed }
  }
}

/**
 * The third outcome, shared by both real-run tests: the tool works here, but took longer than the
 * enumerator is willing to wait. That is not a fault in the enumerator's logic and must not be
 * reported as one — it is evidence that `ENUMERATE_TIMEOUT_MS` is too tight for this class of host,
 * which is the finding to act on. Silently passing would hide it; asserting `none` would enshrine
 * it as correct behaviour.
 */
function failAsTooTight(tool: string, probed: Probe): never {
  // The two shapes are different evidence and must not be reported as the same sentence: one
  // measured the cost, the other only bounded it from below — which is precisely the mistake the
  // 10 s budget was built on.
  const observed = probed.timedOut
    ? `was still running after ${probed.ms} ms, when the probe's own ${PROBE_TIMEOUT_MS} ms budget ` +
      `killed it (so its true cost is at least that, and unknown above it)`
    : `completed here in ${probed.ms} ms`
  throw new Error(
    `${tool} ${observed}, which is longer than ENUMERATE_TIMEOUT_MS (${ENUMERATE_TIMEOUT_MS} ms). ` +
      `The host can enumerate fonts; the enumerator's timeout is too tight to let it, so every ` +
      `user on a host this slow gets an empty installed-font list. Raise ENUMERATE_TIMEOUT_MS ` +
      `above ${probed.ms} ms rather than relaxing this test.`,
  )
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
      const probed = await probe('fc-list', [':', 'family'])
      const result = await enumerateSystemFonts('linux')
      expectWellFormed(result)

      if (probed.stdout === null) {
        if (probed.timedOut) failAsTooTight('fc-list', probed)
        // fc-list is genuinely unreachable here. Then `none` is not merely allowed, it is required:
        // an enumerator reporting `fc-list` without fc-list would be reporting a lie.
        expect(result).toEqual({ families: [], source: 'none' })
        return
      }
      if (probed.ms > ENUMERATE_TIMEOUT_MS) failAsTooTight('fc-list', probed)

      const stdout = probed.stdout
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
    PROBE_TIMEOUT_MS + ENUMERATE_TIMEOUT_MS + 10_000,
  )

  it(
    'really enumerates win32 through powershell.exe where the host can reach it',
    async () => {
      // Under WSL `powershell.exe` resolves through interop and answers in ~0.5 s warm with the
      // Windows host's families; on a bare Linux CI runner it is absent. The probe decides which.
      //
      // **The probe runs the real payload, not `-Command 1`.** The old probe proved only that the
      // shell *starts*, and starting is the cheap half: the expensive half is
      // `Add-Type -AssemblyName System.Drawing`, which the old probe never touched. So on the M9.0
      // `windows-latest` runner the probe passed in milliseconds, the enumerator was then killed by
      // its own 10 s timeout mid-assembly-load, and a legitimately slow host was reported as a
      // broken enumerator. Running the real work is what closes that gap — and it has a second
      // effect that matters: the probe pays the *cold* cost, so by the time the subject runs the
      // assembly is warm. The cold number therefore shows up in `probed.ms`, where it can be
      // compared against the budget, instead of only ever showing up as a SIGTERM.
      //
      // The script is a literal here, not `POWERSHELL_SCRIPT` imported from the module: a probe
      // built from the subject's own constant moves whenever the subject moves and could agree with
      // a broken payload. `enumerate-spawn.test.ts` is what pins the two to each other.
      const SCRIPT =
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
        'Add-Type -AssemblyName System.Drawing;' +
        '(New-Object System.Drawing.Text.InstalledFontCollection).Families|ForEach-Object{$_.Name}'
      const probed = await probe('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64'),
      ])
      const result = await enumerateSystemFonts('win32')
      expectWellFormed(result)

      if (probed.stdout === null) {
        // Branch 3a: it did not fail, it was too slow even for the probe's own long budget. Saying
        // `none` is correct here would be enshrining the very defect this test exists to catch.
        if (probed.timedOut) failAsTooTight('the powershell.exe font query', probed)
        // Branch 1: powershell.exe cannot run the font query here at all. Then `none` is not merely
        // allowed, it is required — an enumerator reporting `powershell` without powershell would
        // be reporting a lie.
        expect(result).toEqual({ families: [], source: 'none' })
        return
      }

      // Branch 3b: the query completes here, but not inside the enumerator's budget. Under the old
      // 10 s that is precisely the M9.0 release failure, and it must be reported as "the timeout is
      // too tight", naming both durations, rather than passed over or blamed on the enumerator.
      if (probed.ms > ENUMERATE_TIMEOUT_MS) {
        failAsTooTight('the powershell.exe font query', probed)
      }

      // Branch 2: the host can do the work inside the budget, so the enumerator has no excuse for
      // an empty list. A broken `-EncodedCommand` payload lands in the catch and reports `none`,
      // which reds here.
      expect(result.source).toBe('powershell')
      expect(result.families.length).toBeGreaterThan(0)
      // Derived from the tool's own raw bytes, the way the fc-list branch above is: the enumerator
      // must agree with what PowerShell actually printed, not merely return *some* families.
      expect([...result.families]).toEqual(normalizeFontFamilies(probed.stdout.split('\n')))
    },
    // The probe's budget plus the subject's, plus slack. The "times out" outcome is one of the ones
    // under test and takes a full timeout to arrive, so this has to outlast both of them — under a
    // loaded host, interop `powershell.exe` has taken longer than vitest's 5 s default and this
    // test died before its subject had answered.
    PROBE_TIMEOUT_MS + ENUMERATE_TIMEOUT_MS + 10_000,
  )
})
