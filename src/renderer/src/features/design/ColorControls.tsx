/**
 * The APPEARANCE colour controls for M3.8 (§5.1 of `.claude/plans/init/40-design-mode.md`, roadmap
 * M3.8). For each colour target — Text (`color`), Fill (`background-color`/SVG `fill`) and Stroke
 * (`border-color`/SVG `stroke`) — it renders a native `<input type="color">` swatch showing and picking
 * the current colour, an eyedropper button that samples a pixel anywhere in the app window, and the
 * deck's theme palette as a one-click quick row. Every choice is handed to `onApply(field, value)`,
 * which the panel commits as one undoable `slide.setHtml` (§7.1) — this component holds no state and
 * does no patching itself.
 *
 * ## Why the writes look the way they do
 *
 * - The native input only speaks `#rrggbb`; a swatch/eyedropper pick is merged through
 *   `applyPickedColor` so the **source's alpha is preserved** (a translucent fill stays translucent).
 * - A theme swatch writes a `var(--sl-*)` token reference, not the resolved hex, so the element stays
 *   re-themeable (`themeSwatchWriteValue`).
 *
 * ## react-perf hygiene
 *
 * There are N swatches × 3 targets of interactive elements, so per-element inline closures would both
 * churn allocations and trip `react-perf`. Instead every handler is one stable `useCallback` that reads
 * the target field and the value from the element's `data-*` attributes, and the theme swatches'
 * colour style objects are memoised once per palette rather than allocated inline.
 */

import { useCallback, useMemo, type JSX } from 'react'
import type { PropertyField } from '../../../../shared/design/property-model'
import { applyPickedColor, toColorInputValue } from '../../../../shared/design/color'
import { themeSwatchWriteValue, type ThemeSwatch } from '../../../../shared/design/theme-swatches'
import type { ColorPicker } from './eyedropper'

/** One colour target: the field it edits, its label, and its current source value (`null` if unset). */
export interface ColorTarget {
  readonly field: Extract<PropertyField, 'color' | 'fill' | 'stroke'>
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

function fieldOf(element: HTMLElement): PropertyField {
  return element.dataset['field'] as PropertyField
}

export function ColorControls({
  targets,
  swatches,
  picker,
  onApply,
}: ColorControlsProps): JSX.Element {
  // Precompute each theme swatch's written value and its (stable) colour style object, so the render
  // below allocates neither a closure nor an object literal per swatch.
  const swatchViews = useMemo(
    () =>
      swatches.map((swatch) => ({
        key: swatch.key,
        label: swatch.label,
        write: themeSwatchWriteValue(swatch),
        style: { backgroundColor: swatch.hex } as const,
      })),
    [swatches],
  )

  const onSwatchPick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const current = event.currentTarget.dataset['current'] ?? null
      onApply(fieldOf(event.currentTarget), applyPickedColor(current, event.currentTarget.value))
    },
    [onApply],
  )

  const runEyedrop = useCallback(
    async (field: PropertyField, current: string | null): Promise<void> => {
      if (picker === null) return
      const hex = await picker.pickColor()
      if (hex === null) return
      onApply(field, applyPickedColor(current, hex))
    },
    [picker, onApply],
  )

  const onEyedropClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      const current = event.currentTarget.dataset['current'] ?? null
      void runEyedrop(fieldOf(event.currentTarget), current)
    },
    [runEyedrop],
  )

  const onThemeClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      const write = event.currentTarget.dataset['write']
      if (write === undefined) return
      onApply(fieldOf(event.currentTarget), write)
    },
    [onApply],
  )

  return (
    <div data-testid="color-controls" className="flex flex-col gap-1.5">
      {targets.map((target) => (
        <div key={target.field} className="flex flex-wrap items-center gap-2">
          <span className="w-12 shrink-0 text-chrome-muted dark:text-ink-muted">
            {target.label}
          </span>
          <input
            type="color"
            name={target.field}
            data-field={target.field}
            data-current={target.current ?? undefined}
            data-testid={`swatch-${target.field}`}
            aria-label={`${target.label} color`}
            value={toColorInputValue(target.current)}
            onChange={onSwatchPick}
            className="h-6 w-8 cursor-pointer rounded border border-chrome-line bg-transparent p-0 dark:border-ink-line"
          />
          {picker !== null ? (
            <button
              type="button"
              data-field={target.field}
              data-current={target.current ?? undefined}
              data-testid={`eyedrop-${target.field}`}
              aria-label={`Sample ${target.label} color with the eyedropper`}
              onClick={onEyedropClick}
              className="rounded border border-chrome-line px-1.5 py-0.5 hover:border-accent dark:border-ink-line"
            >
              <span aria-hidden="true">💧</span>
            </button>
          ) : null}
          <div className="flex flex-wrap items-center gap-1">
            {swatchViews.map((swatch) => (
              <button
                key={swatch.key}
                type="button"
                data-field={target.field}
                data-write={swatch.write}
                data-testid={`theme-${target.field}-${swatch.key}`}
                aria-label={`Apply theme color ${swatch.label} to ${target.label}`}
                title={swatch.label}
                onClick={onThemeClick}
                style={swatch.style}
                className="h-5 w-5 rounded border border-chrome-line hover:ring-2 hover:ring-accent dark:border-ink-line"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
