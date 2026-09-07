/**
 * The one table of reasons a text cannot be edited, in words — shared by the caret (`useTextEditing`
 * raises it as the overlay notice when a double-click will not open) and the property panel (which
 * shows it as the disabled Content field's hint). One table because the vocabulary is one:
 * `textEditBlock`'s reasons, which `property-model.ts`'s `textFieldBlock` narrows for the panel.
 * A second copy over the same keys disagreed the day it was written — the panel captioned an `<img>`
 * "holds code or metadata" while the caret said, correctly, that there is no text on it (M3.12
 * round-4 review) — the same drift the write core and the gate each had to be unified to remove.
 *
 * Wording is surface-neutral wherever the sentence can be read in two places — it says what is
 * wrong with the element, not where the user is standing. The exception is `too-long`, which names
 * the panel on purpose: it is the one reason `textFieldBlock` narrows away, so only the caret ever
 * raises it, and pointing at the surface that *can* edit the text is the whole content of it.
 */

import type { TextEditBlock } from '../../../../shared/design/text-edit'

/**
 * What to tell the user about an element whose text cannot be edited. Same voice as
 * `useTextEditing`'s `REFUSAL_NOTICE`, different tense: nothing was attempted yet, so each of these
 * says why *this* element is not editable and, where there is one, where the text can be changed
 * instead.
 */
export const BLOCK_NOTICE: Readonly<Record<TextEditBlock, string>> = {
  'mixed-content':
    'This text has formatting inside it, so it can’t be edited as plain text yet — ask Claude to change it.',
  'not-text': 'There is no text on this element to edit.',
  'too-long': 'This text is too long to edit on the canvas — use the Content field in the panel.',
  locked: 'This element is locked, so its text can’t be edited.',
  'unknown-element': 'That element is no longer on this slide.',
}
