/**
 * @vitest-environment happy-dom
 *
 * **No status is conveyed by colour alone** (M8b.2's definition of done; M8b.0 §3's accessibility
 * punch-list). A `Notice` tells the user something went well, went wrong, or needs care — and the
 * tint that says which is invisible to a monochrome display, to most forms of colour blindness at
 * these low chroma values, and to every screen reader.
 *
 * So the tone word is part of the notice's text, not part of its styling: it is rendered `sr-only`
 * so a sighted user reads the sentence they were given, while the accessible name of the region
 * still begins with "Warning:" or "Error:". This test asserts on `textContent`, which is what a
 * screen reader linearises — an assertion on the class string would pass on a notice whose only
 * status cue was the class.
 *
 * Mutation: delete the `sr-only` tone `<span>` from `Notice.tsx` and every row here reds.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Notice } from '../../../src/renderer/src/components/ui/Notice'
import type { NoticeTone } from '../../../src/renderer/src/components/ui/Notice'

afterEach(cleanup)

const TONES: readonly [tone: NoticeTone, word: string][] = [
  ['info', 'Note'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['danger', 'Error'],
]

describe('Notice — status is never colour alone', () => {
  it.each(TONES)('a %s notice says "%s" in its text', (tone, word) => {
    render(<Notice tone={tone}>Fonts were substituted.</Notice>)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toBe(`${word}: Fonts were substituted.`)
  })

  it('is polite by default and interrupts only when a surface asks', () => {
    const view = render(<Notice>Saved.</Notice>)
    expect(screen.getByRole('status')).toBeTruthy()
    view.rerender(<Notice role="alert">Saved.</Notice>)
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
