/**
 * @vitest-environment happy-dom
 *
 * The generated presenter shell (M4.4).
 *
 * Three groups, in order of how much they would cost to get wrong:
 *
 *  1. **Sandboxing.** The shell is opened from `file://` outside our app, so the iframe sandbox is
 *     the only thing standing between a hostile slide and the viewer's filesystem. Both tokens are
 *     pinned, and `allow-same-origin` is asserted absent from the whole emitted document.
 *  2. **Escaping.** The deck title reaches three contexts; each is probed with a breakout payload
 *     and the assertion is made against a *parsed* document, not against the source string.
 *  3. **Logic parity.** The shell's key/clamp/reduce logic is emitted JavaScript, so it is evaluated
 *     here and cross-checked against `keyToPresentIntent` / `clampSlideIndex` / `reducePresent` —
 *     the tie that makes "shares M4.1's tested module" true of generated code rather than a claim.
 */

import { describe, expect, it } from 'vitest'
import {
  buildKeyIntentTable,
  buildPresenterLogicJs,
  buildPresenterShell,
  SHELL_MANIFEST_ELEMENT_ID,
  SHELL_SLIDE_SANDBOX,
  type BundleManifest,
} from '../../../src/shared/export/presenter-shell'
import { SLIDE_SANDBOX } from '../../../src/renderer/src/features/canvas/SlideFrame'
import {
  clampSlideIndex,
  createPresentState,
  keyToPresentIntent,
  PRESENT_KEYS,
  reducePresent,
  type PresentIntent,
  type PresentState,
} from '../../../src/shared/present/machine'

function manifestOf(title: string, slideCount = 3): BundleManifest {
  return {
    formatVersion: 1,
    generator: 'sloodge',
    title,
    slideCount,
    slides: Array.from({ length: slideCount }, (_unused, index) => ({
      index,
      id: `s_${String(index)}`,
      title: `Slide ${String(index + 1)}`,
      file: `slides/${String(index + 1).padStart(3, '0')}-slide.html`,
    })),
  }
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

describe('presenter shell — sandboxing', () => {
  it('sandboxes slide frames exactly as the editor canvas does', () => {
    // If these two ever diverge, the exported bundle is laxer than the app that produced it — and it
    // runs in a *weaker* environment, with no response header and no host CSP behind it.
    expect(SHELL_SLIDE_SANDBOX).toBe(SLIDE_SANDBOX)
    expect(SHELL_SLIDE_SANDBOX).toBe('allow-scripts')
  })

  it('gives every slide frame the sandbox attribute', () => {
    const doc = parse(buildPresenterShell(manifestOf('Deck')))
    const frames = [...doc.querySelectorAll('iframe')]
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    }
  })

  it('never grants allow-same-origin anywhere in the emitted document', () => {
    // The load-bearing assertion of this milestone. `allow-scripts allow-same-origin` is documented
    // by the HTML standard as equivalent to removing the sandbox entirely; over `file://` that would
    // hand a slide same-origin access to other local files — i.e. the viewer's filesystem — plus the
    // shell's own DOM. Adding the token anywhere, including in the runtime script, reddens here.
    const html = buildPresenterShell(manifestOf('Deck'))
    expect(html).not.toContain('allow-same-origin')
  })

  it('keeps slide frames out of the top-level document', () => {
    // A bundle that inlined slide markup into index.html would run author script with the shell's
    // own `file://` privileges, with no sandbox at all. Slides must be framed by `src`, never inlined.
    const doc = parse(buildPresenterShell(manifestOf('Deck')))
    for (const frame of doc.querySelectorAll('iframe')) {
      expect(frame.hasAttribute('srcdoc')).toBe(false)
    }
  })

  it('emits no postMessage channel to the sandboxed frames', () => {
    // The sandbox has no hole to keep open only if the shell never opens one. Nothing is injected
    // into a slide and nothing is listened for from one.
    const html = buildPresenterShell(manifestOf('Deck'))
    expect(html).not.toContain('postMessage')
    expect(html).not.toContain('contentWindow')
    expect(html).not.toContain('contentDocument')
  })
})

describe('presenter shell — escaping of injected text', () => {
  const HOSTILE = '</title><script>alert(1)</script>" onload="alert(2)" & \'x\''

  it('cannot break out of the document title', () => {
    const doc = parse(buildPresenterShell(manifestOf(HOSTILE)))
    expect(doc.title).toBe(HOSTILE)
    // No element from the payload was created anywhere in the document.
    expect(doc.querySelectorAll('script[src], img').length).toBe(0)
  })

  it('cannot break out of an attribute context', () => {
    const doc = parse(buildPresenterShell(manifestOf(HOSTILE)))
    const controls = doc.getElementById('controls')
    expect(controls?.getAttribute('aria-label')).toBe(`${HOSTILE} presentation controls`)
    expect(controls?.hasAttribute('onload')).toBe(false)
    for (const frame of doc.querySelectorAll('iframe')) {
      expect(frame.hasAttribute('onload')).toBe(false)
    }
  })

  it('cannot break out of the inlined manifest block', () => {
    const doc = parse(buildPresenterShell(manifestOf(HOSTILE)))
    const block = doc.getElementById(SHELL_MANIFEST_ELEMENT_ID)
    const parsed = JSON.parse(block?.textContent ?? '') as BundleManifest
    // The block was not terminated early: the whole manifest survived, title intact.
    expect(parsed.title).toBe(HOSTILE)
    expect(parsed.slides).toHaveLength(3)
  })

  it('only ever emits the one inline script it wrote itself', () => {
    // Exactly two blocks: the JSON manifest and the runtime. A payload that injected a third would
    // change this count.
    const doc = parse(buildPresenterShell(manifestOf(HOSTILE)))
    expect(doc.querySelectorAll('script')).toHaveLength(2)
  })

  it('keeps a legitimate title readable', () => {
    const title = 'Q1 & Q2 — "Growth" <2026>'
    const doc = parse(buildPresenterShell(manifestOf(title)))
    expect(doc.title).toBe(title)
  })
})

