/**
 * The local property panel — Design Mode's zero-LLM direct-edit surface (§5 of
 * `.claude/plans/init/40-design-mode.md`, wireframe §20 "Design Mode active"). Docked at the bottom
 * of the canvas, it shows editable fields for the selected element and commits every edit as one
 * undoable `slide.setHtml` command that patches the slide **source** and hot-reloads the frame —
 * never an LLM round-trip (v0's lesson).
 *
 * ## The re-derivation rule, enforced here (§2.2, normative)
 *
 * The element being edited is resolved from the **parent-owned** source map built from the current
 * slide bytes, keyed by the sl-id the **parent** tracks (`designStore.selection.slId`). Nothing in
 * this component reads element data out of a bridge message — a forged `SL_HITTEST` can at most move
 * the parent's selection to a neighbouring sl-id, and the edit then targets *that* element's real
 * spans. All the patch math is the pure `buildFieldOps`/`applyOps` layer; this file is only wiring.
 *
 * ## Value source and coalescing
 *
 * Fields are populated from the **source** (`readPropertyValues`), not computed styles: a source
 * editor reads and writes the same channel it edits, so an untouched field stays untouched and one
 * edit adds exactly one declaration (see `property-model.ts`). Edits commit on blur and on Enter,
 * so a typing burst in one field is one undo step; the frame reloads once per commit. The finer
 * 600 ms cross-field merge of §7.2 needs a coalescing API `history.ts` does not expose yet and is
 * deferred — each committed field edit is its own clean undo unit, which is the safe default.
 *
 * ## Always mounted, fixed height — the dock must never move the slide
 *
 * The panel is a real dock (wireframe §20, "docked bottom of canvas"), so it takes its space from
 * the slide's mat. It therefore renders for as long as Design Mode is on — an empty state with
 * nothing selected — and at a fixed height regardless of content. Mounting it on selection made the
 * first click on a fresh deck re-fit the slide ~116px higher, so the second click of a double-click
 * hit a different element and no caret opened (round-2 review, executed in Electron). A layout that
 * jumps on select is a defect in its own right, and the working layout — an element selected — is
 * the one with the panel open, so reserving it costs the never-selected state only.
 */

import { useCallback, useMemo, useState, type JSX } from 'react'
import { buildSlideMap } from '../../../../shared/design/slide-map'
import { applyOps } from '../../../../shared/design/patch'
import { buildElementContextBundle } from '../../../../shared/design/element-context'
import {
  buildFieldOps,
  readPropertyValues,
  resolveElement,
  type PropertyField,
  type TextFieldBlock,
} from '../../../../shared/design/property-model'
import { themeColorSwatches, type ThemeSwatch } from '../../../../shared/design/theme-swatches'
import { useChatContextStore } from '../chat/chatContextStore'
import type { SlideView } from '../../stores/deckStore'
import { getSlideHtml, selectSlideViews, useDeckStore } from '../../stores/deckStore'
import { useDesignStore } from './designStore'
import { useElementActions } from './useElementActions'
import { ColorControls, type ColorTarget } from './ColorControls'
import { createEyeDropperPicker, hasEyeDropper, type ColorPicker } from './eyedropper'
import type { ElementInspectApi } from './useElementInspect'

const FIELD_LABELS: Readonly<Record<PropertyField, string>> = {
  text: 'Text',
  fontSize: 'Size',
  fontWeight: 'Weight',
  color: 'Color',
  fill: 'Fill',
  stroke: 'Stroke',
  x: 'X',
  y: 'Y',
  width: 'W',
  height: 'H',
}

/** The Edit-menu label for one edit, with the value capped so a long text edit stays readable. */
function editLabel(field: PropertyField, rawValue: string): string {
  const value = rawValue.trim()
  const shown = value.length > 24 ? `${value.slice(0, 24)}…` : value
  return `${FIELD_LABELS[field]} ${shown}`
}

export interface PropertyPanelProps {
  /** The slide whose element is selected — provides the id and the raw source bytes to edit. */
  readonly slide: SlideView
  /**
   * The `SL_INSPECT` client (computed styles + rect from the frame), when Design Mode is wired to a
   * live frame. Optional: without it, "Ask Claude about this element" still attaches a bundle built
   * from the parent-owned source map and the selection's last-known geometry — computed styles are an
   * enrichment, not a requirement (§6.2). Absent in tests and in a no-frame host.
   */
  readonly inspect?: ElementInspectApi['inspect']
  /**
   * The eyedropper seam (M3.8). Omitted in production, where the panel feature-detects the Chromium
   * `EyeDropper` API and builds the real picker; passed explicitly by tests (a fake pick) and the
   * recorded demo, or `null` to force the eyedropper button hidden.
   */
  readonly picker?: ColorPicker | null
}

