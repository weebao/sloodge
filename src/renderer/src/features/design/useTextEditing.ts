/**
 * The parent half of direct text editing (M3.11) — §4.1 of `.claude/plans/init/40-design-mode.md`.
 *
 * Double-click (or `Enter`/`F2` on a selection) opens a caret **inside the frame**; this hook owns
 * the session's parent-side lifecycle and the one place a committed value becomes document bytes.
 *
 * ## Undo: coalesced structurally, not by a timer
 *
 * §7.2 asks for "one command per pause, not per character", and the plan reaches for a 600 ms
 * debounce. This hook does something stronger and simpler: **typing never touches the store at all.**
 * The characters live in the frame's DOM — which is already the live preview, for free — and the only
 * call to `setSlideHtml` happens once, when the session ends. So a burst of 500 keystrokes is exactly
 * one undo entry, not "usually one", and there is no window in which a fast typist or a slow frame
 * produces two. It is the same structural argument M3.5 makes for drag (only `pointerup` commits),
 * and it is why the M3.8 colour-picker bug — 250 entries from one gesture, evicting the user's
 * history past the 200-entry cap — cannot recur here: the cap is never approached because the entry
 * count is bounded by *sessions*, not by input events.
 *
 * A session that changed nothing commits nothing: `buildTextEditPatch` returns `null` for an
 * unchanged value, so tabbing through text without editing leaves the undo stack untouched.
 *
 * ## Enter / Escape / commit semantics, and why
 *
 * | Key            | Behaviour                                                                    |
 * |----------------|------------------------------------------------------------------------------|
 * | `Enter`        | **Commits** and returns to selection — never inserts a newline.               |
 * | `Escape`       | **Commits** and returns to selection (§9.3; PowerPoint keeps the text too).   |
 * | `Tab`          | Commits and returns to selection.                                            |
 * | Click elsewhere| Commits (the frame's `blur`).                                                 |
 *
 * `Enter` does not insert a line break in *any* element, heading or paragraph, and that is a
 * deliberate limit rather than an oversight. A raw newline in a text node renders as a space, so
 * inserting one would silently do nothing visible; representing a real break needs a `<br>`, which is
 * markup — and the whole point of this path is that it writes into a `textOnly` element's text-node
 * span and can therefore never introduce markup (see `text-edit.ts`). Multi-line content stays the
 * property panel's and the agent's job until a milestone that can safely edit mixed content lands.
 *
 * `Escape` committing rather than reverting follows §9.3 ("on blur/Esc the frame returns the
 * element's content") and PowerPoint, where `Esc` leaves your typing and selects the shape. Undo is
 * the cancel path and it is exactly one entry, so nothing is trapped.
 *
 * ## The untrusted-text rule
 *
 * The committed string arrives over postMessage from a realm the slide's own JS shares, so it is
 * untrusted (§2.2). This hook never treats it as markup: it re-derives the element from the parent's
 * own `SlideMap` by the parent-tracked `slId` and hands the string to `buildTextEditPatch`, which
 * escapes it into a text-node position and refuses any edit that would break the slide contract.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { SlEditEventPayload } from '../../../../shared/design/bridge-protocol'
import { buildSlideMap } from '../../../../shared/design/slide-map'
import { buildTextEditPatch, isTextEditable } from '../../../../shared/design/text-edit'
import { resolveElement } from '../../../../shared/design/property-model'
import { getSlideHtml, useDeckStore } from '../../stores/deckStore'
import { useDesignStore } from './designStore'
import type { DesignBridgeApi } from './useDesignBridge'

export interface TextEditingOptions {
  readonly slideId: string
  readonly requestEdit: DesignBridgeApi['requestEdit']
}

export interface TextEditingApi {
  /**
   * Open a session on `slId` if that element is editable. Returns `true` when a session was opened,
   * so a caller can fall back to another gesture when it was not.
   */
  readonly beginEdit: (slId: string) => boolean
  /** Handle a session the frame ended itself. Wire this into `useDesignBridge`'s `onEditEnd`. */
  readonly onFrameEditEnd: (payload: SlEditEventPayload) => void
  /** The sl-id with an open session, or `null`. */
  readonly editing: string | null
}

