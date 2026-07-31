# Research: "Design Mode" Direct-Manipulation Editing in AI Coding Tools

Purpose: survey how Cursor, v0, react-grab, Onlook, stagewise, and devtools-style element
pickers let a user click a rendered UI element and either (a) edit it visually with the
change written back to source, or (b) send precise element context to an LLM agent — so we
can design a similar direct-manipulation layer for an **HTML-slides desktop app** (select an
element on a rendered slide, edit it inline or hand it to an AI as context, and persist the
change back into the slide's HTML source).

---

## 1. Cursor — Design Mode / Browser Visual Editor

Cursor's "Design Mode" (shipped with Cursor 3, evolved from the "Browser Visual Editor" in
Cursor 2.2) runs inside Cursor's embedded browser pane, next to the running dev server.

**Selection & context capture**
- Toggle a Design Mode button in the browser pane, then click any element in the live app.
- On click, Cursor captures multiple layers of context about the element simultaneously:
  - **Structural identity**: an XPath to the node, the owning component, and its props —
    pulled from the **React fiber tree** (i.e., it's instrumented for React specifically,
    similar to how React DevTools walks fibers).
  - **Style identity**: computed CSS for the node.
  - **Code identity**: the underlying source snippet for that element/component.
  - **Visual identity**: a screenshot of the surrounding layout so the agent has spatial/visual
    grounding, not just a DOM path.
- All of this is bundled and handed to the agent (Composer) along with the user's typed or
  spoken instruction — closing what Cursor calls the "reference gap" (agent no longer has to
  guess which of several similar-looking divs the user means).

