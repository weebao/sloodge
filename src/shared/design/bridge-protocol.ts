/**
 * The postMessage bridge protocol — §3 of `.claude/plans/init/40-design-mode.md`, the layer-4 seam
 * of the four-layer sandbox (§7 of 10-architecture.md).
 *
 * The slide iframe is `sandbox="allow-scripts"` with **no** `allow-same-origin` (see
 * `SlideFrame.tsx`), so it is an opaque origin: the renderer cannot touch `iframe.contentDocument`
 * and every DOM read crosses `postMessage`. This module is the shared, pure contract for that
 * channel — the envelope, the message catalogue this milestone needs, the runtime validators for
 * **both** directions, and the one predicate the whole security story rests on
 * (`isMessageFromFrame`).
 *
 * It is deliberately free of DOM and of React: the wiring that calls `window.postMessage` /
 * `addEventListener('message')` is thin and lives in the renderer and in the injected frame script;
 * everything worth testing — envelope shape, payload shape, source identity — is a pure function
 * here, exercised directly.
 *
 * ## Why `event.source`, never `event.origin`
 *
 * For a sandboxed opaque-origin frame `event.origin` is the string `"null"` — shared by every
 * opaque frame and by anything that can get a message onto the channel — so validating it proves
 * nothing. The check that means something is reference identity: the renderer holds
 * `iframe.contentWindow` and accepts a frame message only when `event.source` **is** that exact
 * window object; the frame holds `window.parent` and accepts only messages whose source is that.
 * See `isMessageFromFrame`. It is unit-tested and mutation-covered because it is load-bearing — but
 * read the next section for the precise, and narrower, guarantee it actually delivers.
 *
 * ## What source identity does and does NOT distinguish — the real trust boundary
 *
 * `isMessageFromFrame` proves a message came from **this frame's window** rather than from some
 * other window (the parent, a sibling frame, an unrelated context). It does **not** — and *cannot*
 * — distinguish the injected bridge script from the slide's own untrusted, model-authored JavaScript:
 * both run in the *same realm* (`iframe.contentWindow`), so for a message either one posts,
 * `event.source` is the identical window object. The slide's author knows its own slide id (readable
 * from the injected `data-sl-id` prefix or `data-sl-slide`), can observe request ids by adding its
 * own `message` listener, and can even pre-empt the real bridge via the `__slDesignBridge`
 * install-once flag. A **well-formed** `SL_HITTEST` response forged by author code therefore passes
 * both the source check and `parseFrameMessage`, and the parent acts on it. This is proven, not
 * hypothetical — see `bridge-protocol.test.ts` ("a co-resident forged message is accepted").
 *
 * So a frame → parent response is an **untrusted hint about the slide's own view state**, not an
 * authenticated fact. In M3.2 that is safe *because of what the parent does with it, not because of
 * this check*: the only actions are ephemeral, re-validatable selection state (`setHover` /
 * `setSelection`), the payload is rendered as escaped React text with finite-validated geometry, and
 * no parent secret ever flows frame-ward (requests carry only `x`/`y`/`mode`/`alt`). There is no
 * escalation and no exfiltration channel.
 *
 * **The rule this establishes for later milestones (40-design-mode.md §2.2):** any feature that acts
 * *authoritatively* on a bridge message — edit-on-select, apply-patch, anything that mutates saved
 * source — MUST NOT trust the message payload. It must re-derive from **parent-held state** (the
 * `sl-id → span` map the renderer already owns) and treat the message as at most "the user gestured
 * near sl-id X", and it must route any resulting source change through the accept/reject diff gate
 * (§6.5), which requires a human keystroke. If a *silent* trusted frame → parent signal is ever
 * genuinely needed, the enforceable design is the MessageChannel-capture handshake specified in
 * §2.2 — which is viable only once the bridge is injected *before* author script, a prerequisite
 * this milestone does not meet (the bridge is appended before `</body>`, after the author's
 * last-body `<script>`).
 */

