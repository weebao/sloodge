/**
 * `data-sl-lock` — "selectable but **not mutable** by Design Mode" (`30-slide-format.md` §3.4),
 * honoured by **every** Design Mode writer (M3.16), not only the caret and the panel's Content field.
 *
 * ## Why the suite is shaped per writer
 *
 * Until M3.16 the attribute was read in exactly two places, so nine of the panel's ten fields, flip,
 * rotate, duplicate and the whole drag/align/distribute path mutated a locked element while the
 * panel told the user it was locked. The fix puts one refusal in each of the three pure layers that
 * make the bytes (`buildFieldOps`, `commitTransform`, `buildDuplicatePatch`), and each of those
 * gates covers several user-visible writers.
 *
 * That is exactly the shape that rots: a gate covering six writers, pinned by one test, quietly
 * uncovers five of them at the next refactor. So every writer below gets its **own** assertion, and
 * every one of them was shown to red on its own when its gate was mutated away — the table is in the
 * M3.16 PR body. Aggregate coverage of a shared gate is not coverage.
 *
 * The invariant asserted is byte identity, not "no visible change": a locked element's bytes must be
 * the *same string*, so no command reaches the undo stack and no re-parse churns the source.
 */

import { describe, expect, it } from 'vitest'
import {
  isLocked,
  LOCK_ATTR,
  LOCK_NOTICE,
  LOCK_REASON,
  lockNotice,
  lockRefusal,
} from '../../../src/shared/design/lock'
import { buildDragPatch } from '../../../src/shared/design/drag-commit'
import { buildDuplicatePatch } from '../../../src/shared/design/duplicate'
import { buildMultiElementPatch } from '../../../src/shared/design/multi-commit'
import { buildFlipPatch, buildRotatePatch } from '../../../src/shared/design/transform-commit'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { applyOps } from '../../../src/shared/design/patch'
import {
  buildFieldOps,
  readPropertyValues,
  resolveElement,
  type PropertyField,
} from '../../../src/shared/design/property-model'
import type { SlRect } from '../../../src/shared/design/bridge-protocol'

/**
 * An HTML block that declares something for *every* field, so a refusal cannot be mistaken for "the
 * write had nothing to change". `left`/`top` put it on the offsets move channel, which is the one a
 * lock must not silently borrow the transform lock's refusal from.
 */
const LOCKED_HTML =
  '<div data-sl-lock style="position: absolute; left: 10px; top: 20px; width: 100px; height: 50px; color: red">Hi</div>'
/** The identical element without the attribute — every assertion below is paired against it. */
const FREE_HTML = LOCKED_HTML.replace(' data-sl-lock', '')

/** The SVG twin: the attribute channels (`x`/`y`/`width`/`height`/`fill`/`stroke`) rather than style. */
const LOCKED_SVG = '<svg><rect data-sl-lock x="1" y="2" width="3" height="4" fill="red"/></svg>'

const START: SlRect = { x: 10, y: 20, width: 100, height: 50 }

function at(html: string, n: number) {
  const map = buildSlideMap('s', html)
  const element = resolveElement(map, `s:${String(n)}`)!
  return { map, element, source: map.source }
}

/** The sl-id of the first element carrying `data-sl-lock`. */
function lockedId(html: string): string {
  const map = buildSlideMap('s', html)
  for (const [id, span] of map.byId) if (isLocked(span)) return id
  throw new Error('no locked element in fixture')
}

/** Every field the panel can edit, with a value that would visibly change the fixture above. */
const FIELD_EDITS: readonly (readonly [PropertyField, string])[] = [
  ['text', 'Changed'],
  ['fontFamily', 'Arial'],
  ['fontSize', '99'],
  ['fontWeight', '900'],
  ['color', 'blue'],
  ['fill', 'green'],
  ['stroke', 'black'],
  ['x', '999'],
  ['y', '888'],
  ['width', '777'],
  ['height', '666'],
]

describe('lockRefusal — the one decision function', () => {
  it('reads the attribute, not its value: bare, empty and "true" are all locked', () => {
    for (const html of [
      '<div data-sl-lock>a</div>',
      '<div data-sl-lock="">a</div>',
      '<div data-sl-lock="true">a</div>',
      // A falsy-looking value is still the attribute being present — the format defines no values.
      '<div data-sl-lock="false">a</div>',
    ]) {
      expect(lockRefusal(at(html, 0).element)).toBe(LOCK_REASON)
      expect(lockNotice(at(html, 0).element)).toBe(LOCK_NOTICE)
    }
    expect(lockRefusal(at('<div>a</div>', 0).element)).toBeNull()
    expect(lockNotice(at('<div>a</div>', 0).element)).toBeNull()
  })

  it('an unresolved element is absent, not locked — the caller has its own answer for that', () => {
    expect(lockRefusal(null)).toBeNull()
    expect(lockNotice(null)).toBeNull()
  })

  it('the two spellings are one rule: the sentence contains the clause', () => {
    // So a surface can pick its grammar without picking a different rule (`lock.ts`).
    expect(LOCK_NOTICE).toContain(LOCK_REASON)
    expect(LOCK_REASON).toContain(LOCK_ATTR)
  })
})

