# Sloodge — Slide Format: the `.sloodge` document & slide HTML contract

> Defines the on-disk document model, the HTML contract every slide must satisfy, theming,
> versioning/migration, and the machine-checkable validation rules. Derived from
> [00-overview.md](00-overview.md), [research/slides-export-electron.md](research/slides-export-electron.md),
> [research/design-mode-tools.md](research/design-mode-tools.md) and the three frozen skills in
> [`experiments/init/skills/`](../../../experiments/init/skills/) (`slide-deck`, `svg-animation`,
> `interactive-graph`) — those skills ARE the proven contract; this doc formalizes and extends them.

---

## 1. Decision: `.sloodge` is a ZIP container

**Chosen: a ZIP archive with a `manifest.json` + one HTML file per slide + a theme + an assets dir.**
File extension `.sloodge`, MIME `application/vnd.sloodge.deck+zip`, magic bytes `PK\x03\x04`.

### Why ZIP-of-files, not a single JSON blob

| Criterion | ZIP + files (chosen) | Single JSON with embedded HTML strings |
|---|---|---|
| Design Mode byte-span patching | Slide HTML is a real UTF-8 text file — `parse5` location info maps 1:1 to file offsets; patch exact spans (Onlook lesson, §7.1 of design-mode research) | HTML lives as a JSON-escaped string; every patch needs escape/unescape round-trips, offsets drift |
| Agent SDK ergonomics | Agent gets `Read`/`Write`/`Edit` on plain `.html` files in a temp workdir — zero custom tooling, skills work verbatim | Agent must call bespoke MCP tools for every read/write; skills would need rewriting |
| Diffability / recovery | Individual slides recoverable with any unzip tool if the deck is corrupted | One bad byte can kill the whole document |
| Export | `printToPDF` / `capturePage` load slide files directly | Must materialize temp files anyway |
| Size | Deflate compresses HTML/SVG ~5–8× | Base64'd binary assets inflate JSON ~33% |

Rejected alternatives: **single self-contained HTML** (can't hold speaker notes/metadata cleanly, and
one giant file defeats per-slide byte-span patching); **directory-on-disk, no zip** (kept as an
*escape hatch* — see §1.3 — but a single file is what users expect to double-click and email);
**SQLite** (opaque to the agent, overkill for ≤200 slides).

### 1.1 Archive layout

```
deck.sloodge (zip, deflate; mimetype entry STORED first, OPC-style)
├── mimetype                     # "application/vnd.sloodge.deck+zip", stored uncompressed, no EOL
├── manifest.json                # the document model — single source of truth for order & metadata
├── theme/
│   ├── theme.json               # design tokens (semantic → value)
│   └── theme.css                # generated: :root{--sl-*} custom properties (derived from theme.json)
├── slides/
│   ├── s_01H8X....html          # one self-contained 1280x720 document per slide, named by slide id
│   └── s_01H8Y....html
├── notes/
│   └── s_01H8X....md            # speaker notes, markdown, one per slide (optional; absent = no notes)
├── assets/                      # rare — only for user-imported binaries too big to inline
│   └── a_01H8Z....png
└── thumbs/                      # cache, regenerable, excluded from dirty-checks
    └── s_01H8X....webp          # 320x180 rail thumbnail
```

Rules:
- **Everything is UTF-8, LF line endings.** Zip entry names are forward-slash, no leading `/`, no `..`.
- **`manifest.json` is authoritative for slide ORDER.** Filenames are ids, not positions — reordering
  a deck rewrites only `manifest.json`, never renames files (keeps undo/redo and git-style diffs sane).
- **`thumbs/` and any unknown top-level dir are non-authoritative** — a reader may drop them; a writer
  must preserve unknown entries it did not author (forward-compat, see §5.3).
- Zip is written atomically: build to `deck.sloodge.tmp` in the same directory, `fsync`, then rename.

### 1.2 Slide ids

`s_` + [ULID](https://github.com/ulid/spec) (26 chars, Crockford base32, lexicographically sortable by
creation time). Example `s_01H8XQZ4P7K2M9NB3VYRTC6FDA`. Ids are **immutable for the life of the slide**
— duplicating a slide mints a new id; reordering never changes ids. Asset ids use `a_` + ULID, theme
`t_` + ULID.

### 1.3 Unpacked working directory (runtime, not a format)

While a deck is open, Sloodge extracts it to
`app.getPath('userData')/workspaces/<deckId>/` with the identical layout. The Agent SDK, Design Mode's
byte-span patcher, and the export pipeline all operate on that directory; saving re-zips it. A crash
leaves the workspace on disk → recovery prompt on next launch. Power users can `File ▸ Save as Folder`
to keep the unpacked form permanently (`deck.sloodge.d/`), which Sloodge opens transparently.

---

## 2. `manifest.json`

### 2.1 Example

