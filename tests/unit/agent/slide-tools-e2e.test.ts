/**
 * Unit-level end-to-end: pure tool handlers driving a real command-backed host, standing in for the
 * SDK's tool loop. It exercises the whole M2.2 path — a tool call validates untrusted HTML, dispatches
 * a command, the deck mutates, a screenshot round-trips through the injected capturer, and Ctrl+Z
 * restores the deck — with no SDK, no renderer, no subprocess. This is the "fake SDK drives tool
 * calls → deck mutates → undo restores" evidence.
 */

import { describe, expect, it, vi } from 'vitest'
import { createDeckToolHost } from '../../../src/main/agent/deck-host'
import {
  runCreateSlide,
  runReadSlide,
  runScreenshot,
  runUpdateSlide,
} from '../../../src/shared/agent/slide-tools'
import { DocumentHistory } from '../../../src/shared/document/history'
import type { DeckDoc } from '../../../src/shared/document/commands'
import { slideCount } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'
import { makeDoc } from '../document/deck-doc-fixture'

const html = (title: string): string =>
  createStarterSlideHtml({ id: 's_01H8XQZ4P7K2M9NB3VYRTC6FDA' as SlideId, title })

describe('mcp__slides__* end-to-end (fake SDK loop)', () => {
  it('creates, edits, screenshots and reads a slide, then undo restores the deck', async () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(1).doc)
    const capture = vi.fn(async () => 'PNGBYTES')
    const host = createDeckToolHost({ history, sessionId: 'as_test', capture })
    const startCount = slideCount(history.doc.manifest)

    // 1. create_slide — untrusted HTML is validated, then a slide.insert command runs.
    const created = await runCreateSlide(host, { html: html('Intro'), title: 'Intro' })
    expect(created.isError).toBeUndefined()
    const newId = (created.structuredContent as { slideId: SlideId }).slideId
    expect(slideCount(history.doc.manifest)).toBe(startCount + 1)

    // 2. update_slide — replace its HTML.
    const updated = await runUpdateSlide(host, { slideId: newId, html: html('Introduction') })
    expect(updated.isError).toBeUndefined()

    // 3. screenshot_slide — round-trips through the injected renderer, image-only result.
    const shot = await runScreenshot(host, { slideId: newId })
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(capture).toHaveBeenCalledOnce()

    // 4. read_slide — reflects the edited HTML.
    const read = await runReadSlide(host, { slideId: newId })
    expect((read.structuredContent as { html: string }).html).toBe(html('Introduction'))

    // 5. Ctrl+Z reverses the agent edits: update, then create.
    expect(history.undo().ok).toBe(true) // undo the update
    expect(history.doc.slides[newId]).toBe(html('Intro'))
    expect(history.undo().ok).toBe(true) // undo the create
    expect(slideCount(history.doc.manifest)).toBe(startCount)
  })

  it('a rejected create leaves the deck untouched (contract gate is end-to-end)', async () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(2).doc)
    const host = createDeckToolHost({ history })
    const before = slideCount(history.doc.manifest)

    const result = await runCreateSlide(host, { html: '<div>not a slide</div>', title: 'Bad' })
    expect(result.isError).toBe(true)
    expect(slideCount(history.doc.manifest)).toBe(before)
    expect(history.canUndo).toBe(false)
  })
})