describe('writer 1 — buildFieldOps: every panel field, not `case "text"` alone', () => {
  it.each(FIELD_EDITS)('refuses the %s field on a locked element', (field, value) => {
    const { source, element } = at(LOCKED_HTML, 0)
    expect(buildFieldOps(source, element, field, value)).toEqual([])
    expect(applyOps(source, buildFieldOps(source, element, field, value))).toBe(source)
  })

  it.each(FIELD_EDITS)(
    'the same %s edit lands on the identical element without the attribute',
    (field, value) => {
      // The paired half: without this, a gate that refused *everything* — a typo in the fixture, a
      // field name that no longer exists — would pass the block above and prove nothing.
      const { source, element } = at(FREE_HTML, 0)
      const ops = buildFieldOps(source, element, field, value)
      expect(ops.length).toBeGreaterThan(0)
      expect(applyOps(source, ops)).not.toBe(source)
    },
  )

  it.each(['fill', 'stroke', 'x', 'y', 'width', 'height'] as const)(
    'refuses the attribute channel too: SVG %s',
    (field) => {
      // The SVG arms write presentation *attributes* rather than a style declaration, a different
      // code path through the same function — the gate has to be above the switch, not inside it.
      const { source, element } = at(LOCKED_SVG, 1)
      expect(element.tagName).toBe('rect')
      expect(buildFieldOps(source, element, field, '42')).toEqual([])
      const free = at(LOCKED_SVG.replace(' data-sl-lock', ''), 1)
      expect(buildFieldOps(free.source, free.element, field, '42').length).toBeGreaterThan(0)
    },
  )

  it('a locked descendant of a free parent is refused while the parent still edits', () => {
    // The lock is per element, not inherited downward or upward: a locked caption inside an editable
    // card must not freeze the card, and the card being editable must not thaw the caption.
    const html = '<div><p data-sl-lock>chrome</p></div>'
    const { source } = at(html, 0)
    expect(buildFieldOps(source, at(html, 1).element, 'color', 'blue')).toEqual([])
    expect(buildFieldOps(source, at(html, 0).element, 'color', 'blue').length).toBeGreaterThan(0)
  })
})

describe('reader/writer agreement — the panel cannot offer a control the writer ignores', () => {
  it('readPropertyValues still reads the truth, and buildFieldOps refuses all of it', () => {
    // The lock is deliberately NOT folded into `moveChannel` (see `lock.ts`): a locked `left: 10px`
    // element must still *show* X as `10px`, greyed, rather than reading it off an absent translate
    // and showing the field empty. The panel greys what it shows; it does not lie about it.
    const { source, element } = at(LOCKED_HTML, 0)
    const values = readPropertyValues(source, element)
    expect(values.x).toBe('10px')
    expect(values.y).toBe('20px')
    expect(values.width).toBe('100px')
    expect(values.color).toBe('red')
    // …and every one of those readable fields is refused on the write side.
    for (const [field, value] of FIELD_EDITS) {
      expect(buildFieldOps(source, element, field, value)).toEqual([])
    }
  })

  it('the Content field keeps its own M3.12 reason, which is the same lock', () => {
    const { element } = at(LOCKED_HTML, 0)
    expect(readPropertyValues(LOCKED_HTML, element).textBlock).toBe('locked')
    expect(readPropertyValues(LOCKED_HTML, element).text).toBeNull()
  })
})

describe('writer 2 — buildDragPatch: the single drag and resize', () => {
  it('a move leaves a locked element byte-identical', () => {
    const id = lockedId(LOCKED_HTML)
    const moved: SlRect = { ...START, x: 40, y: 60 }
    expect(buildDragPatch('s', LOCKED_HTML, id, START, moved)).toBe(LOCKED_HTML)
  })

  it('a resize leaves a locked element byte-identical — W/H never touch the transform', () => {
    // The transform lock deliberately lets width/height through while refusing X/Y; this lock does
    // not, so the resize arm needs its own assertion rather than riding on the move's.
    const id = lockedId(LOCKED_HTML)
    const resized: SlRect = { x: 10, y: 20, width: 300, height: 200 }
    expect(buildDragPatch('s', LOCKED_HTML, id, START, resized)).toBe(LOCKED_HTML)
  })

  it('the identical unlocked element does move and resize', () => {
    const id = lockedId(LOCKED_HTML)
    const free = FREE_HTML
    const freeId = buildSlideMap('s', free).order[0]!
    expect(id).toBe(freeId) // same position, same id — the fixtures really are twins
    expect(buildDragPatch('s', free, freeId, START, { ...START, x: 40 })).toContain('left: 40px')
    expect(
      buildDragPatch('s', free, freeId, START, { x: 10, y: 20, width: 300, height: 200 }),
    ).toContain('width: 300px')
  })
})