/**
 * Renders the panel when an element is selected, nothing otherwise. Splits the resolve/render work
 * from the editable fields so the fields remount (via `key`) whenever the source or selection
 * changes, resetting every input to the freshly-patched source value after a commit.
 */
export function PropertyPanel({ slide, inspect, picker }: PropertyPanelProps): JSX.Element | null {
  const selection = useDesignStore((state) => state.selection)
  const attachContext = useChatContextStore((state) => state.attach)

  // The theme-token quick row surfaces the deck's palette (§4.1 "the color picker offers theme swatches
  // first"). `theme` lives on the document; it changes rarely and only via a full doc replace, so a
  // selector read is enough. When there is no theme, the default palette keeps the row populated.
  const theme = useDeckStore((state) => state.history.doc.theme)
  const swatches = useMemo<readonly ThemeSwatch[]>(() => themeColorSwatches(theme), [theme])

  // The eyedropper: an injected picker when the caller supplied one (tests, the demo), otherwise the
  // real `EyeDropper`-backed picker when the API is present, else `null` (button hidden). `undefined`
  // means "decide for me"; an explicit `null` means "no eyedropper".
  const resolvedPicker = useMemo<ColorPicker | null>(
    () => (picker !== undefined ? picker : hasEyeDropper() ? createEyeDropperPicker() : null),
    [picker],
  )

  // The parent-owned map, rebuilt from the *current* slide bytes. Memoized on (id, source) so a
  // re-render that changed neither does not re-parse.
  const map = useMemo(() => buildSlideMap(slide.id, slide.html), [slide.id, slide.html])

  // "Ask Claude about this element" (§6.1, wireframe §20): build the element context bundle and attach
  // it to the next chat turn as the composer's `[⊕ctx]` chip. The bundle's authoritative field — the
  // element's source HTML — is re-derived here from the parent-owned map keyed by the parent-tracked
  // `slId` (§2.2), never from a bridge payload; computed styles/rect are an untrusted frame hint,
  // fetched via `SL_INSPECT` when available and folded in as inert informational context.
  const askAboutElement = useCallback(async (): Promise<void> => {
    const slId = useDesignStore.getState().selection?.slId
    if (slId === undefined) return
    const current = getSlideHtml(useDeckStore.getState().slideHtml, slide.id)
    if (current === undefined) return
    const liveMap = buildSlideMap(slide.id, current)
    if (liveMap.byId.get(slId) === undefined) return
    const { deck, slideHtml } = useDeckStore.getState()
    const index = selectSlideViews(deck, slideHtml).findIndex((view) => view.id === slide.id)
    const info = inspect ? await inspect(slId) : null
    const hintRect = info?.rect ?? useDesignStore.getState().selection?.rect ?? undefined
    // Build with `exactOptionalPropertyTypes` in mind: only pass the frame hints when present, rather
    // than passing `undefined`, which the strict optional types reject.
    const bundle = buildElementContextBundle({
      map: liveMap,
      slId,
      slide: { index: index < 0 ? 0 : index, title: slide.title },
      ...(info?.computed !== undefined ? { computedStyles: info.computed } : {}),
      ...(hintRect !== undefined ? { rect: hintRect } : {}),
    })
    if (bundle !== null) attachContext(bundle)
  }, [slide.id, slide.title, inspect, attachContext])

  const onAskClick = useCallback((): void => {
    void askAboutElement()
  }, [askAboutElement])

  const element = selection === null ? null : resolveElement(map, selection.slId)
  // The selected sl-id no longer resolves (e.g. a structural edit reparsed the slide): show the
  // shell but no fields rather than guessing an element. Re-resolution by path is M3.5's job.
  const values = element === null ? null : readPropertyValues(map.source, element)

  return (
    <section
      aria-label="Properties"
      data-testid="property-panel"
      // `h-64` + `overflow-y-auto`, not content height: the dock's size must not depend on what is
      // selected (see the header). 256px is the fields' unwrapped height at a 740px-wide canvas plus
      // a little slack; narrower canvases wrap the field rows and scroll inside the dock.
      className="h-64 shrink-0 overflow-y-auto border-t border-chrome-line bg-shell-bg/95 px-4 py-2.5 text-[12px] dark:border-ink-line dark:bg-ink-alt/95"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-chrome-muted dark:text-ink-muted">
        <span>Properties</span>
        {selection === null ? null : (
          <span className="font-normal normal-case text-chrome-muted/80 dark:text-ink-muted/80">
            {selection.tag}
            {selection.id ? `#${selection.id}` : ''}
          </span>
        )}
      </div>
      {selection === null ? (
        <p data-testid="property-panel-empty" className="text-chrome-muted dark:text-ink-muted">
          Click an element to see its properties. Double-click text, or press Enter, to edit it in
          place.
        </p>
      ) : element === null || values === null ? (
        <p className="text-chrome-muted dark:text-ink-muted">Selection is no longer available.</p>
      ) : (
        <>
          <PropertyFields
            key={`${selection.slId}:${map.sourceHash}`}
            slide={slide}
            slId={selection.slId}
            values={values}
            swatches={swatches}
            picker={resolvedPicker}
          />
          <div className="mt-2">
            <button
              type="button"
              data-testid="ask-claude-element"
              onClick={onAskClick}
              className="inline-flex items-center gap-1 rounded border border-accent/60 bg-accent/10 px-2 py-0.5 text-[12px] font-medium text-shell-fg hover:bg-accent/20 dark:text-ink-fg"
            >
              <span aria-hidden="true">✨</span> Ask Claude about this element…
            </button>
          </div>
        </>
      )}
    </section>
  )
}

