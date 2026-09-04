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
 * ## Ctrl/⌘+Z *inside* the caret is the field's undo, never the deck's
 *
 * While a session is open the element is a `contenteditable` with its own undo history, and §5 of
 * 10-architecture.md binds the deck's chord "only when focus is not inside a text input that has its
 * own native undo". In a browser host that is automatic — the keystroke lands in the frame and Blink
 * handles it. In Electron the Edit menu owns the accelerator, the chord arrives as `edit.undo` in the
 * parent, and the parent's `activeElement` is the `<iframe>`, so nothing about focus says "a field
 * owns this". The session therefore registers itself (`textEditSession.ts`) for as long as
 * `designStore.editing` is set, and `editActions.ts` forwards the chord to the frame as an `SL_EDIT`
 * `undo`/`redo`, which runs the editing host's own command. The deck's undo is unreachable from
 * inside a caret — the alternative (deck undo under an open session) changes the bytes, reloads the
 * frame and destroys the very text the user was trying to take back one character of.
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
 * ## The frame is the source of truth for whether a caret exists
 *
 * `designStore.editing` is set when the frame *confirms* a `begin`, not when the parent asks. The
 * flag is what puts the overlay into pass-through and disarms `Enter`/`F2`, so setting it early
 * would leave a live slide with no caret and no way back in whenever the frame did not answer (a
 * slide whose author JS swallowed the bridge's `message` handler). The reverse desync is closed
 * too: when the store clears `editing` behind this hook's back — `setSelection` of another element,
 * a shift-click, a marquee — the hook sends the frame a `cancel`, so a `contenteditable` never
 * outlives the flag that says it exists.
 *
 * ## The document moving under an open caret ends the session — by *cancel*, deterministically
 *
 * Three things can replace the frame's document while a caret is open: the slide switches, the slide's
 * bytes change from outside this hook (an agent edit landing via M2.6, a `deck:updated` snapshot, the
 * property panel), or the frame simply reloads. In every case the DOM the characters lived in is gone
 * and the frame's session with it; what must not survive is the parent's `editing` flag, because the
 * overlay reads it as "pass pointer events through, disarm Enter/F2" and would be stranded with a
 * live slide and no way to re-enter editing.
 *
 * The session is ended in the store and **not committed**. Committing would mean writing the
 * in-progress text against *new* bytes by a positional `slId` that referred to the old map — after an
 * agent restructures the slide, that id can name a different element, and a silent write into the
 * wrong element is worse than a lost in-progress edit. The same reasoning already applies to the
 * slide switch (the id belongs to the previous slide's map). Three signals end it, each sufficient on
 * its own: the `slideId` prop changing, the slide's html string changing while `editing` is set (a
 * commit from this hook clears `editing` *before* it writes, so it never trips this), and the frame's
 * next `SL_READY` — which by construction can only arrive for a fresh document, since a session
 * cannot begin before the first `SL_READY` armed the frame.
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
import { setActiveTextEditSession } from './textEditSession'
import type { DesignBridgeApi } from './useDesignBridge'

export interface TextEditingOptions {
  readonly slideId: string
  readonly requestEdit: DesignBridgeApi['requestEdit']
}

export interface TextEditingApi {
  /**
   * Ask the frame for a caret on `slId` if that element is editable in the source. Returns `true`
   * when it asked, so a caller can fall back to another gesture when it did not; the session itself
   * opens when the frame confirms (see the header).
   */
  readonly beginEdit: (slId: string) => boolean
  /** Handle a session the frame ended itself. Wire this into `useDesignBridge`'s `onEditEnd`. */
  readonly onFrameEditEnd: (payload: SlEditEventPayload) => void
  /** The frame loaded a fresh document. Wire this into `useDesignBridge`'s `onReady`. */
  readonly onFrameReady: () => void
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
    const previous = editingRef.current
    editingRef.current = editing
    // The store closed the session behind this hook's back — `setSelection` of another element, a
    // shift-click, a marquee — and the frame still has a live `contenteditable`. Tell it, or the two
    // disagree about whether a caret exists. Every end this hook performs itself nulls the ref
    // *before* the store, so those never arrive here with `previous` set.
    if (previous !== null && editing === null) requestEdit(previous, 'cancel')
  }, [editing, requestEdit])

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

  /** Close the session in the store without talking to the frame. */
  const dropSession = useCallback((): void => {
    editingRef.current = null
    endEditing()
  }, [endEditing])

  // The `begin` this hook is waiting on. Only the newest request may open a session; a reply to an
  // older one — an element asked for and then abandoned before the frame answered — is dropped.
  const pendingRef = useRef<string | null>(null)

  const beginEdit = useCallback(
    (slId: string): boolean => {
      if (!canEdit(slId)) return false
      pendingRef.current = slId
      requestEdit(slId, 'begin', (result) => {
        if (pendingRef.current !== slId) return
        pendingRef.current = null
        // The frame judges editability on its live DOM, which author JS may have changed since the
        // source was parsed (a script that split the text into spans). Declined means no caret, and
        // `editing` was never set, so nothing is stranded.
        if (result === null || !result.editing) return
        // The selection moved on while the frame was answering: the caret it just opened is on an
        // element nobody has selected, so close it rather than draw a caret frame around another.
        if (useDesignStore.getState().selection?.slId !== slId) {
          requestEdit(slId, 'cancel')
          return
        }
        editingRef.current = slId
        beginEditing(slId)
      })
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
      dropSession()
      commitText(payload.slId, payload.text)
    },
    [dropSession, commitText],
  )

  // Unmount with a session open — Design Mode turned off, the deck emptied. The bridge's listener is
  // already gone (it is declared before this hook in the overlay) and postMessage is asynchronous, so
  // the frame cannot be asked for its text from here. What saves the text on those paths is the
  // frame's own `blur`: a click on the Design Mode toggle, on Present, or the Settings accelerator
  // moves focus out of the frame, which commits, before React unmounts anything (all three executed
  // in Electron, round 2). Only the flag is cleared here.
  useEffect(() => {
    return () => {
      if (editingRef.current !== null) dropSession()
    }
  }, [dropSession])

  // The slide changed under an open session: the frame is being replaced and its `slId` refers to
  // the *previous* slide's map, so committing would write the wrong element. Abandon instead — the
  // bridge is already bound to the new slide id, so there is no frame to send a cancel to either.
  const slideRef = useRef(slideId)
  useEffect(() => {
    if (slideRef.current === slideId) return
    slideRef.current = slideId
    if (editingRef.current !== null) dropSession()
  }, [slideId, dropSession])

  // The slide's bytes changed under an open session from outside this hook — see the header. The
  // frame is reloading with the new bytes, so there is no session left to cancel there; only the
  // store's flag has to go. A commit from this hook never trips this: it clears `editing` first.
  const slideHtml = useDeckStore((state) => state.slideHtml)
  const source = getSlideHtml(slideHtml, slideId)
  const sourceRef = useRef(source)
  useEffect(() => {
    if (sourceRef.current === source) return
    sourceRef.current = source
    if (editingRef.current !== null) dropSession()
  }, [source, dropSession])

  // A fresh frame document while the flag is set: whatever caused the reload, the session is gone.
  const onFrameReady = useCallback((): void => {
    if (editingRef.current !== null) dropSession()
  }, [dropSession])

  // Announce the open session to the Edit menu's router for exactly as long as it is open.
  useEffect(() => {
    if (editing === null) return
    setActiveTextEditSession({
      undo: () => requestEdit(editing, 'undo'),
      redo: () => requestEdit(editing, 'redo'),
    })
    return () => {
      setActiveTextEditSession(null)
    }
  }, [editing, requestEdit])

  return { beginEdit, onFrameEditEnd, onFrameReady, editing }
}
