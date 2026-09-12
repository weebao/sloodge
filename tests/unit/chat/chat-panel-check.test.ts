import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'

/**
 * M8b.3 surface 1: `node scripts/design-inventory.mjs --check <file>` is the milestone's definition
 * of done for `ChatPanel.tsx`, and until M8b.4 lands it runs only when someone remembers to run it.
 * Spawned here over this one file, it reds on a retired token, a `dark:` twin, a palette colour, an
 * alpha suffix or an arbitrary value coming back — the spellings every one of U2, U4, U10, U12, U13
 * and U18 was written in. The rendered-class half of the guard (a role token of the *wrong* role,
 * which this gate cannot see) is `chat-panel-design.test.tsx` next door; it is a separate file only
 * because `.tsx` tests are typechecked under the web tsconfig, which has no Node types to spawn with.
 *
 * Mutation: `bg-surface` → `bg-surface dark:bg-ink` on the panel's `<aside>` → `RESULT: FAIL (2)`
 * (`legacy = 1`, `dark = 1`), the row printing `| 1 | 1 |` where the gate columns must be 0.
 */
const FILE = 'src/renderer/src/features/chat/ChatPanel.tsx'

describe('M8b.3 surface 1 — the design check over ChatPanel.tsx', () => {
  it('passes: every gate column is 0 and the script prints RESULT: pass', () => {
    let out: string
    try {
      out = execFileSync(process.execPath, ['scripts/design-inventory.mjs', '--check', FILE], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })
    } catch (error) {
      out = (error as { stdout?: string }).stdout ?? String(error)
    }
    // `| file | utilities | colour | legacy | dark: | arbitrary | palette | alpha | unknown |` —
    // the first two are counts, the six after them are the gate.
    expect(
      out,
      out
        .split('\n')
        .filter((l) => /^- |RESULT/.test(l))
        .join('\n'),
    ).toMatch(/\| features\/chat\/ChatPanel\.tsx \| \d+ \| \d+ \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \|/)
    expect(out).toContain('RESULT: pass')
  })
})