/** Magic marker on every envelope; a message without it is not ours and is ignored silently. */
export const SL_MAGIC = 1

/** Protocol version. A frame speaking a different version is ignored rather than misread. */
export const SL_PROTOCOL_VERSION = 1

/** Frame → parent, once, when the agent script has booted and its listener is armed. */
export const SL_READY = 'SL_READY'

/**
 * Parent → frame request / frame → parent response: resolve a point to the addressable element
 * under it. Hover and click share the type and differ only by `mode`, because the frame does the
 * identical DOM work for both and only the parent treats the result differently (outline vs.
 * select).
 */
export const SL_HITTEST = 'SL_HITTEST'

/**
 * Parent → frame request / frame → parent response: report the whitelisted computed styles and the
 * rendered rect of one already-selected element (§6.2, the M3.4 context bundle). This is the *only*
 * way to get `getComputedStyle` out of the sandboxed frame — the renderer cannot reach the frame DOM.
 *
 * Like every frame → parent message, the response is an **untrusted hint** (see the trust-boundary
 * section above): a co-resident slide script can forge a well-formed one. That is safe here because
 * the parent never acts *authoritatively* on it — the computed styles and rect become inert
 * informational context in the bundle, while the bundle's authoritative field (the element's source
 * HTML) is re-derived from the parent-owned map, never from this payload (§2.2, `element-context.ts`).
 */
export const SL_INSPECT = 'SL_INSPECT'

/** Direction tag. Requests carry an id a response echoes; events are fire-and-forget. */
export type SlDir = 'req' | 'res' | 'evt'

/** The wire envelope. `slide` is the sender's own slide id — the staleness guard of §3.1. */
export interface SlEnvelope<TType extends string, TPayload> {
  readonly __sl: typeof SL_MAGIC
  readonly v: typeof SL_PROTOCOL_VERSION
  readonly id: number
  readonly dir: SlDir
  readonly type: TType
  readonly slide: string
  readonly payload: TPayload
}

/** A rectangle in the slide's own 1280×720 frame coordinates (not screen, not overlay, px). */
export interface SlRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One breadcrumb link: an addressable ancestor, with the geometry to outline it on hover. */
export interface SlCrumb {
  readonly slId: string
  readonly tag: string
  /** The element's `id` attribute, or `null` — shown as `tag#id` in the breadcrumb. */
  readonly id: string | null
  readonly classes: readonly string[]
  readonly rect: SlRect
}

/** The result of a hit-test: the resolved element plus its breadcrumb ancestry, nearest-first. */
export interface SlHit {
  readonly slId: string
  readonly tag: string
  readonly id: string | null
  readonly classes: readonly string[]
  /**
   * The element's **rendered** bounding box in frame coords — the axis-aligned box a rotated element
   * inflates to, used for hover outlines and as the overlay fallback.
   */
  readonly rect: SlRect
  /**
   * The element's **unrotated** border box in frame coords (its rendered size with its own rotation
   * removed, centred on the rendered box), when the frame could measure it. The M3.6 rotation
   * overlay renders *this* box turned by the element's source rotation, so the selection outline
   * hugs a rotated element instead of showing its inflated axis-aligned bounds. Optional: an older
   * frame, or a node the frame could not measure untransformed, omits it and the overlay falls back
   * to `rect`.
   */
  readonly box?: SlRect
  /** Nearest-first ancestor chain (excludes the hit element itself), for the breadcrumb bar. */
  readonly ancestors: readonly SlCrumb[]
}

/** `SL_READY` payload: the frame's viewport size and how many elements the map addressed. */
export interface SlReadyPayload {
  readonly w: number
  readonly h: number
  readonly mappedCount: number
}

