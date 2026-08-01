import { beforeEach, describe, expect, it } from 'vitest'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'

const NOW = 1_700_000_000_000

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
})

describe('deckStore.setSlideHtml', () => {
  it('replaces one slide’s HTML as an undoable command', () => {
    const id = useDeckStore.getState().currentSlideId!
    const before = getSlideHtml(useDeckStore.getState().slideHtml, id)!

    const ok = useDeckStore.getState().setSlideHtml(id, '<h1>patched</h1>', id, 'Edit element')
    expect(ok).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, id)).toBe('<h1>patched</h1>')
    expect(useDeckStore.getState().canUndo).toBe(true)

    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, id)).toBe(before)
  })

  it('redo re-applies the patch', () => {
    const id = useDeckStore.getState().currentSlideId!
    useDeckStore.getState().setSlideHtml(id, '<h1>patched</h1>', id, 'Edit element')
    useDeckStore.getState().undo()
    expect(useDeckStore.getState().redo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, id)).toBe('<h1>patched</h1>')
  })

  it('declines an unknown slide id without mutating anything', () => {
    const before = useDeckStore.getState().slideHtml
    expect(useDeckStore.getState().setSlideHtml('nope', '<h1>x</h1>', 'nope', 'Edit')).toBe(false)
    expect(useDeckStore.getState().slideHtml).toBe(before)
    expect(useDeckStore.getState().canUndo).toBe(false)
  })
})