/** The Edit-menu label for a committed text edit, trimmed so the menu stays readable. */
function commitLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return 'Clear text'
  return `Edit text "${flat.length > 24 ? `${flat.slice(0, 24)}…` : flat}"`
}

export function useTextEditing(options: TextEditingOptions): TextEditingApi {
  const { slideId, requestEdit } = options
  const editing = useDesignStore((state) => state.editing)
  const beginEditing = useDesignStore((state) => state.beginEditing)
  const endEditing = useDesignStore((state) => state.endEditing)

  // Read through a ref inside callbacks that outlive a render (the frame's event can arrive at any
  // time), so a stale closure can never commit against the wrong session.
  const editingRef = useRef(editing)
  useEffect(() => {
    editingRef.current = editing
  }, [editing])

  /**
   * Whether `slId` can take a caret in the *current* bytes. Internal: the overlay derives the same
   * answer from the map it already builds, and exporting a second path invites the two to disagree.
   */
  const canEdit = useCallback(
    (slId: string): boolean => {
      const source = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (source === undefined) return false
      const element = resolveElement(buildSlideMap(slideId, source), slId)
      return element !== null && isTextEditable(element)
    },
    [slideId],
  )

  const beginEdit = useCallback(
    (slId: string): boolean => {
      if (!canEdit(slId)) return false
      beginEditing(slId)
      requestEdit(slId, 'begin')
      return true
    },
    [canEdit, beginEditing, requestEdit],
  )

  /**
   * The single commit point. Re-derives the element from current bytes and the parent-tracked id,
   * then writes at most one `setSlideHtml` — the whole session's undo entry.
   */
  const commitText = useCallback(
    (slId: string, text: string): void => {
      const source = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (source === undefined) return
      const patched = buildTextEditPatch(buildSlideMap(slideId, source), slId, text)
      // `null` covers every refusal — unchanged text, a non-editable or locked target, an sl-id the
      // map no longer has, or a patch that would introduce an SL-S04 violation. None of them may
      // push an undo entry.
      if (patched === null) return
      useDeckStore.getState().setSlideHtml(slideId, patched, slId, commitLabel(text))
    },
    [slideId],
  )

  const onFrameEditEnd = useCallback(
    (payload: SlEditEventPayload): void => {
      // Only the session the parent believes is open may commit. A forged event naming another
      // element is dropped here, before it can reach the source map.
      if (editingRef.current !== payload.slId) return
      editingRef.current = null
      endEditing()
      commitText(payload.slId, payload.text)
    },
    [endEditing, commitText],
  )

  // Ending a session the parent initiated: ask the frame for the text, then commit it. Used when the
  // app — not the frame — decides editing is over (Design Mode off, the slide changed, unmount).
  const endFromParent = useCallback(
    (slId: string, commit: boolean): void => {
      editingRef.current = null
      endEditing()
      requestEdit(slId, commit ? 'commit' : 'cancel', (result) => {
        if (commit && result !== null) commitText(slId, result.text)
      })
    },
    [endEditing, commitText, requestEdit],
  )

  // Design Mode turned off (or the overlay unmounted) with a session open: commit rather than
  // discard — the user's characters are on screen and losing them silently would be the worse bug.
  const endRef = useRef(endFromParent)
  useEffect(() => {
    endRef.current = endFromParent
  }, [endFromParent])
  useEffect(() => {
    return () => {
      const open = editingRef.current
      if (open !== null) endRef.current(open, true)
    }
  }, [])

  // The slide changed under an open session: the frame is about to be replaced and its `slId` refers
  // to the *previous* slide's map, so committing would write the wrong element. Abandon instead.
  const slideRef = useRef(slideId)
  useEffect(() => {
    if (slideRef.current === slideId) return
    const open = editingRef.current
    slideRef.current = slideId
    if (open !== null) endRef.current(open, false)
  }, [slideId])

  return { beginEdit, onFrameEditEnd, editing }
}