/** `SL_HITTEST` request payload. `x`/`y` are frame coords; the parent divides by zoom first. */
export interface SlHittestRequest {
  readonly x: number
  readonly y: number
  /** `hover` → the parent draws an outline; `select` → it commits a selection. */
  readonly mode: 'hover' | 'select'
  /** `Alt` bypasses the grabbable climb and selects the deepest addressable node (§4.3). */
  readonly alt: boolean
}

/** `SL_HITTEST` response payload: the hit, or `null` when nothing addressable is under the point. */
export type SlHittestResponse = SlHit | null

/** `SL_INSPECT` request payload: the sl-id to inspect (the parent-tracked selection). */
export interface SlInspectRequest {
  readonly slId: string
}

/**
 * `SL_INSPECT` response payload: the element's whitelisted computed styles and rendered rect, or
 * `null` when the frame has no node for that sl-id (a stale selection the frame has since reloaded
 * past). `computed` keys are CSS property names; values are the resolved strings from
 * `getComputedStyle`. Both fields are untrusted hints (see `SL_INSPECT`).
 */
export interface SlInspect {
  readonly slId: string
  readonly computed: Readonly<Record<string, string>>
  readonly rect: SlRect
}
export type SlInspectResponse = SlInspect | null

export type BridgeEvent = SlEnvelope<typeof SL_READY, SlReadyPayload>
export type BridgeRequest =
  SlEnvelope<typeof SL_HITTEST, SlHittestRequest> | SlEnvelope<typeof SL_INSPECT, SlInspectRequest>
export type BridgeResponse =
  | SlEnvelope<typeof SL_HITTEST, SlHittestResponse>
  | SlEnvelope<typeof SL_INSPECT, SlInspectResponse>

/** Everything the parent can legitimately receive from the frame. */
export type FromFrame = BridgeEvent | BridgeResponse

/* -------------------------------------------------------------------------------------------- *
 * Source identity — the security check
 * -------------------------------------------------------------------------------------------- */

/**
 * The one field of a `MessageEvent` this check reads. Typed structurally rather than as the DOM
 * `MessageEvent` because this module lives in `src/shared`, which is compiled under both the
 * DOM-less node config and the web config — see the two `tsconfig`s. The renderer passes a real
 * `MessageEvent` (assignable to this) and the frame does its own inline check.
 */
export interface SourcedMessage {
  readonly source: unknown
}

/**
 * Whether `event` came from the window `frameWindow` — **not** whether it came from the bridge.
 *
 * This is the opaque-origin check of §2.2: source identity, not origin string. `event.source` is a
 * live reference to the sending browsing context; comparing it to `iframe.contentWindow` proves the
 * message originated in that frame rather than in some *other* window. `event.origin` is `"null"`
 * for a sandboxed frame and is never consulted.
 *
 * **It does not authenticate the bridge.** The slide's untrusted author JS shares the frame's realm,
 * so a message it posts has the identical `event.source`; this returns `true` for it too. See the
 * "real trust boundary" section in this file's header — a passing result means "from this frame",
 * which is only a trustworthy fact when the receiver treats the payload as an untrusted hint.
 *
 * A nullish `frameWindow` — the iframe not yet mounted, or torn down — makes this `false`: there is
 * no frame to match, so nothing matches. Guarding it here rather than at every call site is what
 * keeps the check impossible to forget. `frameWindow` is `unknown` for the same cross-config reason
 * as `SourcedMessage`; the renderer passes a `Window`.
 */
export function isMessageFromFrame(event: SourcedMessage, frameWindow: unknown): boolean {
  return frameWindow !== null && frameWindow !== undefined && event.source === frameWindow
}