```json
{
  "$schema": "https://sloodge.app/schema/deck-1.json",
  "formatVersion": 1,
  "id": "d_01H8XQZ4P7K2M9NB3VYRTC6FDA",
  "title": "Q3 Revenue Review",
  "subtitle": "Board deck — October 2026",
  "authors": ["baochidangg@gmail.com"],
  "createdAt": "2026-07-31T09:14:02.116Z",
  "updatedAt": "2026-07-31T11:02:44.900Z",
  "generator": { "app": "sloodge", "version": "0.4.1" },
  "canvas": { "width": 1280, "height": 720 },
  "theme": "theme/theme.json",
  "slideOrder": [
    "s_01H8XQZ4P7K2M9NB3VYRTC6FDA",
    "s_01H8XR0M5S8T1WQZ9C4XKB7GEH"
  ],
  "slides": {
    "s_01H8XQZ4P7K2M9NB3VYRTC6FDA": {
      "id": "s_01H8XQZ4P7K2M9NB3VYRTC6FDA",
      "file": "slides/s_01H8XQZ4P7K2M9NB3VYRTC6FDA.html",
      "title": "Q3 Revenue Review",
      "kind": "title",
      "capabilities": ["static"],
      "notes": "notes/s_01H8XQZ4P7K2M9NB3VYRTC6FDA.md",
      "thumb": "thumbs/s_01H8XQZ4P7K2M9NB3VYRTC6FDA.webp",
      "createdAt": "2026-07-31T09:14:02.116Z",
      "updatedAt": "2026-07-31T09:31:10.004Z",
      "origin": { "type": "agent", "skill": "slide-deck", "sessionId": "as_01H8..." },
      "validation": {
        "status": "pass",
        "checkedAt": "2026-07-31T09:31:12.220Z",
        "contentHash": "sha256:3f9a…",
        "issues": []
      },
      "hidden": false,
      "transition": "fade",
      "advance": { "mode": "manual" }
    },
    "s_01H8XR0M5S8T1WQZ9C4XKB7GEH": {
      "id": "s_01H8XR0M5S8T1WQZ9C4XKB7GEH",
      "file": "slides/s_01H8XR0M5S8T1WQZ9C4XKB7GEH.html",
      "title": "Revenue by quarter",
      "kind": "chart",
      "capabilities": ["interactive-js"],
      "notes": "notes/s_01H8XR0M5S8T1WQZ9C4XKB7GEH.md",
      "thumb": "thumbs/s_01H8XR0M5S8T1WQZ9C4XKB7GEH.webp",
      "createdAt": "2026-07-31T09:20:41.310Z",
      "updatedAt": "2026-07-31T11:02:44.900Z",
      "origin": { "type": "agent", "skill": "interactive-graph", "sessionId": "as_01H8..." },
      "validation": { "status": "warn", "checkedAt": "2026-07-31T11:02:46.100Z",
                      "contentHash": "sha256:aa71…",
                      "issues": [{ "rule": "SL-C07", "severity": "warn",
                                   "message": "axis label font-size 15px < 16px minimum",
                                   "selector": "[data-sl-id=\"e_0f3\"]" }] },
      "hidden": false,
      "transition": "none",
      "advance": { "mode": "manual" }
    }
  },
  "assets": {},
  "presentation": { "defaultTransition": "fade", "loop": false, "showSlideNumbers": true }
}
```