**Interaction modes**
- **Click-to-select** a single element.
- **Multi-select**: reference two-plus elements at once (e.g. "make this match that", "remove
  the repeated ones", "apply this spacing to the whole group").
- **Draw-to-select**: draw a rectangle/annotation over a region of the page. This freezes the
  viewport frame at that instant and sends the frozen screenshot + annotation, which is
  important for crowded or animated UI where a live re-query would resolve to the wrong state.
- **Voice**: narrate the requested change instead of/alongside typing.
- **Queueing**: users can point at an element, describe a change, then immediately move to
  another element and queue a second edit before the first agent turn finishes — edits stream
  back into the running app via hot reload.

**Relevant reusable ideas for us**
- Bundle *four* channels of context per selection: structural path, computed style, source
  snippet, and a screenshot — an LLM benefits from redundant signal, not just one clean ID.
  For an HTML-slides tool, the source snippet + computed style are cheap to get since we own
  the DOM (no fiber tree needed, just plain DOM/HTML).
- "Freeze the frame" pattern for draw-to-select: capture a screenshot at selection time and
  keep referring to *that* screenshot in the context payload even if the live DOM has since
  changed, so the agent's visual grounding matches what the user actually saw.
- Multi-select + relational instructions ("make A match B") is a genuinely useful UX pattern
  worth reusing for slide editing (e.g. "make this text box match that one's font").

Sources:
- [Direct agents with visual prompts in Design Mode · Cursor](https://cursor.com/blog/design-mode)
- [A visual editor for the Cursor Browser · Cursor](https://cursor.com/blog/browser-visual-editor)
- [Cursor Design Mode: Edit UI by Pointing & Talking](https://www.buildfastwithai.com/blogs/cursor-design-mode-edit-ui-voice-2026)
- [Cursor's Design Mode (Visual Editing) Explained — Builder.io](https://www.builder.io/blog/cursor-design-mode-visual-editing)
- [Cursor Design Mode: What It Is and How Cursor 3 Visual Editing Works](https://pasqualepillitteri.it/en/news/3794/cursor-design-mode-what-it-is-how-it-works-cursor-3)

---

## 2. Vercel v0 — Design Mode

v0's Design Mode is a **non-AI, zero-credit** direct-manipulation layer that overlays design
tools on top of the live Preview iframe.

**Selection & overlay**
- Toggling Design Mode (or `Cmd/Ctrl+I`) turns the cursor into a selection tool.
- Hovering highlights elements in the running preview; clicking selects one and shows
  **selection handles** plus a **design panel** (a property inspector, Figma-style).
- `Escape` deselects. Selection state is scoped to the Preview iframe (the running app), not
  the chat/code panel.

**Editable properties (all inline, all direct-manipulation, no prompting)**
- Typography: font family, size, weight, line height, letter spacing, alignment, decoration.
- Color: text color. Background: background color.
- Layout: margin/padding per side.
- Border: color, style, width.
- Appearance: opacity, corner radius.
- Shadow: box-shadow.
- Content: direct inline text editing (contenteditable-style).
- It auto-detects Tailwind usage in the project and "surfaces Tailwind-compatible values"
  where applicable — implying it tries to map panel edits onto existing utility classes rather
  than always emitting arbitrary inline styles/new class names.

**Credits/cost model — the key differentiator**
- Panel-driven visual tweaks (drag a slider, pick a color, nudge padding) are **free** — no v0
  tokens/credits consumed, because no LLM call happens; it's a direct DOM/style mutation loop
  in the sandboxed preview.
- Only when you *apply* the change (or ask v0 to do something more complex via chat) does it
  synthesize an updated version of the source and that flows through the normal
  versioned-chat/diff pipeline (this part does cost credits if it re-invokes generation).
- Unapplied edits are held pending in the panel; navigating away warns you first.
- Applying produces a new **chat version** so it's diffable/revertible like any other v0 edit.

**Relevant reusable ideas for us**
- The core insight: **direct style manipulation should never require an LLM round-trip.**
  Build a local "structured edit" layer (property panel bound directly to computed style /
  known attributes) that mutates the DOM/HTML immediately and only calls the LLM for edits that
  are semantic/generative ("make this look more festive") rather than parametric (font size,
  color, padding). This is the most important architectural lesson from v0 for a slides app:
  most of what people want (resize text, change color, nudge position, edit copy) is not an AI
  task at all — it's a property-panel task, and should be instant/local/free.
  For a slides editor this maps extremely well: text/position/size/color edits = local
  direct-manipulation; "make this slide more visually interesting" = LLM task.
  - Selection-handle affordances (resize/move handles overlaid on selected element,
    matching a Figma-like mental model) are worth reusing directly for a WYSIWYG slide canvas.

Sources:
- [Design mode | v0 Docs](https://v0.app/docs/design-mode)
- [Introducing Design Mode on v0 — Vercel Community](https://community.vercel.com/t/introducing-design-mode-on-v0/13225)
- [Edit UI with v0's design mode — Vercel Community](https://community.vercel.com/t/edit-ui-with-v0s-design-mode/17477)
- [Edit Mode | Vercel Docs](https://vercel.com/docs/edit-mode)

---

## 3. react-grab (Aiden Bai) — "copy any UI element for your agent"

`aidenybai/react-grab` is the most directly relevant prior art for the "select element → give
precise context to an LLM" half of the problem. It deliberately does **not** try to edit
anything itself — it is a context-acquisition tool, meant to sit in front of any agent
(Cursor, Claude Code, Copilot, Windsurf, etc.).

**Core UX**
- Hover any element in a running React app in the browser → press `⌘C` / `Ctrl+C` → the tool
  copies a structured text blob to the clipboard → paste it into your agent chat.
- No always-on install cost in the shipped app; typically added as a dev-only script/import
  during local development (Next.js `app/layout.tsx` or `pages/_document.tsx`, a Vite dynamic
  import, or a conditional Webpack import), or run via `npx grab@latest init` which wires it up
  for you. It is explicitly a **dev-time tool**, not a runtime feature to ship to end users.

**Copied payload format**
- A compact, LLM-friendly annotation of the element plus its React component stack and exact
  source location, e.g.:
  `[<a class="ml-auto inline-block text-sm">Forgot your password?</a> in LoginForm (at components/login-form.tsx:46:19)]`
- This gives the agent: (1) a snippet of the actual rendered markup/classes so it can visually
  ground itself, (2) the owning component name, (3) exact `file:line:column`, which is enough
  for a coding agent to `Read` the right file at the right offset without searching.

**How it identifies elements / maps to source**
- Built on top of **bippy** (also by Aiden Bai), a toolkit that "hacks into React internals" by
  impersonating the React DevTools global hook (`window.__REACT_DEVTOOLS_GLOBAL_HOOK__`), which
  React's renderer talks to. This gives bippy — and therefore react-grab — direct access to the
  live **fiber tree** without needing a compiled-in babel source-map plugin. Utilities exposed:
  `traverseRenderedFibers`, `traverseFiber`, `traverseProps`, `traverseState`,
  `traverseContexts`. Works across React 17–19.
  - This is a materially different approach from the classic `babel-plugin-transform-react-jsx-source`
    method (below): instead of baking `__source: {fileName, lineNumber}` into every JSX element
    at compile time, it reads whatever source-location metadata React/DevTools tooling already
    attaches to fibers at dev time, walking up the fiber tree to resolve the nearest named
    component and its file/line.
- `react-grab/primitives` exposes the selection engine standalone so you can build a custom UI
  on top of it:
  - `getElementAtPoint()` — coordinate-based hit testing (pointer position → DOM node → fiber).
  - `isElementGrabbable()` — filtering predicate (skip layout-only wrappers, etc.).
  - Container scoping — restrict hit testing to a subtree.
  - `data-react-grab-ignore` attribute — opt an element/subtree out of being selectable (useful
    for the picker's own overlay UI so it doesn't select itself).
  - Page freezing — pause visual state during selection (same "frozen frame" idea as Cursor's
    draw-to-select).
  - Clipboard access + "editor navigation" (jump straight to file:line in your editor).
- A companion package, **petite-react-grab**, is a smaller/lighter variant of the same idea.
- Repo is a monorepo (`packages/`, `apps/`, `skills/`) using Turbo/Vite/pnpm; ships a `skills/`
  directory suggesting it's also packaged as an agent-callable skill.

**Relevant reusable ideas for us**
- The **payload format** (`[<snippet> in ComponentName (at file:line:col)]`) is a good template
  for our own "selected element → LLM context" string: for HTML slides we'd emit something like
  `[<div class="title">Q3 Results</div> in slide-04.html:12:3]` plus maybe the enclosing
  `<section>`/slide id.
  - Since we own plain HTML (not compiled JSX), we don't need bippy's fiber-hacking trick at
    all — every DOM node in an HTML slide can carry a stable identifier we control (see
    Onlook's `data-oid` pattern below), or we can rely on the browser's native
    element→source mapping if we render from a known static file (walk up from the clicked
    node, use `outerHTML`, and locate it in the source file text directly since HTML is not
    transformed/minified in a slides tool the way React JSX is).
  - The `getElementAtPoint` / `isElementGrabbable` / ignore-attribute pattern is directly
    reusable for our own overlay picker implementation (see §6).
  - Treating this as a **separable "primitives" library** decoupled from any specific UI is a
    good architectural split: (1) hit-testing/selection engine, (2) context-serialization
    format, (3) picker overlay UI, (4) clipboard/agent-handoff — we should keep these as
    separate layers too.

Sources:
- [GitHub - aidenybai/react-grab: Copy any UI element for your agent](https://github.com/aidenybai/react-grab)
- [react-grab/README.md](https://github.com/aidenybai/react-grab/blob/main/README.md)
- [GitHub - aidenybai/petite-react-grab](https://github.com/aidenybai/petite-react-grab)
- [GitHub - aidenybai/bippy: hack into react internals](https://github.com/aidenybai/bippy)
- [bippy/README.md](https://github.com/aidenybai/bippy/blob/main/README.md)
- [Using React Grab to speed up AI-assisted coding — Better Stack](https://betterstack.com/community/guides/scaling-nodejs/react-grab-ai/)
- [React Grab — Made with React.js](https://madewithreactjs.com/react-grab)

---

## 4. Onlook — "Cursor for Designers" (open-source Electron app, React/Tailwind)

Onlook (`onlook-dev/onlook`) is the closest full-product prior art to what we're building: a
**desktop app** that lets you visually edit a running app's UI (drag, resize, restyle, edit
text) and writes the changes back into real source files on disk, plus has an AI chat layered
on top for generative edits.

**Tech stack**
- Frontend/editor: Electron desktop shell + Next.js (their own site/dashboard) + Tailwind CSS
  + Vite for the editor's own build.
- Server interface: tRPC.
- Sandbox/runtime for the *target* project being edited: **CodeSandbox SDK** running a **Bun**
  runtime inside Docker containers (a full disposable dev environment, not just an iframe over
  a locally-running dev server).
- Hosting for published projects: Freestyle.
- AI layer: Vercel AI SDK as the LLM client, OpenRouter as the model gateway/provider,
  **Morph Fast Apply** and **Relace** as "fast apply" providers — i.e., specialized
  small/fast models whose only job is to take a diff/instruction and merge it into an existing
  file quickly (this is the same "fast apply" pattern used by Cursor's apply model) — streamed
  via diff-match-patch so both canvas and file tree update incrementally.
- Monorepo tooling: Bun as package manager/runtime/bundler.

**Element → source mapping (the core trick)**
- At build/dev time, Onlook instruments the served bundle with a **Babel plugin**
  (`@onlook/babel-plugin-react`, published on npm) that injects a `data-oid` attribute into
  every JSX element. This is conceptually identical to `babel-plugin-transform-react-jsx-source`
  (adds file/line metadata to elements) but Onlook owns the plugin so it can control the ID
  format and correlate it precisely with their own AST offsets rather than just line/column.
- The `data-oid` therefore appears in the rendered DOM (as an actual `data-*` attribute you can
  inspect), giving Onlook a **stable, bidirectional key**: DOM node → `data-oid` → exact AST
  node in the source file, and back.
- Full pipeline: (1) project code loads into the CodeSandbox web container, (2) container runs
  the dev server and serves the (instrumented) app, (3) editor gets a preview URL and renders it
  in an iframe/canvas, (4) editor also reads/indexes the raw source from the container over its
  own channel (not just what's in the DOM), (5) visual edits apply **first to the iframe DOM**
  (instant feedback) **then get resolved to the corresponding JSX** via the `data-oid` → AST
  lookup, patched with an AST transform (not string-replace), and (6) the patched file triggers
  HMR so the running app picks it up — closing the loop.
- Because everything funnels through the `data-oid`, drag/resize/recolor/retype operations in
  the canvas become "find AST node by oid → mutate the relevant JSX attribute/className/text →
  write file" operations, which is much safer than regex/string patching and preserves
  formatting/structure.
- The AI chat participates in the same loop: it "has read the entire repo" for context (so it
  respects existing theme tokens/naming), and users can **accept/reject** each AI suggestion on
  the canvas before it touches the real files (a review gate between model output and disk).

**Right-click → jump to code**
- Right-clicking a canvas element opens the exact source location — same `data-oid` lookup used
  in reverse, for navigation rather than mutation.

**Relevant reusable ideas for us — this is the most transferable architecture**
- **Own the ID, don't infer it.** Rather than trying to reverse-engineer which DOM node
  corresponds to which HTML source range after the browser's own parsing/normalization, inject
  a stable `data-*` id into every element at "compile"/load time that we control, and keep a
  side-table mapping id → exact byte offset (or line/col span) in the slide's HTML source. This
  sidesteps a huge class of bugs (whitespace differences, attribute reordering, self-closing tag
  normalization) that a naive DOM→source-text search would hit. For an **HTML-slides app**, this
  is *easy* compared to Onlook's JSX case, because we're not dealing with a compiler: at slide
  load time we can parse the raw HTML ourselves (e.g. via `parse5`/`htmlparser2` with location
  info, or `DOMParser` + our own reconciliation pass) and stamp `data-sloodge-id="<n>"` onto
  each element both in the DOM we render *and* record the matching span in the original text, so
  we can always patch the exact original bytes rather than re-serializing the whole DOM (which
  would destroy formatting/comments/whitespace).
- **Two-stage apply: DOM-first, then source.** Apply the visual mutation to the live rendered
  DOM immediately for instant feedback, then asynchronously resolve it to a source-text patch.
  Don't block the interaction on the source round-trip.
- **AST/text-patch over string-replace**, and preserve formatting — mutate only the specific
  attribute/text node identified by the id, not regenerate the whole element.
- **Human-in-the-loop apply for AI edits**: AI-proposed diffs shown as accept/reject overlays on
  the canvas before touching the file, decoupled from the always-safe local direct-manipulation
  path (echoes v0's "local edits are free, AI edits are reviewable" split).
- Running the target app/slide-deck in an isolated container/sandbox (vs. directly in-process)
  is Onlook's choice for arbitrary React projects; for our case (self-contained HTML slides) we
  likely don't need a full container — an iframe or a Chromium `webview`/`BrowserView` in the
  Electron/desktop shell rendering the slide's HTML directly is sufficient and much lighter.

Sources:
- [GitHub - onlook-dev/onlook](https://github.com/onlook-dev/onlook)
- [onlook/README.md](https://github.com/onlook-dev/onlook/blob/main/README.md)
- [@onlook/babel-plugin-react — npm](https://www.npmjs.com/package/@onlook/babel-plugin-react)
- [Onlook: A React visual editor — LogRocket Blog](https://blog.logrocket.com/onlook-react-visual-editor/)
- [Onlook: The Open-Source "Cursor for Designers" — BrightCoding](https://www.blog.brightcoding.dev/2025/09/05/onlook-the-open-source-cursor-for-designers-that-lets-you-visually-build-style-and-edit-react-apps-with-ai/)
- [Onlook — Cursor for Designers (beta.onlook.com/features)](https://beta.onlook.com/features)

---

## 5. stagewise (and the related 21st.dev / `21st-extension` toolbar)

`stagewise-io/stagewise` (YC S25) is a **browser toolbar** injected into a running dev app that
bridges live browser context to an AI coding agent running in your IDE — it does not try to
render/edit anything itself in the browser; it's purely a context/bridge layer plus (in its
newer incarnation) a full agentic IDE.

**How it's wired up**
- `npx stagewise@latest` starts a **local CLI proxy on port 3100** and injects a toolbar into
  the running app (typically via a dev-only script tag / framework plugin for React, Next.js,
  Vue, Nuxt — "works with every framework" is the broader claim, first-party support is listed
  for those four).
- The toolbar runs *inside* the target page (same-origin, not a separate iframe wrapper), so it
  can do normal DOM hit-testing directly against the live page.
- **Bridge mode**: the toolbar in the browser doesn't execute anything itself — you select an
  element and type/comment a request in the toolbar UI; that request plus captured context is
  sent over the local proxy to your **IDE's agent** (Cursor, Copilot, Windsurf, or any
  MCP-compatible client), and the *actual code edit execution* happens in the IDE, not the
  browser. This is a clean separation: browser = context capture + UX, IDE agent = execution.
  - The 21st.dev fork/rebrand (`@21st-extension/toolbar`, via `initToolbar()`) is the same
    pattern packaged as a VS Code/Cursor extension + toolbar package, configured with a
    `stagewiseConfig` object and a plugin list.
- **Context captured per selection**: DOM structure, a screenshot, and metadata — described as
  including component hierarchies, CSS cascade info, state-management patterns, and
  framework-specific metadata (exact mechanism per-framework isn't publicly detailed, but for
  React it's presumably fiber-based like the others, and for Vue/Svelte likely framework
  devtools hooks or compiler-injected source maps analogous to `__source`).
- **Plugin system**: plugins can hook into three distinct phases of the pipeline — **context
  gathering**, **code generation**, and **file writing** — giving fine-grained control/override
  at each stage. This is a useful pipeline decomposition to copy.
- Transport is **MCP-based**: stagewise positions itself as an MCP client/server bridge so any
  MCP-compatible agent can consume the captured context, rather than building bespoke
  integrations per IDE.
- License: AGPLv3, by stagewise GmbH.

**Relevant reusable ideas for us**
- The **three-phase plugin pipeline** (gather context → generate code → write file) is a clean
  way to structure our own AI-edit path, and lets us keep "gather context" fully local/fast
  while "generate" is the only LLM-bound stage.
- Running the selection UI **in-page** (rather than in a wrapping iframe/devtools panel) keeps
  hit-testing trivial (`document.elementFromPoint`, native `getBoundingClientRect`) since there's
  no cross-origin/iframe coordinate translation to do — worth doing the same for our slides
  editor if slides render directly in the app's own webview rather than a sandboxed iframe.
- Using a well-known **transport protocol (MCP)** rather than a bespoke one for the
  browser-to-agent handoff is attractive if we want the slides editor to be usable by *any*
  external agent (Claude Code, Cursor, etc.) later, not just our own built-in assistant.

Sources:
- [GitHub - stagewise-io/stagewise](https://github.com/stagewise-io/stagewise)
- [stagewise.io](https://stagewise.io/)
- [Show HN: Stagewise (YC S25)](https://news.ycombinator.com/item?id=44798553)
- [stagewise: Browser-Powered Agent for Production Codebases — BrightCoding](https://www.blog.brightcoding.dev/2026/07/04/stagewise-browser-powered-agent-for-production-codebases)
- [GitHub - 21st-dev/21st-extension](https://github.com/21st-dev/21st-extension)
- [AI Coding Tools That Actually See Your Browser (2026) — DEV Community](https://dev.to/bluehotdog/ai-coding-tools-that-actually-see-your-browser-2026-2hoc)

---

## 6. Browser devtools-style element pickers — general implementation technique

This is the substrate all of the above tools sit on top of. Two implementation families:

**A. Native "inspect element" pickers (Chrome/Firefox DevTools style)**
- Enter an "inspect mode": a full-viewport transparent overlay layer captures `mousemove`.
- On each `mousemove`, resolve the element under the cursor with
  `document.elementFromPoint(x, y)` (or `elementsFromPoint` for the full z-stack) — this is the
  browser-native hit-testing primitive; DevTools' own implementation (Chrome/Blink) is more
  elaborate internally (walks the render tree/paint layers via the `Overlay` domain of the
  Chrome DevTools Protocol — `Overlay.setInspectMode`, `Overlay.highlightNode`,
  `inspectNodeRequested` event on click) but the DOM-accessible equivalent for an in-page
  picker is `elementFromPoint`.
- On hover, draw a highlight rectangle using `el.getBoundingClientRect()`, positioned via an
  absolutely-positioned overlay `<div>` (DevTools draws margin/border/padding/content as nested
  colored boxes — the classic box-model highlight). Must re-run on scroll/resize
  (`ResizeObserver`/`scroll` listeners) since rects are viewport-relative and go stale on any
  layout shift.
- On click, capture: the DOM node reference, `outerHTML`/`tagName`, computed style
  (`getComputedStyle`), bounding rect, and (if available) a source-location attribute.
- Must exclude the picker's own overlay elements from hit-testing (either give the overlay
  `pointer-events: none` and resolve on top of it, or explicitly skip nodes tagged with an
  ignore attribute/class — same pattern as react-grab's `data-react-grab-ignore`).
- CDP's `Overlay` domain (used by DevTools itself and Puppeteer/Playwright-driven tools) is the
  "out of process" version of the same idea — useful if we ever want to drive the picker from
  outside the page's own JS context (e.g. from an Electron main process via CDP) rather than
  injecting in-page script.

**B. Framework-aware pickers (React DevTools style / source-mapped)**
- Two established ways to get *source location*, not just DOM structure:
  1. **Compile-time instrumentation**: `@babel/plugin-transform-react-jsx-source` (formerly
     `babel-plugin-transform-react-jsx-source`) rewrites every JSX element to carry a
     `__source: {fileName, lineNumber, columnNumber}` prop (via the `__self`/`__source` dev-mode
     args to `jsxDEV`). React DevTools' "inspect element → view source" and various click-to-
     open-in-editor tools read this. Onlook's `data-oid` Babel plugin is the same idea, just
     emitting a DOM-visible `data-*` attribute instead of a non-DOM prop, which is actually more
     robust for a canvas/iframe scenario since it survives into the rendered HTML you can query
     from *outside* React (you don't need fiber access to read a `data-oid` attribute).
  2. **Runtime introspection**: bippy-style — impersonate the React DevTools hook and walk the
     live fiber tree at runtime, no compile step needed, but React-specific and depends on
     unstable internals.
- For our HTML-slides case, **neither is really necessary** — there is no compile step and no
  virtual DOM. We render actual static/generated HTML. The direct analog is: parse the slide's
  HTML source with a location-aware parser once at load, assign each element a stable id
  attribute reflecting its exact source span, and keep the DOM-in-webview and source-text in
  sync by *always mutating through that id* rather than ever diffing serialized DOM against
  original text.

**Relevant reusable technique summary for building our overlay picker**
1. Absolutely-positioned, `pointer-events:none` highlight box(es), positioned each frame (or on
   `mousemove`+`scroll`+`ResizeObserver`) via `getBoundingClientRect()`.
2. Hit-test with `elementFromPoint`/`elementsFromPoint`, filtered by an ignore-list/attribute for
   our own UI chrome.
3. On selection, snapshot: bounding rect, computed style subset relevant to editing (font,
   color, spacing, size), `outerHTML` excerpt, and our stable source-id.
4. Keep the picker and the "apply edit" logic decoupled (a "primitives" layer) from the actual
   panel/overlay UI, matching react-grab's split — lets us reuse the same engine for (a) local
   property-panel editing and (b) "send to AI" context capture.

Sources:
- [Inspect mode: Quickly analyze element properties — Chrome DevTools docs](https://developer.chrome.com/docs/devtools/inspect-mode)
- [Chrome DevTools Protocol — Overlay domain](https://chromedevtools.github.io/devtools-protocol/tot/Overlay/)
- [@babel/plugin-transform-react-jsx-source — Babel docs](https://babeljs.io/docs/babel-plugin-transform-react-jsx-source)
- [babel-plugin-transform-react-jsx-source — npm](https://www.npmjs.com/package/babel-plugin-transform-react-jsx-source)
- [babel-plugin-transform-react-jsx-location (data-source attribute variant)](https://github.com/adrianton3/babel-plugin-transform-react-jsx-location)

---

## 7. Synthesis — recommended design for an HTML-slides direct-manipulation layer

Given the above, a proposed architecture, borrowing the best-fit piece from each tool:

1. **Stable source-anchored IDs (from Onlook)**: On slide load, parse the raw HTML with a
   location-aware parser (e.g. `parse5`) once; assign every element a `data-sloodge-id`; keep a
   map `id → {start, end}` byte offsets into the *original* HTML text of that slide. Never
   re-serialize the whole file to persist an edit — always patch the exact original span. This
   preserves user formatting/comments and avoids drift.
2. **In-page (not cross-origin-iframe) rendering (from stagewise)** where possible — render the
   slide directly in a webview/BrowserView we control, so hit-testing is plain
   `elementFromPoint`/`getBoundingClientRect` with no postMessage/coordinate-translation
   overhead. If sandboxing requires an iframe, mirror v0/Cursor's approach of tracking rect
   offsets and translating coordinates at the boundary.
3. **Separate "primitives" engine from UI (from react-grab)**: a small library exposing
   `getElementAtPoint`, `isEditable`/ignore-list filtering, `getSourceSpan(id)`,
   `serializeContext(id)` — reused by both the local property panel and the "ask AI about this
   element" flow.
4. **Local-first structured editing (from v0)**: build a property panel (text content, font,
   color, size/position, spacing) that mutates the DOM instantly and writes back to the source
   span synchronously via the primitives engine — **zero LLM calls**, zero latency, for the 90%
   of edits that are parametric. Reserve the LLM for generative/semantic requests ("redesign
   this slide", "make the chart pop") that don't map to a single property twiddle.
5. **Rich multi-channel context bundle for AI requests (from Cursor)**: when a request *does* go
   to the LLM, send: the exact HTML snippet (`outerHTML`), the source span/location, computed
   style summary, a screenshot of the slide (optionally frozen at request time so it matches what
   the user saw), and — if multiple elements are selected — all of them plus their relation
   ("make this match that").
6. **Human-in-the-loop apply for AI edits (from Onlook)**: show the AI's proposed patch on the
   canvas (diff or live preview) with accept/reject before committing to the slide's saved HTML,
   keeping AI writes reviewable and local direct-manipulation writes instant/unreviewed.
7. **Three-stage pipeline discipline (from stagewise)**: keep "gather context", "generate
   edit", and "write to source" as cleanly separable stages/plugins, so we can swap the LLM
   backend or add framework-specific (e.g. Reveal.js vs. plain HTML vs. Markdown-slide) context
   gatherers without touching the write-back logic.

This combination gives us: instant, free, local editing for the common case (v0's model),
precise LLM grounding for the generative case (Cursor + react-grab's context format), and a
robust, formatting-preserving write-back mechanism (Onlook's id-anchored AST/text patching)
implemented cheaply because — unlike React/JSX — our target is plain HTML with no compile step.