/* -------------------------------------------------------------------------------------------- *
 * Runtime validators — both directions
 * -------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isRect(value: unknown): value is SlRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value['x']) &&
    isFiniteNumber(value['y']) &&
    isFiniteNumber(value['width']) &&
    isFiniteNumber(value['height'])
  )
}

function isCrumb(value: unknown): value is SlCrumb {
  return (
    isRecord(value) &&
    typeof value['slId'] === 'string' &&
    typeof value['tag'] === 'string' &&
    (value['id'] === null || typeof value['id'] === 'string') &&
    isStringArray(value['classes']) &&
    isRect(value['rect'])
  )
}

function isHit(value: unknown): value is SlHit {
  const ancestors = isRecord(value) ? value['ancestors'] : undefined
  const box = isRecord(value) ? value['box'] : undefined
  return (
    isRecord(value) &&
    typeof value['slId'] === 'string' &&
    typeof value['tag'] === 'string' &&
    (value['id'] === null || typeof value['id'] === 'string') &&
    isStringArray(value['classes']) &&
    isRect(value['rect']) &&
    (box === undefined || isRect(box)) &&
    Array.isArray(ancestors) &&
    ancestors.every(isCrumb)
  )
}

function isHittestRequestPayload(value: unknown): value is SlHittestRequest {
  return (
    isRecord(value) &&
    isFiniteNumber(value['x']) &&
    isFiniteNumber(value['y']) &&
    (value['mode'] === 'hover' || value['mode'] === 'select') &&
    typeof value['alt'] === 'boolean'
  )
}

function isReadyPayload(value: unknown): value is SlReadyPayload {
  return (
    isRecord(value) &&
    isFiniteNumber(value['w']) &&
    isFiniteNumber(value['h']) &&
    isFiniteNumber(value['mappedCount'])
  )
}

/** A record whose every own value is a string — the shape of a computed-style map. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function isInspectRequestPayload(value: unknown): value is SlInspectRequest {
  return isRecord(value) && typeof value['slId'] === 'string'
}

function isInspect(value: unknown): value is SlInspect {
  return (
    isRecord(value) &&
    typeof value['slId'] === 'string' &&
    isStringRecord(value['computed']) &&
    isRect(value['rect'])
  )
}

interface EnvelopeBase {
  readonly id: number
  readonly dir: string
  readonly type: string
  readonly slide: string
  readonly payload: unknown
}

/**
 * The envelope fields common to every message, or `null` if `data` is not a well-formed envelope
 * for `expectedSlide`.
 *
 * The `slide` check is the staleness guard: a message is accepted only when its `slide` matches the
 * slide the receiver is currently bound to, so a frame that has since reloaded to a different slide
 * — or a message meant for a different slide instance — is dropped rather than misapplied.
 */
function envelopeBase(data: unknown, expectedSlide: string): EnvelopeBase | null {
  if (!isRecord(data)) return null
  if (data['__sl'] !== SL_MAGIC) return null
  if (data['v'] !== SL_PROTOCOL_VERSION) return null
  const id = data['id']
  const dir = data['dir']
  const type = data['type']
  if (!isFiniteNumber(id)) return null
  if (typeof dir !== 'string') return null
  if (typeof type !== 'string') return null
  if (data['slide'] !== expectedSlide) return null
  return { id, dir, type, slide: expectedSlide, payload: data['payload'] }
}

/**
 * Validate a message the **parent** received from the frame, returning the typed union or `null`.
 *
 * Only the two shapes the frame is allowed to send survive: a `SL_READY` event and a `SL_HITTEST`
 * response (whose payload may be `null`). Anything else — a request direction, an unknown type, a
 * malformed payload, a mismatched slide — is rejected. This is *shape* validation, not
 * *authentication*: it stops a malformed message, but a **well-formed** message forged by the
 * slide's own co-resident author script passes here exactly as the real bridge's does (both share
 * the frame realm; see this file's header). The parent must therefore treat a valid response as an
 * untrusted hint about the slide's own view state, never as an authenticated fact.
 */
