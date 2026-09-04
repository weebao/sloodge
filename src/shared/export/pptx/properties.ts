/**
 * The **closed-world property census** (M4.8a, review r2): which CSS properties the structured PPTX
 * pipeline can account for, and — by exclusion — which it cannot.
 *
 * ## Why this file exists
 *
 * Every earlier cut of the confidence scorer was a **deny-list**: a hand-written set of constructs
 * known to be lossy (`filter`, `clip-path`, `mix-blend-mode`, …), each with a deduction. Anything
 * nobody had thought of scored 100. Two review rounds found the same failure at successively deeper
 * layers — r1 named `::before`, painted empty `<div>`s and opacity; r2 then found `mask-image`,
 * `-webkit-text-stroke`, `list-style: none`, clipped text and the standalone `rotate:` property, all
 * shipping at 90–100 with an empty loss list. A deny-list cannot converge: the next reviewer just
 * picks the next property off the ~340 Chromium computes.
 *
 * So the world is closed instead. The measurement pass enumerates **every** computed longhand on
 * every element, compares it to that property's initial value, and reports by name any property that
 * is set to something non-initial and appears in neither set below. `confidence.ts` deducts
 * `unmodelledProperty` (a WRONG-class weight) for those, so an unfamiliar property routes the slide
 * to an honest raster instead of a confident lie.
 *
 * ## The two sets, and how to extend them
 *
 * A maintainer adding support for a CSS feature makes **one explicit edit here**, and the default —
 * for a property in neither set — is to fail toward raster:
 *
 * - **`MODELLED_PROPERTIES`** — the pipeline either emits an OOXML equivalent for it (`color` →
 *   run colour) *or* carries a dedicated, named deduction for it (`clip-path` → `SCORE_WEIGHTS
 *   .clipPath`). Add a property here **only together with** the emitter or the deduction; the
 *   comment beside each group says which of the two it is.
 * - **`LAYOUT_RESOLVED_PROPERTIES`** — the property's entire effect is already contained in what the
 *   measurement pass captured (Chromium resolved `display: grid` into the rects we measure) or it
 *   cannot affect a static rendering at all (`cursor`, `transition-duration`). Add a property here
 *   only with a reason; "it seemed harmless" is how a deny-list grows back.
 *
 * Neither set is a judgement about how *common* a property is. `zoom` and `direction` are absent on
 * purpose: they change what a reader sees, nothing emits them, so a slide using one must rasterize
 * until somebody does the work.
 *
 * ## Baselines
 *
 * "Non-initial" is measured against a real probe element carrying `all: initial`, read once per
 * slide, rather than a hard-coded table that would drift with Chromium. The probe lives two shadow
 * roots deep so that no author declaration — `!important` included — can reach it and quietly make
 * the baseline equal to the value under test; see `node.ts`. Every element is censused this way,
 * and so are `<html>` and `<body>`, which `querySelectorAll` cannot reach. Two kinds of property
 * need a baseline other than the probe's:
 *
 * - **`CURRENTCOLOR_PROPERTIES`** compute to the element's own `color`, so an initial-value
 *   comparison would fire on every coloured element. They count as unmodelled only when they differ
 *   from `color` — which is exactly the signal that matters: `-webkit-text-fill-color: transparent`
 *   on hollow outlined type differs, an inherited `text-decoration-color` does not.
 * - Properties whose computed value is **layout-derived** (`perspective-origin` resolves `50% 50%`
 *   to pixels, so it differs from the zero-sized probe's on every element) are in
 *   `LAYOUT_RESOLVED_PROPERTIES` for that reason, noted individually.
 */

/**
 * Properties the pipeline emits into the `.pptx`, or scores by name. Grouped by which of the two it
 * is, because that is the question a maintainer extending this set has to answer.
 */