describe('writer 3 — buildMultiElementPatch: the group drag and align/distribute', () => {
  const PAIR =
    '<div data-sl-lock style="position: absolute; left: 10px; top: 20px; width: 100px; height: 50px">a</div>' +
    '<div style="position: absolute; left: 200px; top: 20px; width: 100px; height: 50px">b</div>'

  it('moves the free member and leaves the locked one byte-identical, in one patch', () => {
    const map = buildSlideMap('s', PAIR)
    const [lockedSl, freeSl] = map.order as [string, string]
    const result = buildMultiElementPatch('s', PAIR, [
      { slId: lockedSl, startRect: START, nextRect: { ...START, x: 40 } },
      {
        slId: freeSl,
        startRect: { x: 200, y: 20, width: 100, height: 50 },
        nextRect: { x: 230, y: 20, width: 100, height: 50 },
      },
    ])
    expect(result.moved.has(lockedSl)).toBe(false)
    expect(result.moved.has(freeSl)).toBe(true)
    expect(result.source).toContain('left: 230px')
    // The locked member's own declaration is untouched, byte for byte.
    expect(result.source).toContain('data-sl-lock style="position: absolute; left: 10px;')
  })

  it('a group whose every member is locked patches nothing at all', () => {
    const both = PAIR.replace('<div style=', '<div data-sl-lock style=')
    const map = buildSlideMap('s', both)
    const [a, b] = map.order as [string, string]
    const result = buildMultiElementPatch('s', both, [
      { slId: a, startRect: START, nextRect: { ...START, x: 40 } },
      {
        slId: b,
        startRect: { x: 200, y: 20, width: 100, height: 50 },
        nextRect: { x: 230, y: 20, width: 100, height: 50 },
      },
    ])
    expect(result.source).toBe(both)
    expect(result.moved.size).toBe(0)
  })
})

describe('writer 4 — buildFlipPatch', () => {
  it('leaves a locked element byte-identical, and flips the unlocked twin', () => {
    expect(buildFlipPatch('s', LOCKED_HTML, lockedId(LOCKED_HTML), 'x')).toBe(LOCKED_HTML)
    const freeId = buildSlideMap('s', FREE_HTML).order[0]!
    expect(buildFlipPatch('s', FREE_HTML, freeId, 'x')).toContain('scale(-1, 1)')
  })
})

describe('writer 5 — buildRotatePatch', () => {
  it('leaves a locked element byte-identical, and rotates the unlocked twin', () => {
    // Rotate shares `commitTransform` with flip but reaches it from the overlay's rotation handle,
    // which is a different entry point with a different gesture behind it.
    expect(buildRotatePatch('s', LOCKED_HTML, lockedId(LOCKED_HTML), 30)).toBe(LOCKED_HTML)
    const freeId = buildSlideMap('s', FREE_HTML).order[0]!
    expect(buildRotatePatch('s', FREE_HTML, freeId, 30)).toContain('rotate(30deg)')
  })
})

describe('writer 6 — buildDuplicatePatch', () => {
  it('refuses outright, so no clone of locked chrome is inserted', () => {
    // `null` rather than "the source unchanged": the caller reads `null` as "commit nothing" *and*
    // skips the select-the-clone step, which would otherwise select an element that does not exist.
    expect(
      buildDuplicatePatch('s', LOCKED_HTML, lockedId(LOCKED_HTML), { dx: 16, dy: 16 }),
    ).toBeNull()
  })

  it('the unlocked twin still duplicates', () => {
    const freeId = buildSlideMap('s', FREE_HTML).order[0]!
    const result = buildDuplicatePatch('s', FREE_HTML, freeId, { dx: 16, dy: 16 })
    expect(result).not.toBeNull()
    expect(result!.source.length).toBeGreaterThan(FREE_HTML.length)
  })

  it('a locked descendant is carried by a free parent’s duplicate — the parent is what was acted on', () => {
    // Deliberate, and worth pinning so it is not read as a hole: the lock refuses acting *on* the
    // locked element. A locked caption inside a duplicated card comes along with the card, still
    // locked, exactly as it would if the author had copied the card in the source.
    const html = '<div><p data-sl-lock>chrome</p></div>'
    const parentId = buildSlideMap('s', html).order[0]!
    const result = buildDuplicatePatch('s', html, parentId, { dx: 16, dy: 16 })
    expect(result).not.toBeNull()
    expect(result!.source.match(/data-sl-lock/g)?.length).toBe(2)
  })
})
