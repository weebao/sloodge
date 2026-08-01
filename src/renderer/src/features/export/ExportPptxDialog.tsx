import { useCallback, useState, type ChangeEvent, type JSX, type MouseEvent } from 'react'
import type { PptxFidelity } from '../../../../shared/export/pptx/types'

/**
 * The PPTX fidelity dialog (M4.3 / 20-ui-wireframes.md, 60-export.md §3.8). PowerPoint has no layout
 * engine, so a slide is either converted to editable shapes (where it converts faithfully) or placed
 * as a picture (where it does not). This dialog lets the user choose how that decision is made:
 *
 *  - **Auto** — decide per slide by a confidence score (the recommended default);
 *  - **Editable where possible** — force structured conversion even below threshold, risks and all;
 *  - **Picture-perfect** — rasterize every slide, guaranteeing the visual at the cost of editability.
 *
 * A lightweight overlay rather than a Radix dialog: the app has no dialog primitive yet and M4.3 adds
 * zero UI dependencies. It is a controlled component — `open` drives visibility — so it renders
 * predictably in happy-dom tests without relying on the native `<dialog>` modal stack.
 */

export type ExportPptxDialogProps = {
  open: boolean
  slideCount: number
  onCancel: () => void
  onExport: (fidelity: PptxFidelity) => void
}

const OPTIONS: ReadonlyArray<{ value: PptxFidelity; label: string; hint: string }> = [
  {
    value: 'auto',
    label: 'Auto (recommended)',
    hint: 'Editable text and shapes where a slide converts cleanly; a picture where it does not.',
  },
  {
    value: 'editable',
    label: 'Editable where possible',
    hint: 'Force editable conversion for every slide. Complex slides may look different in PowerPoint.',
  },
  {
    value: 'raster',
    label: 'Picture-perfect (all raster)',
    hint: 'Every slide is a full-resolution image. Looks exact, but nothing is editable.',
  },
]

export function ExportPptxDialog(props: ExportPptxDialogProps): JSX.Element | null {
  const { open, slideCount, onCancel, onExport } = props
  const [fidelity, setFidelity] = useState<PptxFidelity>('auto')

  const stopPropagation = useCallback((event: MouseEvent) => {
    event.stopPropagation()
  }, [])
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setFidelity(event.target.value as PptxFidelity)
  }, [])
  const handleExport = useCallback(() => {
    onExport(fidelity)
  }, [onExport, fidelity])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-pptx-title"
        className="w-[28rem] max-w-[90vw] rounded-lg bg-white p-6 shadow-xl"
        onClick={stopPropagation}
      >
        <h2 id="export-pptx-title" className="text-lg font-semibold text-neutral-900">
          Export to PowerPoint
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          {slideCount} slide{slideCount === 1 ? '' : 's'} · fidelity
        </p>

        <fieldset className="mt-4 space-y-3">
          <legend className="sr-only">PowerPoint fidelity</legend>
          {OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-md border border-neutral-200 p-3 hover:bg-neutral-50"
            >
              <input
                type="radio"
                name="pptx-fidelity"
                value={option.value}
                checked={fidelity === option.value}
                onChange={handleChange}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium text-neutral-900">{option.label}</span>
                <span className="text-xs text-neutral-500">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <p className="mt-4 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
          Animations and interactivity can&apos;t run in PowerPoint. Animated slides export as a
          single still frame; export to HTML to keep them working.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Export
          </button>
        </div>
      </div>
    </div>
  )
}