### 2.2 JSON Schema (`deck-1.json`, abridged to the load-bearing parts)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://sloodge.app/schema/deck-1.json",
  "title": "Sloodge deck manifest v1",
  "type": "object",
  "required": ["formatVersion", "id", "title", "canvas", "slideOrder", "slides"],
  "additionalProperties": true,
  "properties": {
    "formatVersion": { "const": 1 },
    "id":       { "type": "string", "pattern": "^d_[0-9A-HJKMNP-TV-Z]{26}$" },
    "title":    { "type": "string", "minLength": 1, "maxLength": 200 },
    "subtitle": { "type": "string", "maxLength": 300 },
    "authors":  { "type": "array", "items": { "type": "string" } },
    "createdAt": { "type": "string", "format": "date-time" },
    "updatedAt": { "type": "string", "format": "date-time" },
    "generator": {
      "type": "object",
      "required": ["app", "version"],
      "properties": { "app": { "type": "string" }, "version": { "type": "string" } }
    },
    "canvas": {
      "type": "object", "required": ["width", "height"],
      "properties": { "width": { "const": 1280 }, "height": { "const": 720 } },
      "description": "v1 is fixed 1280x720; the object exists so v2 can relax it."
    },
    "theme": { "type": "string", "default": "theme/theme.json" },
    "slideOrder": {
      "type": "array", "minItems": 0,
      "items": { "$ref": "#/$defs/slideId" },
      "description": "Authoritative presentation order. Must be a permutation of Object.keys(slides)."
    },
    "slides": {
      "type": "object",
      "propertyNames": { "$ref": "#/$defs/slideId" },
      "additionalProperties": { "$ref": "#/$defs/slide" }
    },
    "assets": {
      "type": "object",
      "additionalProperties": {
        "type": "object", "required": ["file", "mime"],
        "properties": {
          "file": { "type": "string" }, "mime": { "type": "string" },
          "bytes": { "type": "integer", "minimum": 0 },
          "sha256": { "type": "string" }
        }
      }
    },
    "presentation": {
      "type": "object",
      "properties": {
        "defaultTransition": { "$ref": "#/$defs/transition" },
        "loop": { "type": "boolean", "default": false },
        "showSlideNumbers": { "type": "boolean", "default": true }
      }
    }
  },
  "$defs": {
    "slideId": { "type": "string", "pattern": "^s_[0-9A-HJKMNP-TV-Z]{26}$" },
    "transition": { "enum": ["none", "fade", "slide-left", "slide-right", "zoom"] },
    "slide": {
      "type": "object",
      "required": ["id", "file", "title"],
      "additionalProperties": true,
      "properties": {
        "id":    { "$ref": "#/$defs/slideId" },
        "file":  { "type": "string", "pattern": "^slides/s_[0-9A-HJKMNP-TV-Z]{26}\\.html$" },
        "title": { "type": "string", "maxLength": 200,
                   "description": "Human label for the rail/outline; NOT necessarily the on-slide heading." },
        "kind":  { "enum": ["title", "content", "comparison", "chart", "animation", "section", "blank", "custom"],
                   "default": "content" },
        "capabilities": {
          "type": "array", "uniqueItems": true,
          "items": { "enum": ["static", "css-animation", "smil-animation", "interactive-js"] },
          "description": "Declared by the generator; validated by the linter. Drives export behavior (animated/interactive slides raster-export at final frame) and Present-mode reload policy."
        },
        "notes": { "type": "string", "pattern": "^notes/s_[0-9A-HJKMNP-TV-Z]{26}\\.md$" },
        "thumb": { "type": "string" },
        "createdAt": { "type": "string", "format": "date-time" },
        "updatedAt": { "type": "string", "format": "date-time" },
        "origin": {
          "type": "object",
          "properties": {
            "type": { "enum": ["agent", "user", "import", "template"] },
            "skill": { "enum": ["slide-deck", "svg-animation", "interactive-graph"] },
            "sessionId": { "type": "string" },
            "prompt": { "type": "string", "maxLength": 4000 }
          }
        },
        "validation": { "$ref": "#/$defs/validation" },
        "hidden": { "type": "boolean", "default": false,
                    "description": "Skipped in Present and exports; still visible in the rail (dimmed)." },
        "transition": { "$ref": "#/$defs/transition" },
        "advance": {
          "type": "object",
          "properties": {
            "mode": { "enum": ["manual", "auto"], "default": "manual" },
            "afterMs": { "type": "integer", "minimum": 250, "maximum": 600000 }
          }
        }
      }
    },
    "validation": {
      "type": "object",
      "required": ["status"],
      "properties": {
        "status": { "enum": ["pass", "warn", "fail", "unknown"] },
        "checkedAt": { "type": "string", "format": "date-time" },
        "contentHash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$",
                         "description": "Hash of the slide HTML at check time; a mismatch means the cached result is stale." },
        "issues": {
          "type": "array",
          "items": {
            "type": "object", "required": ["rule", "severity", "message"],
            "properties": {
              "rule": { "type": "string", "pattern": "^SL-[A-Z]\\d{2}$" },
              "severity": { "enum": ["error", "warn", "info"] },
              "message": { "type": "string" },
              "selector": { "type": "string", "description": "CSS selector, normally [data-sl-id=\"…\"]" },
              "line": { "type": "integer", "minimum": 1 }
            }
          }
        }
      }
    }
  }
}
```

**Cross-field invariants** (checked on load, not expressible in JSON Schema):
1. `slideOrder` is a permutation of `Object.keys(slides)` — no dupes, no orphans.
2. For every slide, `slides[k].id === k` and `slides[k].file` exists in the archive.
3. Every `notes`/`thumb`/`assets[*].file` path referenced exists (missing `thumb` is a warning → regenerate;
   missing `file` or `notes` is an error → repair by creating an empty slide/notes file and flagging).
4. No zip entry escapes the archive root (`..`, absolute paths, symlinks → reject the file outright).

### 2.3 Speaker notes

Notes live in `notes/<slideId>.md`, **not** inline in the manifest: they are user prose that can run long,
they are edited in a text pane (markdown), and keeping them as files means the agent can read/write them
with the same file tools it uses for slides. Empty/absent file = no notes. Notes are CommonMark, rendered
read-only in Presenter View and passed to `slide.addNotes()` on PPTX export and to a `showNotes` page on
PDF export.

---

## 3. The slide HTML contract

Every file in `slides/` is a **complete, standalone HTML document** that renders identically when opened
in a bare browser, in Sloodge's sandboxed iframe, and in the export renderer. This is the contract the
three skills already enforce; the rules below are its normative form, each with a lint rule id (§6).

### 3.1 Skeleton (canonical form emitted by the agent and by "New Slide")

```html
<!doctype html>
<html lang="en" data-sl-slide="s_01H8XQZ4P7K2M9NB3VYRTC6FDA" data-sl-contract="1">
<head>
<meta charset="utf-8">
<title>Q3 Revenue Review</title>
<style>
  :root{
    --sl-bg:#0d1220; --sl-fg:#f0f0f5; --sl-accent:#4c8dff; --sl-muted:#9aa4b8;
    --sl-font:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    --sl-radius:14px; --sl-pad:48px;
  }                                   /* theme tokens: inlined copy of theme/theme.css (§4) */
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--sl-bg)}
  .slide{
    width:1280px;height:720px;overflow:hidden;position:relative;
    box-sizing:border-box;padding:var(--sl-pad);
    background:var(--sl-bg);color:var(--sl-fg);font-family:var(--sl-font);
  }
  /* slide-specific CSS below */
