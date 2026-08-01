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
  makeInspectRequest,
  makeInspectResponse,
  makeReadyEvent,
  parseFrameMessage,
  parseParentMessage,
  SL_HITTEST,
  SL_INSPECT,
  SL_MAGIC,
  SL_PROTOCOL_VERSION,
  SL_READY,
  type SlHit,
  type SlInspect,
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

describe('the real trust boundary — a co-resident forged message is accepted', () => {
  // This suite PINS A LIMITATION, not a feature. The slide's untrusted author JS shares the frame's
  // realm with the injected bridge, so a message it posts carries the identical `event.source` — the
  // very `iframe.contentWindow` the parent trusts. Source identity distinguishes THIS frame from
  // other windows; it cannot distinguish the bridge from author code inside it. If either assertion
  // below ever flips, someone has changed the boundary — do not "fix" the test by re-asserting the
  // false guarantee that source+shape validation stops a same-realm spoof. See bridge-protocol.ts.

  it('isMessageFromFrame accepts an author message because it shares the frame window', () => {
    const frameWindow = { name: 'contentWindow' }
    // Author code runs in `frameWindow` too, so `event.source` IS the trusted window.
    const authorMessage = { source: frameWindow }
    expect(isMessageFromFrame(authorMessage, frameWindow)).toBe(true)
  })

  it('parseFrameMessage accepts a well-formed forged response (shape != authentication)', () => {
    // A forgery the author can trivially build: correct slide id, plausible echoed request id, and a
    // hit that points wherever the author likes. It is well-formed, so it survives validation.
    const forged = makeHittestResponse(99, SLIDE, {
      slId: `${SLIDE}:0`,
      tag: 'div',
      id: null,
      classes: [],
      rect: { x: 0, y: 0, width: 10, height: 10 },
      ancestors: [],
    })
    expect(parseFrameMessage(forged, SLIDE)).not.toBeNull()
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

  it('accepts the optional unrotated box (M3.6) and rejects a malformed one', () => {
    const withBox = parseFrameMessage(
      envelope({ payload: { ...hit, box: { x: 1, y: 2, width: 3, height: 4 } } }),
      SLIDE,
    )
    expect(withBox?.dir).toBe('res')
    // A present-but-malformed box is rejected, not silently dropped.
    expect(
      parseFrameMessage(envelope({ payload: { ...hit, box: { x: 1, y: 2 } } }), SLIDE),
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
    expect(message?.type).toBe(SL_HITTEST)
    // `BridgeRequest` is a union (SL_HITTEST | SL_INSPECT); narrow by type before reading `mode`.
    if (message?.type === SL_HITTEST) expect(message.payload.mode).toBe('hover')
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

describe('SL_INSPECT — the computed-styles bridge message (M3.4)', () => {
  const inspect: SlInspect = {
    slId: `${SLIDE}:3`,
    computed: { color: 'rgb(1, 2, 3)', 'font-size': '20px' },
    rect,
  }

  it('parseFrameMessage accepts a well-formed inspect response', () => {
    const env = makeInspectResponse(11, SLIDE, inspect)
    const message = parseFrameMessage(env, SLIDE)
    expect(message?.type).toBe(SL_INSPECT)
    expect(message?.dir).toBe('res')
    if (message?.type === SL_INSPECT && message.payload !== null) {
      expect(message.payload.computed['font-size']).toBe('20px')
      expect(message.payload.rect).toEqual(rect)
    }
  })

  it('parseFrameMessage accepts a null inspect payload (stale id in the frame)', () => {
    const env = makeInspectResponse(12, SLIDE, null)
    const message = parseFrameMessage(env, SLIDE)
    expect(message?.type).toBe(SL_INSPECT)
    if (message?.type === SL_INSPECT) expect(message.payload).toBeNull()
  })

  it('parseFrameMessage rejects a computed map with a non-string value', () => {
    const env = makeInspectResponse(13, SLIDE, inspect)
    const bad = { ...env, payload: { slId: `${SLIDE}:3`, computed: { color: 5 }, rect } }
    expect(parseFrameMessage(bad, SLIDE)).toBeNull()
  })

  it('parseFrameMessage rejects an inspect response with a malformed rect', () => {
    const bad = {
      ...makeInspectResponse(14, SLIDE, inspect),
      payload: { slId: `${SLIDE}:3`, computed: {}, rect: { x: 1, y: 2, width: 'no', height: 4 } },
    }
    expect(parseFrameMessage(bad, SLIDE)).toBeNull()
  })

  it('parseFrameMessage rejects an inspect response for a different slide', () => {
    const env = makeInspectResponse(15, SLIDE, inspect)
    expect(parseFrameMessage({ ...env, slide: 's_other' }, SLIDE)).toBeNull()
  })

  it('parseParentMessage accepts a well-formed inspect request', () => {
    const env = makeInspectRequest(16, SLIDE, { slId: `${SLIDE}:3` })
    const message = parseParentMessage(env, SLIDE)
    expect(message?.type).toBe(SL_INSPECT)
    if (message?.type === SL_INSPECT) expect(message.payload.slId).toBe(`${SLIDE}:3`)
  })

  it('parseParentMessage rejects an inspect request with no slId', () => {
    const bad = { ...makeInspectRequest(17, SLIDE, { slId: 'x' }), payload: { slId: 5 } }
    expect(parseParentMessage(bad, SLIDE)).toBeNull()
  })

  it('SOURCE-VALIDATION: an inspect reply is gated by isMessageFromFrame, not its content', () => {
    // The renderer's inspect client only reads event.data after isMessageFromFrame passes. A reply
    // from any window that is not the frame's contentWindow is dropped regardless of how well-formed
    // it is — the opaque-origin guard, mirrored from the hit-test path.
    const frameWindow = { name: 'frame' }
    const attacker = { name: 'attacker' }
    const env = makeInspectResponse(18, SLIDE, inspect)
    expect(isMessageFromFrame({ source: attacker }, frameWindow)).toBe(false)
    // Same well-formed reply is only trusted-as-a-hint when it comes from the frame window itself
    // (a co-resident forged reply passes shape+source, which is why the bundle never derives its
    // authoritative HTML from it — see element-context.test.ts §2.2 re-derivation).
    expect(isMessageFromFrame({ source: frameWindow }, frameWindow)).toBe(true)
    expect(parseFrameMessage(env, SLIDE)?.type).toBe(SL_INSPECT)
  })
})