describe('presenter shell — embedded slide list', () => {
  it('embeds exactly the manifest it was given', () => {
    const manifest = manifestOf('Deck', 5)
    const doc = parse(buildPresenterShell(manifest))
    const parsed = JSON.parse(
      doc.getElementById(SHELL_MANIFEST_ELEMENT_ID)?.textContent ?? '',
    ) as BundleManifest
    expect(parsed).toEqual(manifest)
    expect(parsed.slides).toHaveLength(parsed.slideCount)
  })

  it('inlines the manifest rather than fetching it (file:// has no fetch)', () => {
    const html = buildPresenterShell(manifestOf('Deck'))
    expect(html).toContain(`<script type="application/json" id="${SHELL_MANIFEST_ELEMENT_ID}">`)
    expect(html).not.toContain('fetch(')
    expect(html).not.toContain('XMLHttpRequest')
  })

  it('references no external resource — the bundle is self-contained', () => {
    const doc = parse(buildPresenterShell(manifestOf('Deck')))
    for (const el of doc.querySelectorAll('script[src], link[href], img[src]')) {
      throw new Error(`unexpected external reference: ${el.outerHTML}`)
    }
    expect(doc.querySelectorAll('script[src], link[href]')).toHaveLength(0)
  })
})

/**
 * Evaluate the emitted pure logic and hand back its three functions. This is the seam that makes the
 * generated code testable against the module it was generated from.
 */
function evalShellLogic(): {
  keyToIntent: (key: string) => PresentIntent | null
  clampIndex: (index: number, slideCount: number) => number
  reduce: (state: PresentState, intent: PresentIntent) => PresentState
} {
  const factory = new Function(
    `${buildPresenterLogicJs()}\nreturn { keyToIntent: keyToIntent, clampIndex: clampIndex, reduce: reduce };`,
  ) as () => ReturnType<typeof evalShellLogic>
  return factory()
}

describe('presenter shell — emitted logic agrees with the Present-mode module', () => {
  const logic = evalShellLogic()

  it('maps every claimed key to the same intent the app does', () => {
    for (const key of PRESENT_KEYS) {
      expect(keyToPresentIntent(key)).not.toBeNull()
      expect(logic.keyToIntent(key)).toBe(keyToPresentIntent(key))
    }
  })

  it('covers the navigation keys the wireframe specifies', () => {
    const table = buildKeyIntentTable()
    expect(table['ArrowRight']).toBe('next')
    expect(table[' ']).toBe('next')
    expect(table['PageDown']).toBe('next')
    expect(table['ArrowLeft']).toBe('prev')
    expect(table['PageUp']).toBe('prev')
    expect(table['Escape']).toBe('exit')
    expect(table['b']).toBe('toggle-blank')
    expect(table['B']).toBe('toggle-blank')
  })

  it('declines unclaimed keys, leaving them to the slide', () => {
    for (const key of ['a', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', '1']) {
      expect(logic.keyToIntent(key)).toBeNull()
      expect(keyToPresentIntent(key)).toBeNull()
    }
  })

  it('does not mistake a prototype member for an intent', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(logic.keyToIntent(key)).toBeNull()
    }
  })

  it('clamps identically to clampSlideIndex across the boundaries', () => {
    for (const slideCount of [0, 1, 3, 10]) {
      for (let index = -3; index <= slideCount + 3; index += 1) {
        expect(logic.clampIndex(index, slideCount)).toBe(clampSlideIndex(index, slideCount))
      }
    }
  })

  it('reduces identically to reducePresent over every intent from every position', () => {
    const intents: PresentIntent[] = ['next', 'prev', 'first', 'last', 'toggle-blank', 'exit']
    for (const slideCount of [1, 4]) {
      for (let start = 0; start < slideCount; start += 1) {
        for (const intent of intents) {
          const expected = reducePresent(createPresentState(start, slideCount), intent)
          const actual = logic.reduce({ index: start, slideCount, blank: false }, intent)
          expect({ index: actual.index, blank: actual.blank }).toEqual({
            index: expected.index,
            blank: expected.blank,
          })
        }
      }
    }
  })

  it('does not wrap past either end — a talk must not jump to the title slide', () => {
    // The clamp is the one line a mutation (`+ 1` with no clamp) would remove.
    expect(logic.reduce({ index: 3, slideCount: 4, blank: false }, 'next').index).toBe(3)
    expect(logic.reduce({ index: 0, slideCount: 4, blank: false }, 'prev').index).toBe(0)
  })

  it('preserves blank across navigation and toggles it in place', () => {
    expect(logic.reduce({ index: 0, slideCount: 4, blank: true }, 'next')).toEqual({
      index: 1,
      slideCount: 4,
      blank: true,
    })
    expect(logic.reduce({ index: 2, slideCount: 4, blank: false }, 'toggle-blank')).toEqual({
      index: 2,
      slideCount: 4,
      blank: true,
    })
  })
})