export const MODELLED_PROPERTIES: readonly string[] = [
  // --- Emitted: text runs (`walker.ts` textRunFor) ---
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-decoration-line',
  'text-transform',
  // `list-style-type` is read to SUPPRESS the bullet on `list-style: none`; the other two list
  // longhands are not modelled and stay out of both sets.
  'list-style-type',

  // --- Emitted: shape geometry, fill, outline, shadow (`walker.ts`) ---
  'background-color',
  'border-bottom-color',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-bottom-style',
  'border-bottom-width',
  'border-left-color',
  'border-left-style',
  'border-left-width',
  'border-right-color',
  'border-right-style',
  'border-right-width',
  'border-top-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-top-style',
  'border-top-width',
  /**
   * The logical aliases of the four physical sides and the four corners. Chromium computes both
   * spellings of every border longhand, so leaving these out flagged `border-block-start-color` on
   * all 124 elements of the corpus — the same paint the physical longhand above already emits.
   */
  'border-block-start-color',
  'border-block-start-style',
  'border-block-start-width',
  'border-block-end-color',
  'border-block-end-style',
  'border-block-end-width',
  'border-inline-start-color',
  'border-inline-start-style',
  'border-inline-start-width',
  'border-inline-end-color',
  'border-inline-end-style',
  'border-inline-end-width',
  'border-start-start-radius',
  'border-start-end-radius',
  'border-end-start-radius',
  'border-end-end-radius',
  'box-shadow',
  'opacity',
  'z-index',

  // --- Emitted: the transform chain (`confidence.ts` decomposeTransformSpec) ---
  'transform',
  'rotate',
  'scale',
  'translate',
  /**
   * Modelled by construction rather than by being read: rotating or scaling about **any** origin
   * equals the same operation about the element's centre followed by a translation, and that
   * translation is already inside the measured `getBoundingClientRect`. The walker places the
   * unrotated box on the measured bounds' centre, so a `transform-origin: top left` rotation lands
   * in the right place without the property ever being consulted.
   */
  'transform-origin',

  // --- Scored by name: constructs with a dedicated `SCORE_WEIGHTS` entry ---
  'background-image', // elementImageBackground (area-scaled)
  'backdrop-filter',
  'filter',
  'mix-blend-mode',
  'clip-path',
  'text-shadow',
  'writing-mode', // hard blocker
  '-webkit-writing-mode', // Chromium's alias of the same computed value
  'position', // hard blocker on `sticky`
  'overflow-x', // escapingDescendants + clippedText
  'overflow-y',
  'overflow-block', // logical aliases of the two above
  'overflow-inline',
  'text-overflow', // clippedText
]

/**
 * Properties whose effect is already inside the measurement pass, or which cannot change a static
 * rendering. Each entry needs a reason; the grouping comments carry them.
 */
