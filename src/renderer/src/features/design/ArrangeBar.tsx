/**
 * The floating **Arrange** toolbar (M3.7) — align and distribute for a multi-selection. It appears
 * over the top of the canvas only in Design Mode with two or more elements selected, mirroring
 * PowerPoint's contextual Arrange group. It owns no state: the buttons call `useArrangeActions`,
 * which commits each align/distribute as one undoable command, and the enable rules come straight
 * from the selection count (align ≥2, distribute ≥3).
 */

import { useCallback, type JSX, type ReactNode } from 'react'
import { useDesignStore } from './designStore'
import { useArrangeActions } from './useArrangeActions'
import type { AlignEdge, DistributeAxis } from '../../../../shared/design/arrange'

export type ArrangeBarProps = {
  /** The slide whose source the align/distribute commands patch. */
  readonly slideId: string
}

const BUTTON =
  'inline-flex h-7 w-7 items-center justify-center rounded border border-transparent text-shell-fg transition-colors hover:border-chrome-line hover:bg-chrome-alt disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent dark:text-ink-fg dark:hover:border-ink-line dark:hover:bg-ink-alt'

function Icon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
    >
      {children}
    </svg>
  )
}

/** Each align icon: a reference rule plus two bars hugging the aligned edge/centre. */
const ALIGN_ICON: Readonly<Record<AlignEdge, JSX.Element>> = {
  left: (
    <Icon>
      <path d="M2 2v12" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="3.5" y="4" width="8" height="2.2" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="3.5" y="9.8" width="5" height="2.2" rx="0.6" fill="currentColor" stroke="none" />
    </Icon>
  ),
  hcenter: (
    <Icon>
      <path d="M8 2v12" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="4" y="4" width="8" height="2.2" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="5.5" y="9.8" width="5" height="2.2" rx="0.6" fill="currentColor" stroke="none" />
    </Icon>
  ),
  right: (
    <Icon>
      <path d="M14 2v12" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="4.5" y="4" width="8" height="2.2" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="7.5" y="9.8" width="5" height="2.2" rx="0.6" fill="currentColor" stroke="none" />
    </Icon>
  ),
  top: (
    <Icon>
      <path d="M2 2h12" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="4" y="3.5" width="2.2" height="8" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="9.8" y="3.5" width="2.2" height="5" rx="0.6" fill="currentColor" stroke="none" />
    </Icon>
  ),
  vcenter: (
    <Icon>
      <path d="M2 8h12" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="4" y="4" width="2.2" height="8" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="9.8" y="5.5" width="2.2" height="5" rx="0.6" fill="currentColor" stroke="none" />
    </Icon>
  ),
  bottom: (
    <Icon>
      <path d="M2 14h12" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="4" y="4.5" width="2.2" height="8" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="9.8" y="7.5" width="2.2" height="5" rx="0.6" fill="currentColor" stroke="none" />
    </Icon>
  ),
}

const ALIGN_LABEL: Readonly<Record<AlignEdge, string>> = {
  left: 'Align left',
  hcenter: 'Align center',
  right: 'Align right',
  top: 'Align top',
  vcenter: 'Align middle',
  bottom: 'Align bottom',
}

const ALIGN_ORDER: readonly AlignEdge[] = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom']

const DISTRIBUTE_ICON: Readonly<Record<DistributeAxis, JSX.Element>> = {
  horizontal: (
    <Icon>
      <rect x="1.5" y="4.5" width="2.4" height="7" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="6.8" y="4.5" width="2.4" height="7" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="12.1" y="4.5" width="2.4" height="7" rx="0.6" fill="currentColor" stroke="none" />
    </Icon>
  ),
  vertical: (
    <Icon>
      <rect x="4.5" y="1.5" width="7" height="2.4" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="4.5" y="6.8" width="7" height="2.4" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="4.5" y="12.1" width="7" height="2.4" rx="0.6" fill="currentColor" stroke="none" />
    </Icon>
  ),
}

const DISTRIBUTE_LABEL: Readonly<Record<DistributeAxis, string>> = {
  horizontal: 'Distribute horizontally',
  vertical: 'Distribute vertically',
}

const DISTRIBUTE_ORDER: readonly DistributeAxis[] = ['horizontal', 'vertical']

export function ArrangeBar({ slideId }: ArrangeBarProps): JSX.Element | null {
  const count = useDesignStore((state) => state.selections.length)
  const actions = useArrangeActions(slideId)

  // One hoisted handler per group reads its target from the button's data attribute, so the eight
  // buttons share a stable prop (react-perf: no fresh closure per button per render).
  const { align, distribute } = actions
  const onAlignClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      align(event.currentTarget.dataset['edge'] as AlignEdge)
    },
    [align],
  )
  const onDistributeClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      distribute(event.currentTarget.dataset['axis'] as DistributeAxis)
    },
    [distribute],
  )

  // Contextual, like PowerPoint's Arrange group: nothing to arrange with fewer than two elements.
  if (count < 2) return null

  return (
    <div
      role="toolbar"
      aria-label="Arrange"
      data-testid="arrange-bar"
      className="pointer-events-auto absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-chrome-line bg-white/95 px-1.5 py-1 shadow-md backdrop-blur dark:border-ink-line dark:bg-ink-alt/95"
    >
      <span className="px-1 text-[11px] font-medium text-chrome-muted dark:text-ink-muted">
        {count} selected
      </span>
      <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-chrome-line dark:bg-ink-line" />
      {ALIGN_ORDER.map((edge) => (
        <button
          key={edge}
          type="button"
          data-edge={edge}
          aria-label={ALIGN_LABEL[edge]}
          title={ALIGN_LABEL[edge]}
          className={BUTTON}
          onClick={onAlignClick}
        >
          {ALIGN_ICON[edge]}
        </button>
      ))}
      <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-chrome-line dark:bg-ink-line" />
      {DISTRIBUTE_ORDER.map((axis) => (
        <button
          key={axis}
          type="button"
          data-axis={axis}
          aria-label={DISTRIBUTE_LABEL[axis]}
          title={DISTRIBUTE_LABEL[axis]}
          disabled={!actions.canDistribute}
          className={BUTTON}
          onClick={onDistributeClick}
        >
          {DISTRIBUTE_ICON[axis]}
        </button>
      ))}
    </div>
  )
}
