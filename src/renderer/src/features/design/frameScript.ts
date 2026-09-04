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
 * which is `"null"` for this opaque-origin frame and proves nothing (§2.2). It acts only on the
 * request types the protocol enumerates (`SL_HITTEST`, and `SL_INSPECT` for the M3.4 context bundle),
 * for its own slide, and there is no `eval`-style escape hatch. The parent applies the mirror-image
 * check (`isMessageFromFrame`) so spoofing is refused at both ends.
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
  const TYPE_INSPECT = 'SL_INSPECT'
  const TYPE_ELEMENTS = 'SL_ELEMENTS'
  const TYPE_EDIT = 'SL_EDIT'
  const ID_ATTR = 'data-sl-id'
  const EDIT_ATTR = 'contenteditable'
  const LOCK_ATTR = 'data-sl-lock'
  // Mirror of `NON_EDITABLE_TAGS` in `src/shared/design/text-edit.ts`; frame-script.test.tsx asserts
  // the two agree, so a tag added there and not here fails a unit test. The parent gate is the one
  // that matters (it decides what gets *written*); this one stops a caret ever appearing.
  const NOT_EDITABLE: Record<string, boolean> = {
    script: true,
    style: true,
    xmp: true,
    plaintext: true,
    noscript: true,
    noembed: true,
    noframes: true,
    iframe: true,
    title: true,
    textarea: true,
    template: true,
    table: true,
    thead: true,
    tbody: true,
    tfoot: true,
    tr: true,
    colgroup: true,
    ul: true,
    ol: true,
    dl: true,
    select: true,
    optgroup: true,
    html: true,
    head: true,
  }
  // The computed-style whitelist (§6.2) — must stay inside this self-contained function, so it is a
  // literal copy of `COMPUTED_STYLE_WHITELIST` in `element-context.ts`. `frame-script.test.tsx`
  // asserts the two are byte-identical, so a drift fails a unit test.
  const STYLE_WHITELIST = [
    'display',
    'position',
    'top',
    'right',
    'bottom',
    'left',
    'width',
    'height',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    'color',
    'background-color',
    'background-image',
    'opacity',
    'text-align',
    'text-transform',
    'text-decoration',
    'white-space',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'gap',
    'flex-direction',
    'align-items',
    'justify-content',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-color',
    'border-style',
    'border-radius',
    'box-shadow',
    'transform',
    'transform-origin',
    'overflow',
    'z-index',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'paint-order',
  ]
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

  // Whether an element is itself a valid selection target — the standing form of the `climb`
  // predicate, used to enumerate the marquee/guide candidate set (M3.7). Mirrors the per-node checks
  // in `climb` (grabbable.ts's `resolveSelectionTarget`), kept in sync by frame-script.test.tsx.
  const isGrabbable = (el: Element): boolean =>
    !NEVER[tag(el)] &&
    isAddressable(el) &&
    !insideIgnored(el) &&
    !SVG_TEXT_FRAGMENT[tag(el)] &&
    !isBareInlineWrapper(el) &&
    !isEmptyBox(el)

  // Every grabbable element as a full hit, in document order — the marquee tests rect intersection
  // over this set, and smart guides snap against the rects of the elements not being dragged.
  const allElements = () => {
    const nodes = doc.querySelectorAll('[' + ID_ATTR + ']')
    const seen: Record<string, boolean> = {}
    const out: ReturnType<typeof hitTest>[] = []
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i]!
      if (!isGrabbable(el)) continue
      const d = describe(el)
      // Adoption-agency clones share one id; report each id once (its rect is already unioned).
      if (seen[d.slId]) continue
      seen[d.slId] = true
      out.push({ ...d, box: boxForId(d.slId), ancestors: ancestorsOf(el) })
    }
    return out
  }

  // Computed styles (whitelisted subset) + rect for an already-selected id, for the M3.4 context
  // bundle (§6.2). The first node carrying the id is measured for styles (adoption-agency clones
  // share one id but the same computed style); the rect is unioned across all of them, matching
  // `rectForId`. Returns null when the id is not in this frame (a stale selection).
  const inspectId = (slId: string) => {
    const node = doc.querySelector('[' + ID_ATTR + '="' + slId + '"]')
    if (!node) return null
    const style = win.getComputedStyle(node)
    const computed: Record<string, string> = {}
    for (let i = 0; i < STYLE_WHITELIST.length; i++) {
      const prop = STYLE_WHITELIST[i]!
      const value = style.getPropertyValue(prop)
      if (value && value.length > 0) computed[prop] = value.trim()
    }
    return { slId, computed, rect: rectForId(slId) }
  }

  const send = (env: unknown): void => {
    parentWin.postMessage(env, '*')
  }

  /* ---------------------------------------------------------------------------------------- *
   * Direct text editing (M3.11, §4.1)
   *
   * The caret lives here because the element does: the parent cannot reach into an opaque-origin
   * frame's document. What crosses back is only ever `textContent` — a read that *cannot* carry
   * markup, so a paste that smuggled HTML in is flattened by the read itself rather than filtered
   * afterwards. The parent still treats it as untrusted (see `SL_EDIT` in bridge-protocol.ts).
   * ---------------------------------------------------------------------------------------- */

  let session: { el: HTMLElement; original: string; stop: () => void } | null = null
  // The element and pre-edit text of the session that ended most recently, kept so the parent can
  // `revert` an edit it refused. The frame ends a session on its own keystrokes and reports the text
  // afterwards, so by the time the parent decides the value is unwritable there is no open session
  // left to cancel — and the rejected text would otherwise stay on screen until something unrelated
  // reloaded the slide (round-4 major). Cleared once used, and by the next `begin`.
  let lastEnded: { el: HTMLElement; original: string } | null = null

  /** Whether this element can host a caret: character-data children only, unlocked, editable tag. */
  const isFrameEditable = (el: Element): boolean => {
    if (NOT_EDITABLE[tag(el)]) return false
    if (el.getAttribute(LOCK_ATTR) !== null) return false
    const kids = el.childNodes
    for (let i = 0; i < kids.length; i++) {
      // 3 === Node.TEXT_NODE. Anything else means mixed content, which M3.11 does not edit.
      if (kids[i]!.nodeType !== 3) return false
    }
    return true
  }

  /** End the open session. `restore` puts the pre-edit text back. Returns the resulting text. */
  const endEdit = (restore: boolean): string => {
    const open = session
    if (!open) return ''
    session = null
    lastEnded = { el: open.el, original: open.original }
    open.stop()
    if (restore) open.el.textContent = open.original
    open.el.removeAttribute(EDIT_ATTR)
    open.el.removeAttribute('spellcheck')
    return open.el.textContent ?? ''
  }

  const selectAllOf = (el: Element): void => {
    const selection = win.getSelection()
    if (!selection) return
    const range = doc.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const beginEdit = (slId: string) => {
    const node = doc.querySelector('[' + ID_ATTR + '="' + slId + '"]')
    if (!node) return null
    if (session) endEdit(false)
    lastEnded = null
    if (!isFrameEditable(node)) return { slId, text: node.textContent ?? '', editing: false }

    const el = node as HTMLElement
    const original = el.textContent ?? ''

    // `plaintext-only` is the load-bearing choice: Chromium's editing engine then refuses to insert
    // elements at all, so rich paste, drag-and-drop and execCommand styling cannot introduce markup.
    // The `true` fallback is for engines that ignore it; the paste/drop guards and the `textContent`
    // read below keep even that path plain.
    el.setAttribute(EDIT_ATTR, 'plaintext-only')
    if (!el.isContentEditable) el.setAttribute(EDIT_ATTR, 'true')
    el.setAttribute('spellcheck', 'false')

    const finish = (reason: string): void => {
      // Escape *commits* and returns to selection, matching §9.3 ("on blur/Esc the frame returns
      // the element's content") and PowerPoint, where Esc leaves the text and selects the shape.
      // Undo is the cancel path, and a whole typing burst is exactly one undo entry.
      const text = endEdit(false)
      send({
        __sl: MAGIC,
        v: VERSION,
        id: 0,
        dir: 'evt',
        type: TYPE_EDIT,
        slide: mySlide,
        payload: { slId, text, reason },
      })
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        // Always commit, never a newline: a raw newline in a text node renders as a space, and a
        // `<br>` would be markup this element's byte-span text model cannot represent. See the
        // Enter semantics note in useTextEditing.ts.
        event.preventDefault()
        finish('enter')
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        finish('escape')
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        finish('tab')
        return
      }
      // Keep the slide's own key handlers out of a text edit.
      event.stopPropagation()
    }

    // Insert `text` at the caret as a **text node**, so a paste can never contribute markup even if
    // `plaintext-only` is not honoured.
    const insertPlain = (text: string): void => {
      const selection = win.getSelection()
      if (!selection || selection.rangeCount === 0) {
        el.textContent = (el.textContent ?? '') + text
        return
      }
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const inserted = doc.createTextNode(text)
      range.insertNode(inserted)
      range.setStartAfter(inserted)
      range.setEndAfter(inserted)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    const onPaste = (event: ClipboardEvent): void => {
      // Plain text only, explicitly — never rely on `plaintext-only` alone. `getData('text/plain')`
      // is the only channel read, so a clipboard carrying `text/html` contributes nothing.
      event.preventDefault()
      const clip = event.clipboardData
      const text = clip ? clip.getData('text/plain') : ''
      if (text) insertPlain(text)
    }

    const onDrop = (event: Event): void => {
      // A drop can carry `text/html`. Refusing outright is simpler than sanitizing it.
      event.preventDefault()
    }

    const onBlur = (): void => {
      finish('blur')
    }

    // Keep the "frozen frame" property (§2.1) for the rest of the slide while a caret is open: the
    // element being edited gets real pointer events, everything else has its handlers suppressed.
    const onDocPointer = (event: Event): void => {
      const target = event.target as Node | null
      if (target && el.contains(target)) return
      event.stopPropagation()
    }

    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('paste', onPaste)
    el.addEventListener('drop', onDrop)
    el.addEventListener('dragover', onDrop)
    el.addEventListener('blur', onBlur)
    doc.addEventListener('mousedown', onDocPointer, true)
    doc.addEventListener('click', onDocPointer, true)

    session = {
      el,
      original,
      stop: () => {
        el.removeEventListener('keydown', onKeyDown)
        el.removeEventListener('paste', onPaste)
        el.removeEventListener('drop', onDrop)
        el.removeEventListener('dragover', onDrop)
        el.removeEventListener('blur', onBlur)
        doc.removeEventListener('mousedown', onDocPointer, true)
        doc.removeEventListener('click', onDocPointer, true)
      },
    }

    el.focus()
    // Select the whole value so typing replaces it — the common case for a title or label. The
    // frame is interactive during a session, so a second click places the caret precisely.
    selectAllOf(el)
    return { slId, text: original, editing: true }
  }

  /**
   * Put the element the last session edited back to the text it began with. Only for that element,
   * only once, and only while it is still in the document — anything else and the frame answers with
   * what is actually there rather than writing over an element the parent may no longer mean.
   */
  const revertEdit = (slId: string) => {
    const last = lastEnded
    lastEnded = null
    if (!last || last.el.getAttribute(ID_ATTR) !== slId || !doc.contains(last.el)) return null
    last.el.textContent = last.original
    return { slId, text: last.original, editing: false }
  }

  /** Apply an `SL_EDIT` request and describe the resulting state. */
  const applyEdit = (slId: string, action: string) => {
    if (action === 'begin') return beginEdit(slId)
    if (action === 'revert') return revertEdit(slId)
    const open = session
    // A commit/cancel/undo/redo for an element that is not the open session must not touch the
    // document.
    if (!open || open.el.getAttribute(ID_ATTR) !== slId) {
      const node = doc.querySelector('[' + ID_ATTR + '="' + slId + '"]')
      if (!node) return null
      return { slId, text: node.textContent ?? '', editing: false }
    }
    if (action === 'undo' || action === 'redo') {
      // The field's own undo. In Electron the Edit menu owns Ctrl/⌘+Z, so the chord never reaches
      // this document as a keystroke; the parent forwards it here instead, and Blink's editing
      // command steps the editing host's undo stack exactly as the keystroke would have.
      doc.execCommand(action)
      return { slId, text: open.el.textContent ?? '', editing: true }
    }
    return { slId, text: endEdit(action === 'cancel'), editing: false }
  }

  win.addEventListener('message', (event: MessageEvent) => {
    // Source identity is the whole authentication: reject anything not from the trusted parent.
    if (event.source !== parentWin) return
    const data = event.data as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return
    if (data['__sl'] !== MAGIC || data['v'] !== VERSION) return
    if (data['dir'] !== 'req') return
    if (data['slide'] !== mySlide) return
    const p = data['payload'] as Record<string, unknown> | null
    if (!p || typeof p !== 'object') return

    if (data['type'] === TYPE_HITTEST) {
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
      return
    }

    if (data['type'] === TYPE_INSPECT) {
      if (typeof p['slId'] !== 'string') return
      send({
        __sl: MAGIC,
        v: VERSION,
        id: data['id'],
        dir: 'res',
        type: TYPE_INSPECT,
        slide: mySlide,
        payload: inspectId(p['slId']),
      })
      return
    }

    if (data['type'] === TYPE_ELEMENTS) {
      send({
        __sl: MAGIC,
        v: VERSION,
        id: data['id'],
        dir: 'res',
        type: TYPE_ELEMENTS,
        slide: mySlide,
        payload: allElements(),
      })
      return
    }

    if (data['type'] === TYPE_EDIT) {
      if (typeof p['slId'] !== 'string') return
      const action = p['action']
      if (
        action !== 'begin' &&
        action !== 'commit' &&
        action !== 'cancel' &&
        action !== 'revert' &&
        action !== 'undo' &&
        action !== 'redo'
      ) {
        return
      }
      send({
        __sl: MAGIC,
        v: VERSION,
        id: data['id'],
        dir: 'res',
        type: TYPE_EDIT,
        slide: mySlide,
        payload: applyEdit(p['slId'], action),
      })
    }
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
