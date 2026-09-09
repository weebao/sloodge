/**
 * `data-sl-lock` — the one place Design Mode decides whether an element may be written at all
 * (`.claude/plans/init/30-slide-format.md` §3.4: "selectable but **not mutable** by Design Mode";
 * roadmap M3.16).
 *
 * ## Why this is a module and not four `if`s
 *
 * A locked element *is* selectable — the grabbable climb excludes only `html`/`head`/`body` — so it
 * arrives at every writer the editor has. Until M3.16 the attribute was read in exactly two of them
 * (the caret's `textEditBlock`, and through it the panel's Content field), and the other nine field
 * writers, flip, rotate, duplicate and the whole drag/align/distribute path mutated it happily: the
 * panel announced a lock it enforced on one field of ten.
 *
 * M3.6 learned the same lesson about its *transform* lock across four review rounds — enforced at
 * the overlay it was missing from the group anchor, then from align/distribute, then from a source
 * edit landing mid-drag; enforced at `buildDragPatch` it was still missing from the panel's X/Y
 * inputs — and ended with `moveChannel`: **one function answering "may this be written" for the
 * reader, the writer and the user-facing message alike**. This is that function for the lock, and
 * the refusals built on it sit in the three pure layers that make the bytes, not at the call sites:
 *
 * - `buildFieldOps` (`property-model.ts`) — every panel field, and therefore `buildDragPatch`,
 *   `buildMultiElementPatch`, the single drag, the group drag, and align/distribute.
 * - `commitTransform` (`transform-commit.ts`) — flip and rotate.
 * - `buildDuplicatePatch` (`duplicate.ts`) — duplicate.
 * - `textEditBlock` (`text-edit.ts`) — the caret and the panel's Content field, since M3.11/M3.12.
 *
 * A new entry point that goes through any of those inherits the refusal; one that does not is a new
 * writer, and belongs on this list.
 *
 * ## Duplicate is a mutation of the element it is invoked on
 *
 * Cloning a locked element inserts a second copy of chrome the deck author marked immutable, and the
 * clone carries the `data-sl-lock` with it — a locked element the user can neither move nor delete
 * from Design Mode. So `buildDuplicatePatch` refuses when the element being duplicated is locked.
 *
 * It does *not* refuse when a locked element merely rides along inside a free parent the user did
 * legitimately act on (pinned in `lock.test.ts`, writer 6). Both halves are the same span-scoped
 * rule — the refusal is about acting **on** the locked element — and the passenger copy is the
 * author's own copy, arriving still locked, exactly as it would if they had copied the card in the
 * source. Refusing any subtree that merely contains a locked node would let one locked caption
 * freeze a whole card, which §3.4's "selectable but not mutable" does not ask for.
 *
 * ## Scope: the attribute answers for its own element, never for its subtree
 *
 * `lockRefusal` takes an `ElementSpan` and no `SlideMap`, which is the scope written into the
 * signature: an ancestor walk is not expressible at any gate. A free `<p>` inside a locked `<div>` is
 * therefore fully mutable — colour, drag, group move, flip, rotate, duplicate and the caret all land
 * on it — and it is also what a click on that text *selects*, because the grabbable climb
 * (`grabbable.ts`) stops at the first addressable node rather than at the outermost one.
 *
 * That is the contract as written: `30-slide-format.md` §3.3 gives `data-sl-ignore` explicit
 * "(or subtree)" wording and §3.4's `data-sl-lock` row has none — §3.4 now states the asymmetry
 * rather than leaving it to be inferred. Whether a locked container *should* freeze its children is a
 * product question this module does not get to settle; roadmap **M3.21** puts it to the user with the
 * evidence. Both directions are pinned by tests (`lock.test.ts`, "scope"), so moving the rule is a
 * visible decision that reds a suite rather than a quiet change of meaning.
 *
 * ## What the lock is *not*
 *
 * It is not the transform lock (`moveChannel`'s `refused` arm, M3.6): that one is about a `matrix()`
 * a move cannot be written through, is per-channel, and still lets width, colour and text edits land.
 * Deliberately kept out of `moveChannel`, which stays a question about *which channel a move uses* —
 * folding the lock in there would have made `readPropertyValues` read a locked `left: 10px` element's
 * X off its (absent) translate and show the field empty, so the panel would grey out the truth.
 */

import type { ElementSpan } from './types'

/** The attribute. `30-slide-format.md` §3.4; the frame script has its own copy, it is injected. */
export const LOCK_ATTR = 'data-sl-lock'

/**
 * The refusal as a **clause**, for the surfaces that embed it in a sentence of their own — the
 * overlay's `N of M won't move — …` badge, beside `moveRefusal`'s clauses in the same slot.
 */
export const LOCK_REASON = 'it is locked with data-sl-lock'

/**
 * The refusal as a **sentence**, for the surfaces that show it alone — every disabled property-panel
 * control's tooltip, `BLOCK_NOTICE.locked` (so the caret's double-click notice says the same thing),
 * and the overlay's badge on a single locked element. Derived from `LOCK_REASON` rather than written
 * out a second time: two tables over one reason drifted the day they were written (M3.12 round-4).
 */
export const LOCK_NOTICE = `Design Mode can’t change this element — ${LOCK_REASON}.`

/** Whether `data-sl-lock` is present. The whole rule: the value is not read, only the attribute. */
export function isLocked(element: ElementSpan): boolean {
  return element.attrs[LOCK_ATTR] !== undefined
}

/**
 * Why Design Mode will not write this element, or `null` when it may. The decision function every
 * writer and every surface calls, so a control the panel offers is by construction a control an edit
 * would honour. `null` in, `null` out: an unresolved sl-id is not "locked", it is absent, and its
 * caller already has its own answer for that.
 *
 * Takes the element and no map, deliberately: the answer is about *this* element's own attributes,
 * so a locked ancestor cannot refuse a free descendant and a locked descendant cannot refuse a free
 * ancestor. See "Scope" above — that is the shipped contract, not an omission.
 */
export function lockRefusal(element: ElementSpan | null): string | null {
  return element !== null && isLocked(element) ? LOCK_REASON : null
}

/**
 * The same decision as `lockRefusal`, worded as a standalone sentence — for the property panel's
 * disabled controls and the overlay's badge on a single locked element, which have no sentence of
 * their own to embed a clause in. Both spellings resolve through `isLocked`, so a surface can pick
 * the grammar it needs without picking a different rule.
 */
export function lockNotice(element: ElementSpan | null): string | null {
  return element !== null && isLocked(element) ? LOCK_NOTICE : null
}
