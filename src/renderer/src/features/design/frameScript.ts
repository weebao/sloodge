/**
 * The in-frame agent script — §2.2 of `.claude/plans/init/40-design-mode.md`, the slide-side half of
 * the bridge. It is the *only* code that can read the sandboxed slide's DOM; the renderer is the
 * source of truth and this script holds no state that matters (§2.2).
 *
 * It lives in the renderer, not `src/shared`, for one concrete reason: it is saturated with DOM
 * types (`Window`, `Element`, `document`), and `src/shared` is compiled under a DOM-less node config
 * as well as the web one. Only the renderer builds and injects it, so this is its home.
 *
 * ## Why the logic is a real function, not a string literal
 *
 * `SLIDE_RUNTIME_GUARD` (in `wrapSlideHtml.ts`) is a hand-written string because it is four lines. A
 * hit-test loop with a grabbable climb is not, and a security-sensitive message handler that lives
 * only as an un-runnable string is exactly the code that rots. So the behaviour is authored as
 * `designBridgeFrameMain`, a **self-contained** function — it closes over nothing, imports nothing,
 * and reads only globals the frame provides — and the shipped script is `(${fn.toString()})()`.
 *
 * That buys two things at once: the function is called directly in `frame-script.test.tsx` against a
 * real happy-dom document (the iframe never executes in the test environment, so this is the only
 * way to exercise it at all), and the string that runs in the slide is built from the same function
 * the test ran. The one discipline it demands is genuine self-containment — a reference to a
 * module-scope binding would type-check and then be `undefined` (or renamed by the production
 * minifier) inside the serialized copy.
 *
 * ## The security posture, restated at the point it is enforced
 *
 * The frame trusts exactly one peer: `window.parent`, the host renderer. It validates
 * `event.source === parent` on every inbound message — **source identity, never `event.origin`**,
 * which is `"null"` for this opaque-origin frame and proves nothing (§2.2). It acts only on the one
 * request type the protocol enumerates (`SL_HITTEST`), for its own slide, and there is no
 * `eval`-style escape hatch. The parent applies the mirror-image check (`isMessageFromFrame`) so
 * spoofing is refused at both ends.
 */

import { SL_ID_ATTR } from '../../../../shared/design/grabbable'

// The agent script is serialized whole via `.toString()` (see the header), so every helper it uses
// must stay nested inside `designBridgeFrameMain` to be included in the shipped bytes — hoisting them
// to module scope, which these rules would ask for, would leave them `undefined` in the frame.
/* oxlint-disable unicorn/consistent-function-scoping -- helpers must stay nested for serialization. */
/* oxlint-disable no-underscore-dangle -- `__slDesignBridge` is an install-once flag on the slide window. */

/** A slide-frame window may carry this install-once flag; declared here so the cast type-checks. */
interface BridgeWindow extends Window {
  __slDesignBridge?: boolean
}

/**
 * The agent script's body. **Do not reference anything outside this function** — see the file
 * header. It takes `trustedParent` only so the test can supply a stand-in for `window.parent`
 * (which, for the top-level test window, is the window itself and would correctly read as
 * "not framed"); the shipped IIFE passes nothing and falls back to `window.parent`.
 */