</style>
</head>
<body>
<div class="slide" data-sl-id="e_root">
  <h1 data-sl-id="e_001" style="font-size:76px;font-weight:700;line-height:1.15">Q3 Revenue Review</h1>
  <p  data-sl-id="e_002" style="font-size:28px;color:var(--sl-muted)">Board deck — October 2026</p>
</div>
<!-- optional: <script> … </script> as the LAST element in body -->
</body>
</html>
```

### 3.2 Normative rules

**Geometry (SL-G\*)**
- Root element is `<div class="slide">` at **exactly 1280×720**, `overflow:hidden`, `position:relative`,
  `box-sizing:border-box`.
- `html,body{margin:0;padding:0}` and the universal `box-sizing` reset are mandatory.
- Zero page scroll: `documentElement.scrollWidth <= 1280 && scrollHeight <= 720`.
- Minimum 48px inset on the root; absolutely-positioned footers/motifs may sit inside it.
- No `position:fixed` (breaks under Chromium's print pass), no `vh`/`vw` units (they resolve against the
  iframe viewport, not the slide box — use px).

**Self-containment (SL-S\*)**
- **Zero external subresources.** No off-document reference from any referencing element or
  attribute: `<link>` of *any* `rel` (incl. `imagesrcset`), `<script src>`, `<iframe src>`,
  `<video src|poster>`, `<audio src>`, `<source src>`, `<object data>`, `<embed src>`, `<track src>`,
  `<input src>` (type=image), any `srcset` candidate, an SVG `<use href|xlink:href>` pointing
  off-document, `<img src>`/`<image href>` outside the document, the obsolete presentational
  `background=` attribute, plus `url(http…)`/`//` and `@import` in CSS. Permitted targets are inline
  payloads (`data:`, `blob:`, `sloodge-asset:`) and same-document `#` fragments (e.g.
  `<use href="#gradient">`) — including inside `srcset`, which is parsed per the HTML srcset grammar
  so a `data:` candidate's internal commas are not misread as candidate separators. Raster images, if
  truly needed, are `data:` URIs (or `assets/` entries inlined at load time — see §3.5). **SL-S01 is
  checked on the parsed HTML tree, not by regex**, so attribute order, casing, whitespace and entity
  encoding cannot evade it. It rejects subresources *declared in the markup*; a script that
  reconstructs a fetch at runtime is stopped by the `slide://` CSP (`connect-src 'none'`), the
  load-bearing second layer.
