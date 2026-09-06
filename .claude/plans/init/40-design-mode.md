# 40 — Design Mode

Design Mode is Sloodge's direct-manipulation layer: click an element on a rendered slide,
see it outlined, edit it instantly through a local property panel (zero LLM), or hand it to
the agent as precise context. It is the feature that makes HTML slides feel like PowerPoint
instead of like a text editor with a preview pane.

The architecture below is the synthesis from [research/design-mode-tools.md](research/design-mode-tools.md) §7,
adapted to one constraint that research doc flagged but did not resolve: **our slides render in
a `sandbox="allow-scripts"` iframe** (overview decision #3). That iframe is opaque-origin, so
the overlay in the renderer *cannot* touch `iframe.contentDocument`. Every DOM read and write
crosses a `postMessage` bridge. Designing that bridge well is the core of this document.

---

## 0. Design goals & non-goals

**Goals**
1. Selecting and editing an element is instant and free — never an LLM round-trip for a
   parametric change (v0's lesson).
2. Every edit — local or AI — lands as a **patch to the slide's original HTML source bytes**,
   never a re-serialization of the DOM. Formatting, comments, and whitespace survive.
3. Every edit — local or AI — is **exactly one undoable command** on the deck's undo stack.
4. AI edits pass through an **accept/reject diff gate** before touching saved source
   (Onlook's lesson). Local edits do not.
5. The selection engine is a **library** (`@sloodge/design-core`), not UI code — reused by the
   property panel, the AI context bundler, and (later) headless tests.

**Non-goals for v1**
- Multi-select relational edits ("make this match that"). Protocol reserves room; UI does not ship.
- Editing inside `<canvas>`/WebGL content. Not addressable; treated as an opaque leaf.
- Round-tripping arbitrary user JS that mutates the DOM at runtime (see §9.2).

---

## 1. Stable IDs and byte-span source mapping

### 1.1 The `data-sl-id` contract

Every element in a slide's rendered HTML carries `data-sl-id="<slideId>:<n>"`, where `n` is the
element's **document order index in the original source**, assigned by a single parse pass.
IDs are:

- **Stable across reloads** of unedited source (same parse → same indices).
- **Stable across a local edit** that only changes attribute values or text (span lengths shift;
  indices do not).
- **Invalidated by structural edits** (insert/delete/move an element) — after any structural
  change, the slide is re-parsed and IDs are reassigned. The selection is re-resolved by
  *path* rather than id across a reparse (see §1.5).

`data-sl-id` is **injection-only**: it lives in the HTML handed to the iframe, never in the
`.sloodge` file on disk. The saved source stays clean and portable — important because slides
are exportable standalone HTML.

### 1.2 The parse pass (`parse5` with location info)

```ts
// packages/design-core/src/map.ts
import { parse } from 'parse5';

export interface ElementSpan {
  slId: string;              // "s04:37"
  tagName: string;
  /** span of the whole element incl. tags, in the ORIGINAL source */
  outer: { start: number; end: number };
  /** span between > and </tag — null for void elements */
  inner: { start: number; end: number } | null;
  /** per-attribute spans; name span + value span (value span excludes quotes) */
  attrs: Record<string, { name: Span; value: Span | null; whole: Span }>;
  /** insertion point for a NEW attribute: just after the tag name */
  attrInsert: number;
  parentSlId: string | null;
  childSlIds: string[];
  /** structural path from root, e.g. [1,0,3] — used to re-resolve across reparse */
  path: number[];
  /** true if the element's only children are text nodes */
  textOnly: boolean;
  ns: 'html' | 'svg' | 'mathml';
}

export interface SlideMap {
  slideId: string;
  sourceHash: string;         // sha256 of original source; guards stale patches
  source: string;             // the ORIGINAL bytes, untouched
  byId: Map<string, ElementSpan>;
  order: string[];            // document order
}
```

`parse5.parse(src, { sourceCodeLocationInfo: true })` gives us, per element node,
`sourceCodeLocation` with `startOffset`, `endOffset`, `startTag`, `endTag`, and
`attrs[name] = {startOffset, endOffset, startLine, startCol}`. That is everything the table
above needs; deriving `inner` is `startTag.endOffset → (endTag?.startOffset ?? endOffset)`.

Two parse5 quirks we must handle explicitly:

- **Implied elements.** `parse5` inserts `<html>/<head>/<body>` even when absent, and those
  synthetic nodes have `sourceCodeLocation === null`. Elements with a null location get **no
  `data-sl-id`** and are marked non-selectable; hit-testing walks past them to the nearest
  mapped ancestor.
- **Attribute name case & namespaces.** parse5 lowercases HTML attribute names but preserves
  SVG camelCase (`viewBox`, `gradientUnits`). We key `attrs` by the *source-cased* name and
  match case-insensitively only in the HTML namespace.

### 1.3 Injection — rendering the instrumented document

We never re-serialize the parse5 tree (that would normalize quotes, reorder attributes, drop
comments). Instead we build the instrumented HTML by **splicing** `data-sl-id` strings into a
copy of the original source, right-to-left so earlier offsets stay valid:

```
original:      <div class="title">Q3</div>
                   ^ attrInsert = 4
instrumented:  <div data-sl-id="s04:12" class="title">Q3</div>
```

Right-to-left splicing means a single pass, no offset bookkeeping, and the map's offsets keep
referring to the **original** source — which is exactly what patches operate on.

> **Implementation note (M3.1).** `src/shared/design/instrument.ts` keeps the property this
> paragraph is after — offsets always refer to the original source — but gets it a different way:
> insertions are sorted *ascending* and the output is assembled from source slices in one pass,
> joined once. Right-to-left splicing rebuilds the whole document per insertion, which is
> O(elements × length): 20.4s on a 525KB / 30k-element slide, against M8's sub-100ms goal. Chunked
> assembly is byte-identical (asserted over the corpus) at ~12ms, and it never mutates the source
> at all, so no offset can go stale in the first place.
>
> Two further M3.1 findings that belong with §1.2's parse pass:
>
> - `sourceCodeLocation.attrs` keys are **lowercased in every namespace**, SVG included — the
>   camelCase `viewBox` survives only on `node.attrs`. The map keys attributes by the lowercased
>   name and keeps the source casing alongside, rather than keying by source-cased name as §1.2
>   describes.
> - The adoption agency **clones** mis-nested formatting elements and parse5 copies the original's
>   `sourceCodeLocation` onto each clone, so one physical start tag can back several tree
>   elements. Element identity is therefore the start-tag offset, not the tree node: the first
>   claimant in tree order is addressable and later ones are treated like implied elements. This
>   matters for §1.1's "document order index" — the index counts *source* elements.

The instrumented document also gets, injected just before `</body>`:
- `<script>` — the **agent script** (§2.2), the in-frame half of the bridge.
- `<style>` — the in-frame highlight styles for hover/selection *fallback* (see §3.3 note).

Both carry `data-sl-ignore` so they can never be selected, and both are stripped from any
export path.

### 1.4 Patching — the write-back primitive

All writes funnel through one function. It takes span-anchored operations against the
**original** source, sorts them descending by offset, asserts non-overlap, and splices:

```ts
type SourceOp =
  | { kind: 'replaceSpan'; span: Span; text: string }     // attr value, text content
  | { kind: 'insertAt'; at: number; text: string }         // new attribute
  | { kind: 'deleteSpan'; span: Span };                    // remove attribute

function applyOps(map: SlideMap, ops: SourceOp[]): { source: string } // throws on overlap
```

Derived helpers used by the property panel:

| Helper | Behaviour |
|---|---|
| `setAttr(slId, name, value)` | If attr exists → `replaceSpan(attrs[name].value)`. If it exists but is valueless (`hidden`) → `replaceSpan(attrs[name].whole, 'name="v"')`. If absent → `insertAt(attrInsert, ' name="v"')`. |
| `removeAttr(slId, name)` | `deleteSpan` over `whole` plus the single leading space. |
| `setStyleProp(slId, prop, value)` | Read `attrs.style.value`, parse as a declaration list **preserving order and unknown props**, upsert `prop`, re-emit, `setAttr`. Never touches other declarations. |
| `textContentOp(element, text)` (`text-edit.ts`) | Only valid when `textOnly`; `replaceSpan(inner, escapeAndNeutralizeText(text))`, or no op when the decoded text is unchanged. `text` is the **decoded** string (what `ElementSpan.textContent` reads), for the caret and the panel's Content field alike — shipped as `setTextContent(escapeText)` in M3.3, unified with the caret's write in M3.12 after the panel was found double-escaping. |
| `replaceOuter(slId, html)` | `replaceSpan(outer, html)` — the AI path's primitive; forces reparse. |

`escapeText` escapes `&` and `<` only (and `>` after `]]`), matching what a browser needs — we
deliberately do not entity-encode non-ASCII, so a user typing "Café" keeps "Café" in source.

**Staleness guard.** Every patch carries the `sourceHash` it was computed against. If the
current slide source's hash differs, the patch is rejected and the caller re-resolves. This is
what makes concurrent AI edits and local edits safe without a lock.

### 1.5 Re-resolving selection across a reparse

After a structural edit, indices shift. The selection survives via `path`: before applying the
patch we record the selected element's `path` (child-index chain from the document root,
counting only element nodes). After reparse, we look up by path; if the path no longer resolves
(the element was deleted), we walk up the path prefix until something resolves and select that
ancestor, flashing the breadcrumb to signal the fallback.

---

## 2. Overlay architecture

### 2.1 The layer stack

The slide iframe is sandboxed and opaque-origin. The overlay therefore lives entirely in the
**renderer**, positioned over the iframe in the same coordinate space, and gets all its DOM
knowledge from the bridge.

```
┌──────────────────────────── Renderer (React, chrome) ─────────────────────────────┐
│                                                                                   │
│  ┌──── #canvas-stage ─────────────────────────────────────────────────────────┐   │
│  │  position:relative; transform: scale(z)   (z = fit-to-pane zoom factor)    │   │
│  │                                                                            │   │
│  │  ┌── <iframe id="slide-frame"> ────────────────────────────────────────┐   │   │
│  │  │  sandbox="allow-scripts"  srcdoc=<instrumented HTML>                │   │   │
│  │  │  width=1280 height=720   (never scaled internally; stage scales it) │   │   │
│  │  │                                                                     │   │   │
│  │  │      [ slide content ]        + injected agent script (§2.2)        │   │   │
│  │  └─────────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                            │   │
│  │  ┌── <div id="overlay">  position:absolute; inset:0 ───────────────────┐   │   │
│  │  │  DESIGN MODE ON  → pointer-events: auto   (swallows all pointer     │   │   │
│  │  │                     events; iframe never sees them)                 │   │   │
│  │  │  DESIGN MODE OFF → pointer-events: none   (slide is interactive)    │   │   │
│  │  │                                                                     │   │   │
│  │  │   ┌ hover-outline ┐   ┌ selection-box + 8 handles ┐   ┌ margin/pad ┐│   │   │
│  │  │   └ (1px dashed)  ┘   └ (2px solid + squares)     ┘   └ (tinted)   ┘│   │   │
│  │  └─────────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                            │   │
│  │  ┌── breadcrumb bar (bottom-left of stage, above overlay) ─────────────┐   │   │
│  │  │  body › section.slide › div.chart › svg › g.bars › rect       [×]   │   │   │
│  │  └─────────────────────────────────────────────────────────────────────┘   │   │
│  └────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                   │
│  ┌── property panel (right dock, replaces/stacks with chat) ───────────────────┐  │
│  └─────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────┘
                                     ▲   │
                       SL_* messages │   │ postMessage(msg, '*')  [origin 'null']
                                     │   ▼
                          window.parent ⇄ iframe.contentWindow
```

**Key consequence of overlay-swallows-events:** in Design Mode the slide's own JS and CSS
`:hover` never fire. That is intentional — it is the "frozen frame" property Cursor gets from
draw-to-select, for free. Toggling Design Mode off restores full interactivity (needed for
testing an interactive chart). `Present` always forces Design Mode off.

### 2.2 The in-frame agent script

~6 KB of vanilla JS injected into every slide in the editor (never in export or Present). It is
the only code that can read the slide DOM. Responsibilities:

1. Hit-test on demand (`elementFromPoint` / `elementsFromPoint`).
2. Report geometry (`getBoundingClientRect`, box model, transform matrix).
3. Report computed styles (a **whitelisted subset**, not the full 340-property dump).
4. Apply optimistic DOM mutations for instant feedback (before the source patch lands).
5. Emit `SL_READY`, `SL_RESIZE`, `SL_ERROR`.

It holds **no state that matters** — the renderer is the source of truth. If the frame reloads,
the renderer re-sends selection by `data-sl-id`.

Everything it can be asked to do is enumerated by the protocol below; there is no `eval`-style
escape hatch. The frame is sandboxed and hostile-input-tolerant by construction. The renderer
**validates `event.source === iframe.contentWindow`** (it cannot validate `event.origin`, which is
`"null"` for sandboxed frames) and rejects anything whose shape doesn't match the schema.

**The precise trust boundary — do not overstate it.** Source-identity proves a message came from
*this frame's window* rather than from some other window. It does **not**, and cannot, distinguish
the injected bridge script from the slide's own untrusted author JS: both run in the same realm
(`iframe.contentWindow`), so their messages carry the identical `event.source`. Shape validation
only rejects *malformed* messages. Therefore a **well-formed** bridge response forged by co-resident
author code — which knows its own slide id, can read request ids via its own `message` listener, and
can pre-empt the real bridge — passes both checks and reaches the parent. An earlier draft of this
section claimed the source check stops a slide spoofing bridge messages; that is false and was
corrected here (M3.2 review). A frame → parent response is an **untrusted hint about the slide's own
view state**, not an authenticated fact.

This is safe in M3.2 only because of *what the parent does with a hit*: it drives ephemeral,
re-validatable selection state (`setHover`/`setSelection`), renders the payload as escaped text with
finite-validated geometry, and sends nothing frame-ward but `x`/`y`/`mode`/`alt` — no escalation, no
exfiltration.

**Normative rule for any feature that acts authoritatively on a bridge message** (edit-on-select,
apply-patch — M3.5+): it MUST NOT trust the message payload. It re-derives from **parent-held state**
— the `sl-id → span` map the renderer already owns — treating the message as at most "the user
gestured near sl-id X", and routes any resulting change to saved source through the accept/reject
diff gate (§6.5), which requires a human keystroke. These two together bound a co-resident
confused-deputy to, at worst, redirecting a *human-confirmed* edit onto a neighbouring element,
which the diff preview then shows and the user can reject.

**If a *silent, trusted* frame → parent signal is ever genuinely required** (one the parent must act
on without a human in the loop and cannot re-derive itself — e.g. a geometry fact only
`elementFromPoint` inside the frame can produce, feeding an automatic action), the enforceable
design is a **MessageChannel-capture handshake**, and it has one hard prerequisite:

- The bridge must be **the first script to run in the frame's realm**, so it captures native
  `MessageChannel`/`postMessage`/`addEventListener` before author code can monkeypatch or race them.
  It then creates a `MessageChannel`, keeps `port1` in a closure author code cannot reach, and
  transfers `port2` out to the parent inside its first `postMessage` (an *outgoing* transfer author
  code cannot intercept). The parent thereafter sends and receives bridge traffic only on that port
  and ignores `window` `message` events for the bridge, so an author `window.parent.postMessage`
  reaches nothing the parent listens on, and author code never obtains a port reference.
- **M3.2 does not meet the prerequisite:** the bridge is injected immediately before `</body>`, and
  the slide contract puts the author's single `<script>` as the last body element, so *author runs
  first*. Building the channel therefore also requires moving the bridge to run first (into `<head>`
  or as the first body child) and re-verifying that the move preserves M3.1 byte-span integrity and
  `wrapSlideHtml`'s constant-length prefix. That is a focused change belonging to the milestone that
  first needs a trusted silent signal; it is deliberately **not** half-built in M3.2, where the
  untrusted-hint model above is sufficient and the diff-gate is the real backstop.

---

## 3. The postMessage bridge protocol

### 3.1 Envelope

```ts
interface SlEnvelope<T = unknown> {
  __sl: 1;                 // magic; anything without it is ignored
  v: 1;                    // protocol version
  id: number;              // monotonic; requests carry it, responses echo it
  dir: 'req' | 'res' | 'evt';
  type: string;            // 'SL_HITTEST' etc.
  slide: string;           // slideId — guards against a stale frame answering
  payload: T;
}
```

Request/response is promisified in the renderer with a 250 ms timeout; a timeout marks the
frame unhealthy and triggers a reload. Events are fire-and-forget.

### 3.2 Message catalogue

```
 RENDERER (parent)                                    IFRAME (agent script)
 ─────────────────                                    ─────────────────────

                          ◀── evt  SL_READY ────────  { w, h, docTitle, mappedCount }
                                                       (frame booted, listeners armed)

 ─── req SL_HITTEST ──▶                                pointer moved / clicked
     { x, y,                                           x,y are FRAME coords
       stack: false }                                  (parent divides by zoom first)
                          ◀── res  SL_HITTEST ───────  { slId, path, rect, tag,
                                                         classes, ancestors[] }
                                                       ancestors = breadcrumb chain,
                                                       nearest-first, each
                                                       {slId, tag, id, classes, rect}

 ─── req SL_MEASURE ──▶                                after scroll/resize/anim frame
     { slIds: [...] }
                          ◀── res  SL_MEASURE ───────  { rects: {slId: DOMRectLike},
                                                         box:  {slId: BoxModel} }
                                                       BoxModel = margin/border/
                                                       padding/content rects

 ─── req SL_INSPECT ──▶                                on selection
     { slId }
                          ◀── res  SL_INSPECT ───────  { slId, outerHTML, innerText,
                                                         computed: {…whitelist},
                                                         rect, box, matrix,
                                                         ns, textOnly, editableText,
                                                         isPositioned, parentRect }

 ─── req SL_PREVIEW ──▶                                live drag / slider scrub
     { ops: [{slId, kind:'style',                      OPTIMISTIC ONLY — never
              prop, value}                             persisted; cleared by the
             |{slId, kind:'text', value}] }            next SL_RELOAD
                          ◀── res  SL_PREVIEW ───────  { ok, rects: {...} }

 ─── req SL_REVERT ───▶                                drag cancelled (Esc)
     { slIds }                                         drops all optimistic ops
                          ◀── res  SL_REVERT ────────  { ok }

 ─── req SL_SHOT ─────▶                                AI context bundle
     { slId, pad: 24 }                                 frame has no html2canvas;
                          ◀── res  SL_SHOT ─────────   { rect }   ← geometry only
                                                       (the actual pixels come from
                                                        main-process capture, §6.2)

 ─── req SL_FREEZE ───▶                                animated slides
     { on: true }                                      pauses CSS anims + SMIL:
                          ◀── res  SL_FREEZE ───────   { ok }     document.getAnimations()
                                                                  .forEach(a=>a.pause())
                                                                  svg.pauseAnimations()

 ─── req SL_SCROLLTO ─▶                                breadcrumb navigation
     { slId }
                          ◀── res  SL_SCROLLTO ─────   { rect }

                          ◀── evt  SL_RESIZE ───────   { slId, rect }
                                                       ResizeObserver on selected el
                          ◀── evt  SL_ERROR ────────   { message, stack? }
                                                       window.onerror in the slide
```

`SL_RELOAD` is not a message — reloading is the parent replacing `srcdoc`, followed by a fresh
`SL_READY`.

### 3.3 Why hover uses `SL_HITTEST` and not an in-frame outline

An alternative design draws the hover outline *inside* the frame (the agent script owns a
highlight div). That is fewer round-trips, but the outline then scales with the stage zoom,
sits under the slide's own z-indexed content, and can be styled/clobbered by slide CSS. We draw
in the renderer instead and accept the round-trip. The round-trip is cheap because:

- `mousemove` is **rAF-throttled and coalesced** — at most one in-flight `SL_HITTEST`; newer
  positions replace the queued one.
- The response carries the full ancestor chain, so breadcrumb hovering needs no extra calls.
- A **rect cache** keyed by `slId` serves re-renders; it is invalidated on `SL_RESIZE`,
  stage zoom change, and any `SL_PREVIEW`.

Measured budget: hover feedback must land within one frame at 60 Hz for a static slide. If
`SL_HITTEST` p95 exceeds ~8 ms we fall back to in-frame outlining (kept behind a flag).

### 3.4 Coordinate translation

The stage applies `transform: scale(z)`; the iframe is always a true 1280×720 box.

```
frameX = (clientX - stageRect.left) / z
frameY = (clientY - stageRect.top)  / z          // → send to SL_HITTEST

overlayX = frameRect.x * z          // rect from frame → overlay px
overlayW = frameRect.width * z
```

The overlay is a child of the *scaled* stage, so in practice we place it **inside** the scaled
container and use raw frame coordinates directly — the browser applies `z` for us. The only
things that must be un-scaled are stroke widths and handle sizes, done with
`transform: scale(1/z)` on the handle elements so borders stay 1 px and grips stay 8 px at any
zoom.

---

## 4. Selection UI

### 4.1 States

| State | Visual | Trigger |
|---|---|---|
| Idle | nothing | Design Mode on, pointer outside stage |
| Hover | 1 px dashed accent outline + tag chip (`div.title`) at top-left, offset outward | `mousemove` → `SL_HITTEST` |
| Selected | 2 px solid outline + 8 square handles + dimension badge (`320 × 84`) | click |
| Selected + spacing | above, plus translucent padding (green) / margin (orange) bands | hold `Alt` |
| Editing text | outline turns to a text caret frame; in-frame `contenteditable` on | double-click or `Enter` |
| AI pending | outline turns dashed violet, "reviewing" chip | agent proposed a patch for this element |

### 4.2 Traversal & keyboard

| Key | Action |
|---|---|
| `Esc` | deselect → exit text editing → exit Design Mode (three-stage) |
| `↑` / `Escape`-less parent | select parent (`SL_HITTEST` ancestors chain, already cached) |
| `↓` | select first child |
| `←` / `→` | previous / next sibling |
| `Enter` | enter text editing if `editableText` |
| `Tab` | next element in document order |
| arrows (with selection, not editing) | nudge 1 px; `Shift` → 10 px (§5) |
| `Alt`-click | select the *deepest* node under cursor, bypassing the "grabbable" filter |
| `Cmd/Ctrl+D` | toggle Design Mode |

**Shipped as of M3.11** (the rest of this table is planned, not contracted): `Esc`, `Enter`/`F2`,
`Alt`-click and `Cmd/Ctrl+D`. Arrow traversal (parent/child/sibling) and `Tab` traversal are not
implemented. `Esc` ships as **two** stages, not three — deselect, then close a text-edit session —
and stage three (exit Design Mode) is deliberately deferred: with Design Mode on by default (M3.11)
an `Esc` that turned it off would leave the user in the inert, click-does-nothing state the M3.11
default exists to eliminate, one keystroke from a gesture they meant as "cancel". `Cmd/Ctrl+D` and
the toolbar toggle remain the deliberate ways out. See `useDeselectKey.ts`.

### 4.3 The grabbable filter

Plain `elementFromPoint` returns the deepest node, which is often a layout-only `<span>` or a
`<tspan>`. Following react-grab's `isElementGrabbable`, the agent script climbs from the hit
node to the **first sensible selection target**:

```
climb while ANY of:
  - node has [data-sl-ignore] or is our own injected script/style      → skip entirely
  - node has no data-sl-id (synthetic/implied)                          → go to parent
  - node is a bare inline wrapper (<span>/<b>/<i>/<em>/<a>) whose text  → go to parent
    equals its parent's text and which has no own class/style
  - node is a <tspan>/<textPath> inside <text>                          → go to <text>
  - node rect is 0×0                                                    → go to parent
stop at <body>; never select <html>/<head>/<body> themselves
```

`Alt`-click disables the climb, so power users can still reach a `<tspan>`.

### 4.4 Breadcrumb

Rendered in the renderer from the `ancestors[]` array in the last `SL_HITTEST`/`SL_INSPECT`
response. Each crumb shows `tag#id.first-class`, truncated with a middle ellipsis; hovering a
crumb previews that ancestor's outline (no round trip — rects came with the response); clicking
selects it. The rightmost crumb is the current selection. Overflow collapses from the left into
a `…` menu.

```
 body › section.slide › div.chart-wrap › svg#rev › g.bars › rect
 └─ click any crumb to select ─┘   └ hover shows its outline ┘
```

---

## 5. Local property panel (zero LLM)

The whole point (v0's lesson): **parametric edits never call a model.** The panel binds to the
`SL_INSPECT` computed-style whitelist, writes optimistically via `SL_PREVIEW`, and commits a
source patch through `setStyleProp`/`setAttr`/`textContentOp`.

### 5.1 Sections

```
┌─ PROPERTIES ──────────── rect  (svg) ─┐
│ CONTENT                               │   only when textOnly
│  [ Q3 Revenue                      ]  │   → textContentOp (decoded text in, escaped bytes out)
│                                       │
│ TEXT                                  │   only when the element renders text
│  Font   [Inter          ▾]            │   font-family
│  Size   [ 44 ]px  Weight [700 ▾]      │   font-size, font-weight
│  Line   [1.15]    Spacing [ 0  ]      │   line-height, letter-spacing
│  Color  [■ #0F172A]                   │   color
│  Align  [≡ ≡ ≡ ≡]                     │   text-align
│  Style  [B] [I] [U]                   │   font-weight/font-style/text-decoration
│                                       │
│ POSITION & SIZE                       │
│  X [ 120 ]  Y [ 88  ]                 │   translate()  — see 5.3
│  W [ 320 ]  H [ 84  ]  [🔗 lock AR]   │   width/height
│  Rotate [ 0 ]°   Opacity [100]%       │   rotate() / opacity
│                                       │
│ SPACING                    [Alt view] │
│  padding  T[16] R[24] B[16] L[24]     │   padding-*
│  margin   T[ 0] R[ 0] B[24] L[ 0]     │   margin-*
│  gap      [ 12 ]                      │   gap (only if display:flex|grid)
│                                       │
│ APPEARANCE                            │
│  Fill    [■ #FFFFFF]  (bg / SVG fill) │   background-color | fill
│  Stroke  [■ #94A3B8]  W[ 2 ]          │   border-color/width | stroke/stroke-width
│  Radius  [ 12 ]px                     │   border-radius | rx (SVG rect)
│  Shadow  [ none        ▾]             │   box-shadow preset list
│                                       │
│ ┌───────────────────────────────────┐ │
│ │  ✨ Ask AI about this element      │ │  → §6
│ └───────────────────────────────────┘ │
└───────────────────────────────────────┘
```

### 5.2 SVG vs HTML property mapping

The panel is **namespace-aware** (`ns` from `SL_INSPECT`). The same UI row writes different
targets:

| Panel row | HTML element | SVG element |
|---|---|---|
| Fill | `style: background-color` | `fill` **presentation attribute** if one exists in source, else `style: fill` |
| Stroke | `style: border-color` + `border-style: solid` | `stroke` attr / `style: stroke` |
| Stroke width | `style: border-width` | `stroke-width` |
| Radius | `style: border-radius` | `rx`/`ry` attrs on `<rect>`; disabled on other shapes |
| W / H | `style: width/height` | `width`/`height` attrs on `<rect>`/`<image>`; `r` on `<circle>`; **disabled** on `<path>` (see §9.1) |
| X / Y | see 5.3 | `x`/`y` attrs, or `transform="translate()"` |
| Opacity | `style: opacity` | `opacity` |

**Rule: prefer the channel the source already uses.** If the source says `fill="#e11d48"`, we
patch that attribute. If it says `style="fill:#e11d48"`, we patch the declaration. If neither
exists we add an inline `style` declaration (never a new class — we have no stylesheet-ownership
story, and inline style always wins the cascade, which is what a user nudging a value expects).

### 5.3 Position: transform-first

Slide elements come in two flavours. The panel detects which from `isPositioned` +
computed `position`:

- **Absolutely positioned** (`position: absolute|fixed`, the common case for generated slides):
  X/Y write `left`/`top` when those already exist in source; otherwise write
  `transform: translate(Xpx, Ypx)`.
- **In flow** (a paragraph inside a stack): X/Y write `transform: translate(...)` **only**, so
  the element visually moves without disturbing sibling layout. The panel shows a small
  "offset" badge to make clear this is a nudge, not a layout change.

Transform is stored as a **canonical ordered string** we own end-to-end:
`translate(Xpx, Ypx) rotate(Rdeg) scale(S)` — we parse the existing transform, replace only the
function we're editing, and re-emit in that order. Any transform function we don't recognise is
preserved and appended verbatim after ours.

### 5.4 Edit lifecycle (the fast path)

```
 user drags "font size" slider
     │
     ├─ each frame:  SL_PREVIEW {slId, style:'font-size', value:'46px'}   ← optimistic, in-frame
     │               overlay re-measures from the returned rects
     │
     └─ on release (or 400 ms debounce for typed input):
            setStyleProp(slId, 'font-size', '46px')
              → SourceOp[] → applyOps() → new source
              → UndoStack.push(EditCommand)          ← ONE command (§7)
              → slide source updated in the store
              → srcdoc replaced  →  SL_READY  →  re-select by slId
```

The reload is a full `srcdoc` swap. For a 1280×720 self-contained document this is sub-16 ms in
practice; we still avoid it during the drag (that's what `SL_PREVIEW` is for) and coalesce it
with the debounce. If a slide is measured slow to reload (heavy JS, big inline data), we mark
it and extend the debounce to 800 ms.

### 5.5 Drag-to-move and resize

Handles are 8 px squares at corners + edge midpoints, drawn in the overlay, unscaled.

```
        nw ■──────────■ n ──────────■ ne
           │                        │
         w ■      selected el       ■ e        drag body  → move
           │                        │          drag corner→ resize (Shift = keep AR)
        sw ■──────────■ s ──────────■ se       drag edge  → resize one axis
                                               Alt        → resize about centre
```

**Move semantics**
1. `pointerdown` on the selection body records `startFrame = {x,y}` and the element's current
   translate/left-top.
2. `pointermove` (rAF-throttled) sends `SL_PREVIEW` with the new transform. Snapping applies
   before the message: 8 px snap to slide centre lines, slide edges, and the bounding edges +
   centres of *siblings* (rects fetched once per drag via a single `SL_MEASURE` on the parent's
   children). Guide lines are drawn in the overlay.
3. `Shift` constrains to the dominant axis. Arrow keys do 1 px / `Shift` 10 px discrete moves,
   each of which is its own preview+commit but **coalesced into one undo command** if within
   600 ms of the previous nudge (§7.2).
4. `pointerup` → commit; `Esc` mid-drag → `SL_REVERT`, no command pushed.

**Resize semantics** depend on what the element is:

| Element kind | Resize writes |
|---|---|
| Absolutely positioned block | `width`/`height` (and `left`/`top` for nw/n/w handles) |
| SVG `<rect>`/`<image>` | `width`/`height` attrs (+ `x`/`y`) |
| SVG `<circle>`/`<ellipse>` | `r` / `rx`,`ry` |
| Text element | **width only** by default; height is content-driven. Dragging a vertical handle instead adjusts `font-size` proportionally, with a modifier hint in the badge. |
| In-flow block | `width`/`height` if they were already set; otherwise `scale()` in the transform, with a "scaled" badge |
| Arbitrary `<path>`, `<g>` | `transform: scale()` about the element's own bbox centre — never geometry rewriting (§9.1) |

Aspect-ratio lock is on by default for images and SVG shapes with intrinsic ratio; off for
boxes.

---

## 6. AI edit path

Local panel covers parametric edits. Everything semantic ("make this chart pop", "rewrite this
bullet to be punchier", "match the style of the title on slide 2") goes to the agent — with the
selection attached as a rich, multi-channel context bundle (Cursor's lesson).

### 6.1 Entry points

- `✨ Ask AI about this element` in the property panel → focuses the chat with a selection chip.
- With an element selected, typing in the chat automatically attaches the chip (dismissible).
- Right-click → "Ask AI about this…".

The chat input shows the attachment as a removable chip:
`[ ▣ rect.bar in slide 4 · 320×84 ]`

### 6.2 The context bundle

Assembled entirely in the renderer/main; **no LLM call to build it.**

```jsonc
{
  "kind": "sloodge.element-selection",
  "slide":  { "id": "s04", "index": 3, "title": "Q3 Revenue", "size": [1280, 720] },
  "element": {
    "slId": "s04:37",
    "sourceSpan": { "start": 1842, "end": 1971, "line": 41, "col": 7 },
    "outerHTML": "<rect class=\"bar\" x=\"40\" y=\"120\" width=\"48\" height=\"180\" fill=\"#38bdf8\"/>",
    "ancestorPath": "body > section.slide > div.chart-wrap > svg#rev > g.bars > rect.bar",
    "ns": "svg",
    "boundingBox": { "x": 168, "y": 244, "w": 48, "h": 180 },   // frame coords
    "computed": { /* whitelist: ~30 props, only non-default values */ },
    "siblingSummary": "5 sibling <rect.bar> elements, x = 40|108|176|244|312"
  },
  "context": {
    "parentOuterHTMLTruncated": "<g class=\"bars\"> …6 children… </g>",
    "screenshot":      "data:image/png;base64,…",  // element crop + 24px padding
    "slideScreenshot": "data:image/png;base64,…",  // full 1280×720, frozen at request time
    "theme": { /* §6.3 */ }
  },
  "request": "make the bars a gradient and round the tops"
}
```

**Screenshots.** The frame is sandboxed, so we cannot rasterize from inside it. Capture happens
in the **main process** via `webContents.capturePage(rect)` on the window, translating frame
coords → window coords → device pixels. The slide is `SL_FREEZE`d immediately before capture
and unfrozen after, so animated slides yield a stable frame — and that *same* frozen PNG is what
travels with the request even if the slide has since moved on (Cursor's frozen-frame lesson).
Crop images are downscaled so the long edge ≤ 768 px; the full-slide shot ≤ 1280 px.

**Computed-style whitelist** (the only styles ever sent — full dumps are token-expensive and
mostly noise):

```
display position inset(top right bottom left) width height
font-family font-size font-weight font-style line-height letter-spacing
color background-color background-image opacity
text-align text-transform text-decoration white-space
margin-* padding-* gap flex-direction align-items justify-content
border-* border-radius box-shadow transform transform-origin overflow z-index
fill stroke stroke-width stroke-linecap paint-order
```

Values equal to the browser default are dropped before serialization.

### 6.3 Deck theme

Every request carries the deck's theme so the agent stays consistent with the other slides
rather than inventing a fifth blue. Extracted from the deck manifest (design tokens declared at
deck creation) plus a cheap static scan of the deck's slides:

```jsonc
"theme": {
  "palette":   ["#0F172A","#38BDF8","#F472B6","#FACC15","#F8FAFC"],
  "fonts":     { "display": "Inter", "body": "Inter", "mono": "JetBrains Mono" },
  "scale":     { "h1": 64, "h2": 44, "body": 24, "caption": 18 },
  "radius":    12,
  "cssVars":   { "--sl-accent": "#38BDF8", "--sl-bg": "#0F172A" },
  "slideSize": [1280, 720]
}
```

### 6.4 Agent contract — patch, not file

The agent must return a **targeted patch**, not a rewritten slide. Enforced by the MCP tool
surface (detailed in 50-agent-integration.md); Design Mode consumes one shape:

```ts
interface ElementPatch {
  slideId: string;
  sourceHash: string;               // must match, else rejected & retried
  edits: Array<
    | { op: 'replaceOuter'; slId: string; html: string }
    | { op: 'setAttr';      slId: string; name: string; value: string }
    | { op: 'removeAttr';   slId: string; name: string }
    | { op: 'setText';      slId: string; text: string }
    | { op: 'insertAdjacent'; slId: string;
        where: 'beforebegin'|'afterbegin'|'beforeend'|'afterend'; html: string }
    | { op: 'remove';       slId: string }
  >;
  rationale: string;                // one line, shown in the diff gate header
}
```

Because the agent works in `data-sl-id` terms, it never has to reason about byte offsets, and we
never have to trust a model-produced offset. The `slId` → span lookup is ours.

**Validation before the gate:** every `slId` must exist in the current map; inserted HTML is
parsed with parse5 and rejected if it is not well-formed, contains `<script>` when the original
element subtree had none, or references an external URL not already present in the deck. Failed
validation is reported back to the agent as a tool error for one retry.

### 6.5 The accept/reject diff gate

No AI edit ever reaches saved source without a human keystroke (Onlook's lesson).

```
┌── canvas ────────────────────────────────────────────────────────────────────┐
│                                                                              │
│      [ slide rendered WITH the proposed patch applied — live preview ]        │
│      selected element outlined dashed violet                                  │
│                                                                              │
│  ┌── review bar (floating, bottom-centre) ─────────────────────────────────┐ │
│  │  ✨ "Gradient fill + rounded bar tops"        [Before|After] [ Diff ▾ ]  │ │
│  │                                    [ Reject  Esc ]  [ Accept  ⏎ ]       │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘

  Diff ▾ expands an inline unified diff of the affected source spans only:

    slide-04.html
    @@ 41,3 +41,4 @@
    -  <rect class="bar" x="40" y="120" width="48" height="180" fill="#38bdf8"/>
    +  <rect class="bar" x="40" y="120" width="48" height="180" rx="6"
    +        fill="url(#barGrad)"/>
```

- **Preview is a shadow source.** We compute `patchedSource = applyOps(map, patchOps)` and render
  that in the frame. The store's committed source is untouched until Accept.
- **Before/After** toggles `srcdoc` between the two; hold `B` for a momentary peek.
- **Accept** commits `patchedSource`, pushes one `AiEditCommand` (§7), and reparses.
- **Reject** restores the committed source and reports the rejection to the agent turn so it can
  offer an alternative rather than assuming success.
- **Multi-slide patches** (agent touched three slides) show a per-slide accordion in the diff
  panel with per-slide accept; partial accept is allowed and commits as one command.
- Gate is modal over Design Mode: selection changes are disabled while pending. `Esc` rejects.

**Auto-accept.** A setting exists (default **off**) to skip the gate for edits confined to a
single element's attributes. Never available for `insertAdjacent`/`remove`/multi-slide.

---

## 7. Undo integration

### 7.1 One edit = one command

Design Mode never manipulates the store directly. It emits commands onto the deck-level undo
stack shared with chat edits, slide reordering, etc. (defined in 10-architecture.md).

```ts
interface SlideSourceCommand {
  kind: 'design.local' | 'design.ai' | 'design.drag' | 'design.text';
  label: string;                 // "Font size 44 → 46", "AI: gradient bars"
  slideId: string;
  before: { source: string; hash: string };
  after:  { source: string; hash: string };
  selectionBefore: string | null;   // slId
  selectionAfter:  string | null;
  ts: number;
}
```

We store **full before/after source strings**, not the ops. A slide is ~4–40 KB; a 200-deep
stack is a few MB and buys perfect fidelity with zero inverse-op logic. Undo = write `before`,
reparse, restore `selectionBefore`, reload frame. Redo = the mirror. Because reparse follows
every undo, `data-sl-id`s stay consistent with whatever source is live.

### 7.2 Coalescing

Commands merge when all hold: same `kind`, same `slideId`, same `slId`, same property, and
`ts` gap < 600 ms. This makes:
- a slider drag → **one** command (the intermediate `SL_PREVIEW`s never touch the stack at all),
- a run of arrow-key nudges → one command,
- typing into a text field → one command per pause, not per character.

The merge rewrites the top command's `after` only; `before` is preserved from the first.

### 7.3 Interaction with in-flight AI

An AI turn may be streaming while the user makes a local edit. Rules:
- Local edits commit immediately; they bump `sourceHash`.
- When the AI patch arrives with a now-stale hash, the gate opens in **"rebase" mode**: we
  re-resolve every `slId` against the current map. If all resolve, we apply and show the diff
  against current source. If any fail, we show "the slide changed while I was working" and offer
  Retry (re-runs the turn with a refreshed bundle) or Discard.
- Accepting an AI patch while a text edit is open first commits the text edit — two commands,
  in order.

### 7.4 Undo across the diff gate

A pending gate is **not** on the undo stack. `Cmd/Ctrl+Z` while the gate is open rejects the
patch (equivalent to `Esc`) rather than undoing the previous command — matching the mental model
that the preview isn't real yet.

---

## 8. Module layout

```
packages/design-core/          # pure, no React, no Electron — unit-testable
  map.ts                       # parse5 → SlideMap; instrument(); reparse()
  patch.ts                     # SourceOp, applyOps, setAttr/setStyleProp (text writes: text-edit.ts)
  style.ts                     # declaration-list parser, transform parser, unit handling
  grabbable.ts                 # selection climb rules (mirrored in the frame script)
  context.ts                   # buildContextBundle()
  protocol.ts                  # SlEnvelope types + runtime validators (shared with frame)

packages/design-frame/         # the injected agent script; builds to a single IIFE string
  index.ts                     # message loop, hit-test, measure, inspect, preview, freeze

apps/desktop/src/renderer/design/
  useBridge.ts                 # promisified postMessage client, timeouts, health
  useSelection.ts              # selection state machine, keyboard traversal
  Overlay.tsx                  # outline, handles, guides, badges
  Breadcrumb.tsx
  PropertyPanel/*.tsx
  DiffGate.tsx
```

`grabbable.ts` rules are authored once and **bundled into the frame script** at build time, so
the renderer and the frame can never disagree about what is selectable.

---

## 9. Edge cases

### 9.1 Elements inside SVG

- **Coordinate spaces.** `getBoundingClientRect()` on an SVG child already returns *screen*
  coordinates through the full `viewBox`/`transform` chain — so hover/selection outlines are
  correct for free. But **editing** `x`/`y`/`width` is in *user units*, not pixels. The frame
  reports `matrix = el.getScreenCTM()`; the panel converts panel-pixels → user units via its
  inverse. A 10 px drag on a `viewBox="0 0 640 360"` SVG displayed at 1280 px wide writes 5
  user units.
- **`<path>`, `<polygon>`, `<g>`.** We never rewrite path `d` data. Move/resize writes
  `transform` on the element instead, with origin set to the element's own bbox centre
  (`transform-box: fill-box; transform-origin: center`) so scaling feels natural. The panel
  shows a "transform" badge so the user knows geometry wasn't touched.
- **`<use>` and `<symbol>`.** Selectable but flagged *instanced*: the panel disables geometry
  fields and shows "this is a reference to `#id`; edit the definition instead", with a link that
  selects the referenced `<symbol>`/`<defs>` node.
- **`<defs>`, gradients, filters.** Zero-size and never hit-testable. Reachable only via
  breadcrumb from a referencing element (Fill row shows `url(#barGrad) →` as a jump link).
- **Presentation attribute vs CSS.** SVG presentation attributes are the *lowest* cascade layer,
  so an existing `style="fill:red"` beats `fill="blue"`. The panel reads `computed` (the truth)
  but writes to whichever channel the source uses (§5.2), and warns if it detects that the
  channel it would write to is being overridden by a higher-priority one.
- **Nested `<svg>`** and `foreignObject`: crossing back into the HTML namespace mid-tree is
  handled by per-element `ns`, not per-document.

### 9.2 Animated elements

- **Selection on a moving target.** With Design Mode on, the overlay swallows pointer events but
  CSS/SMIL animations keep running, so a bar could slide out from under the outline. On selection
  we auto-issue `SL_FREEZE` (Web Animations `pause()` + `SVGSVGElement.pauseAnimations()`), and
  show a small "⏸ animation paused" chip with a play toggle. Deselecting resumes.
- **Frozen state is never persisted.** Freeze only pauses timelines; it never writes
  `animation-play-state` into source.
- **Inline-style clobbering.** A slide's own JS may write `el.style.transform` every frame. If
  the user edits `transform` on such an element, our source patch is immediately overwritten
  visually. Detection: after a commit + reload, the frame re-reads the property and compares; a
  mismatch emits a warning chip — *"this element is animated by the slide's script; your change
  is in the source but the script overrides it at runtime"* — with a "select the script" action.
- **Keyframe-driven properties.** If the edited property is a target of an `@keyframes` rule
  (detected by scanning the slide's stylesheet text for the property inside a keyframe block
  matching the element's `animation-name`), the panel labels the field "animated" and suggests
  the AI path instead, since editing a static value is futile.
- **Screenshot capture** always freezes first (§6.2).

### 9.3 Text spanning inline tags

`textContentOp` is only offered when `textOnly` — every child is a text node. For
`<p>Revenue rose <b>18%</b> in Q3</p>`:

- The **Content** field is replaced by a read-only preview plus an **"Edit text"** button that
  enters in-frame rich text editing: the agent script sets `contenteditable="true"` on the
  element and the overlay switches to caret mode (pointer events pass through to the frame *only
  for this element*, via a hole punched in the overlay at its rect).
- On blur/`Esc`, the frame returns the element's `innerHTML`. We normalize it (strip
  `contenteditable`, drop `<br>`-only trailing noise, unwrap `<font>`/`<span style>` that the
  browser's editing engine may have introduced, map `<b>/<i>` back to whatever tags the original
  used) and commit as a single `replaceSpan(inner, normalizedHTML)` — one `design.text` command.
- **Formatting toolbar** (the top ribbon's text tab) acts on the current selection range inside
  the frame via `document.execCommand`-equivalents implemented in the agent script
  (`bold`/`italic`/`underline` → wrap/unwrap the range in the deck's canonical tags). Every
  toolbar action is one command.
- Selecting an inline child directly (`Alt`-click a `<b>`) gives a panel scoped to that child —
  font/color edits write to the `<b>`'s own style, which is usually what the user meant.
- **Structural IDs are invalidated** by any rich-text commit (inline tags may be added/removed),
  so a reparse always follows; selection is restored by path (§1.5).

**Shipped as of M3.11** (this section is still planned, not contracted): none of it. M3.11's caret
writes a `textOnly` element's text-node span and can therefore never introduce markup, so mixed
inline content is **refused** rather than edited as plain text — replacing the content above as text
would silently delete the `<b>`. What M3.11 does add is that the refusal is *visible*: a double-click
on such an element raises the overlay's `role="status"` notice saying the element has formatting
inside it, instead of doing nothing at all (round-5). The rich-text path here, which returns
`innerHTML` — the payload §2.2 forbids acting on authoritatively — needs its own milestone to
reconcile the two. The read-only preview and "Edit text" button are not implemented; the panel's
Content field is simply disabled, with a hint explaining why.

### 9.4 Other edges

| Case | Handling |
|---|---|
| `<canvas>` / WebGL | Selectable as a leaf; only position/size/opacity enabled; content edits routed to AI. |
| `<iframe>` inside a slide | Blocked at the slide-contract level (30-slide-format.md); if present, treated as opaque leaf. |
| Element with `pointer-events: none` | Unreachable by `elementFromPoint`. The frame retries the hit-test with `elementsFromPoint` and offers the stack in a disambiguation popover on `Alt`-click. |
| Zero-size / `display:none` | Not hit-testable; reachable only via breadcrumb or keyboard traversal. Panel shows "hidden" and enables `display`. |
| Pseudo-elements (`::before`) | Not selectable, not addressable. Panel surfaces a read-only "has ::before content" note. |
| Shadow DOM in slide JS | Out of contract for v1; hit-test stops at the host. |
| Duplicate `slId` after a bad patch | `applyOps` asserts uniqueness at reparse; a duplicate aborts the patch and surfaces an error rather than corrupting the map. |
| Frame crash / script error | `SL_ERROR` → banner + "reload slide"; Design Mode degrades to read-only until a `SL_READY`. |
| Bridge timeout | 3 consecutive timeouts → frame reload; 3 reload failures → Design Mode disabled for that slide with a diagnostic. |
| Very large slides (>500 elements) | `SL_MEASURE` batches capped at 200 ids; sibling-snap rects fetched lazily per drag. |

**Shipped as of M3.11**, two edges this table did not anticipate, both about an open caret:

- **Leaving Design Mode with a caret open commits it.** The toggle, `Ctrl/⌘+D` and Present all
  unmount the overlay, taking the bridge listener with it in the same commit, so the frame's
  `SL_EDIT` reaches nobody and the typed text was silently discarded (round-7). The session is now
  finished on a channel that outlives the overlay — `PinnedEdit.finish` in `useDesignBridge.ts` —
  and the text lands as one ordinary undo entry. That guarantee is a bound, not an absolute, and the
  bound is worth writing down: turning Design Mode off also re-navigates the stage iframe to a fresh
  `slide://` document — measured at **+28 ms after the click**, and it happens even when nothing was
  edited — so `finish` is only ever answered by a document that is about to be torn down, and its
  generous `FINISH_TIMEOUT_MS` buys nothing once it has been. Stalling the slide frame's main thread
  across the toggle in the built app, the text commits at 0/50/100/200/400 ms of stall and is **lost
  at 800 ms**: no commit, the frame reverted, nothing said. Ordinary interaction does not reach it —
  the slide's own JS has to stall for about a second at the instant of the toggle, and ~130 real
  sessions across the toggle, Present, `Enter`, `Esc`, `Tab` and blur never lost text — and it fails
  safe, leaving the document untouched. **Closed in M3.13** by deferring the re-navigation:
  `setEnabled(false)` raises `designStore.finishing` in the same update that removes the overlay,
  `SlideCanvas` keeps the instrumented document for as long as it is set, and the `finish` callback
  clears it — so the caret's document stays until it has answered or `FINISH_TIMEOUT_MS` has
  passed, and the swap to the raw document happens once, on settle. The other half offered
  (capturing `contentWindow` at pin time) was not taken: a WindowProxy keeps its identity across
  navigations, so it cannot tell the documents apart and does nothing about a document torn down
  before its stalled script can answer. A frame that still does not answer within the timeout is
  now announced ("didn’t answer in time … wasn’t saved") instead of reverted in silence.
- **Quitting with a caret open still loses it.** Nothing commits or cancels an open session on app
  quit or window close: typing deliberately never touches the store (`useTextEditing.ts`), so the
  characters live only in the frame's DOM until the session ends. This is consistent with the app
  having no unsaved-changes prompt at all today, and is not specific to M3.11 — but when a
  dirty-state or save-prompt milestone lands it must treat `designStore.editing` as a second source
  of unsaved state alongside the deck history, not just prompt on the document.

---

## 10. Testing hooks

- `design-core` is pure: golden-file tests for `instrument()` (byte-exact output for a corpus of
  slides incl. SVG, comments, weird quoting) and property-based tests for `applyOps`
  (random op sets never corrupt, always reparse to the same tree modulo the edit).
- The frame script is testable in jsdom-less isolation by driving `postMessage` against a real
  Chromium page in Playwright; the protocol validators are shared, so contract drift fails a
  unit test.
- Visual tests: select → edit → screenshot compare, per property row.
- A `--design-trace` flag logs every envelope to disk for replaying user sessions in bug reports.

---

## 11. Open questions

1. **Class-based edits.** v0 maps panel edits onto Tailwind utilities. Our slides use inline
   styles and a small `<style>` block. Should a panel edit that matches a deck token
   (`--sl-accent`) write the token reference instead of a literal? Leaning yes for colors in v2.
2. **Multi-select.** Protocol supports `slIds[]` everywhere already; the question is panel
   semantics for mixed values (show "Mixed", write to all). Deferred past v1.
3. **In-frame vs renderer outlining.** Decided renderer-side (§3.3) but flagged for a perf
   revisit once we measure `SL_HITTEST` latency on animation-heavy slides.
4. **Style-block editing.** Editing a `<style>` rule (rather than an element) has no natural
   selection target. Candidate: select an element → "edit the rule that sets this" → jump to the
   rule's span. Needs a CSS parser with location info (`postcss`) — deferred.