export const LAYOUT_RESOLVED_PROPERTIES: readonly string[] = [
  // --- Box model and flow: Chromium resolved all of it into the rects we measured ---
  'display',
  'box-sizing',
  'float',
  'clear',
  'vertical-align',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'block-size',
  'inline-size',
  'min-block-size',
  'min-inline-size',
  'max-block-size',
  'max-inline-size',
  'aspect-ratio',
  'top',
  'right',
  'bottom',
  'left',
  'inset-block-start',
  'inset-block-end',
  'inset-inline-start',
  'inset-inline-end',
  /**
   * Margins and paddings position the box and its text, and Chromium already applied both: the
   * measured rect is the border box and the text rect is where the glyphs actually landed.
   * PowerPoint's own text inset would fight that, so `pptx-writer.ts` passes `margin: 0` on every
   * text shape and the emitted `<a:bodyPr>` carries `lIns="0" tIns="0" rIns="0" bIns="0"`.
   */
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block-start',
  'margin-block-end',
  'margin-inline-start',
  'margin-inline-end',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-block-start',
  'padding-block-end',
  'padding-inline-start',
  'padding-inline-end',

  // --- Flex, grid and alignment: layout algorithms, fully resolved into the measured boxes ---
  'flex-basis',
  'flex-direction',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'order',
  'align-content',
  'align-items',
  'align-self',
  'justify-content',
  'justify-items',
  'justify-self',
  'place-content',
  'place-items',
  'place-self',
  'row-gap',
  'column-gap',
  'grid-auto-columns',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-column-start',
  'grid-column-end',
  'grid-row-start',
  'grid-row-end',
  'grid-template-areas',
  'grid-template-columns',
  'grid-template-rows',

  // --- Table layout: resolved into rects like any other layout mode ---
  'border-collapse',
  'border-spacing',
  'caption-side',
  'empty-cells',
  'table-layout',

  /**
   * Line breaking. Chromium's line boxes are already inside the measured rect, and where a break
   * *changed what the reader sees* — a clipped or ellipsised line — the `clippedTextPx` signal
   * catches it directly. PowerPoint re-wraps regardless of any of these, which is the milestone's
   * openly-admitted reflow blind spot (§5.2) and is measured by the pixel step, not by a property.
   */
  'white-space-collapse',
  'text-wrap-mode',
  'text-wrap-style',
  'word-break',
  'overflow-wrap',
  'line-break',
  'hyphens',
  'hyphenate-character',
  'hyphenate-limit-chars',
  'tab-size',

  /**
   * Background painting parameters. They only mean anything alongside a `background-image`, and any
   * element carrying one is already deducted for by `elementImageBackground` — which names the whole
   * paint, not one knob of it.
   */
  'background-attachment',
  'background-origin',
  'background-position',
  'background-position-x',
  'background-position-y',
  'background-repeat',
  'background-repeat-x',
  'background-repeat-y',
  'background-size',

  // --- Rendering hints with no structural effect: subpixel/hinting only ---
  '-webkit-font-smoothing',
  'text-rendering',
  'text-size-adjust',
  '-webkit-text-size-adjust',
  '-webkit-locale',
  'font-optical-sizing',
  'color-scheme',
  'forced-color-adjust',
  'print-color-adjust',
  'accent-color',
  'color-rendering',
  'image-rendering',
  'shape-rendering',

  // --- Interaction only: nothing is interactive in a still slide ---
  'cursor',
  'pointer-events',
  'user-select',
  '-webkit-user-select',
  '-webkit-user-drag',
  '-webkit-tap-highlight-color',
  'touch-action',
  'resize',
  'appearance',
  '-webkit-appearance',
  'caret-color',
  'overscroll-behavior-x',
  'overscroll-behavior-y',
  'overscroll-behavior-block',
  'overscroll-behavior-inline',
  'scroll-behavior',
  'scroll-margin-top',
  'scroll-margin-right',
  'scroll-margin-bottom',
  'scroll-margin-left',
  'scroll-padding-top',
  'scroll-padding-right',
  'scroll-padding-bottom',
  'scroll-padding-left',
  'scroll-snap-align',
  'scroll-snap-stop',
  'scroll-snap-type',
  'scrollbar-color',
  'scrollbar-gutter',
  'scrollbar-width',

  /**
   * Animation and transition. The export path waits on the readiness + animation-settle barrier
   * before measuring, so every box is final, and `MeasureResult.hasAnimation` reports the fact
   * separately as a speaker-notes degradation note (§4.2). A per-property flag would fire on every
   * slide with a fade-in and say nothing new.
   */
  'animation-composition',
  'animation-delay',
  'animation-direction',
  'animation-duration',
  'animation-fill-mode',
  'animation-iteration-count',
  'animation-name',
  'animation-play-state',
  'animation-timing-function',
  'transition-behavior',
  'transition-delay',
  'transition-duration',
  'transition-property',
  'transition-timing-function',
  'will-change',
  /**
   * Chromium assigns `view-transition-name: root` to the document element itself, so censusing
   * `<html>` reported it on every slide in the corpus. It names an element as a view-transition
   * participant and paints nothing; outside an active transition — and the export path measures a
   * settled static document — it has no rendering effect at all.
   */
  'view-transition-name',

  /**
   * Containment *inputs*: sizes and names a container query resolves against, which Chromium has
   * already applied to the rects we measured.
   *
   * `contain` and `content-visibility` used to sit here as "hints with no paint of their own".
   * That was false and it shipped a defect: `contain: paint` clips descendants to the padding box
   * exactly as `overflow: hidden` does while leaving the computed `overflow` at `visible`, so a
   * 460×340 block that the reader sees clipped to a 380×200 card was emitted whole and painted
   * over the background at score 100 (review r3). `content-visibility: hidden` skips rendering
   * a subtree outright. Both are out of both sets now, so a non-initial value fails toward raster;
   * `node.ts`'s `clipsBox` separately teaches the clip signals about the clipping keywords, so the
   * loss is *named* rather than merely rasterized.
   */
  'contain-intrinsic-block-size',
  'contain-intrinsic-inline-size',
  'contain-intrinsic-height',
  'contain-intrinsic-width',
  'container-name',
  'container-type',

  /**
   * `visibility` is the measurement pass's own visibility filter: only `visible` elements become
   * nodes, so neither `hidden` nor `collapse` can reach the file. (It read `!== 'hidden'` until
   * r3, which let a `visibility: collapse` banner Chromium paints nowhere ship in full.)
   *
   * `content` is NOT here: it is `normal` on ordinary elements but `content: url(…)` replaces one,
   * and the exporter has no way to emit the replacement image. The `::before`/`::after` case is
   * unaffected — those are counted as `paintedPseudoCount`, since they have no rect.
   */
  'visibility',

  /**
   * Layout-derived computed values: Chromium resolves these against the element's own box, so they
   * differ from a zero-sized probe's on *every* element and an initial-value comparison is
   * meaningless. `perspective-origin` is inert without `perspective`, which is NOT in either set and
   * therefore flags on its own.
   */
  'perspective-origin',
  'transform-box',
]

/**
 * Properties whose initial value is `currentcolor`, so their computed value tracks the element's own
 * `color`. Comparing them against the probe's initial would fire on every coloured element; they are
 * unmodelled only when they differ from `color` — which is the case that matters (a transparent
 * `-webkit-text-fill-color` over hollow outlined type) rather than the case that does not (an
 * inherited `text-decoration-color`).
 */
export const CURRENTCOLOR_PROPERTIES: readonly string[] = [
  '-webkit-text-fill-color',
  '-webkit-text-stroke-color',
  'text-decoration-color',
  'text-emphasis-color',
  'column-rule-color',
  'row-rule-color',
  'outline-color',
]

/** Most unmodelled properties a single node reports, so one exotic element cannot bloat the payload. */
export const MAX_UNMODELLED_PER_NODE = 8