interface PropertyFieldsProps {
  readonly slide: SlideView
  readonly slId: string
  readonly values: ReturnType<typeof readPropertyValues>
  readonly swatches: readonly ThemeSwatch[]
  readonly picker: ColorPicker | null
}

const NUMERIC_FIELDS: ReadonlySet<PropertyField> = new Set(['x', 'y', 'width', 'height'])

/**
 * Why the Content field is disabled, in words. A disabled field that says only "mixed" tells the
 * user nothing about why they cannot type in it (round-5 major 2 of M3.11) — and these are the same
 * elements a double-click on the canvas refuses, for the same three reasons.
 */
const TEXT_BLOCK_HINT: Readonly<Record<TextFieldBlock, string>> = {
  'mixed-content':
    'This element mixes text with other markup, so its text can’t be edited here yet.',
  locked: 'This element is locked, so its text can’t be edited.',
  'not-text': 'This element holds code or metadata, not slide text, so it can’t be edited here.',
}
const TEXT_BLOCK_PLACEHOLDER: Readonly<Record<TextFieldBlock, string>> = {
  'mixed-content': 'mixed content',
  locked: 'locked',
  'not-text': 'not text',
}

/** The Content textarea and the other fields' inputs share one set of handlers. */
type FieldElement = HTMLInputElement | HTMLTextAreaElement

