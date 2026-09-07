/**
 * The opt-in regenerator for `tests/fixtures/pptx/sloodge-export.pptx`.
 *
 * Skipped by default and that is the point. M4.6 asserts an unedited round-trip reproduces the
 * *input file* byte for byte, so the reference file has to be a fixed point: a fixture rebuilt on
 * every run could not catch a retention regression, because it would move with it. pptxgenjs also
 * stamps `docProps/core.xml` with a fresh timestamp, so every regeneration produces different bytes
 * and a different hash — which is exactly why this is a deliberate, manual act.
 *
 * To regenerate:
 *   1. flip `it.skip` to `it` here,
 *   2. `pnpm vitest run tests/unit/export/pptx-fixture-generate.test.ts`,
 *   3. re-run `tests/unit/import/pptx-roundtrip-identity.test.ts` — it derives the expected hash
 *      from the file it reads, so it needs no edit, but its recorded slide/part counts might,
 *   4. flip it back.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeDeckPptx } from '../../../src/main/export/pptx-writer'
import { SLOODGE_FIXTURE_PLAN } from '../../fixtures/pptx/sloodge-fixture-plan'
import { FIXTURE_DIR } from '../import/fixtures'

describe('pptx fixture generation', () => {
  it.skip('regenerates sloodge-export.pptx from the M4.3 export path', async () => {
    const bytes = await writeDeckPptx(SLOODGE_FIXTURE_PLAN)
    await mkdir(FIXTURE_DIR, { recursive: true })
    await writeFile(join(FIXTURE_DIR, 'sloodge-export.pptx'), bytes)
    expect(bytes.length).toBeGreaterThan(1000)
  })
})