- No network at runtime: `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`navigator.sendBeacon` are
  forbidden and blocked by CSP anyway.
- No storage APIs (`localStorage`, `indexedDB`, cookies) — slides must be stateless across reloads.
- Fonts: the system stack `-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif` only. Rationale:
  PPTX embeds font *references* by name (research §2.1), so system fonts survive export; web fonts don't.

**Sandbox posture (SL-S05)** — the host renders slides with
`<iframe sandbox="allow-scripts" csp="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'none'; connect-src 'none'">` and **never** `allow-same-origin`,
`allow-top-navigation`, `allow-popups`, `allow-modals`, `allow-forms`. The slide must therefore work with
no same-origin privileges. `alert`/`confirm`/`prompt` are no-ops in that sandbox — forbidden.

**Animation (SL-A\*)** — from `svg-animation`
- CSS `@keyframes` or SMIL (`<animate>`, `<animateMotion>`, `<animateTransform>`); JS/rAF only when
  CSS/SMIL cannot express the timing.
- Starts immediately on load; loops forever (`animation-iteration-count:infinite` /
  `repeatCount="indefinite"`). No click-to-start. `fill="freeze"` forbidden unless part of a restarting
  `begin="0s; last.end"` chain.
- Animate only `transform`/`opacity`/SMIL motion — never layout properties.
- Moving elements stay inside 1280×720 for the entire cycle.
- Slides declaring animation must set `capabilities: ["css-animation"|"smil-animation"]`, and must honor
  `@media (prefers-reduced-motion: reduce)` by pausing or by holding a representative frame. Export
  captures the **final/representative frame** (Sloodge sets `data-sl-freeze` on `<html>`, which the
  contract requires slides to respect via `[data-sl-freeze] *{animation-play-state:paused!important}`
  in the emitted skeleton — the export pass injects the rule itself, so slides need do nothing).

**Interactivity (SL-I\*)** — from `interactive-graph`
- Vanilla JS only, no libraries. A single `<script>` as the last element of `<body>` (so the DOM exists;
  no `defer`/`async` juggling, no `DOMContentLoaded` dependency).
- **Zero console errors** — measured; any `console.error`, unhandled rejection, or thrown error fails.
- Chart geometry computed numerically from the data; y-axis from 0; axis/legend text ≥ 16px.
- Testing hooks (mandatory when `capabilities` includes `interactive-js`):
  - `data-hover-target` on the primary hoverable data element (first bar / first point marker).
  - `data-click-target` on the primary clickable element (first bar / the legend item that toggles).
  - Exactly one of each per slide. These exist so the validator (and CI visual tests, see
    [70-testing-ci.md](70-testing-ci.md)) can synthesize a hover and a click and assert a visible delta.
  - Hover handlers must fire on **both** `mouseenter` and `mouseover` (synthetic hovers vary).
- Optional richer hooks, same namespace, all opt-in:
  `data-sl-tooltip` (the element that appears on hover — validator asserts hidden at rest, visible and
  fully inside the viewport on hover), `data-sl-summary` (the text region a click must mutate).

**Typography & contrast (SL-C\*)** — from `slide-deck`
- Title slide: 64–88px title, 24–32px subtitle. Content slide: 40–48px title, 26–30px headings,
  20–24px body, 16–18px footer. Nothing below 16px anywhere.
- Line-height 1.3–1.5, never `text-align:justify`, ~14 words max per body line.
- WCAG AA (4.5:1) for every text/background pairing, evaluated against the *actual* painted background.

### 3.3 `data-sl-id` — stable element identity for Design Mode

Every element inside `.slide` carries `data-sl-id="e_<hex>"`, unique within the slide document.

- **Who assigns them:** Sloodge, not the model. On import/generation the slide HTML is parsed with
  **`parse5` with `sourceCodeLocationInfo: true`**; any element lacking a `data-sl-id` is stamped with a
  fresh one (`e_` + 3–6 hex chars from a per-slide counter), and the attribute is written into the source
  text. The agent is *permitted but not required* to emit ids; skills stay simple.
- **Why in the source, not a side-table only:** the attribute survives serialization, DOM inspection, and
  round-trips through the model — the Onlook `data-oid` lesson (design-mode research §4). It is
  simultaneously mirrored by a **side-table** `id → {startOffset, endOffset, startTag, attrs}` byte spans
  into the *original* file text, so Design Mode patches the exact bytes and never re-serializes the
  document (preserves formatting, comments, and the model's hand-written whitespace).
- **Stability:** an id is stable across saves, reorders, Design Mode edits, and agent edits that leave the
  element in place. The agent is instructed (via the MCP tool prompt, see [50-agent-integration.md](50-agent-integration.md))
  to preserve existing `data-sl-id` attributes when rewriting a slide; the re-stamp pass repairs any it
  drops by matching structural position, and reports `SL-D02` when a mapping is lost.
- **Reserved values:** `e_root` on the `.slide` element. `data-sl-ignore` on an element (or subtree) opts
  it out of Design Mode hit-testing (react-grab's `data-react-grab-ignore` pattern) — used for decorative
  motif layers.
- **Selection context bundle** handed to the LLM (Cursor/react-grab pattern) is derived from the id:
  `[<h1 data-sl-id="e_001" class="title">Q3 Revenue Review</h1> in slides/s_01H8X….html:24:3]` plus a
  computed-style subset and a cropped screenshot.

### 3.4 Reserved attribute namespace

| Attribute | On | Meaning |
|---|---|---|
| `data-sl-contract` | `<html>` | Contract version integer (currently `1`). |
| `data-sl-slide` | `<html>` | Slide id — lets a detached HTML file be re-associated with its manifest entry. |
| `data-sl-id` | any element in `.slide` | Stable element identity (§3.3). |
| `data-sl-ignore` | any element | Excluded from Design Mode hit-testing. |
| `data-sl-lock` | any element | Selectable but not mutable by Design Mode (template chrome). |
| `data-sl-freeze` | `<html>`, injected by host | Export/thumbnail pass: pause animations. |
| `data-hover-target` | one element | Testing hook: primary hoverable. |
| `data-click-target` | one element | Testing hook: primary clickable. |
| `data-sl-tooltip` | one element | Optional: the tooltip node. |
| `data-sl-summary` | one element | Optional: the text region a click updates. |
| `data-sl-build` | any element | Optional progressive reveal step index (integer ≥ 1), reveal.js-fragment style. Absent = always visible. |

Anything else in the `data-sl-*` namespace is reserved for future Sloodge use; slides must not invent
`data-sl-*` attributes.

### 3.5 Assets

Preferred: inline everything as `data:` URIs — self-containment is the contract. `assets/` exists only
for user-imported binaries over 256 KB (large photos), referenced from slide HTML as
`src="sloodge-asset:a_01H8Z….png"`. The host's iframe loader rewrites that custom scheme to a `blob:`/
`data:` URL *before* the document is parsed, so the rendered document is still fully self-contained and
the file-on-disk stays small. Export and "Export ▸ HTML" always materialize them as `data:` URIs.

---

## 4. Themes and shared design tokens

The skills mandate "pick ONE accent color and derive the palette from it" per slide. Themes turn that
per-slide instinct into a deck-wide invariant without breaking self-containment.

### 4.1 Model

`theme/theme.json` holds **semantic tokens**. A build step derives `theme/theme.css`, a single
`:root{ --sl-*: … }` block. That CSS block is **inlined verbatim into every slide's `<style>`**, delimited
by sentinel comments:

```css
/* sl:theme:start v=7 */
:root{ --sl-bg:#0d1220; --sl-fg:#f0f0f5; … }
/* sl:theme:end */
```

Changing the theme rewrites only the bytes between the sentinels in each slide — a mechanical,
LLM-free, undoable operation. This is why tokens are inlined rather than `@import`ed: a slide opened
standalone (Export ▸ HTML, or the file dragged into a browser) must still look right, and no external
subresource is permitted (SL-S01).

Slides are expected to *use* the tokens (`color:var(--sl-fg)`), but the contract does **not** forbid
literal values — a chart's five series colors may be literals. The linter emits `SL-T01` (info) when a
color literal exactly matches a token value ("could use `var(--sl-accent)`"), and Design Mode's color
picker offers theme swatches first.

### 4.2 `theme.json` schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://sloodge.app/schema/theme-1.json",
  "type": "object",
  "required": ["formatVersion", "id", "name", "mode", "tokens"],
  "properties": {
    "formatVersion": { "const": 1 },
    "id":   { "type": "string", "pattern": "^t_[0-9A-HJKMNP-TV-Z]{26}$" },
    "name": { "type": "string", "minLength": 1 },
    "mode": { "enum": ["light", "dark"] },
    "derivedFrom": { "type": "string", "description": "accent hex the palette was derived from" },
    "tokens": {
      "type": "object",
      "required": ["color", "font", "size", "space"],
      "properties": {
        "color": {
          "type": "object",
          "required": ["bg", "fg", "accent", "muted"],
          "additionalProperties": { "type": "string", "pattern": "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" },
          "properties": {
            "bg": {}, "fg": {}, "accent": {}, "accentFg": {}, "muted": {},
            "surface": {}, "border": {}, "ok": {}, "warn": {}, "danger": {}
          }
        },
        "series": {
          "type": "array", "minItems": 3, "maxItems": 8,
          "items": { "type": "string" },
          "description": "Categorical chart palette; must be distinguishable without relying on red/green."
        },
        "font": {
          "type": "object",
          "properties": {
            "sans": { "type": "string", "default": "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" },
            "mono": { "type": "string", "default": "ui-monospace,'Cascadia Mono',Consolas,monospace" }
          }
        },
        "size": {
          "type": "object",
          "description": "px, must stay inside the ranges in §3.2 SL-C*",
          "properties": {
            "titleHero": { "type": "integer", "minimum": 64, "maximum": 88 },
            "title":     { "type": "integer", "minimum": 40, "maximum": 48 },
            "heading":   { "type": "integer", "minimum": 26, "maximum": 30 },
            "body":      { "type": "integer", "minimum": 20, "maximum": 24 },
            "caption":   { "type": "integer", "minimum": 16, "maximum": 18 }
          }
        },
        "space": {
          "type": "object",
          "properties": {
            "pad":    { "type": "integer", "minimum": 48 },
            "gap":    { "type": "integer", "minimum": 8 },
            "radius": { "type": "integer", "minimum": 0, "maximum": 32 }
          }
        }
      }
    },
    "version": { "type": "integer", "minimum": 1,
                 "description": "Bumped on every edit; matches the sl:theme sentinel v= in slide CSS. A mismatch means a slide has a stale token block and needs re-inlining." }
  }
}
```

Token → CSS custom property mapping is mechanical: `tokens.color.accent` → `--sl-color-accent` (aliased
`--sl-accent`), `tokens.size.title` → `--sl-size-title` (`48px`), `tokens.series[i]` → `--sl-series-i`.

### 4.3 Applying / changing a theme

1. User picks a theme (or nudges the accent) → `theme.json` written, `version` bumped.
2. `theme.css` regenerated.
3. For each slide: replace the sentinel-delimited block. If a slide has no sentinel block (hand-written,
   imported), insert one as the first rule inside the first `<style>` and record `SL-T02` (info).
4. Re-validate contrast per slide (`SL-C05` can flip to error under a new theme — e.g. dark text on a now
   dark background). Failures surface as a badge in the rail with a one-click "ask Claude to fix contrast".
5. The whole operation is one undo entry.

Theme is also injected into every agent prompt as a compact token table, so generated slides use
`var(--sl-*)` natively rather than being retro-fitted.

---

## 5. Versioning & migration

### 5.1 Three independent version numbers

| Version | Where | Bumps when |
|---|---|---|
| `formatVersion` (manifest) | `manifest.json` | Container layout or manifest schema changes incompatibly. Integer. |
| `data-sl-contract` (slide) | `<html>` attr | The slide HTML contract changes (new required attribute, new geometry). Integer. |
| `theme.formatVersion` | `theme.json` | Token schema changes. Integer. |

They are decoupled because a contract change (e.g. contract 2 adds a required attribute) does not
necessarily require a container change, and vice versa. v1 ships all three at `1`.

### 5.2 Compatibility policy

- **Reader ≥ writer** (`file.formatVersion <= app.maxFormatVersion`): open, run any needed migrations.
- **Reader < writer**: open **read-only** with a clear banner ("saved by a newer Sloodge"); Save is
  disabled, `Save a Copy` downgrades only if a lossless downgrade exists, otherwise refuses. Never
  silently drop fields.
- **Unknown fields are preserved.** The manifest loader keeps unrecognized keys in a `__unknown` bag and
  re-emits them on save; unrecognized zip entries are copied through verbatim. This makes forward-compat
  cheap and lets a newer version's data survive a round-trip through an older one.
- **Slide contract mismatch** is per-slide, not fatal: a contract-1 slide in a contract-2 app renders via
  the compat path and is upgraded lazily on first edit.

### 5.3 Migration mechanics

Migrations are an ordered, pure, testable chain — one function per version step, never conditional
branching inside a single loader:

```ts
type Migration = {
  from: number; to: number;
  describe: string;
  migrate(deck: DeckBundle): Promise<DeckBundle>;   // manifest + slide texts + theme
};

const MIGRATIONS: Migration[] = [ /* 1→2, 2→3, … */ ];

async function open(path: string) {
  const bundle = await unzip(path);
  assertNoZipSlip(bundle);
  let v = bundle.manifest.formatVersion;
  if (v > MAX_FORMAT_VERSION) return openReadOnly(bundle);
  const backupNeeded = v < MAX_FORMAT_VERSION;
  if (backupNeeded) await copyFile(path, `${path}.v${v}.bak`);   // one-time, alongside the original
  for (const m of MIGRATIONS.filter(m => m.from >= v)) bundle = await m.migrate(bundle);
  return bundle;
}
```

Rules: every migration ships with a fixture deck at the old version and a golden expected output in the
test suite; migrations run against the *unpacked* bundle in the workspace, so a crash mid-migration never
touches the user's original file; the pre-migration `.bak` is kept until the user's first successful save.

Slide-contract migrations are HTML rewrites over the parse5 tree (e.g. contract 1→2 might stamp a new
required attribute), applied with the same byte-span patcher Design Mode uses, so formatting survives.

### 5.4 Import / export of the format

- **Export ▸ HTML** produces a single self-contained `.html`: all slides concatenated as
  `<div class="slide">` siblings with `break-after:page`, one merged `<style>`, per-slide scripts wrapped
  in IIFEs and namespaced by slide id to avoid global collisions. This is a *derived* artifact, not
  round-trippable.
- **Import** of a folder of loose 1280×720 HTML files: each becomes a slide, ids stamped, contract
  validated, failures listed with "ask Claude to fix" affordances. This is the main on-ramp for people
  who already generated HTML slides in a chat tool.

---

## 6. Validation rules (machine-checkable)

Three tiers, all runnable headlessly (in the app, in `sloodge lint`, and in CI via a hidden
`BrowserWindow`/Playwright — see [70-testing-ci.md](70-testing-ci.md)). Results cache into
`slides[id].validation` keyed by `contentHash`.

### 6.1 Tier 1 — static lint (parse5, no browser, <5ms/slide)

| Rule | Severity | Check |
|---|---|---|
| `SL-S01` | error | No off-document subresource, checked on the parse5 tree: `<link>` (any rel, incl. `imagesrcset`), `<script src>`, `<iframe src>`, `<video src\|poster>`, `<audio src>`, `<source src>`, `<object data>`, `<embed src>`, `<track src>`, `<input src>` (type=image), any `srcset` candidate (parsed per srcset grammar), SVG `<use href\|xlink:href>` off-document, `background=`, plus CSS `@import` and `url(http(s)://` / `//`). Allowed: `data:`/`blob:`/`sloodge-asset:` and `#` fragments |
| `SL-S02` | error | No `<img src>`/`<image href>` outside `data:` or `sloodge-asset:` |
| `SL-S03` | error | No `@font-face`; font-family resolves to the system stack |
| `SL-S04` | error | Source contains none of `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `localStorage`, `indexedDB`, `document.cookie`, `alert(`, `eval(`, `new Function(` |
| `SL-G01` | error | Exactly one `.slide` root with `width:1280px;height:720px` (computed from the inline stylesheet) |
| `SL-G02` | error | `overflow:hidden` and `position:relative` on `.slide` |
| `SL-G03` | error | `html,body{margin:0;padding:0}` and universal `box-sizing:border-box` present |
| `SL-G04` | warn | Root padding ≥ 48px (or explicit `data-sl-fullbleed`) |
| `SL-G05` | error | No `position:fixed`; no viewport units (`vh`/`vw`/`vmin`/`vmax`/`dvh`/…). Checked in `<style>` **and** inline `style=` attributes |
| `SL-D01` | error | Every element inside `.slide` has a unique `data-sl-id`; `.slide` is `e_root` |
| `SL-D02` | warn | No previously-known `data-sl-id` disappeared vs. the last saved revision (mapping loss) |
| `SL-I01` | error | If `capabilities` ⊇ `interactive-js`: exactly one `data-hover-target` and one `data-click-target` |
| `SL-I02` | error | `<script>` is the last element of `<body>` |
| `SL-A01` | error | If `capabilities` ⊇ `*-animation`: at least one `@keyframes`/SMIL element with infinite repeat |
| `SL-A02` | error | No `fill="freeze"` outside a `begin="…; x.end"` restart chain |
| `SL-A03` | warn | Animated properties limited to `transform`/`opacity`/SMIL motion |
| `SL-C01` | warn | No declared `font-size` below 16px |
| `SL-C02` | warn | No `text-align:justify` |
| `SL-T01` | info | Color literal equals a theme token value (suggest `var(--sl-*)`) |
| `SL-T02` | info | Missing `sl:theme` sentinel block, or `v=` ≠ current theme version |
| `SL-H01` | error | Declared `capabilities` match what's actually in the file (no undeclared `<script>`, no undeclared animation) |

### 6.2 Tier 2 — rendered checks (headless load, ~150ms/slide)

Load the slide in an offscreen 1280×720 iframe/`BrowserWindow`, `await document.fonts.ready`, then:

| Rule | Severity | Check |
|---|---|---|
| `SL-R01` | error | `documentElement.scrollWidth <= 1280 && scrollHeight <= 720` (the skills' #1 machine check) |
| `SL-R02` | error | No element's `getBoundingClientRect()` extends beyond `[0,0,1280,720]` by more than 1px (catches clipped-but-hidden overflow that `overflow:hidden` masks) |
| `SL-R03` | error | Zero console errors / unhandled rejections / failed subresource loads during 6s of runtime |
| `SL-R04` | error | Zero network requests attempted (CSP `connect-src 'none'` + request interception counts attempts) |
| `SL-C05` | error | For every text node, computed color vs. sampled background at its box → contrast ≥ 4.5:1 (≥ 3:1 for ≥24px bold). Background sampled from the rendered pixel buffer under the text box, so gradients/motifs are accounted for |
| `SL-C06` | warn | No two visible text boxes overlap by >10% area (collision) |
| `SL-C07` | warn | Every rendered text node's computed `font-size` ≥ 16px |
| `SL-M01` | warn | Peak JS heap < 64MB and no rAF loop above 8ms/frame at steady state |

### 6.3 Tier 3 — behavioral checks (only for declared capabilities, ~2–6s/slide)

| Rule | Severity | Check |
|---|---|---|
| `SL-A10` | error | Screenshots at t=0s / t=2s / t=5s differ pairwise in the animated region (perceptual diff > 0.5%); no frozen end-state |
| `SL-A11` | error | With `data-sl-freeze` set, t=0 and t=2 screenshots are identical (export determinism) |
| `SL-A12` | error | Under `prefers-reduced-motion: reduce`, no unbounded motion |
| `SL-I10` | error | Dispatch `mouseover`+`mouseenter` on `[data-hover-target]` → a previously-hidden element becomes visible, fully inside the viewport, with text ≥16px |
| `SL-I11` | error | `click` on `[data-click-target]` → screenshot delta > 0.5%, and if `[data-sl-summary]` exists its `textContent` changed |
| `SL-I12` | error | Hover then unhover restores the pre-hover screenshot (no stuck tooltips) |
| `SL-I13` | warn | `cursor:pointer` on both testing-hook targets |

### 6.4 When validation runs, and what it gates

- **On agent write** (MCP `slide.write`): Tier 1 + Tier 2 synchronously; Tier 3 if capabilities declare it.
  Errors are returned to the agent as tool output so it self-corrects in-loop (this is exactly the harness
  that drove the skills to 100% in [90-experiments.md](90-experiments.md)) — with a retry budget of 2.
- **On Design Mode local edit:** Tier 1 (`SL-D01`, `SL-G*`) + Tier 2 `SL-R01/R02/C05` only, debounced 300ms.
  Never blocks the edit; surfaces a warning badge.
- **On save:** Tier 1 for every dirty slide; the resulting `validation` object is written to the manifest.
- **On export:** Tier 2 must pass for every non-hidden slide, or the user gets an explicit
  "export anyway?" dialog listing offending slides.
- **In CI:** Tiers 1–3 over the fixture decks in `tests/fixtures/*.sloodge`.

`fail` never blocks the user from keeping their work — a deck with failing slides saves fine; the rail
shows a red dot and the chat offers a repair prompt.

---

## 7. Open questions

1. **Progressive reveal (`data-sl-build`)** — specified as an attribute here but the Present-mode runtime
   and PDF "one page per build step" behavior belong to [60-export.md](60-export.md); defer the runtime to
   after v1 if the milestone is tight (attribute reserved either way so decks stay forward-compatible).
2. **Per-slide theme overrides** — v1 has one theme per deck. A `slides[id].themeOverride` patch object is
   the obvious v2 extension; not specified now to avoid a half-designed cascade.
3. **`SL-C05` contrast sampling cost** — per-text-node pixel sampling may be too slow for 100-slide decks
   on save; likely restricted to Tier 2-on-demand + export gating, with a cheaper static approximation in
   Tier 1.
