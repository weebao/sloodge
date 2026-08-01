/**
 * The `SL_ELEMENTS` bridge message (M3.7): the parent asks the frame for every grabbable element and
 * the frame answers with an array of hits. Both validators must accept the well-formed shapes and
 * reject malformed ones, exactly like the `SL_HITTEST`/`SL_INSPECT` pair.
 */

import { describe, expect, it } from 'vitest'
import {
  makeElementsRequest,
  makeElementsResponse,
  parseFrameMessage,
  parseParentMessage,
  SL_ELEMENTS,
  type SlHit,
} from '../../../src/shared/design/bridge-protocol'

const SLIDE = 's_el'

const HIT: SlHit = {
  slId: 's_el:1',
  tag: 'div',
  id: null,
  classes: ['card'],
  rect: { x: 10, y: 20, width: 100, height: 40 },
  box: { x: 10, y: 20, width: 100, height: 40 },
  ancestors: [
    {
      slId: 's_el:0',
      tag: 'div',
      id: null,
      classes: ['slide'],
      rect: { x: 0, y: 0, width: 1280, height: 720 },
    },
  ],
}

describe('SL_ELEMENTS request', () => {
  it('round-trips through parseParentMessage', () => {
    const req = makeElementsRequest(7, SLIDE)
    const parsed = parseParentMessage(req, SLIDE)
    expect(parsed?.type).toBe(SL_ELEMENTS)
    expect(parsed?.dir).toBe('req')
    expect(parsed?.id).toBe(7)
  })

  it('is rejected for a mismatched slide (staleness guard)', () => {
    expect(parseParentMessage(makeElementsRequest(1, SLIDE), 'other')).toBeNull()
  })
})

describe('SL_ELEMENTS response', () => {
  it('round-trips an array of hits through parseFrameMessage', () => {
    const res = makeElementsResponse(7, SLIDE, [HIT])
    const parsed = parseFrameMessage(res, SLIDE)
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe(SL_ELEMENTS)
    expect(parsed?.dir).toBe('res')
    const payload = parsed?.payload as readonly SlHit[]
    expect(payload[0]?.slId).toBe('s_el:1')
  })

  it('accepts an empty element list', () => {
    const parsed = parseFrameMessage(makeElementsResponse(1, SLIDE, []), SLIDE)
    expect(parsed?.payload).toEqual([])
  })

  it('rejects a response whose payload is not an array of hits', () => {
    const bad = { ...makeElementsResponse(1, SLIDE, []), payload: [{ slId: 5 }] }
    expect(parseFrameMessage(bad, SLIDE)).toBeNull()
  })

  it('rejects a non-array payload', () => {
    const bad = { ...makeElementsResponse(1, SLIDE, []), payload: { slId: 'x' } }
    expect(parseFrameMessage(bad, SLIDE)).toBeNull()
  })
})
