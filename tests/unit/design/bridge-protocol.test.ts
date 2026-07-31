/**
 * The postMessage bridge contract — envelope + payload validation in both directions, the factories,
 * and above all the opaque-origin source check (`isMessageFromFrame`), which is the single most
 * security-sensitive line in Design Mode and is mutation-covered below.
 */

import { describe, expect, it } from 'vitest'
import {
  createEnvelopeIdSource,
  isMessageFromFrame,
  makeHittestRequest,
  makeHittestResponse,
  makeReadyEvent,
  parseFrameMessage,
  parseParentMessage,
  SL_HITTEST,
  SL_MAGIC,
  SL_PROTOCOL_VERSION,
  SL_READY,
  type SlHit,
} from '../../../src/shared/design/bridge-protocol'

const SLIDE = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'

const rect = { x: 10, y: 20, width: 30, height: 40 }

const hit: SlHit = {
  slId: `${SLIDE}:3`,
  tag: 'rect',
  id: 'bar',
  classes: ['bar', 'accent'],
  rect,
  ancestors: [{ slId: `${SLIDE}:1`, tag: 'g', id: null, classes: ['bars'], rect }],
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id: 7,
    dir: 'res',
    type: SL_HITTEST,
    slide: SLIDE,
    payload: hit,
    ...overrides,
  }
}

describe('isMessageFromFrame — the opaque-origin source check', () => {
  it('accepts a message whose source IS the trusted frame window', () => {
    const frameWindow = { name: 'frame' }
    expect(isMessageFromFrame({ source: frameWindow }, frameWindow)).toBe(true)
  })

  it('rejects a message from any other source — the spoofing case', () => {
    const frameWindow = { name: 'frame' }
    const attacker = { name: 'attacker' }
    expect(isMessageFromFrame({ source: attacker }, frameWindow)).toBe(false)
  })

  it('rejects when there is no trusted frame yet (null / undefined)', () => {
    const frameWindow = { name: 'frame' }
    // A null source must never match a null frame — otherwise an unmounted frame trusts everything.
    expect(isMessageFromFrame({ source: null }, null)).toBe(false)
    expect(isMessageFromFrame({ source: frameWindow }, null)).toBe(false)
    expect(isMessageFromFrame({ source: frameWindow }, undefined)).toBe(false)
  })

  it('does not consult event.origin at all — identity is the whole check', () => {
    const frameWindow = { name: 'frame' }
    // Even an event carrying a trusted-looking origin is rejected when the source is wrong.
    const spoof = { source: { name: 'other' }, origin: 'https://sloodge.app' }
    expect(isMessageFromFrame(spoof, frameWindow)).toBe(false)
  })
})