function PropertyFields({
  slide,
  slId,
  values,
  swatches,
  picker,
}: PropertyFieldsProps): JSX.Element {
  const setSlideHtml = useDeckStore((state) => state.setSlideHtml)
  const actions = useElementActions(slide.id)
  const textBlock = values.textBlock

  // One controlled value per field, seeded from source. The component is remounted (via `key`) on
  // every source change, so this initial-from-props read is correct, not stale.
  const [draft, setDraft] = useState<Record<PropertyField, string>>(() => ({
    text: values.text ?? '',
    fontSize: values.fontSize ?? '',
    fontWeight: values.fontWeight ?? '',
    color: values.color ?? '',
    fill: values.fill ?? '',
    stroke: values.stroke ?? '',
    x: values.x ?? '',
    y: values.y ?? '',
    width: values.width ?? '',
    height: values.height ?? '',
  }))

  // The three input handlers are hoisted to stable `useCallback`s (not recreated per input per
  // render), which keeps the panel warning-clean under react-perf and means the field factory below
  // allocates only JSX, no fresh function props. Each handler reads *which* field fired from the
  // input's `name` and the current value from the event, so `commit` needs no `draft` dependency —
  // it works off the value the DOM already holds.
  const commit = useCallback(
    (fieldName: PropertyField, value: string): void => {
      // Re-derive from the store's *current* bytes at commit time, not from the `slide.html` prop
      // captured at render — a blur that fires after some other edit landed must patch the source
      // that is actually live, closing the staleness window §1.4 warns about (there is no async
      // gap: read, compute and commit all happen synchronously). The element is still resolved from
      // the parent-owned map keyed by the parent-tracked `slId` (§2.2), never a message payload.
      const current = getSlideHtml(useDeckStore.getState().slideHtml, slide.id)
      if (current === undefined) return
      const map = buildSlideMap(slide.id, current)
      const element = resolveElement(map, slId)
      if (element === null) return
      const ops = buildFieldOps(map.source, element, fieldName, value)
      if (ops.length === 0) return
      const patched = applyOps(map.source, ops)
      if (patched === map.source) return
      setSlideHtml(slide.id, patched, slId, editLabel(fieldName, value))
    },
    [slide.id, slId, setSlideHtml],
  )

  const handleChange = useCallback((event: React.ChangeEvent<FieldElement>): void => {
    const name = event.target.name as PropertyField
    const { value } = event.target
    setDraft((prev) => ({ ...prev, [name]: value }))
  }, [])

  const handleBlur = useCallback(
    (event: React.FocusEvent<FieldElement>): void => {
      commit(event.currentTarget.name as PropertyField, event.currentTarget.value)
    },
    [commit],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<FieldElement>): void => {
      // Enter commits in every field; Shift+Enter is the Content textarea's newline (see `field`).
      // Enter during IME composition accepts the candidate and must never commit — the same gate
      // as the chat composer's, the only other Enter-commits textarea in the app (round-2 review).
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
      event.preventDefault()
      commit(event.currentTarget.name as PropertyField, event.currentTarget.value)
      event.currentTarget.blur()
    },
    [commit],
  )

  const flipH = useCallback((): void => actions.flip('x'), [actions])
  const flipV = useCallback((): void => actions.flip('y'), [actions])
  const duplicate = useCallback((): void => actions.duplicate(), [actions])

  // The three colour targets for M3.8's swatch/eyedropper/theme controls, each carrying its current
  // source value so a pick can preserve the source's alpha. Memoised so `ColorControls` gets a stable
  // array prop (react-perf) that changes only when a colour value does.
  const colorTargets = useMemo<readonly ColorTarget[]>(
    () => [
      { field: 'color', label: 'Text', current: values.color },
      { field: 'fill', label: 'Fill', current: values.fill },
      { field: 'stroke', label: 'Stroke', current: values.stroke },
    ],
    [values.color, values.fill, values.stroke],
  )

  const field = (name: PropertyField, grow: boolean): JSX.Element => {
    const block = name === 'text' ? textBlock : null
    const disabled = block !== null
    // One prop set for both controls, so the disabled state and its hint cannot drift between
    // the textarea and the inputs; only the control-specific props differ below.
    const common = {
      name,
      'aria-label': FIELD_LABELS[name],
      'data-testid': `prop-${name}`,
      value: draft[name],
      disabled,
      placeholder: block === null ? '' : TEXT_BLOCK_PLACEHOLDER[block],
      title: block === null ? undefined : TEXT_BLOCK_HINT[block],
      onChange: handleChange,
      onBlur: handleBlur,
      onKeyDown: handleKeyDown,
      className: `${grow ? 'min-w-0 flex-1' : 'w-18'} rounded border border-chrome-line bg-white px-1.5 py-0.5 text-shell-fg outline-none focus:border-accent disabled:opacity-50 dark:border-ink-line dark:bg-ink dark:text-ink-fg`,
    }
    return (
      <label
        className={grow ? 'flex min-w-0 flex-1 items-center gap-1.5' : 'flex items-center gap-1.5'}
      >
        <span className="text-chrome-muted dark:text-ink-muted">{FIELD_LABELS[name]}</span>
        {name === 'text' ? (
          // A textarea, not an `<input type="text">`, because the field has to be able to hold the
          // element's decoded text *exactly*: an input's value sanitization strips CR/LF on
          // assignment, so a pretty-printed `<h1>\n  Hello\n</h1>` read back as "  Hello" and an
          // untouched blur rewrote the author's bytes — and flattened a multi-line `<pre>` onto one
          // line (M3.12 round-1 review). The read → commit-unchanged → no-op invariant has to hold
          // through the control the user touches, not only in the model. One row tall for the
          // single-line case, growing with the content to a few lines.
          <textarea
            {...common}
            rows={1}
            className={`${common.className} field-sizing-content max-h-20 resize-none`}
          />
        ) : (
          <input {...common} inputMode={NUMERIC_FIELDS.has(name) ? 'numeric' : undefined} />
        )}
      </label>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {field('text', true)}
        {field('fontSize', false)}
        {field('fontWeight', false)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {field('color', false)}
        {field('fill', false)}
        {field('stroke', false)}
        {field('x', false)}
        {field('y', false)}
        {field('width', false)}
        {field('height', false)}
      </div>
      <ColorControls targets={colorTargets} swatches={swatches} picker={picker} onApply={commit} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-chrome-muted dark:text-ink-muted">Transform</span>
        <button
          type="button"
          data-testid="transform-flip-h"
          onClick={flipH}
          className="rounded border border-chrome-line px-2 py-0.5 hover:border-accent dark:border-ink-line"
        >
          Flip H
        </button>
        <button
          type="button"
          data-testid="transform-flip-v"
          onClick={flipV}
          className="rounded border border-chrome-line px-2 py-0.5 hover:border-accent dark:border-ink-line"
        >
          Flip V
        </button>
        <button
          type="button"
          data-testid="transform-duplicate"
          onClick={duplicate}
          className="rounded border border-chrome-line px-2 py-0.5 hover:border-accent dark:border-ink-line"
        >
          Duplicate
        </button>
      </div>
    </div>
  )
}
