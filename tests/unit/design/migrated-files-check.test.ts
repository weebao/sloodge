import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The per-file design gate, run as a test over every surface M8b.3 has migrated.
 *
 * `node scripts/design-inventory.mjs --check <file …>` is each surface's definition of done
 * (ui-design-audit.md §4, §7): a retired token, a `dark:` twin, an arbitrary value, a palette colour,
 * an alpha suffix or a chain the grammar cannot read coming back turns one of the six gate columns
 * non-zero and the run red. Until M8b.4 turns `--check` into a suite test over the whole renderer, a
 * file that has migrated is guarded only while something runs the gate for it — this file is that
 * something. One spawn covers the whole list (a spawn is ~150 ms on a quiet box; one per file would
 * be N× that), and `it.each` gives every file its own row in the report, so the red names the file
 * and the columns that went non-zero rather than "the check failed".
 *
 * **A surface PR appends its paths to `MIGRATED` as its last step** — one string per file, nothing
 * else to write. A path `--check` does not scan (a typo, a `.ts` file, a file outside
 * `src/renderer/src`) is a failure the script prints as `- <path>: no such file` / `not a scanned
 * renderer file`, and the file's `it` reds on the missing row, so a wrong entry cannot pass as zeros.
 *
 * What this cannot see: a role token of the *wrong* role. `bg-surface` on a field instead of
 * `bg-field` is a declared token in every column, so `--check` stays green while U2 is back at
 * 1.04:1. That is the per-surface rendered-class test's job (`tests/unit/chat/chat-panel-design.test.tsx`
 * for surface 1), whose header says which findings it pins and which shapes escape both halves.
 *
 * Mutation (M8b.3 surface 1): `bg-surface` → `bg-surface dark:bg-ink` on `ChatPanel.tsx`'s `<aside>`
 * → the file's row reds `features/chat/ChatPanel.tsx: legacy = 1, dark: = 1` above the row itself
 * (`| features/chat/ChatPanel.tsx | 98 | 27 | 1 | 1 | 0 | 0 | 0 | 0 |`), and the RESULT test reds
 * quoting `- features/chat/ChatPanel.tsx: legacy = 1`, `- …: dark = 1`, `RESULT: FAIL (2)`.
 */

/** Repo-relative paths under `src/renderer/src`, `.tsx` or `.css`. Append; one comment per surface PR. */
const MIGRATED = [
  // M8b.3 surface 1 — chat panel (#76)
  'src/renderer/src/features/chat/ChatPanel.tsx',
  // M8b.3 surface 2 — app shell (#75)
  'src/renderer/src/app/AppShell.tsx',
  'src/renderer/src/features/format/MenuTabStrip.tsx',
  'src/renderer/src/features/format/FormatBar.tsx',
  'src/renderer/src/features/design/DesignModeToggle.tsx',
  // M8b.3 surface 4 — settings dialog (#79)
  'src/renderer/src/features/settings/SettingsDialog.tsx',
  'src/renderer/src/features/settings/AuthTab.tsx',
  'src/renderer/src/features/settings/BudgetTab.tsx',
  // M8b.3 surface 3 — property panel (#78)
  'src/renderer/src/features/design/PropertyPanel.tsx',
  'src/renderer/src/features/design/ColorControls.tsx',
  'src/renderer/src/features/design/ArrangeBar.tsx',
  // M8b.3 surface 5 — canvas + overlay (#81)
  'src/renderer/src/features/canvas/SlideCanvas.tsx',
  'src/renderer/src/features/design/SelectionOverlay.tsx',
  'src/renderer/src/features/design/DesignNotice.tsx',
] as const

const RENDERER = 'src/renderer/src/'

/**
 * The per-file row is `| file | utilities | colour | legacy | dark: | arbitrary | palette | alpha |
 * unknown |`; the first two numbers are counts, these six are the gate (the script's `COLUMNS`
 * minus `colour`, in its order).
 */
const GATE = ['legacy', 'dark:', 'arbitrary', 'palette', 'alpha', 'unknown'] as const

let output = ''

beforeAll(() => {
  try {
    output = execFileSync(
      process.execPath,
      ['scripts/design-inventory.mjs', '--check', ...MIGRATED],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
  } catch (error) {
    // A non-zero exit is the case worth reading; the table and the reasons are on stdout either way.
    output = (error as { stdout?: string }).stdout ?? String(error)
  }
})

/** What a red should carry: every requested row, every `- reason` bullet, and the RESULT line. */
const digest = (): string =>
  output
    .split('\n')
    .filter((l) => /^\| [\w./-]+\.(?:tsx|css) \||^- |^RESULT/.test(l))
    .join('\n')

describe('M8b.3 — every migrated surface stays on the tokens (`--check` as a suite test)', () => {
  /**
   * The list is the gate. Review r2 found two ways to disable it without anything going red, and
   * both are things a later surface PR could do by accident while appending its paths.
   *
   * An EMPTY list is the dangerous one: arg-less `--check` is the whole-renderer census mode, which
   * prints `RESULT: pass` with `legacy 294` on the tree, so `it.each([])` runs nothing, the RESULT
   * case passes, and nine migrated surfaces are guarded by a green suite. A `./`-prefixed path is the
   * quieter one: the row is found under the un-prefixed name, so the entry reds with the *misleading*
   * "did --check refuse the path?" while the digest shows a clean row.
   */
  it('the MIGRATED list is well formed, or this whole file guards nothing', () => {
    expect(
      MIGRATED.length,
      'MIGRATED is empty — arg-less `--check` is census mode and passes',
    ).toBeGreaterThan(0)
    for (const file of MIGRATED) {
      expect(file, `${file}: drop the ./ prefix — the row is keyed on the plain path`).not.toMatch(
        /^\.\//,
      )
      expect(file, `${file}: must be under ${RENDERER}`).toMatch(new RegExp(`^${RENDERER}`))
      expect(file, `${file}: --check scans .tsx and .css only`).toMatch(/\.(?:tsx|css)$/)
    }
    expect(new Set(MIGRATED).size, 'MIGRATED has a duplicate entry').toBe(MIGRATED.length)
  })

  it.each(MIGRATED)('%s: every gate column is 0', (file) => {
    const short = file.slice(RENDERER.length)
    const row = output.split('\n').find((l) => l.startsWith(`| ${short} |`))
    expect(
      row,
      `no per-file row for ${file} — did --check refuse the path?\n${digest()}`,
    ).toBeDefined()
    // Cells after the file name: utilities, colour, then the six gate columns. A cell that is not a
    // number reads NaN, which is not 0, so a reshaped table reds instead of passing as zeros.
    const cells = (row ?? '')
      .split('|')
      .slice(2, -1)
      .map((c) => Number(c.trim()))
    const offending = GATE.map((name, i) => `${name} = ${String(cells[i + 2])}`).filter(
      (_, i) => cells[i + 2] !== 0,
    )
    expect(offending, `${short}: ${offending.join(', ')}\n${row ?? ''}`).toEqual([])
  })

  it('the script prints RESULT: pass over the whole list', () => {
    expect(output, digest()).toContain('RESULT: pass')
  })
})
