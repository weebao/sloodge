/**
 * The APPEARANCE colour controls for M3.8 (§5.1 of `.claude/plans/init/40-design-mode.md`, roadmap
 * M3.8). For each colour target — Text (`color`), Fill (`background-color`/SVG `fill`) and Stroke
 * (`border-color`/SVG `stroke`) — it renders a native `<input type="color">` swatch showing and picking
 * the current colour, an eyedropper button that samples a pixel anywhere in the app window, and the
 * deck's theme palette as a one-click quick row. Every *committed* choice is handed to
 * `onApply(field, value)`, which the panel commits as one undoable `slide.setHtml` (§7.1) — this
 * component holds no document state and does no patching itself.
 *
 * ## One picker gesture is one undo entry — why this listens for `change`, not React's `onChange`
 *
 * React wires `onChange` on an `<input>` to the DOM **`input`** event, and Chromium fires `input`
 * *continuously* while the user drags inside the OS colour picker. Committing there would push one
 * `slide.setHtml` per intermediate colour: a single short drag produced 250 undo entries in review,
 * overflowing the 200-entry cap in `history.ts` and **evicting the user's real editing history**, after
 * which "undo everything" landed on a mid-drag colour nobody chose. That is undo-state data loss, so
 * intermediate values must never reach the stack.
 *
 * This is the same rule `useDragGesture.ts` already states for pointer drags — "intermediate previews
 * never touch the stack; `onCommit` fires once" — applied to the picker gesture. Intermediate `input`
 * events update **local preview state only** (so the swatch tracks the drag live, with no document
 * write), and the commit happens on the DOM **`change`** event, which Chromium fires exactly once when
 * the picker is closed/confirmed. Cancelling the picker fires no `change`, so the document is left
 * untouched. `change` is attached with a ref rather than a prop precisely because React's `onChange`
 * is the wrong event here.
 *
 * Two corollaries of "the preview is not the document": the preview is an *override* that an aborted
 * gesture clears (so a dismissed picker snaps the swatch back to the source colour rather than
 * stranding one the document never had), and a `change` whose value merely *restates* the source
 * colour commits nothing — some pickers cancel by reverting and firing `change`, and `sameColor`
 * compares parsed colours rather than bytes so `red` vs `#ff0000` is recognised as no change at all.
 *
 * ## Why the written values look the way they do
 *
 * - The native input only speaks `#rrggbb`; a swatch/eyedropper pick is merged through
 *   `applyPickedColor` so the **source's alpha is preserved** (a translucent fill stays translucent).
 * - A theme swatch writes a `var(--sl-*)` token reference, not the resolved hex, so the element stays
 *   re-themeable (`themeSwatchWriteValue`).
 *
 * ## react-perf hygiene
 *
 * Each target and each theme swatch is its own small component, so every handler is a `useCallback`
 * closed over the field it edits rather than an inline arrow allocated per render — and the field no
 * longer has to be smuggled through a `data-*` attribute and cast back.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { PropertyField } from '../../../../shared/design/property-model'
import { applyPickedColor, sameColor, toColorInputValue } from '../../../../shared/design/color'
import { themeSwatchWriteValue, type ThemeSwatch } from '../../../../shared/design/theme-swatches'
import type { ColorPicker } from './eyedropper'

/** The subset of fields that name a colour channel. */
export type ColorField = Extract<PropertyField, 'color' | 'fill' | 'stroke'>

/** One colour target: the field it edits, its label, and its current source value (`null` if unset). */
export interface ColorTarget {
  readonly field: ColorField
  readonly label: string
  readonly current: string | null
}

export interface ColorControlsProps {
  readonly targets: readonly ColorTarget[]
  readonly swatches: readonly ThemeSwatch[]
  /** The eyedropper seam, or `null` when the `EyeDropper` API is unavailable (button hidden). */
  readonly picker: ColorPicker | null
  /** Commit one colour edit — the panel routes this to `slide.setHtml` as one undoable command. */
  readonly onApply: (field: PropertyField, value: string) => void
}

/** A theme-token swatch button. Its own component so the click handler closes over its write value. */
function ThemeSwatchButton({
  swatch,
  field,
  targetLabel,
  onPick,
}: {
  readonly swatch: ThemeSwatch
  readonly field: ColorField
  readonly targetLabel: string
  readonly onPick: (field: ColorField, value: string) => void
}): JSX.Element {
  const write = useMemo(() => themeSwatchWriteValue(swatch), [swatch])
  const style = useMemo(() => ({ backgroundColor: swatch.hex }), [swatch.hex])
  const onClick = useCallback((): void => onPick(field, write), [onPick, field, write])

  return (
    <button
      type="button"
      data-testid={`theme-${field}-${swatch.key}`}
      aria-label={`Apply theme color ${swatch.label} to ${targetLabel}`}
      title={swatch.label}
      onClick={onClick}
      style={style}
      className="h-5 w-5 rounded border border-chrome-line hover:ring-2 hover:ring-accent dark:border-ink-line"
    />
  )
}

