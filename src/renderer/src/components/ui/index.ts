/**
 * The design primitives M8b.2 lands (ui-design-audit.md §5.6). Surfaces adopt these in M8b.3+
 * rather than raw class strings; every interactive one owns its focus ring (rule R6).
 *
 * One import path so the nine parallel surface PRs do not each invent their own.
 */

export { Button, type ButtonProps, type ButtonVariant } from './Button'
export { Chip, type ChipProps, type ChipTone } from './Chip'
export { Dialog, type DialogProps } from './Dialog'
export { dividerGap, type DividerSize } from './Divider'
export { FOCUS_RING } from './focusRing'
export { Input, type InputProps } from './Input'
export { Notice, type NoticeProps, type NoticeTone } from './Notice'
export { PanelHeading, type PanelHeadingProps } from './PanelHeading'
export { ToolbarButton, type ToolbarButtonProps } from './ToolbarButton'
