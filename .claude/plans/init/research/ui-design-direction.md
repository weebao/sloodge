# Research — UI design direction (feeds roadmap M8b.0 → M8b.1–M8b.4)

Researched 2026-09-03. Three inputs: (1) every design skill installed in this environment, read in
full and quoted; (2) the review-shaped skills actually **run** against the shipped renderer
(`interfaces:better-interface` in `full` mode, `find-animation-opportunities`, `improve-animations`);
(3) internet research on Helium, desktop-tool design languages, agent design-skill repos, and
PowerPoint/Keynote's current chrome. Citations inline. Where a source could not be fetched it says so.

This document is **decisions, not a survey**. M8b.1–M8b.4 execute against it.

---

## 1. The design skills in this environment — what each prescribes for a slide editor's chrome

Read from disk at `~/.claude/skills/` and `~/.claude/plugins/marketplaces/interfaces/skills/`
(`artifact-design` and `dataviz` are bundled, loaded via the Skill tool). All quotes are verbatim.

### `interfaces:better-ui` — visual polish and micro-interaction

Prescribes: concentric radii (`outerRadius = innerRadius + padding`); **"Shadows for Elevation,
Borders for Structure"** — replace depth-faking borders with layered transparent `box-shadow`, but
explicitly **"Do not apply this to dividers … or any border whose purpose is layout separation"**;
`transition: all` is always a finding; press feedback is **always `scale(0.96)`**, "Never use a value
smaller than `0.95`"; icon stroke matches adjacent text weight (`1.5px` beside 400, `2px` beside 600);
one `currentColor` SVG per icon with states from CSS, outline default / fill active.
Relevant to sloodge's chrome: the toolbar/panel/dialog surfaces and every icon button.
Would flag today: divider-vs-elevation confusion in panel chrome, any `transition: all`, and missing
press feedback on toolbar buttons.

### `interfaces:better-layout` — structure

Prescribes: **"Group with Space, Not Lines"** — gap between groups ≥ 2× gap within a group; controls
must not be styled like adjacent static text; align to shared edges; use logical properties
(`padding-inline-start`); progressive disclosure needs a visible affordance; **"Hold Structure Until
It Breaks"** — breakpoints come from content, prefer container queries.
Crucially for us it carries an explicit density exemption: **"Preserve deliberate platform chrome,
compact professional tools, and project tokens when they remain usable under hit-area, zoom,
localization, and viewport stress tests."** So sloodge's density is not a defect — but it must survive
the stress tests. Its `12px` between bordered controls / `24px` around borderless controls are
"starting points" for products with no density system; we are entitled to a tighter, *declared* one.

### `interfaces:better-typography` — type

Prescribes: a small type scale with semantic names; **line-height by role** (headings ~`1.1`, body
`1.5`–`1.6`, and "anything that wraps to three or more lines needs at least `1.4`"); unitless
line-height; weight `400`+ below `18px` ("Thin/Light weight on `14px` UI text" is a listed mistake);
`font-variant-numeric: tabular-nums` on **any value that changes**; `-webkit-font-smoothing:
antialiased` once at the root; small uppercase labels get positive letter-spacing.
Its own UI floors: **"`14px` is a useful starting point for inputs and menus … `13px` for captions,
rarely below `12px`."** That is the ceiling on how small our chrome may go.
Relevant to sloodge: slide numbers, zoom percentage, dimensions in the arrange bar, and token/cost
counters in the chat panel are all changing numbers ⇒ all need `tabular-nums`.

### `interfaces:better-colors` — color

