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
} from '../../../../shared/design/property-model'
import { useChatContextStore } from '../chat/chatContextStore'
import type { SlideView } from '../../stores/deckStore'
import { getSlideHtml, selectSlideViews, useDeckStore } from '../../stores/deckStore'
import { useDesignStore } from './designStore'
import { useElementActions } from './useElementActions'
import type { ElementInspectApi } from './useElementInspect'

const FIELD_LABELS: Readonly<Record<PropertyField, string>> = {
  text: 'Text',
  fontSize: 'Size',
  fontWeight: 'Weight',
  color: 'Color',
  fill: 'Fill',
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
}

/**
 * Renders the panel when an element is selected, nothing otherwise. Splits the resolve/render work
 * from the editable fields so the fields remount (via `key`) whenever the source or selection
 * changes, resetting every input to the freshly-patched source value after a commit.
 */
export function PropertyPanel({ slide, inspect }: PropertyPanelProps): JSX.Element | null {
  const selection = useDesignStore((state) => state.selection)
  const attachContext = useChatContextStore((state) => state.attach)

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

  if (selection === null) return null
  const element = resolveElement(map, selection.slId)
  // The selected sl-id no longer resolves (e.g. a structural edit reparsed the slide): show the
  // shell but no fields rather than guessing an element. Re-resolution by path is M3.5's job.
  const values = element === null ? null : readPropertyValues(map.source, element)

  return (
    <section
      aria-label="Properties"
      data-testid="property-panel"
      className="shrink-0 border-t border-chrome-line bg-shell-bg/95 px-4 py-2.5 text-[12px] dark:border-ink-line dark:bg-ink-alt/95"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-chrome-muted dark:text-ink-muted">
        <span>Properties</span>
        <span className="font-normal normal-case text-chrome-muted/80 dark:text-ink-muted/80">
          {selection.tag}
          {selection.id ? `#${selection.id}` : ''}
        </span>
      </div>
      {element === null || values === null ? (
        <p className="text-chrome-muted dark:text-ink-muted">Selection is no longer available.</p>
      ) : (
        <>
          <PropertyFields
            key={`${selection.slId}:${map.sourceHash}`}
            slide={slide}
            slId={selection.slId}
            values={values}
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
}

const NUMERIC_FIELDS: ReadonlySet<PropertyField> = new Set(['x', 'y', 'width', 'height'])

function PropertyFields({ slide, slId, values }: PropertyFieldsProps): JSX.Element {
  const setSlideHtml = useDeckStore((state) => state.setSlideHtml)
  const actions = useElementActions(slide.id)
  const textDisabled = values.text === null

  // One controlled value per field, seeded from source. The component is remounted (via `key`) on
  // every source change, so this initial-from-props read is correct, not stale.
  const [draft, setDraft] = useState<Record<PropertyField, string>>(() => ({
    text: values.text ?? '',
    fontSize: values.fontSize ?? '',
    fontWeight: values.fontWeight ?? '',
    color: values.color ?? '',
    fill: values.fill ?? '',
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

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const name = event.target.name as PropertyField
    const { value } = event.target
    setDraft((prev) => ({ ...prev, [name]: value }))
  }, [])

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement>): void => {
      commit(event.currentTarget.name as PropertyField, event.currentTarget.value)
    },
    [commit],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      commit(event.currentTarget.name as PropertyField, event.currentTarget.value)
      event.currentTarget.blur()
    },
    [commit],
  )

  const flipH = useCallback((): void => actions.flip('x'), [actions])
  const flipV = useCallback((): void => actions.flip('y'), [actions])
  const duplicate = useCallback((): void => actions.duplicate(), [actions])

  const field = (name: PropertyField, grow: boolean): JSX.Element => {
    const disabled = name === 'text' && textDisabled
    return (
      <label
        className={grow ? 'flex min-w-0 flex-1 items-center gap-1.5' : 'flex items-center gap-1.5'}
      >
        <span className="text-chrome-muted dark:text-ink-muted">{FIELD_LABELS[name]}</span>
        <input
          name={name}
          aria-label={FIELD_LABELS[name]}
          data-testid={`prop-${name}`}
          value={draft[name]}
          disabled={disabled}
          placeholder={disabled ? 'mixed' : ''}
          inputMode={NUMERIC_FIELDS.has(name) ? 'numeric' : undefined}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className={`${grow ? 'min-w-0 flex-1' : 'w-18'} rounded border border-chrome-line bg-white px-1.5 py-0.5 text-shell-fg outline-none focus:border-accent disabled:opacity-50 dark:border-ink-line dark:bg-ink-bg dark:text-ink-fg`}
        />
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
        {field('x', false)}
        {field('y', false)}
        {field('width', false)}
        {field('height', false)}
      </div>
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