export function parseFrameMessage(data: unknown, expectedSlide: string): FromFrame | null {
  const base = envelopeBase(data, expectedSlide)
  if (base === null) return null

  if (base.dir === 'evt' && base.type === SL_READY) {
    if (!isReadyPayload(base.payload)) return null
    return {
      __sl: SL_MAGIC,
      v: SL_PROTOCOL_VERSION,
      id: base.id,
      dir: 'evt',
      type: SL_READY,
      slide: base.slide,
      payload: base.payload,
    }
  }

  if (base.dir === 'res' && base.type === SL_HITTEST) {
    if (base.payload !== null && !isHit(base.payload)) return null
    return {
      __sl: SL_MAGIC,
      v: SL_PROTOCOL_VERSION,
      id: base.id,
      dir: 'res',
      type: SL_HITTEST,
      slide: base.slide,
      payload: base.payload,
    }
  }

  if (base.dir === 'res' && base.type === SL_INSPECT) {
    if (base.payload !== null && !isInspect(base.payload)) return null
    return {
      __sl: SL_MAGIC,
      v: SL_PROTOCOL_VERSION,
      id: base.id,
      dir: 'res',
      type: SL_INSPECT,
      slide: base.slide,
      payload: base.payload,
    }
  }

  return null
}

/**
 * Validate a message the **frame** received from the parent, returning the typed request or `null`.
 *
 * The mirror of `parseFrameMessage`: the frame accepts only `SL_HITTEST` requests for its own
 * slide, so a message with any other type or direction — including one the frame itself might see
 * echoed — is ignored. Combined with the source check in the frame script (which, on the frame side,
 * *does* buy a real boundary: the parent is a genuinely different realm, so a message whose source
 * is `window.parent` cannot have come from co-resident author code), this is what makes the agent
 * script have no `eval`-style escape hatch: the only thing it will ever do is what this enumerates.
 */
export function parseParentMessage(data: unknown, expectedSlide: string): BridgeRequest | null {
  const base = envelopeBase(data, expectedSlide)
  if (base === null) return null
  if (base.dir !== 'req') return null

  if (base.type === SL_HITTEST) {
    if (!isHittestRequestPayload(base.payload)) return null
    return {
      __sl: SL_MAGIC,
      v: SL_PROTOCOL_VERSION,
      id: base.id,
      dir: 'req',
      type: SL_HITTEST,
      slide: base.slide,
      payload: base.payload,
    }
  }

  if (base.type === SL_INSPECT) {
    if (!isInspectRequestPayload(base.payload)) return null
    return {
      __sl: SL_MAGIC,
      v: SL_PROTOCOL_VERSION,
      id: base.id,
      dir: 'req',
      type: SL_INSPECT,
      slide: base.slide,
      payload: base.payload,
    }
  }

  return null
}

/* -------------------------------------------------------------------------------------------- *
 * Envelope factories
 * -------------------------------------------------------------------------------------------- */

/** A monotonic id source for requests, starting at 1. Responses echo the id they answer. */
export function createEnvelopeIdSource(): () => number {
  let next = 1
  return () => {
    const id = next
    next += 1
    return id
  }
}

export function makeReadyEvent(slide: string, payload: SlReadyPayload): BridgeEvent {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id: 0,
    dir: 'evt',
    type: SL_READY,
    slide,
    payload,
  }
}

export function makeHittestRequest(
  id: number,
  slide: string,
  payload: SlHittestRequest,
): BridgeRequest {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id,
    dir: 'req',
    type: SL_HITTEST,
    slide,
    payload,
  }
}

export function makeHittestResponse(
  id: number,
  slide: string,
  payload: SlHittestResponse,
): BridgeResponse {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id,
    dir: 'res',
    type: SL_HITTEST,
    slide,
    payload,
  }
}

export function makeInspectRequest(
  id: number,
  slide: string,
  payload: SlInspectRequest,
): BridgeRequest {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id,
    dir: 'req',
    type: SL_INSPECT,
    slide,
    payload,
  }
}

export function makeInspectResponse(
  id: number,
  slide: string,
  payload: SlInspectResponse,
): BridgeResponse {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id,
    dir: 'res',
    type: SL_INSPECT,
    slide,
    payload,
  }
}