Prescribes OKLCH (`oklch(L C H / alpha)`, three decimals), and for Tailwind v4 **"Custom themes
should follow the same convention"** with hex in `@theme` listed as a mistake. Rules with numbers:
light/dark boundary at `L > 0.73`; foreground `L < 0.35` on backgrounds `L > 0.9`; foreground
`L > 0.9` on backgrounds `L < 0.25`; **hue drift > 10° across palette steps is visible**; APCA
`|Lc| >= 75` body / `>= 60` non-body; WCAG 4.5:1 AA. Usage rules: **one color, one meaning**; semantic
tokens named by role and used only in that role ("If a role has no token yet, add the token; don't
borrow one that happens to have the right value today"); **one filled colored action per view**;
dark mode is not a mechanical inversion; `prefers-contrast: more` should widen the L gap by ≥ `0.15`.
It also warns to preserve an existing consistent notation unless the task *is* a color-system
migration — M8b **is** that migration, so the OKLCH conversion is in scope and sanctioned.

### `interfaces:better-accessibility` — a11y

Prescribes: native elements first; **style `:focus-visible`, not bare `:focus`**, with "at least a
`2px` solid perimeter", and "Prefer the browser's unmodified focus indicator"; full keyboard paths per
ARIA APG (Escape closes, arrows move within composite widgets, **roving tabindex** for toolbars/tabs,
never positive `tabindex`); modals set `inert` on the background, move focus in, restore focus to the
trigger, and add `overscroll-behavior: contain`; hit areas — WCAG 2.5.8 AA floor **24×24 CSS px**,
"aim for 44×44px in touch contexts and **40×40px in desktop interfaces when density permits**";
icon-only buttons need `aria-label`; never color alone for status; `prefers-reduced-motion` wraps
motion so it is opt-in; the interface must survive 200% zoom.
The 24px floor with the spacing exception ("20px targets need at least a 4px gap") is the rule that
lets a dense slide-editor toolbar stay dense and still conform.

### `interfaces:better-writing` — copy

Prescribes: one voice, tone flexing with stakes ("Errors, destructive confirmations → Calm, plain,
zero playfulness"); address the reader as "you"; **verb-first buttons** and confirmations that repeat
the consequence (`Delete project`, never `Yes`/`OK`); one capitalization policy per element type with
**sentence case as the safer default**; toggles labelled for their ON state; errors say how to fix,
adjacent to the failure, with "no blame, no 'oops', no exclamation marks"; empty states orient and
offer one next action; placeholders are examples, never labels.
Relevant to sloodge: the settings dialog's Auth tab, export dialogs, the chat panel's empty state, and
every destructive confirmation (delete slide, discard changes).

### `interfaces:better-interface` — orchestration

Owns orchestration only; delegates rules to the six skills and imposes a shared severity scale
(HIGH/MEDIUM/LOW), a finding cap (5 quick / **15 full**), one-root-cause-per-row consolidation, a
mandatory **"Considered but Rejected"** table, and a Verdict. Its ranking rule matters for M8b:
**"Within a severity, rank by reach and leverage. A token or shared-component fix outranks the same
symptom in one leaf component."** That is precisely the argument for M8b.2 (tokens + primitives)
preceding the M8b.3 fan-out. Run against our renderer in §3.

### `apple-design` — fluid motion, materials, foundations

Prescribes: respond on pointer-**down** not release; 1:1 direct manipulation with `setPointerCapture`
and respect for the grab offset; **interruptibility is "the single most important principle"** —
always animate from the *presentation* value, never the target; springs over fixed durations for
anything a user can touch, with shipped values (move `damping 1.0` / `response 0.4`; drawer
`0.8`/`0.3`); momentum projection `current + (v/1000)·d/(1−d)`, `d ≈ 0.998`; **spatial consistency** —
"If something disappears one way, we expect it to emerge from where it came"; translucent materials
via `backdrop-filter` with **"Never stack a light translucent surface on another"**; scroll-edge
fades instead of 1px borders under sticky chrome; three independent a11y signals
(`prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast`); type tracking is
size-specific, never one value; **"Simplicity — not minimalism"**, and "Familiarity … things that look
the same must behave the same and live in the same place".
Relevant to sloodge: canvas drag/resize handles (velocity handoff, rubber-band at zoom limits),
the resizable chat/property panels, and present-mode transitions.
Not relevant: we are a desktop tool, not a touch OS — momentum projection and rubber-banding apply
only to the canvas, and translucency should stay minimal (see §7 non-goals).

### `emil-design-eng` — animation decision framework and component polish

Prescribes a frequency gate first: **100+ times/day ⇒ "No animation. Ever."**, tens/day ⇒ "Remove or
drastically reduce", occasional ⇒ standard, rare ⇒ delight. **"Never animate keyboard-initiated
actions."** Easing: `ease-out` for enter/exit, `ease-in-out` for on-screen movement, `ease` for
hover/color, and **"`ease-in` on UI is always a finding"**. Built-in curves are "too weak"; use
`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`,
`--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`. Durations: press `100–160ms`, tooltip `125–200ms`,
dropdown `150–250ms`, modal/drawer `200–500ms`, **"UI animations should stay under 300ms"**.
Also: never `scale(0)` (start `0.95`+ with opacity); popovers get `transform-origin` at the trigger
while **modals stay centered**; transitions over keyframes for anything rapidly re-triggered;
`transform`/`opacity` only; stagger `30–80ms`; exits softer and faster than enters.
Relevant to sloodge: this is the single most directly applicable skill we have, because a slide editor
is a *daily-use dense tool* — its frequency gate rejects most animation outright, which is the
correct answer for our chrome.

### `find-animation-opportunities` — read-only motion finder

A **filter as much as a finder**: "Expect to reject most candidates", cap 5–7 suggestions for a whole
app, and a mandatory Part 2 listing rejected candidates ("This section is what separates this skill
from an animation wishlist"). Its four-question gate is frequency → purpose (one of feedback / spatial
consistency / state indication / preventing a jarring change / explanation / delight) → speed budget →
function ("Data the user is trying to *read* or *act on* should not move for style").
Run against our renderer in §4.

### `improve-animations` — motion audit + plans

Eight audit categories (purpose & frequency, easing & duration, physicality & origin,
interruptibility, performance, accessibility, cohesion & tokens, missed opportunities) with an
explicit value catalog in its `AUDIT.md` — "Never approximate a value that appears here — copy it."
Severity: HIGH = feel-breaking (`ease-in` on UI, animation on keyboard/high-frequency actions,
`scale(0)`), MEDIUM = wrong origin / non-interruptible / missing reduced-motion, LOW = polish.
Read-only; it writes plans under `plans/`. Run against our renderer in §4.

### `animation-vocabulary` — naming glossary

A reverse-lookup glossary (Entrances & Exits, Sequencing & Timing, Movement & Transforms, Transitions
Between States, Scroll, Feedback & Interaction, Easing, Spring Animations, Looping & Ambient Motion,
Polish & Effects, Performance, Principles to Know). It names effects; it does not design them.
Relevant to sloodge only as shared vocabulary for M8b PR descriptions and the motion token comments —
so a reviewer and an implementer mean the same thing by "pop in" or "rubber-banding". No findings.

### `artifact-design` — page design fundamentals

Written for published Artifacts (HTML pages on claude.ai), so its publishing mechanics do not apply to
an Electron renderer. Four rules do transfer, and one section is directly on-point:
**"Honor what's already there … Precedence is always: the user's own words, then the project's
existing system, then your choices"** (⇒ extend `chrome-*`/`ink-*`, don't replace);
**"Choose neutrals, don't default to them. A pure mid-grey reads as unconsidered; a grey with a slight
hue bias toward the page's accent reads as chosen"**; **"Not everything is a card. Border, fill, radius
and shadow each say 'separate object' — spend them by role"**; and its
**"When it's a UI, not a document"** section: "encode state in form as well as number … Semantic color
(good / warning / critical) is separate from the accent hue and doesn't count as your accent."
Its "Avoid AI-generated design" list is a useful negative check for the slide *templates* we ship.

### `dataviz` — charts

Not about chrome at all — but it is about the **product's output**. Sloodge generates slide HTML, and
board decks are full of charts, so this skill governs the LLM's chart-slide generation, not the
editor's UI. Non-negotiables worth carrying into the slide-generation prompt and the `.sloodge`
theme's `tokens.series[i]`: **never a dual-axis chart** ("the #1 chart mistake"); categorical hues
assigned in fixed order, never cycled; sequential = one hue light→dark, diverging = two hues + neutral
gray midpoint, never a rainbow; **run `scripts/validate_palette.js` rather than eyeballing CVD safety**
(CVD ΔE ≥ 8 target, normal-vision floor < 15 is a hard fail); status colors reserved and never reused
as "series 4"; text wears text tokens, never the series color.
**Action for a later milestone, not M8b:** validate the default `.sloodge` theme's `series[]` palette
with that script. Recorded here so it is not lost.

---

## 2. Token and surface inventory of the shipped UI (the M8b.1 deliverable)

Stack: React 19.2 + **Tailwind v4.3.3, CSS-first** — there is no `tailwind.config.*` anywhere; the whole
theme is one 49-line `@theme` block in `src/renderer/src/styles/theme.css`, imported once from
`src/renderer/src/main.tsx:4`. 20 component files, ~3,600 lines of UI. Electron 43 / Chromium ~140, so
`@starting-style`, `@utility`, `transition-behavior: allow-discrete` and `startViewTransition` are all
available. **No motion library and no UI component library** — a stated zero-UI-dependency policy
(`SettingsDialog.tsx:5-6`, `ExportPptxDialog.tsx:13-15`). Every recommendation below respects that.

### 2.1 Colour tokens — all 14, with OKLCH computed

Every token is a 6-digit sRGB hex. There is **no `oklch()` anywhere in the repo.** OKLCH values below
were computed from the hexes (sRGB → linear → Oklab → OKLCH), not estimated.

| Token | Hex | OKLCH | Uses | Note |
| --- | --- | --- | --- | --- |
| `--color-chrome` | `#fafafa` | `oklch(0.985 0 —)` | 7 | raised surface (light) |
| `--color-shell-bg` | `#f3f3f3` | `oklch(0.964 0 —)` | 2 | app ground (light) |
| `--color-chrome-alt` | `#f0f0f0` | `oklch(0.955 0 —)` | 4 | hover/secondary surface |
| `--color-chrome-line` | `#e2e2e2` | `oklch(0.913 0 —)` | **47** | the workhorse hairline |
| `--color-chrome-muted` | `#5f5f5f` | `oklch(0.485 0 —)` | **43** | secondary text |
| `--color-shell-fg` | `#1b1b1b` | `oklch(0.222 0 —)` | 29 | body text (light) |
| `--color-accent` | `#c43e1c` | `oklch(0.554 0.176 34.8)` | **50** | most-used token |
| `--color-accent-soft` | `#fbe9e4` | `oklch(0.947 0.021 36.0)` | **1** | `FormatBar.tsx:144` only |
| `--color-canvas-mat` | `#7a7a7a` | `oklch(0.580 0 —)` | **1** | `SlideCanvas.tsx:73`, only at `/25` |
| `--color-ink` | `#1f1f22` | `oklch(0.241 0.006 286.0)` | 8 | app ground (dark) |
| `--color-ink-alt` | `#26262b` | `oklch(0.271 0.009 285.8)` | 16 | raised surface (dark) |
| `--color-ink-line` | `#35353c` | `oklch(0.332 0.012 285.7)` | **45** | hairline (dark) |
| `--color-ink-fg` | `#e6e6ea` | `oklch(0.926 0.005 286.3)` | 30 | body text (dark) |
| `--color-ink-muted` | `#a0a0aa` | `oklch(0.709 0.014 286.0)` | 40 | secondary text (dark) |

`—` means hue is meaningless because chroma is exactly `0`.

**Two structural facts fall straight out of the OKLCH column:**

1. **The light neutrals are pure grey (`C = 0.000`); the dark neutrals are violet-tinted
   (`H ≈ 286`, `C = 0.005–0.014`).** The two modes are not the same family. `artifact-design` names
   this exactly: *"A pure mid-grey reads as unconsidered; a grey with a slight hue bias toward the
   page's accent reads as chosen."* Light mode is the unconsidered half, and it is the *default* half.
2. **The lightness ramp is uneven.** Light surfaces sit at `L` = 0.985 / 0.964 / 0.955 / 0.913 — the
   `chrome`→`shell-bg`→`chrome-alt` steps are `0.021` and `0.009` apart, i.e. **three surfaces that are
   very nearly the same colour**, then a `0.042` jump to the hairline. Dark surfaces sit at
   0.241 / 0.271 / 0.332 — spacing `0.030` and `0.061`. Neither is a designed ramp.

**There is no token at all for:** focus ring, shadow, radius, spacing, font size, line-height,
z-index, duration, easing, or semantic success/warning/danger. All of those are Tailwind defaults or
one-offs.

### 2.2 Measured contrast — two real failures

WCAG 2.1 contrast ratios, computed:

| Pair | Ratio | Verdict |
| --- | --- | --- |
| `shell-fg` on `chrome` | 16.50:1 | pass |
| `ink-fg` on `ink` | 13.21:1 | pass |
| `chrome-muted` on `chrome` | 6.12:1 | pass |
| `ink-muted` on `ink` | 6.34:1 | pass |
| white on `accent` | 5.18:1 | pass |
| `accent` on `chrome` | 4.96:1 | pass (AA text) |
| `accent` on `shell-bg` | 4.67:1 | pass (AA text) |
| `accent` on `accent-soft` | 4.41:1 | large/UI only |
| **`accent` on `ink`** | **3.17:1** | **fails AA text** |
| **`accent` on `ink-alt`** | **2.90:1** | **fails AA text *and* the 3:1 non-text floor** |

**The accent is a light-mode-only colour, and this is now measured rather than asserted.** It is why
`MenuTabStrip.tsx:13` falls back to `dark:text-ink-fg` and why `FormatBar.tsx:144` goes
`dark:bg-transparent` — two components independently worked around the same missing token. Any focus
ring, selected-state text, or link built on `accent` fails in dark mode today.

Solved, keeping hue and chroma and moving only lightness (as `better-colors` prescribes): a dark-mode
accent at **`oklch(0.670 0.176 34.8)` = `#ed6444`** gives **4.67:1 on `ink-alt`** and **5.10:1 on
`ink`**. Gamut is fine — max sRGB chroma at that hue peaks near `C = 0.229` at `L = 0.65`, so both the
light `C = 0.176` and this variant sit comfortably inside sRGB.

### 2.3 Radii, shadows, type, spacing, z-index

**Radius** — four distinct values, no token: `rounded` (0.25rem) ×32, `rounded-sm` (0.25rem) ×2,
`rounded-md` (0.375rem) ×6, `rounded-lg` (0.5rem) ×7, `rounded-t` ×3, `rounded-full` ×9. Note
`rounded` and `rounded-sm` are **identical in v4** — `ThumbnailRail.tsx:173` vs `:179` reads as
deliberate differentiation in source and paints the same.

**Shadow** — five levels, none tokenised, none dark-adjusted (Tailwind shadows are black-alpha, so
they are invisible on the `#1f1f22` ground): `shadow-sm`, `shadow-md`, `shadow-lg`, `shadow-xl`, plus
one bespoke two-layer `shadow-[0_1px_2px_rgba(0,0,0,0.12),0_8px_24px_rgba(0,0,0,0.10)]` on the canvas
slide (`SlideCanvas.tsx:92`).

**Type** — `body` is `13px` with **no `line-height`** (`theme.css:31-42`), so the entire app runs on
the UA's `normal` (~1.2). Sizes are arbitrary px: `text-[12px]` ×25, `text-[13px]` ×23, `text-[11px]`
×21, `text-[15px]` ×2 — a real, if undeclared, 4-step scale — **except** `ExportPptxDialog.tsx`, which
uses the rem scale (`text-lg`/`text-sm`/`text-xs`) instead. Weights: 400 ×1, 500 ×14, 600 ×11, 700 ×1.
`tabular-nums` appears **twice** (`ThumbnailRail.tsx:177`, `PresentControls.tsx:69`) — the zoom
percentage, arrange-bar dimensions, cost and issue counters all lack it.

**Font stack**: `'Segoe UI', system-ui, -apple-system, sans-serif` at 13px with `antialiased`
(`theme.css:34-39`). Segoe UI first means macOS/Linux fall through to `system-ui` — the app is
optically tuned for Windows. **No webfont is bundled** (verified: no font files, no `@font-face`, CSP
is `font-src 'self' data:`). The exported presenter shell uses a *different* stack and base size
(`14px/1.4 system-ui, …`, `presenter-shell.ts:279`) — a divergence worth closing.

**Spacing** — Tailwind's default `--spacing: 0.25rem`, unmodified. Most-used: `px-3` ×22, `py-1` ×16,
`px-2` ×16, `gap-2` ×15, `gap-1` ×15, `py-0.5` ×10. Plus ~12 assorted one-off `m*` nudges (`mt-0.5`,
`mb-px`, `ml-0.5`, …) that are the signature of spacing done by eye.

**Z-index** — no scale. `z-50` is claimed independently by four surfaces (slide context menu, settings
backdrop, PPTX backdrop, present surface) with **no ordering contract between them**; `z-10` twice.

### 2.4 Motion — the whole inventory is 13–14 declarations

`transition-colors` ×10, `transition-opacity` ×2, `duration-300` ×1 (the only explicitly chosen
duration in the app), `animate-pulse` ×1. **No `ease-*`, no `transition-transform`, no enter/exit
animation, no stagger, no `@keyframes` of our own, no `transition: all`, no `scale(0)`.** Effective
values are Tailwind defaults nobody chose (`150ms cubic-bezier(0.4, 0, 0.2, 1)`).

**`prefers-reduced-motion` appears exactly once in the whole repository** —
`src/shared/export/presenter-shell.ts:307` — and it governs the *exported* HTML bundle, not the app.
The renderer has no reduced-motion handling, and its one unbounded animation (`animate-pulse`) is
unguarded.

### 2.5 Proven inconsistencies

- **(a) `ExportPptxDialog.tsx` is a second design system.** It uses **none** of the tokens and has
  **no `dark:` classes at all** — `neutral-*` and `amber-*` throughout, `bg-neutral-900` primary
  button, rem type scale. In dark mode it is a white card in a dark app. Compare with
  `SettingsDialog.tsx`, built for the same job: different surface, border, title size, body colour,
  primary button, and full dark support. They share only the backdrop.
- **(b) Two near-identical button recipes** — `FormatBar.tsx:16` (`BUTTON_BASE`) and
  `ArrangeBar.tsx:20` (`BUTTON`) are the same string modulo `px-2` vs `w-7`.
- **(c) Four "primary accent button" variants** (`ChatPanel.tsx:175`, `:290`, `AuthTab.tsx:199`,
  `SettingsDialog.tsx:211`) differing in size, hover and disabled handling — and **four disabled
  opacities** for the same state: `opacity-30`, `-40`, `-50`, `-60`.
- **(d) Six hover mechanisms coexist** (border-only, background tint, full accent fill, text-colour,
  opacity, and a hover *ring* at `ColorControls.tsx:96`). `active:` exists on **exactly one element**
  in the entire app (`FormatBar.tsx:16`) — nothing else has a pressed state.
- **(e) One `focus-visible` in the whole renderer** (`ThumbnailRail.tsx:173`), and it has a bug:
  `ring-offset-1` with no ring-offset colour resolves to Tailwind's default `#fff`, so a focused
  thumbnail gets a **white halo on the dark ground**. Two inputs replace the outline with a 1px border
  colour swap (`ChatPanel.tsx:122`, `PropertyPanel.tsx:309`) — a much weaker indicator, and the only
  focus signal those inputs have. ~40 other interactive controls rely on the unstyled UA default.
- **(f) A broken token reference** — `dark:bg-ink-bg` at `PropertyPanel.tsx:309`. **`--color-ink-bg`
  does not exist**, so it compiles to nothing and every property-panel input stays white in dark mode.
- **(g) Icons are three sizes and two media.** SVG at `h-3`/`h-3.5`/`h-4` with stroke width `1.4` in
  two files and unset (=1) in two others — plus **emoji and dingbats used as icons**: `✦ ⬚ ➤ ◼ ● ⊕ × ⚠
  ✨ 💧 ◀ ▶ ⏹ ›`. Those render in the OS emoji font at the parent size and cannot match the SVG set's
  weight or optical size.
- **(h) Semantic colour has no home.** Error is spelled three ways (`red-300/50/800` +
  dark twins; `red-600`/`red-400`; nothing at all in the PPTX dialog); warning two ways
  (`amber-500/50` vs `amber-50`). No success colour exists in the chrome at all.
- **(i) The accent inverts meaning between modes** — see §2.2. Measured, not asserted.
- **(j) `bg-white` and `bg-chrome` are two names for "raised surface"** and take *different* dark
  partners (`dark:bg-ink` in five places, `dark:bg-ink-alt` in three).

---

## 3. What the review-shaped skills found when actually run against our code

These are the highest-value findings in this document, because they are specific to our files.

### 3.1 `find-animation-opportunities` + `improve-animations`

**Verdict first, because it is the surprising one:** *"This interface needs very little motion, and it
is much closer to right than most React apps of its age — mostly by omission rather than by decision,
but the omissions are in the right places."* The high-frequency surfaces (selection overlay, property
panel, thumbnail selection, typing) are correctly bare and should **stay** bare. This is not an
over-animated app to rein in; it is an under-specified one with four genuine gaps.

**Findings, vetted at `file:line`:**

| # | Sev | Location | Finding |
| --- | --- | --- | --- |
| F1 | **HIGH** | renderer-wide | `prefers-reduced-motion` appears **zero times** in `src/renderer/src/`. No `@media` motion block exists for a guard to land in, and `animate-pulse` runs unbounded and unguarded. |
| F2 | **HIGH** | `present/PresentSurface.tsx:156-163` | `key={current.id}` on `<SlideFrame>` makes React **unmount and remount the iframe on every slide advance**, re-minting a `slide://` URL and reloading the document. `SlideFrame.tsx:79-81` documents this exact hazard for the resize path and guards it there; navigation reloads by construction. In front of an audience this is a hard cut **plus a load flash**. The export has the same gap: `presenter-shell.ts:282-286` keeps both frames mounted and toggles `.is-active` but declares **no transition** on the opacity swap. |
| F3 | MEDIUM | `present/PresentControls.tsx:42-44` | `duration-300` with Tailwind's default curve — whose ease-**in** first half delays the reveal at exactly the moment the presenter moved the mouse *asking* for the controls. Also symmetric: appear is a response (should snap), hide is a dismissal (can be leisurely). |
| F4 | MEDIUM | `deck/ThumbnailRail.tsx:179` | One `transition-colors` covers the hover border **and** the selection ring. Slide selection is core navigation, 100+/day, keyboard-reachable via Alt+Arrow — the canvas swaps instantly while the ring fades in over 150ms, which reads as lag. `emil-design-eng`'s gate is unambiguous here: 100+/day ⇒ no animation. |
| F5 | MEDIUM | `chat/ChatPanel.tsx:250-252` | `animate-pulse` is a **2s** cycle — too slow to read as "working"; at any glance the dot looks static, the opposite of what a liveness indicator is for. The markup (`inline-flex gap-0.5` around a single `●`) already anticipates more than one dot. |
| F6 | MEDIUM | `theme.css:6-22` | No motion tokens. Ten `transition-colors` sites inherit Tailwind defaults *by accident*; the one deliberately chosen value is hand-typed at its use site — while its sibling `PRESENT_CONTROLS_HIDE_MS` **is** properly centralised in `shared/present/machine.ts`. |
| F7 | LOW | `chat/ChatPanel.tsx:54-57` | Not a defect — a **landmine**. The scroll-pin effect depends on `transcript.messages`, so it re-runs on every streamed token. Anyone adding message motion will reach for `scrollTo({ behavior: 'smooth' })`, and a smooth scroll retargeted every ~50ms never settles. Record the constraint in-code. |

**Checked and clean:** no `transition: all`, no own `@keyframes`, no `scale(0)`, no animated
layout properties, no transform-origin errors (both dialogs are modals — correctly centred, and the
skills explicitly exempt modals), and the three `requestAnimationFrame` sites
(`useDragGesture.ts:133`, `useRotateGesture.ts:96`, `useMarqueeGesture.ts:101`) are pointer-event
coalescing for direct manipulation, which is exactly right and **must not** be converted to CSS.

**The six motion opportunities that survived the gate**, in leverage order — present-mode slide
cross-fade (180ms `--ease-out`, both frames mounted); dialog enter/exit (backdrop `150ms linear`,
panel `200ms` opacity + `translateY(6px) scale(0.98)`, exit `140ms` — faster than entry); chat message
arrival (`160ms`, mount-only via `@starting-style`, never re-run during streaming); Present overlay
enter/exit (`220ms` in, `140ms` out — *"entering a talk is a commitment, escaping one is an
emergency"*); rail drag-reorder via `startViewTransition` (200ms); and the arrange bar's appearance
(120ms, near-imperceptible tier only, because of its frequency).

**The rejections matter as much as the suggestions** — these are places the skills considered and
deliberately refused:

- `SelectionOverlay.tsx:465-590` — selection box, 8 resize handles, rotate handle, hover outline,
  marquee, smart guides. *"100+/day, and these are direct-manipulation affordances. A transition on
  the selection box makes the handles lag the cursor during a drag; a fade on a snap guide means the
  guide arrives after the snap it exists to explain."*
- `PropertyPanel.tsx:143` — mounts/unmounts on every selection, **and changes the canvas height**, so
  animating it would slide the slide itself under the user's pointer mid-edit.
- `ThumbnailRail.tsx:161-163` — the drop-edge indicator tracks the pointer during a drag; anything
  that fades in behind the cursor makes the drop target ambiguous exactly when precision matters.
- `SlideContextMenu.tsx:132-145` — a scale-in would be textbook, but it is **rejected on two counts**:
  we imitate PowerPoint on Windows, where OS context menus do not animate; and `:64-69` does a
  `useLayoutEffect` flip measurement that an entrance transform would race. A correctness risk, not
  just a cost.
- `SlideCanvas.tsx:41` — the fit scale is driven by a continuous `ResizeObserver`, so a transition
  would lag every window drag by its own duration.
- Toolbar press feedback — rejected because the FormatBar buttons are `aria-disabled` stubs that do
  nothing, and for the live align/distribute buttons *the real feedback is the elements moving*.

**One security constraint that must travel with the rail-reorder ticket:** any
`view-transition-name` must derive from the card **index, never the slide id** —
`ThumbnailRail.tsx:267-269` records that slide ids are attacker-influenced and are deliberately kept
out of CSS selector strings; the same rule applies to CSS custom idents.

### 3.2 `interfaces:better-interface`, full mode, over `src/renderer/src/`

Verdict: **Block** — three HIGH findings. The reviewer's own summary is worth keeping, because it
calibrates the rest: *"The chrome is genuinely well built: the drop-target reasoning in the rail, the
undo-coalescing discipline in `ColorControls`, the dirty-guard state machine in Settings, and the
sandbox commentary in `SlideFrame` are all above the bar for this stage, and the density is deliberate
rather than careless."* The problems are concentrated, not diffuse.

**The three blockers:**

- **H1 — Design Mode is pointer-only, end to end** (`SelectionOverlay.tsx:465-475`, `:353-384`).
  Selection is created exclusively by `requestHit(...)` from a mouse event; there is no key handler
  anywhere in the overlay, and the only keyboard-reachable control is an `sr-only` "Clear selection"
  button. Because `PropertyPanel` renders only when `selection !== null` (`:143`) and `ArrangeBar`
  only when `selections.length >= 2` (`:138`), a keyboard user also cannot reach the ten property
  fields, the colour controls, Flip/Duplicate, "Ask Claude about this element", or any
  align/distribute action. The eight `h-2 w-2` handles additionally fail WCAG 2.5.8 on any element
  under ~48px, where adjacent handles sit closer than 24px so the spacing exception does not apply.
  The codebase already accepted this obligation for the rail (`ThumbnailRail.tsx:129-147` adds
  Alt+Arrow reorder for exactly this reason); Design Mode never got the equivalent.
  **This is the app's differentiating feature and it needs its own milestone, not an M8b PR.**
- **H2 — the `ink-bg` typo renders the entire property panel unreadable in dark mode**
  (`PropertyPanel.tsx:309`). Verified by compiling `theme.css` through the project's own
  `node_modules/tailwindcss` v4.3.3: `bg-ink-bg` **emits no rule at all**, so the input keeps
  `bg-white` while `dark:text-ink-fg` (`#e6e6ea`) applies — **1.24:1**. Every value in Text, Size,
  Weight, Colour, Fill, Stroke, X, Y, W and H is invisible in dark mode, in the panel whose entire
  purpose is reading and editing those values. One-word fix; ship it immediately.
- **H3 — no modal traps focus and none marks the background `inert`** (`SettingsDialog.tsx:136-144`,
  `ExportPptxDialog.tsx:65-71`, `PresentSurface.tsx:148-155`). All three declare
  `role="dialog" aria-modal="true"`, which hides the background from *some* screen readers and does
  nothing for the keyboard. From the PPTX dialog a keyboard user tabs straight into the rail, format
  bar and chat composer and can operate them while the modal is up — and it has **no Escape handler**,
  so there is no keyboard exit at all. In Present, Tab lands on editor chrome that is not on screen.

**The MEDIUMs worth carrying into M8b** (the rest are folded into §6):

| # | Domain | Location | Finding |
| --- | --- | --- | --- |
| 4 | A11y | `FormatBar.tsx:69`, `ArrangeBar.tsx:142`, `ThumbnailRail.tsx:345-370` | Both bars declare `role="toolbar"` — which **promises arrow-key navigation** — and deliver none. The rail is the costly one: one `<button>` per slide means a 40-slide deck is 40 tab stops, and PowerPoint's arrow-key slide navigation, the muscle memory this UI deliberately mimics, is absent. `SettingsDialog.tsx:167` already implements the tabIndex half of roving tabindex and is the model. |
| 5 | Layout | `ThumbnailRail.tsx:339`, `ChatPanel.tsx:88`, `AppShell.tsx:141-153` | `w-[188px] shrink-0` + `w-[320px] shrink-0` = **508px of fixed chrome against a 1024px minimum window** (`src/main/index.ts:18`) — 50% of the app, leaving the slide ~468px (a 0.37 scale). No collapse, no splitter, no breakpoint, **zero** `sm:`/`md:`/`lg:`/`@container` in the renderer. At 200% zoom the two panels consume the entire effective viewport and the canvas disappears. |
| 9 | Colors | `AuthTab.tsx:193`, `:245`; `ChatPanel.tsx:122` | Credential inputs are `bg-chrome` inside a `bg-chrome` panel — fill contrast **1.00:1**. The field is defined solely by a `#e2e2e2`-on-`#fafafa` border at **1.24:1**, far under WCAG 1.4.11's 3:1 for identifying a UI component. The app's two most important text-entry targets do not read as controls, and one of them is where the user pastes a credential. |
| 10 | A11y | `SettingsDialog.tsx:103-109` | Settings arrow-key navigation **breaks after one press**. `onTabKeyDown` dispatches `select-tab` but never calls `.focus()`, so focus stays on the old button, which `:167` then sets `tabIndex={-1}` — focus is now outside the roving order. A second ArrowRight recomputes the same target, which `settingsState.ts:59` short-circuits as already-selected, so nothing happens. |
| 11 | A11y | `PresentControls.tsx:41` | `aria-hidden` on a wrapper containing three **enabled** buttons — the exact anti-pattern `better-accessibility` names. After the idle fade, Tab focuses invisible buttons with no announced name. Fix is one attribute: `inert` instead of conditional `aria-hidden`, which also makes the `pointer-events` juggling unnecessary. |
| 12 | A11y | `ChatPanel.tsx:94-99` + `useChatSession.ts:69-71` | `aria-live="polite"` over a **token-by-token stream** queues one announcement per chunk, so a screen-reader user hears the answer re-read from the top dozens of times per turn — the message gets *less* accessible the longer it is. Drop `aria-live` (`role="log"` already implies polite), set `aria-busy` while streaming, and announce once per turn boundary from a separate `role="status"`. |
| 13 | Writing | 13 sites | **`"(not wired up yet)"` is developer build-status language shipped to users** on 12 toolbar buttons + Present — and it appears only on hover, so those buttons look and behave live at rest. `placeholder='mixed'` actively misleads: in every design tool it means "multiple differing values", but here it fires when the element simply has no editable text. `aria-label="W"`/`"H"` are announced as letters. Plus one inconsistent-case pass: `sloodge` lowercase in the title bar and capitalised elsewhere, `theme:` lowercase beside sentence-case `Slide 1 of 3`, and the ungrammatical `1 issues`. |
| 15 | UI | `ColorControls.tsx:192`, `PropertyPanel.tsx:181` | The `💧` and `✨` **colour emoji cannot take `currentColor`**, so they ignore hover, disabled and dark mode while every other icon responds to all three, and they render as a different typeface at a different optical weight per OS. |

**The reviewer's "Considered but Rejected" table is as valuable as the findings**, because it tells
M8b what *not* to touch:

- **Chrome density is correct and stays.** `text-[11px]` at `h-7` was measured, not assumed defective:
  `chrome-muted` on `chrome` is **6.12:1** and `ink-muted` on `ink` is **6.34:1**, both comfortably
  past 4.5:1. *"`better-layout` explicitly preserves compact professional tools."*
- **The 20px theme swatches stay.** 20px at a 4px gap puts centres exactly 24px apart, so the
  24px circles are tangent and do not intersect — WCAG 2.5.8's spacing exception is met.
- **The chat context-chip `×` stays small.** Spacing exception applies, and a missed click costs
  nothing because the chip self-clears on send and on slide switch.
- **The `sr-only` labels on the credential inputs stay.** Each sits under its own visible `<h3>`, has
  a real `<label for>`, and the placeholder shows format rather than substituting for the label.
- **Do NOT split the accent into per-role tokens.** *"A single strong accent across chrome is the
  convention in this tool class (Figma's blue, VS Code's `focusBorder`), and each use here is
  disambiguated by shape and position rather than hue, so `better-colors`' 'one color, one meaning'
  is not actually violated."* The actionable part is the accent's **contrast on dark**, not its reuse.

**One open risk flagged, not a defect today:** the renderer uses physical `border-r`/`border-l`/
`ml-auto` throughout and does not target RTL. Worth a decision before localisation.

---

## 4. Internet research

Two evidence classes are marked throughout: **[PUB]** the project wrote it down, **[MEAS]** shipped
CSS/source was downloaded and read. Fetch failures are stated, not papered over.

### 4.1 Helium — the repo the user named

**What is and isn't there.** The repo (https://github.com/imputnet/helium, 20.1k★) has **no `docs/`
folder and no design document**; the README
(https://raw.githubusercontent.com/imputnet/helium/main/README.md) contains **zero design-language
content**. The HN launch thread (https://news.ycombinator.com/item?id=45366867) is entirely about
Chromium monoculture and privacy — **no UI discussion**. DeepWiki's philosophy page
(https://deepwiki.com/imputnet/helium/1.1-project-goals-and-philosophy) explicitly notes the project
*"doesn't explicitly discuss UI minimalism"* as a goal. **Helium's minimalism is practiced, not
theorised** — it lives in the marketing copy and, decisively, in the patch set. That patch set is the
real find, and it is unusually legible because each patch is a diff against Chromium's own constants.

**Stated intent [PUB]** (https://helium.computer/): *"Privacy-first browser without distractions"*;
*"The calmest browser, by default"*; *"Helium is designed to get out of your way. It's compact,
minimalistic, and doesn't invade your workflow with clutter."*

**The four transferable moves, from the patches:**

1. **One base unit, and every chrome dimension derived from it.**
   `layout-constants.patch` introduces **`kHeliumBasePadding = 3`** and re-derives Chromium's
   constants from it. Selected verbatim diffs: `kLocationBarHeight` **34 → 28**;
   `kToolbarButtonHeight` **34 → 28**; `kTabHeight` 34 → 31; `kToolbarDividerWidth` **2 → 1**;
   `kToolbarElementPadding` 4 → base (3); `kLocationBarMargin` 9 → base×2 (6); `TOOLBAR_BUTTON` insets
   **7 → 4**; `kLocationBarChildCornerRadius` **12 → 6**.
   **Icon sizes stay at 16px — the button *padding* absorbs the 18% height reduction.** That is the
   single most useful sentence in this whole section: *cut padding, not glyphs.*
2. **A tight, flat radius ramp with no pills.** `layout-provider.patch` adds a token
   **`kMSmall = 7px`** between XSmall (4) and Small (8), then remaps buttons from `kFull` (pill) to
   7px and all dialogs/menus to 8px; tab-strip controls go from circular to a fixed 8px.
   **Nothing in Helium's chrome is a pill; everything sits at 4–8px.**
3. **Remove ornament, by name.** The patch filenames are the design statement:
   `disable-ink-ripple-effect.patch`, `remove-toolbar-corners.patch`, `remove-toolbar-dividers.patch`,
   `square-interstitial-buttons.patch`, `reduce-text-button-height.patch`,
   `remove-dead-toolbar-actions.patch`. Ripples are killed globally (`kUseRipples = false`) — **no
   press-feedback animation at all** — and the extensions-container `ToolbarDivider` is *deleted* from
   `ToolbarView::Init()`. Separation by spacing, not lines.
4. **Desaturate the neutrals so one accent reads.** `helium-color-scheme.patch` replaces Chromium's
   saturated cyan-blue secondary ramp (`#00639B`, `#047DB7`, `#3998D3`) with a near-neutral blue-grey
   (`#5A5D72`, `#73768B`, `#8D8FA6`, `#A8AAC1`, `#C3C5DD`).

**Zen/Frameless mode is a ready-made spec for auto-hiding chrome over a canvas**
(https://deepwiki.com/imputnet/helium/6.10-zen-mode-and-experimental-ui): hides toolbar, tab strip and
bookmarks; reveals on a **6px edge trigger**; **200ms** on `FAST_OUT_SLOW_IN_3`; **150ms** grace after
leaving the hover area and **3000ms** grace after the cursor leaves the window; either half pinnable.
Compare sloodge's `PRESENT_CONTROLS_HIDE_MS = 2500` — we already independently landed in the same
range.

> **The validation that matters most: Helium's deliberate, hard-won control height is 28px. Sloodge's
> `h-7` is 28px.** Our density is already correct — it was arrived at by copying PowerPoint, and it
> matches what a minimalism-obsessed browser reached by subtraction. §6 therefore contains **no**
> "make it roomier" item.

### 4.2 Desktop productivity chrome, 2025–26

**Linear** is the richest source because both its site and Electron client ship readable CSS.
[PUB] *"LCH has the benefit that it's perceptually uniform"*, and 98 theme variables were collapsed to
**three inputs: base colour, accent colour, contrast**
(https://linear.app/now/how-we-redesigned-the-linear-ui). The 2025 refresh moved the default *"from a
cool, blue-ish hue"* to *"a warmer gray"*, under the governing line **"Structure should be felt not
seen"** — sidebar *"a few notches dimmer"*, *"smaller icons, muted inactive text"*, and **"fewer
separators"** (https://linear.app/now/behind-the-latest-design-refresh).
[MEAS] Surface ladder `--color-bg-level-0..3` = `#08090a → #0f1011 → #141516 → #191a1b` dark,
`#fff → #f8f8f8 → #f4f4f4 → #f0f0f0` light — **~5-point luminance steps carry elevation, not
shadows**; shadow tokens exist but one theme context redefines all four to `--shadow-none`.
Radius usage histogram is dominated by **2, 3, 8, 6, 4px**; `--control-border-radius: 4px`.
Motion: `--speed-quickTransition .1s`, `regular .25s`, `slow .35s`, and tellingly
**`--speed-highlightFadeIn 0s` / `--speed-highlightFadeOut .15s`** — *instant in, eased out*. Of 116
`transition-duration` uses in the app, **42 are `0s`**. Panels: **sidebar 244px collapsing to an 8px
gutter (not 0)**, inspector panes **400px**. No `--space-*` tokens exist; usage is a 4px grid with 2px
nudges and 12px as the workhorse.

**Raycast** [MEAS] ships an 8px scale with named half-steps (`4, 8, 12, 16, 20, 24, 32 …`),
`--radius-md: 6px`, and a theme contract of exactly **12 colour slots** — `background`,
`backgroundSecondary`, `text`, `selection`, `loader` + 7 semantic hues, with **no border token at
all**; separation is two surfaces (https://themes.ray.so). [PUB] a list row is
`icon | title | subtitle | accessories[]`, and *"when a detail pane is open… it is recommended not to
show any accessories on the List.Item"* — **row and inspector must not duplicate information**
(https://developers.raycast.com/api-reference/user-interface/list).

**Figma UI3** [PUB] is the important counter-example: UI3 **added chrome back** — *"backgrounds on
inputs, borders around dropdowns, rounded corners"* — for usability
(https://www.figma.com/blog/behind-our-redesign-ui3/). Also *"All layout-related options, including
width, height, and Auto Layout, are now merged into a single panel"*, and *"component controls like
variants and instances deserved top billing above attributes like color and size"*. Their
**⌘⇧\ Minimize UI** behaviour is directly worth stealing: when minimised and an object is selected,
**the right sidebar auto-re-expands for property editing while the left stays collapsed**
(https://help.figma.com/hc/en-us/articles/360039831974). Figma publishes **no** spacing, type, radius
or motion numbers — do not invent any.

**Superhuman** [PUB] has the strongest keyboard doctrine: *"every interaction should be faster than
100ms"*, targeting *"less than 50ms whenever possible"*
(https://blog.superhuman.com/superhuman-is-built-for-speed/). Its five command-palette rules —
availability, centralisation, **omnipotence** (*"access to every possible action"*), flexible fuzzy
matching with aliases rendered as **"Mark Done (Archive)"**, and **contextual relevance by boosting
scores, not hiding commands** — plus the layout detail that **~5 results show with the last
intentionally clipped** and the shortcut sits on the right of every row *so the palette teaches its
own shortcuts* (https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/).

**Warp** [PUB] themes its entire chrome from **one accent + one background + one foreground**, with
separation from *"the theme background color, the opposite overlay color and an outline"* — a white
overlay on dark themes, black on light
(https://www.warp.dev/blog/how-we-designed-themes-for-the-terminal-a-peek-into-our-process).

**Zen** (stand-in — **Arc has no design-system publication and is sunset**) [MEAS] derives nested radii
rather than hand-picking them: `--zen-border-radius: 7px`, and
`--zen-native-inner-radius: max(5px, calc((var(--zen-border-radius) - var(--zen-element-separation)/2) * 1.3))`.
All chrome colour derives from one `--zen-primary-color` via `color-mix()`/`light-dark()`; interactive
surfaces are `currentColor` at 8%/15% alpha. Motion 0.08s / 0.1s / 0.15s. **Pure system font stack, no
webfont.**

**Notion** [MEAS] uses **warm** neutrals (`#f9f8f7 / #f0efed / #e6e5e3`) and ships **two parallel
shadow families** — plain, and one with a `0 0 0 1px` ring baked in
(`--c-shaOutMd: 0 0 0 1px #383836, 0 4px 12px -2px rgba(25,25,25,.08)`). Focus ring is a triple stack:
`0 0 0 2px {bg}, 0 0 0 4px #2383e2, 0 0 0 6px {bg}`.

**Cursor: nothing citable.** No design system or chrome writeup; its chrome is inherited from VS Code.
Cite only as "VS Code lineage" or drop it.

**Convergences safe to build on:** a 4px grid with deliberate off-grid nudges (not a pure 8px grid);
**separation ladder = whitespace → tone → hairline → shadow, and never a border *and* a floating
shadow on the same element**; dark surface steps are tiny (4–8 points); one accent for
selection/focus/primary with semantic hues never touching chrome; chrome motion 80–250ms with
instant-in / eased-out state feedback; radius 2–6px on controls, 8–12px on panels; dense-UI body text
12–15px.

**A caution worth recording:** sites like `designmd.cc`, `getdesign.md` and `open-design.ai` publish
confident token tables for these companies that are machine-generated and in several cases
**contradicted by the shipped CSS**. Every number above is either [PUB] or read from source.

### 4.3 Design-skill repos on GitHub

| Repo | ★ | What it is |
| --- | --- | --- |
| https://github.com/anthropics/skills | 173k | Official; includes `frontend-design`, `theme-factory`, `brand-guidelines` |
| https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | 124k | Searchable UX rule corpus (+ a `slides` skill) |
| https://github.com/ComposioHQ/awesome-claude-skills | 74k | Index only |
| https://github.com/s0xDk/refactoring-ui-skill | 507 | *Refactoring UI* distilled into hard rules |
| https://github.com/bitjaru/styleseed | 939 | 23-skill engine; **the only one that carves out desktop density** |
| https://github.com/dominikmartn/nothing-design-skill | 2.7k | One opinionated language |

**`anthropics/frontend-design`** prescribes almost no numbers and is entirely anti-convergence — it
names the three AI clichés verbatim, including *"a warm cream background (near #F4F1EA) with a
high-contrast serif display and a terracotta accent"*, and warns *"extra animation contributes to the
feeling that the design is AI-generated."* It requires a written plan (4–6 named hex values, 2+ type
roles, layout as prose, one "signature" element) before any code, and *"Spend your boldness in one
place."*

**`refactoring-ui-skill`** is the most numerically prescriptive and directly contradicts Tailwind's
defaults: spacing `4 8 12 16 24 32 48 64 96 128 …` with **"No two adjacent values may be closer than
~25%"**, type `12 14 16 18 20 24 30 36 48 …`, **two weights only**, *"Nothing below 400 in UI"*,
*"Three text colors, maximum"*, and exactly five shadows. Its diagnostic table is the useful artefact:
*"Busy, boxed-in"* → *"Too many borders… If you have both a border and a background change, drop the
border"*; *"1px border either invisible or harsh"* → *"Keep the soft color, go to 2px."* It also
states plainly: ***"Dense UIs (dashboards) are legitimate — but as a deliberate decision, not a
default."***

**`styleseed/CRAFT-BASELINE`** is the only repo that explicitly protects our case:
*"Dense desktop UI may use 13–14px for metadata, table chrome, timestamps"* and *"pointer-first dense
desktop controls may be smaller [than 44px] when still operable."* Its separation ladder —
*"whitespace, then tone, then hairline, then shadow. Do not combine a visible border and floating
shadow"* — matches the industry convergence above.

**`nothing-design-skill`** contributes one line worth adopting outright: **"If a divider line is
needed, the spacing is probably wrong."**

**The most repeated prohibition across every repo: do not use emoji as icons.** That is finding #15
in §3.2, arrived at independently.

**Honest gap:** these repos are written for marketing pages and consumer apps. Apart from styleseed's
two carve-outs, **almost nothing in them addresses dense desktop chrome.** They are a cross-check, not
an authority, for sloodge.

### 4.4 PowerPoint and Keynote — the product brief's own reference

**Every hard number in this space comes from Fluent 2.** Office itself publishes only icon sizes and a
Windows-7-era figure; Apple publishes only a type ramp, a tracking table, a 1pt divider and a 35% dim.

**Fluent 2 tokens [PUB]** (from `microsoft/fluentui` source, which is authoritative where the docs
site disagrees):

- **Spacing** — `None 0, XXS 2, XS 4, SNudge 6, S 8, MNudge 10, M 12, L 16, XL 20, XXL 24, XXXL 32`.
  The docs say *"The base unit is four pixels"* and, crucially, ***"The values 2, 6, and 10 account
  for extra padding in the Fluent icons"*** — the off-grid nudges are deliberate, not sloppy.
- **Radius** — `None 0, Small 2, Medium 4, Large 6, XLarge 8, 2XLarge 12 …, Circular 10000px`, with
  the rule: *"corner radiuses on rectangle shapes are 4 pixels by default. For shapes smaller than 32
  pixels, the corner angle is reduced to 2 pixels."* (Docs and code disagree on Large: 8 vs 6.)
- **Type** — `fontFamilyBase: 'Segoe UI', …` (**exactly sloodge's stack**), with **body1 = 14/20**;
  ramp 10/14, 12/16, 14/20, 16/22, 20/28, 24/32 …; weights 400/500/600/700.
- **Motion** — durations `UltraFast 50, Faster 100, Fast 150, Normal 200, Gentle 250, Slow 300,
  Slower 400, UltraSlow 500`; curves `DecelerateMid cubic-bezier(0,0,0,1)` for **enter**,
  `AccelerateMid (1,0,1,1)` for **exit**, `EasyEase (0.33,0,0.67,1)` for move. Prose: *"Give larger
  elements more time"*; top-level nav should *"use a quick fade… instead of moving or sliding."*
- **Elevation** — every level is a tight ambient ring **plus** an offset key shadow:
  `shadow2: 0 0 2px A, 0 1px 2px K` … `shadow64: 0 0 8px A, 0 32px 64px K`. Use map: shadow2 *"Ribbon,
  icons"*; shadow8 *"Command bars, command dropdowns, and tooltips"*; shadow64 *"Panels and pop-up
  dialogs."* And: **"Windows uses strokes instead of key shadows to outline an object."**
- **The toolbar-button colour family**, which is exactly what our FormatBar/ArrangeBar need:
  `colorSubtleBackground: transparent` / `Hover #f5f5f5` / `Pressed #e0e0e0` / `Selected #ebebeb`.
  Neutral backgrounds `#fff/#fafafa/#f5f5f5/#f0f0f0/#ebebeb/#e6e6e6`; strokes `#d1d1d1`/`#e0e0e0`;
  foregrounds `#242424/#424242/#616161`. Brand ramp includes **`brandOffice` 80 = `#d83b01`** — a warm
  red-orange, i.e. **sloodge's `#c43e1c` accent is already in the right family**.
- **Components** — Button medium `padding 5px 12px`, radius 4px; **icon-only buttons are fixed
  24/32/40px squares** with 20/20/24px glyphs; tab selection indicator 2px small / 3px medium.
  Toolbar: *"will never wrap onto a second line… use the overflow utility"* and *"Use a text label
  along with the toolbar item icon in the overflow menu."*

**Ribbon structure [PUB]** (https://learn.microsoft.com/en-us/windows/win32/uxguide/cmd-ribbons):
**max seven groups**, **3–5 commands per group**, up to three layouts per group chosen by width, all
commands *"at most four clicks"*. **Ribbon height is not published for modern Office** — the only
figure is a stale Windows-7 *"48 pixels"*. Contextual tabs have a defined taxonomy: **Format** (part
of an object), **Design** (whole object, galleries), **Layout** (structure), and *"If… not enough for
multiple tabs, just provide a Format tab."* Also: *"better to disable common commands like Cut and
Copy than to use a contextual tab"*; start on Home, don't persist the last tab, **do** persist the
minimised/normal ribbon state. The **Simplified Ribbon** *"shows your most used commands in a single
line"* with two-tier overflow (split-button arrows, then *"three dots at the far right"*). The 2021→
Office 2024 visual refresh gave a *"default neutral color palette, customizable ribbon, and soft
corners"* and **hid the Quick Access Toolbar by default** *"to make your interface simpler"* — but
publishes **no radius, spacing or height numbers**.

**Apple [PUB]** — macOS SF ramp: **Body 13/16** (default 13pt, minimum 10pt), Headline 13/16 Bold,
Callout 12/15, Subheadline 11/14, Caption 10/13, with a **size-specific tracking table**
(13pt → −6/1000em, 11pt → +6, 10pt → +12) that is exactly `apple-design`'s "tracking is size-specific,
never one value". *"Avoid Ultralight, Thin, and Light."*
**Apple publishes no sidebar/inspector width, toolbar height, spacing ramp, radius scale, or motion
durations** — the widely-cited "inspector 225–275pt" figure is a **third-party reconstruction**, not
Apple. What it does publish: **"The thin divider measures one point in width"**; *"Provide multiple
ways to reveal hidden panes"*; *"Persistently highlight the current selection in each pane"*;
*"prefer hiding tertiary columns such as inspectors as the view narrows"*; and for HUD panels over
*"a full-screen slide show"* — *"Use color sparingly in HUDs… Keep HUDs small."*

**Keynote's inspector is four levels deep** and is the closest published analogue to our property
panel: (1) a Format / Animate / Document radio in the toolbar that *"move together and can't be
separated"*; (2) selection-dependent tabs — **Style · Text · Arrange** for a shape, Style · Movie ·
Arrange for video; (3) segmented sub-modes (Text → Style / Layout); (4) disclosure sections (Border,
Size, Fill). Its empty state is a single **"Add an Effect"** button that becomes **"Change"**.

**The structural question this poses for sloodge**, and it is the one architectural decision in this
document: **Office and Keynote answer "where does selection-sensitive UI live" differently** —
contextual ribbon tabs versus a right sidebar. Sloodge currently has a ribbon **and** a bottom
inspector **and** a chat panel. The Win32 guide's warning applies directly: *"Avoid multiple paths to
the same command."*

---

## 5. The design direction — decisions

### 5.0 What we are NOT changing, and why

Three things came out of the research validated rather than indicted. M8b must not "fix" them:

- **Density stays.** `h-7` (28px) controls and 11–13px chrome text are correct.
  Helium reached **28px** by deliberate subtraction from Chromium's 34px; we reached it by copying
  PowerPoint. Contrast was measured, not assumed: `chrome-muted` on `chrome` is **6.12:1**.
  `better-layout`, `styleseed` and `refactoring-ui` all explicitly permit dense professional tools.
- **The accent hue stays.** `#c43e1c` = `oklch(0.554 0.176 34.8)` sits in the same family as Fluent's
  **`brandOffice` `#d83b01`**. It is right for a PowerPoint-alike. Only its *dark-mode lightness* is
  broken.
- **One accent for everything stays.** The reviewer explicitly rejected splitting it per role:
  *"A single strong accent across chrome is the convention in this tool class (Figma's blue, VS Code's
  `focusBorder`), and each use here is disambiguated by shape and position rather than hue."*

### 5.1 Decision 1 — re-axis the tokens from *mode-bound* to *role-bound*

This is the highest-leverage change in the document, and it is a **deliberate deviation from M8b.1's
"extend rather than replace"** — so here is the argument.

Today `chrome-*` means "light mode" and `ink-*` means "dark mode". Because the names encode the mode,
**every single element must carry a `dark:` twin**: that is why `chrome-line` (47 uses) and `ink-line`
(45 uses) exist in near-lockstep, and why `chrome-muted` (43) shadows `ink-muted` (40). Roughly **180
`dark:` colour classes** exist purely to restate the same intent twice. Every one is a place the two
modes can drift — and they have: `bg-chrome` pairs with `dark:bg-ink` in five places and `bg-white`
pairs with `dark:bg-ink-alt` in three, for the same semantic surface.

Linear, Warp and Zen all do the opposite: **one role token whose *value* swaps by mode**. Components
then write `bg-surface` once, with no `dark:` variant, and drift becomes structurally impossible.
Tailwind v4 supports this directly — `@theme` custom properties are ordinary CSS variables, so they
can be redefined inside `@media (prefers-color-scheme: dark)`.

**The values are kept; only the naming axis changes.** That honours the "don't throw away the existing
theme" intent while removing the defect that caused half the inconsistencies in §2.5.

```css
@theme {
  /* Surfaces — light values are the defaults */
  --color-surface:        oklch(0.965 0.004 34.8);  /* app ground        was shell-bg  */
  --color-surface-raised: oklch(0.985 0.003 34.8);  /* panels, bars      was chrome    */
  --color-surface-sunken: oklch(0.940 0.005 34.8);  /* wells, hover      was chrome-alt*/
  --color-field:          oklch(1     0     0    ); /* inputs (NEW)                    */
  --color-line:           oklch(0.900 0.006 34.8);  /* hairlines         was chrome-line */
  --color-line-strong:    oklch(0.625 0.010 34.8);  /* control borders (NEW, 3:1)      */
  --color-text:           oklch(0.290 0.012 34.8);  /* body              was shell-fg  */
  --color-text-muted:     oklch(0.544 0.010 34.8);  /* secondary         was chrome-muted */
  --color-accent:         oklch(0.554 0.176 34.8);  /* unchanged value                 */
  --color-accent-soft:    oklch(0.955 0.020 34.8);  /* lifted to clear 4.5:1           */
  --color-focus:          oklch(0.600 0.180 34.8);  /* NEW — one ring, both modes      */
  --color-canvas-mat:     oklch(0.580 0     0    );
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-surface:        oklch(0.225 0.006 286);
    --color-surface-raised: oklch(0.270 0.008 286);
    --color-surface-sunken: oklch(0.195 0.005 286);
    --color-field:          oklch(0.195 0.005 286);
    --color-line:           oklch(0.335 0.012 286);
    --color-line-strong:    oklch(0.543 0.014 286);
    --color-text:           oklch(0.925 0.006 286);
    --color-text-muted:     oklch(0.700 0.014 286);
    --color-accent:         oklch(0.670 0.176 34.8);  /* THE dark-mode fix */
    --color-accent-soft:    oklch(0.330 0.055 34.8);
    /* --color-focus is deliberately NOT overridden — see 5.2 */
  }
}
```

**Every pair above was computed and measured, not chosen by eye:**

| Pair | Light | Dark |
| --- | --- | --- |
| `text` on `surface` | 12.79:1 | 13.70:1 |
| `text` on `surface-raised` | 13.56:1 | 12.08:1 |
| `text-muted` on `surface` | **4.51:1** | 6.39:1 |
| `text-muted` on `surface-raised` | 4.78:1 | 5.63:1 |
| `accent` on `surface` | 4.68:1 | **5.31:1** (was 3.17) |
| `accent` on `surface-raised` | 4.96:1 | **4.68:1** (was 2.90 ✗) |
| `line-strong` vs every ground | ≥ 3.00:1 | ≥ 3.01:1 |
| white on `accent` | 5.19:1 | — |

Both accent variants are inside sRGB (max chroma at hue 34.8 peaks near `C = 0.229`).

**Migration map** (mechanical, and the M8b.4 guard can enforce it):

| Old | New | Note |
| --- | --- | --- |
| `shell-bg` + `dark:ink` | `surface` | drop the `dark:` |
| `chrome` / `bg-white` + `dark:ink-alt` | `surface-raised` | resolves the `white`/`chrome` split |
| `chrome-alt` + `dark:*` | `surface-sunken` | |
| `chrome-line` + `dark:ink-line` | `line` | 92 classes → 46 |
| `chrome-muted` + `dark:ink-muted` | `text-muted` | 83 classes → 43 |
| `shell-fg` + `dark:ink-fg` | `text` | |
| `dark:bg-ink-bg` | `bg-field` | **fixes the broken token** |
| — | `line-strong`, `field`, `focus`, semantic | new roles |
| `accent-soft` | keep, re-valued | single use; keep only if the toggle keeps its tint |

### 5.2 Decision 2 — one focus ring, not two

`oklch(0.600 0.180 34.8)` = `#d64c2a`, verified **≥3:1 against all four surface grounds in both
modes** (light surface 3.87, light raised 4.10, dark surface 3.99, dark raised 3.52). So `--color-focus`
is declared once and **never overridden per mode** — which is why the dark block above deliberately
omits it.

Use `2px solid` with `outline-offset: 2px`, per `better-accessibility`'s *"at least a `2px` solid
perimeter"*. **And delete `ring-offset-1` from `ThumbnailRail.tsx:173`** — with no ring-offset colour
it resolves to Tailwind's default `#fff` and paints a white halo on the dark rail.

### 5.3 Decision 3 — the scales that don't exist yet

Derived from the convergences in §4.2 and Fluent's published ramps, trimmed to what a slide editor
actually uses. **Do not ship a scale wider than this;** unused steps are how drift starts.

```css
/* Radius — ceiling of 8px on chrome. Nothing is a pill except genuine chips. */
--radius-control: 4px;   /* buttons, inputs, toolbar items   (Fluent Medium, Linear control) */
--radius-panel:   6px;   /* cards, bubbles, floating bars                                    */
--radius-overlay: 8px;   /* dialogs, menus                   (Helium's ceiling)              */
--radius-chip:    9999px;/* context chips + present controls ONLY                            */

/* Type — the 4 sizes already in use, named. */
--text-caption: 11px;  /* status bar, metadata, overlay labels */
--text-ui-sm:   12px;  /* dense chrome, secondary             */
--text-ui:      13px;  /* body / default (= Fluent macOS Body, = HIG Body) */
--text-title:   15px;  /* dialog + panel titles               */
--leading-ui:   1.45;  /* NEW — body currently has NO line-height at all */

/* Motion */
--ease-out:     cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out:  cubic-bezier(0.77, 0, 0.175, 1);
--duration-instant: 0ms;    /* selection, high-frequency state — Linear ships 0s 42 times */
--duration-fast:    120ms;  /* hover, press, controls appearing */
--duration-base:    180ms;  /* slide cross-fade, dialogs        */
--duration-slow:    260ms;  /* dismissals only                  */

/* Elevation — Fluent's ring+key structure, only three levels */
--shadow-raised:  0 0 2px oklch(0 0 0 / 0.12), 0 1px 2px oklch(0 0 0 / 0.14);
--shadow-floating:0 0 2px oklch(0 0 0 / 0.12), 0 4px 8px oklch(0 0 0 / 0.14);
--shadow-overlay: 0 0 8px oklch(0 0 0 / 0.12), 0 16px 32px oklch(0 0 0 / 0.14);

/* Z-index — four surfaces currently all claim z-50 with no contract */
--z-panel: 10; --z-menu: 40; --z-dialog: 50; --z-present: 60;
```

**Spacing: change nothing.** Tailwind's 4px base is already the industry convergence, and the
`px-3`/`py-1`/`gap-2` cluster in §2.3 is a real, working 4px grid with the same 2px nudges Linear and
Fluent both use deliberately (*"The values 2, 6, and 10 account for extra padding in the Fluent
icons"*). What needs deleting is the ~12 one-off `m*` nudges, not the scale.

### 5.4 Decision 4 — semantic colour gets tokens, and never touches chrome

Error is currently spelled three ways and warning two; there is no success colour at all. Add
`--color-danger`, `--color-warning`, `--color-success` (+ `-soft` fills) in both modes, and hold the
industry line: **semantic hues are for status only and never for chrome, selection, or emphasis.**
Per `better-accessibility`, every status also needs a redundant non-colour cue — an icon or a word.
The `bg-fuchsia-500` smart guides are a real semantic role in disguise: give them `--color-guide`.

### 5.5 Decision 5 — motion policy, in one paragraph

**Instant-in, eased-out.** State feedback the user triggers (selection, hover, press) is
`--duration-instant`; things that *arrive* (dialogs, slides, messages) get `--duration-base` with
`--ease-out`; things that *leave* are faster than they arrived. **Never `ease-in`.** Never animate
anything keyboard-initiated or hit 100+/day — which specifically means the selection overlay, the
property panel, thumbnail selection, and the drop indicator stay bare **by policy, not by omission**.
Ship the four bridges the audit found (present cross-fade, dialog enter/exit, chat arrival, present
overlay) and nothing else. Every rule lands behind a `prefers-reduced-motion` block that **reduces
rather than removes** — keep opacity and colour, drop transform, cap loops.

### 5.6 Tokens to drop or demote

- **`--color-accent-soft`** — one consumer (`FormatBar.tsx:144`), disabled in dark. Keep only if the
  Design Mode toggle retains a tint; otherwise delete and use `surface-sunken`.
- **`--color-canvas-mat`** — one consumer, used only at `/25`, with a hardcoded `dark:bg-black/40`
  partner. Either make it a real two-mode role token or inline it honestly.
- **`--color-ink-bg`** — does not exist. Delete the reference (`PropertyPanel.tsx:309`).

---

## 6. The top 10 surface-level fixes, ranked by user-visible impact

Ranked by what a user actually notices, then by reach. Items 1–4 are visible on first launch;
5–7 are structural but invisible until something breaks; 8–10 are craft.

| # | Fix | Where | Why it ranks here | Effort |
| --- | --- | --- | --- | --- |
| **1** | **Dark mode: make the property panel readable.** Replace the non-existent `dark:bg-ink-bg` with `bg-field`. | `PropertyPanel.tsx:309` | **Every value in Text, Size, Weight, Colour, Fill, Stroke, X, Y, W, H is currently invisible in dark mode — measured 1.24:1** — in the panel whose only job is showing those values. Compiler-verified: the class emits no rule. One word. | trivial |
| **2** | **Stop the Present-mode flash.** Keep outgoing + incoming frames mounted and cross-fade opacity `180ms --ease-out`; mirror it in `presenter-shell.ts:282-286`, which has the right structure but no transition. | `PresentSurface.tsx:156-163` | `key={current.id}` makes every slide advance a **full iframe document reload**, so an audience sees a hard cut *plus* an unpredictable load flash. This is the only surface other people ever see, and the fix repairs the app and the HTML export together. | medium |
| **3** | **Give the accent a dark-mode variant.** `oklch(0.670 0.176 34.8)`. | `theme.css`, then `MenuTabStrip.tsx:13`, `FormatBar.tsx:141-145` | The accent measures **2.90:1 on `ink-alt`** — failing even the 3:1 non-text floor. Two components already independently worked around it (`dark:text-ink-fg`, `dark:bg-transparent`), which means the brand colour **disappears in dark mode** on the app's most prominent mode control. | small |
| **4** | **Bring the PPTX dialog onto the design system.** Rebuild on tokens the way `SettingsDialog.tsx:144` does; add Escape, focus-move and focus-restore. | `ExportPptxDialog.tsx:57-121` | It is the **only surface with no dark treatment at all** — a full-brightness white card over a dark app, which users read as a bug — and it uses a second, incompatible type scale. It also has **no keyboard exit whatsoever**. | small |
| **5** | **Land the role-axis token set** (§5.1) plus the radius/type/motion/z scales (§5.3). | `theme.css` + mechanical sweep | Deletes ~180 redundant `dark:` classes and makes light/dark drift structurally impossible. **`better-interface`: "a token or shared-component fix outranks the same symptom in one leaf component."** This is what M8b.3's parallel fan-out needs in order not to produce seven inconsistent opinions. | medium |
| **6** | **One focus ring, everywhere.** `--color-focus` at `2px` with `outline-offset: 2px` on every interactive control; delete the `ring-offset-1` halo. | ~40 controls; bug at `ThumbnailRail.tsx:173` | There is exactly **one** `focus-visible` in the entire renderer, and it paints a **white halo on the dark rail**. Two inputs replace the outline with a 1px border swap — the weakest possible indicator, and their only focus signal. Keyboard users currently cannot see where they are. | medium |
| **7** | **Extract one overlay primitive**: `inert` on `#sloodge-shell`, focus in, Tab cycling, focus restored to opener, `overscroll-behavior: contain`. | `SettingsDialog.tsx`, `ExportPptxDialog.tsx`, `PresentSurface.tsx` | No modal traps Tab. From the PPTX dialog a keyboard user tabs into the rail and chat **and can operate them while the modal is up**; in Present, Tab lands on off-screen editor chrome. `SettingsDialog` already has the opener dance — containment is the missing half. Three call sites, one primitive. | medium |
| **8** | **Add motion tokens + a `prefers-reduced-motion` floor that reduces rather than removes.** | `theme.css` | The app honours the preference **nowhere**; its one unbounded animation runs for the whole of every agent turn. Today **the app's own HTML export is more accessible than the editor that produced it.** Also unblocks fixes 2 and 10. | small |
| **9** | **Roving tabindex on both toolbars and the rail.** | `FormatBar.tsx:69`, `ArrangeBar.tsx:142`, `ThumbnailRail.tsx:345-370` | Both bars declare `role="toolbar"`, which **promises arrow-key navigation**, and deliver none. The rail is worse: one tab stop per slide means **a 40-slide deck is 40 Tab presses** to cross — and arrow-key slide navigation is the exact PowerPoint muscle memory this UI exists to mimic. | medium |
| **10** | **Fix the copy and the disabled state.** Drop `"(not wired up yet)"` from 13 controls and give `aria-disabled` buttons a real disabled style; replace `placeholder='mixed'`; `aria-label` `"Width"`/`"Height"`; one capitalisation policy; `1 issue` not `1 issues`. | 13 sites listed in §3.2 | **Developer build-status language is shipping to users**, and only on hover — so 12 dead toolbar buttons look and behave live at rest. `'mixed'` actively misleads: everywhere else in the design-tool world it means "multiple differing values". | small |

**Deliberately not in the top 10, but the biggest issue in the codebase:**

- **Design Mode is pointer-only, end to end** (§3.2 H1). No keyboard path creates a selection, which
  also strands the property panel, colour controls, arrange bar and "Ask Claude about this element"
  behind a mouse. The 8×8px handles fail WCAG 2.5.8 on any element under ~48px. This is not a polish
  item — it is **feature work on the app's differentiating feature and deserves its own milestone**
  (suggest **M8c**), not an M8b PR.
- **508px of fixed chrome against a 1024px minimum window** (§3.2 #5). The rail and chat are
  `shrink-0` with no collapse, no splitter, and zero breakpoints or container queries in the renderer;
  at 200% zoom the canvas disappears entirely. Every peer tool collapses both side panels. Steal
  Figma's ⌘⇧\ behaviour and Linear's *collapse-to-an-8px-gutter, not to zero*. Also its own milestone.
- **The three-surface command question** (§4.4). Sloodge has a ribbon *and* a bottom inspector *and* a
  chat panel; Office and Keynote each pick **one** lifecycle model for selection-sensitive UI.
  *"Avoid multiple paths to the same command."* An architecture decision, not a token.

## 7. Accessibility punch-list

Ordered by severity. Everything here is evidenced in §3.2 or measured in §2.2.

**Contrast**
- `accent` on `ink-alt` **2.90:1** and on `ink` **3.17:1** → ship the dark accent variant (§5.1).
- `accent` on `accent-soft` **4.41:1** (light Design Mode toggle at rest) → lift `accent-soft`.
- Credential and chat inputs have **1.00:1 / 1.02:1 fill contrast** against their panels and are
  defined solely by a **1.24:1** border → add `--color-field` + `--color-line-strong` (≥3:1, WCAG
  1.4.11).
- `dark:bg-ink-bg` → **1.24:1** text-on-white across ten property fields.
- Re-verify every pair in **both** appearances after the migration; `better-colors`: *"A pair that
  passes in light mode can fail in dark mode; the palettes aren't mirror images."*

**Focus and keyboard**
- One `focus-visible` in the whole renderer; ~40 controls unstyled → one `--color-focus` token,
  `2px` + `outline-offset: 2px`, `:focus-visible` only.
- Delete `ring-offset-1` (white halo on dark).
- No modal traps Tab or sets `inert`; `ExportPptxDialog` has **no Escape handler at all**.
- `role="toolbar"` ×2 and the rail promise arrow keys and deliver none.
- Settings arrow-key navigation **breaks after one press** — `SettingsDialog.tsx:103-109` dispatches
  without calling `.focus()`, stranding focus outside the roving order.
- `PresentControls.tsx:41` puts `aria-hidden` on a wrapper of three **enabled** buttons → use `inert`.
- **Design Mode has no keyboard path at all** (see §6).

**Hit areas**
- The eight 8×8px resize handles fail WCAG 2.5.8 where elements are under ~48px → extend to 24px with
  `after:absolute after:-inset-2`.
- Already checked and **passing** via the spacing exception, do not "fix": the 20px theme swatches at
  a 4px gap (centres exactly 24px apart) and the chat context-chip `×`.

**Screen readers**
- `aria-live="polite"` over a token-by-token stream re-reads the whole answer dozens of times per turn
  → drop `aria-live` (`role="log"` implies polite), add `aria-busy` while streaming, and announce turn
  boundaries from a separate stable `role="status"`.
- `aria-label` on `PresentSurface`'s role-less blanker div is ignored by most AT.
- `aria-label="W"`/`"H"` are announced as letters.
- No `<h1>` anywhere; headings start at `<h2>`. No skip link.

**Motion, zoom, modes**
- `prefers-reduced-motion` absent from the renderer; the unbounded pulse is unguarded.
- The app must work at 200% zoom — today the two `shrink-0` panels consume the entire effective
  viewport and the canvas disappears.
- `prefers-contrast: more` is unhandled → widen the L gap by ≥ `0.15` per `better-colors`.
- **Not verified** (the app was not launched): rendered dark-mode appearance, motion at 10% speed, a
  live NVDA/VoiceOver pass, forced-colors mode. M8b.2's definition of done should include these.

## 8. Explicitly NOT doing

- **Do not loosen the density.** No bigger paddings, no taller bars, no 14px chrome text. Measured
  contrast passes and three independent sources permit dense professional tools. Helium's hard-won
  28px equals our existing `h-7`.
- **Do not add marketing-page aesthetics.** No hero treatments, no gradients in chrome, no glassmorphism
  beyond the one existing `backdrop-blur` on the arrange bar, no decorative illustration. This is a
  tool used all day.
- **Do not over-animate.** The motion audit's verdict was that the omissions are *in the right places*.
  Ship four bridges and stop. **Specifically keep bare:** the selection overlay and its handles, the
  property panel's mount/unmount, thumbnail selection, the rail's drop indicator, the canvas fit
  scale, the context menu, and toolbar press feedback — each was individually considered and rejected
  with a reason in §3.1.
- **Do not add a UI or motion dependency.** The zero-dependency policy is stated in the source
  (`SettingsDialog.tsx:5-6`, `ExportPptxDialog.tsx:13-15`) and Chromium 140 supplies `@starting-style`,
  `@utility`, `transition-behavior` and `startViewTransition` natively.
- **Do not split the accent into per-role tokens.** Explicitly rejected in review — one strong accent
  is the convention in this tool class, and each use is disambiguated by shape and position.
- **Do not adopt a wider scale than §5.3.** Unused steps are how drift starts. Four radii, four type
  sizes, three shadows, four durations.
- **Do not introduce a second colour notation.** After the migration everything is OKLCH; a stray hex
  in a component is exactly what the M8b.4 guard must fail on.
- **Do not let chrome tokens leak into slide content.** App chrome is `--color-*`; deck content is
  `--sl-*` (`30-slide-format.md`). They are separate namespaces on purpose — the chrome accent
  (`#c43e1c`, warm) and the default deck accent (`#4c8dff`, cool) are *supposed* to differ.
- **Do not "fix" the deliberate choices** the reviewer already cleared: the `sr-only` labels on the
  credential inputs, the 20px theme swatches, the small context-chip `×`, and the canvas slide's
  `outline` (chosen over `border` because an outline doesn't affect layout — documented at
  `SlideCanvas.tsx:89-91`).
- **Do not chase RTL in M8b.** The renderer uses physical properties throughout. Worth a decision
  before localisation; not a defect today.

## 9. Open items recorded so they aren't lost

- **Validate the `.sloodge` default theme's `series[]` palette** with `dataviz`'s
  `scripts/validate_palette.js` (CVD ΔE ≥ 8; a normal-vision floor below 15 is a hard fail). This
  governs generated **chart slides**, not chrome — a separate milestone, but it is the one place
  `dataviz` genuinely applies to this product.
- **Align the exported presenter shell with the app**: it uses a different font stack *and* a different
  base size (`14px/1.4` vs the app's `13px`), and its reduced-motion rule is a blanket
  `* { transition: none !important }` that `improve-animations` warns against copying into the app.
- **`ThumbnailRail.tsx:173` vs `:179`** use `rounded` and `rounded-sm`, which are **identical** in
  Tailwind v4 — decide which was intended before the token sweep bakes in the wrong one.
- **Security constraint for any future rail-reorder animation:** a `view-transition-name` must derive
  from the card **index, never the slide id** — slide ids are attacker-influenced and are deliberately
  kept out of CSS selector strings (`ThumbnailRail.tsx:267-269`).