describe('parseFrameMessage — what the parent will accept from the frame', () => {
  it('accepts a well-formed hit-test response', () => {
    const message = parseFrameMessage(envelope(), SLIDE)
    expect(message).not.toBeNull()
    expect(message?.dir).toBe('res')
    expect(message?.type).toBe(SL_HITTEST)
    expect(message?.payload).toMatchObject({ slId: `${SLIDE}:3` })
  })

  it('accepts a null-payload response (nothing under the point)', () => {
    const message = parseFrameMessage(envelope({ payload: null }), SLIDE)
    expect(message?.payload).toBeNull()
  })

  it('accepts a SL_READY event', () => {
    const message = parseFrameMessage(
      envelope({ dir: 'evt', type: SL_READY, id: 0, payload: { w: 1280, h: 720, mappedCount: 5 } }),
      SLIDE,
    )
    expect(message?.type).toBe(SL_READY)
  })

  it('rejects a message for a different slide (staleness guard)', () => {
    expect(parseFrameMessage(envelope({ slide: 's_other' }), SLIDE)).toBeNull()
  })

  it('rejects a request direction — the frame may only respond and emit', () => {
    expect(parseFrameMessage(envelope({ dir: 'req' }), SLIDE)).toBeNull()
  })

  it('rejects wrong magic and wrong version', () => {
    expect(parseFrameMessage(envelope({ __sl: 2 }), SLIDE)).toBeNull()
    expect(parseFrameMessage(envelope({ v: 2 }), SLIDE)).toBeNull()
  })

  it('rejects a malformed hit payload', () => {
    // missing rect
    const noRect = { ...hit } as Record<string, unknown>
    delete noRect['rect']
    expect(parseFrameMessage(envelope({ payload: noRect }), SLIDE)).toBeNull()

    // ancestors not an array
    expect(
      parseFrameMessage(envelope({ payload: { ...hit, ancestors: 'nope' } }), SLIDE),
    ).toBeNull()

    // a malformed crumb inside ancestors
    expect(
      parseFrameMessage(envelope({ payload: { ...hit, ancestors: [{ slId: 1 }] } }), SLIDE),
    ).toBeNull()

    // a non-finite number in the rect
    expect(
      parseFrameMessage(
        envelope({ payload: { ...hit, rect: { x: 0, y: 0, width: Infinity, height: 1 } } }),
        SLIDE,
      ),
    ).toBeNull()
  })

  it('rejects non-objects', () => {
    expect(parseFrameMessage(null, SLIDE)).toBeNull()
    expect(parseFrameMessage('SL_HITTEST', SLIDE)).toBeNull()
    expect(parseFrameMessage(42, SLIDE)).toBeNull()
  })
})

describe('parseParentMessage — what the frame will accept from the parent', () => {
  const request = {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id: 1,
    dir: 'req',
    type: SL_HITTEST,
    slide: SLIDE,
    payload: { x: 100, y: 200, mode: 'hover', alt: false },
  }

  it('accepts a well-formed hit-test request', () => {
    const message = parseParentMessage(request, SLIDE)
    expect(message?.dir).toBe('req')
    expect(message?.payload.mode).toBe('hover')
  })

  it('rejects a response direction — the frame never receives responses', () => {
    expect(parseParentMessage({ ...request, dir: 'res' }, SLIDE)).toBeNull()
  })

  it('rejects a bad request payload', () => {
    expect(
      parseParentMessage({ ...request, payload: { x: 1, y: 2, mode: 'x', alt: false } }, SLIDE),
    ).toBeNull()
    expect(
      parseParentMessage(
        { ...request, payload: { x: 'a', y: 2, mode: 'hover', alt: false } },
        SLIDE,
      ),
    ).toBeNull()
    expect(
      parseParentMessage({ ...request, payload: { x: 1, y: 2, mode: 'hover', alt: 'yes' } }, SLIDE),
    ).toBeNull()
  })

  it('rejects a request for a different slide', () => {
    expect(parseParentMessage({ ...request, slide: 's_other' }, SLIDE)).toBeNull()
  })
})

describe('factories round-trip through the validators', () => {
  it('makeHittestRequest is accepted by parseParentMessage', () => {
    const env = makeHittestRequest(5, SLIDE, { x: 1, y: 2, mode: 'select', alt: true })
    expect(parseParentMessage(env, SLIDE)?.id).toBe(5)
  })

  it('makeHittestResponse is accepted by parseFrameMessage', () => {
    const env = makeHittestResponse(5, SLIDE, hit)
    expect(parseFrameMessage(env, SLIDE)?.id).toBe(5)
  })

  it('makeReadyEvent is accepted by parseFrameMessage', () => {
    const env = makeReadyEvent(SLIDE, { w: 1280, h: 720, mappedCount: 3 })
    expect(parseFrameMessage(env, SLIDE)?.type).toBe(SL_READY)
  })

  it('createEnvelopeIdSource is monotonic from 1', () => {
    const next = createEnvelopeIdSource()
    expect([next(), next(), next()]).toEqual([1, 2, 3])
  })
})