export function designBridgeFrameMain(trustedParent?: Window): void {
  const MAGIC = 1
  const VERSION = 1
  const TYPE_READY = 'SL_READY'
  const TYPE_HITTEST = 'SL_HITTEST'
  const ID_ATTR = 'data-sl-id'
  const IGNORE_ATTR = 'data-sl-ignore'
  const BARE_INLINE: Record<string, boolean> = {
    span: true,
    b: true,
    i: true,
    em: true,
    a: true,
    strong: true,
  }
  const SVG_TEXT_FRAGMENT: Record<string, boolean> = { tspan: true, textpath: true }
  const NEVER: Record<string, boolean> = { html: true, head: true, body: true }

  const win = window as BridgeWindow
  const parentWin = trustedParent ?? win.parent
  // Not framed (or framed in itself): there is no trusted peer, so the bridge does not arm. This is
  // also the top-level-window case the test relies on to prove the guard.
  if (!parentWin || parentWin === win) return

  // Install-once: a double srcdoc/reload must not stack two listeners on the same window.
  if (win.__slDesignBridge) return
  win.__slDesignBridge = true

  const doc = win.document

  const ownSlideId = (): string => {
    // Prefer the injected id's prefix ("<slideId>:<n>"): `instrument` derives it from the exact id
    // the parent passed to `buildSlideMap`, so it is guaranteed to match the parent's `slideId`. The
    // author's `data-sl-slide` is only a fallback, since a model slide could carry a different one
    // and a mismatch would make the parent reject every message from this frame.
    const first = doc.querySelector('[' + ID_ATTR + ']')
    const value = first ? first.getAttribute(ID_ATTR) : null
    if (value) {
      const cut = value.lastIndexOf(':')
      return cut === -1 ? value : value.slice(0, cut)
    }
    return doc.documentElement.getAttribute('data-sl-slide') ?? ''
  }

  const mySlide = ownSlideId()

  const tag = (el: Element): string => el.tagName.toLowerCase()

  const isAddressable = (el: Element): boolean =>
    el.getAttribute(ID_ATTR) !== null && el.getAttribute(IGNORE_ATTR) === null

  const insideIgnored = (el: Element): boolean => {
    let node: Element | null = el
    while (node) {
      if (node.getAttribute(IGNORE_ATTR) !== null) return true
      node = node.parentElement
    }
    return false
  }

  const ownText = (el: Element): string => (el.textContent ?? '').trim()

  const isBareInlineWrapper = (el: Element): boolean => {
    if (!BARE_INLINE[tag(el)]) return false
    if (el.getAttribute('class') !== null || el.getAttribute('style') !== null) return false
    const parent = el.parentElement
    return parent !== null && ownText(parent) === ownText(el)
  }

  const isEmptyBox = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    return r.width === 0 && r.height === 0
  }

  // Mirror of `resolveSelectionTarget` in grabbable.ts — kept in sync by frame-script.test.tsx.
  const climb = (hit: Element | null, alt: boolean): Element | null => {
    if (!hit) return null
    if (insideIgnored(hit)) return null
    let node: Element | null = hit
    if (alt) {
      while (node) {
        if (NEVER[tag(node)]) return null
        if (isAddressable(node)) return node
        node = node.parentElement
      }
      return null
    }
    while (node) {
      if (NEVER[tag(node)]) return null
      if (
        isAddressable(node) &&
        !SVG_TEXT_FRAGMENT[tag(node)] &&
        !isBareInlineWrapper(node) &&
        !isEmptyBox(node)
      ) {
        return node
      }
      node = node.parentElement
    }
    return null
  }

  const classesOf = (el: Element): string[] => {
    const out: string[] = []
    const list = el.classList
    for (let i = 0; i < list.length; i++) {
      const value = list.item(i)
      if (value !== null) out.push(value)
    }
    return out
  }

  // Union of every rendered node that carries this id — adoption-agency clones share one id, so
  // querySelectorAll (never querySelector) is mandatory. See overlay-geometry.unionRects.
  const rectForId = (slId: string) => {
    const nodes = doc.querySelectorAll('[' + ID_ATTR + '="' + slId + '"]')
    if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i]!.getBoundingClientRect()
      if (r.left < left) left = r.left
      if (r.top < top) top = r.top
      if (r.right > right) right = r.right
      if (r.bottom > bottom) bottom = r.bottom
    }
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  // The element's UNROTATED border box, in frame coords — its rendered size with its own rotation
  // removed, centred on the rendered box. `offsetWidth/offsetHeight` are the border-box size ignoring
  // the element's transform, so combined with the rendered box's centre (which rotation about centre
  // leaves fixed) this is the box the M3.6 overlay turns by the source rotation. Unioned across every
  // node sharing the id (adoption-agency clones). Falls back to the rendered rect for a node with no
  // usable offset size (an SVG child), which the parent then treats as "no tighter box available".
  const boxForId = (slId: string) => {
    const nodes = doc.querySelectorAll('[' + ID_ATTR + '="' + slId + '"]')
    if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] as HTMLElement
      const r = node.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const w =
        typeof node.offsetWidth === 'number' && node.offsetWidth > 0 ? node.offsetWidth : r.width
      const h =
        typeof node.offsetHeight === 'number' && node.offsetHeight > 0
          ? node.offsetHeight
          : r.height
      const nodeLeft = cx - w / 2
      const nodeTop = cy - h / 2
      if (nodeLeft < left) left = nodeLeft
      if (nodeTop < top) top = nodeTop
      if (nodeLeft + w > right) right = nodeLeft + w
      if (nodeTop + h > bottom) bottom = nodeTop + h
    }
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  const describe = (el: Element) => {
    const slId = el.getAttribute(ID_ATTR) ?? ''
    return {
      slId,
      tag: tag(el),
      id: el.getAttribute('id'),
      classes: classesOf(el),
      rect: rectForId(slId),
    }
  }

  const ancestorsOf = (el: Element) => {
    const out: ReturnType<typeof describe>[] = []
    let node = el.parentElement
    while (node) {
      if (NEVER[tag(node)]) break
      if (isAddressable(node)) out.push(describe(node))
      node = node.parentElement
    }
    return out
  }

  const hitTest = (x: number, y: number, alt: boolean) => {
    const deepest = doc.elementFromPoint(x, y)
    const target = climb(deepest, alt)
    if (!target) return null
    const d = describe(target)
    return { ...d, box: boxForId(d.slId), ancestors: ancestorsOf(target) }
  }

  const send = (env: unknown): void => {
    parentWin.postMessage(env, '*')
  }

  win.addEventListener('message', (event: MessageEvent) => {
    // Source identity is the whole authentication: reject anything not from the trusted parent.
    if (event.source !== parentWin) return
    const data = event.data as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return
    if (data['__sl'] !== MAGIC || data['v'] !== VERSION) return
    if (data['dir'] !== 'req' || data['type'] !== TYPE_HITTEST) return
    if (data['slide'] !== mySlide) return
    const p = data['payload'] as Record<string, unknown> | null
    if (!p || typeof p !== 'object') return
    if (typeof p['x'] !== 'number' || typeof p['y'] !== 'number') return
    if (p['mode'] !== 'hover' && p['mode'] !== 'select') return

    const hit = hitTest(p['x'], p['y'], p['alt'] === true)
    send({
      __sl: MAGIC,
      v: VERSION,
      id: data['id'],
      dir: 'res',
      type: TYPE_HITTEST,
      slide: mySlide,
      payload: hit,
    })
  })

  // Announce readiness so the parent knows the listener is armed and can re-send selection by id.
  const docEl = doc.documentElement
  send({
    __sl: MAGIC,
    v: VERSION,
    id: 0,
    dir: 'evt',
    type: TYPE_READY,
    slide: mySlide,
    payload: {
      w: docEl.clientWidth,
      h: docEl.clientHeight,
      mappedCount: doc.querySelectorAll('[' + ID_ATTR + ']').length,
    },
  })
}