/** One target's row: the native swatch, the eyedropper button, and the theme quick row. */
function ColorTargetRow({
  target,
  swatches,
  picker,
  onApply,
}: {
  readonly target: ColorTarget
  readonly swatches: readonly ThemeSwatch[]
  readonly picker: ColorPicker | null
  readonly onApply: (field: PropertyField, value: string) => void
}): JSX.Element {
  const { field, label, current } = target
  const inputRef = useRef<HTMLInputElement>(null)

  // Preview-only state for the drag, held as an *override*: `null` means "show the source colour".
  // Keeping it nullable rather than seeding it with a copy of the source is what lets an **aborted**
  // gesture snap back — a drag that is dismissed without confirming clears the override and the swatch
  // reads the source again, instead of stranding a colour the document does not have.
  const [preview, setPreview] = useState<string | null>(null)
  const shown = preview ?? toColorInputValue(current)

  const onPreview = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    setPreview(event.currentTarget.value)
  }, [])

  // Leaving the control ends any gesture that never confirmed: drop the override so the swatch
  // re-derives from source.
  const onAbort = useCallback((): void => setPreview(null), [])

  // The commit. `change` fires once, when the OS picker is confirmed — never during the drag, and not
  // at all if the user cancels. Attached imperatively because React's `onChange` is the `input` event.
  useEffect(() => {
    const element = inputRef.current
    if (element === null) return
    const onCommit = (): void => {
      setPreview(null)
      // Some pickers cancel by *reverting* the value and firing `change` with it. Compare colours, not
      // bytes: the source may hold `red` while the input reports the canonical `#ff0000`, and rewriting
      // one to the other would spend an undo entry on a gesture the user cancelled, with nothing to see.
      //
      // Compare the **merged** value, not the raw input value. `applyPickedColor` re-attaches the
      // source's alpha, and a native colour input can never report alpha — so against a translucent
      // source the raw hex always differs from the source and the skip would never fire, leaving this
      // guard closed for opaque colours and open for translucent ones. Comparing what we are actually
      // about to write is the only comparison that answers "would this change the declaration?".
      const next = applyPickedColor(current, element.value)
      if (sameColor(current, next)) return
      onApply(field, next)
    }
    element.addEventListener('change', onCommit)
    return (): void => {
      element.removeEventListener('change', onCommit)
    }
  }, [field, current, onApply])

  const onEyedrop = useCallback((): void => {
    if (picker === null) return
    void picker.pickColor().then((hex) => {
      // A cancelled pick resolves `null`: sample nothing, write nothing.
      if (hex !== null) onApply(field, applyPickedColor(current, hex))
    })
  }, [picker, field, current, onApply])

  const onThemePick = useCallback(
    (pickedField: ColorField, value: string): void => onApply(pickedField, value),
    [onApply],
  )

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-12 shrink-0 text-chrome-muted dark:text-ink-muted">{label}</span>
      <input
        ref={inputRef}
        type="color"
        name={field}
        data-testid={`swatch-${field}`}
        aria-label={`${label} color`}
        value={shown}
        onChange={onPreview}
        onBlur={onAbort}
        className="h-6 w-8 cursor-pointer rounded border border-chrome-line bg-transparent p-0 dark:border-ink-line"
      />
      {picker !== null ? (
        <button
          type="button"
          data-testid={`eyedrop-${field}`}
          aria-label={`Sample ${label} color with the eyedropper`}
          onClick={onEyedrop}
          className="rounded border border-chrome-line px-1.5 py-0.5 hover:border-accent dark:border-ink-line"
        >
          <span aria-hidden="true">💧</span>
        </button>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        {swatches.map((swatch) => (
          <ThemeSwatchButton
            key={swatch.key}
            swatch={swatch}
            field={field}
            targetLabel={label}
            onPick={onThemePick}
          />
        ))}
      </div>
    </div>
  )
}

export function ColorControls({
  targets,
  swatches,
  picker,
  onApply,
}: ColorControlsProps): JSX.Element {
  return (
    <div data-testid="color-controls" className="flex flex-col gap-1.5">
      {targets.map((target) => (
        <ColorTargetRow
          key={target.field}
          target={target}
          swatches={swatches}
          picker={picker}
          onApply={onApply}
        />
      ))}
    </div>
  )
}
