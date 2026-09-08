import { describe, expect, it } from 'vitest'

import { firstFontFamily, isSystemFont } from '../../../src/shared/fonts/system-fonts'
import { SYSTEM_FONT_GROUP } from '../../../src/shared/fonts/family'

describe('isSystemFont', () => {
  it('recognizes safe families and flags others', () => {
    expect(isSystemFont('Arial, sans-serif')).toBe(true)
    expect(isSystemFont('"Times New Roman", serif')).toBe(true)
    expect(isSystemFont('Inter, sans-serif')).toBe(false)
    expect(firstFontFamily('"Helvetica Neue", Arial')).toBe('helvetica neue')
  })

  // Why the predicate is shared rather than duplicated: the dropdown's first section promises no
  // export warning, so a face added there that the scorer penalises would make the panel contradict
  // the export report.
  it('accepts every face the dropdown lists as a system font', () => {
    for (const entry of SYSTEM_FONT_GROUP) {
      expect(isSystemFont(entry.name), entry.name).toBe(true)
    }
  })
})