/**
 * The shipped `<script>`: the agent script above as an immediately-invoked IIFE, tagged
 * `data-sl-ignore` so it can never itself be selected (§1.3) and so the export path can strip it.
 *
 * `designBridgeFrameMain.toString()` is the transpiled body — modern but plain JS, valid whether the
 * build minifies it or not, because the function is self-contained. This constant varies only when
 * the source of the function does, which is what lets `injectDesignBridge` treat it as a constant
 * suffix.
 */
export const DESIGN_BRIDGE_SCRIPT = `<script data-sl-ignore>(${designBridgeFrameMain.toString()})();</script>`

const BODY_CLOSE = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i

/**
 * Append the agent script to an already-instrumented slide document, immediately before the final
 * `</body>` (or at the very end when the document has none).
 *
 * ## Why this is safe for the byte-span map
 *
 * `instrument()` produces a **render artifact** — the source plus `data-sl-id` attributes — and the
 * map's spans index the *original* source, never this string. This insertion happens on that
 * artifact, after all instrumentation, so it moves no offset the map depends on. It is applied only
 * in Design Mode and never touches the `.sloodge` file on disk (§1.1), and the script it inserts is
 * `data-sl-ignore`, so it is invisible to the very hit-testing it enables.
 *
 * It is a single insertion at one computed offset — nothing before that offset is rewritten — so
 * composing it with `wrapSlideHtml` (a constant-length prefix at the doctype) leaves both transforms
 * independent. `wrapSlideHtml` must run *after* this so its injected `<meta>` CSP — which permits
 * `'unsafe-inline'` script — governs the bridge script too.
 */
export function injectDesignBridge(instrumentedHtml: string): string {
  const match = BODY_CLOSE.exec(instrumentedHtml)
  if (match === null) return instrumentedHtml + DESIGN_BRIDGE_SCRIPT
  const at = match.index
  return instrumentedHtml.slice(0, at) + DESIGN_BRIDGE_SCRIPT + instrumentedHtml.slice(at)
}

/** The attribute the shipped script must reference, re-exported so a drift fails to resolve. */
export { SL_ID_ATTR }
