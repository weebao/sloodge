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
 * A session that changed nothing commits nothing: `resolveTextEdit` answers `unchanged` for an
 * untouched value, so tabbing through text without editing leaves the undo stack untouched.
 *
 * ## A refused edit is put back, and said out loud (M3.11 round-4)
 *
 * `resolveTextEdit` can also *refuse* — an over-cap value, a locked or non-editable target, an sl-id
 * the map no longer has, an SL-S04 violation. Refusing is right; refusing **silently** was not. The
 * frame ends a session on its own keystrokes and hands the text over afterwards, so a rejected
 * 70 000-character paste stayed on screen looking accepted, and vanished later at an unrelated
 * moment when something else reloaded the slide (reproduced in the built app). So a refusal now does
 * two things: it sends the frame a `revert`, which puts the element back to the text the session
 * began with — the committed text, since nothing was written — and it raises a notice the overlay
 * shows. What the user sees then matches what is stored, at the moment it is decided.
 *
 * `unchanged` stays silent: it is the ordinary outcome of opening a caret and leaving.
 *
 * Refusing to *open* one says so too (round-5). A double-click on `Revenue rose <b>18%</b> in Q3` did
 * nothing at all — no caret, no notice, no explanation — which is the shape of the report this
 * milestone exists to answer. `BLOCK_NOTICE` names the reason instead: formatting inside the element,
 * a lock, a value already past the cap, or an element with no text.
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
 * | Design Mode off| **Commits** — the session is finished on the way out (round-7).               |
 * | Present        | Commits by that same path: Present forces Design Mode off.                    |
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
 * Three things can end a caret's document from outside: the slide switches, the slide's bytes change
 * from outside this hook (an agent edit landing via M2.6, a `deck:updated` snapshot, the property
 * panel), or the frame simply reloads. What must not survive any of them is the parent's `editing`
 * flag, because the overlay reads it as "pass pointer events through, disarm Enter/F2" and would be
 * stranded with a live slide and no way to re-enter editing.
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
 * ## Ending a session on its own frame, not on whichever frame is current
 *
 * Two of those three signals used to be self-cleaning: a reload or a slide switch destroyed the DOM
 * the characters lived in, so clearing the store flag was the whole job. M8.2's lazy mounting made
 * that false for the slide switch — the outgoing slide's frame stays mounted as a hidden, `inert`
 * neighbour so a step back is instant, and it keeps its `contenteditable` and the uncommitted text
 * with it. Meanwhile the bridge has re-bound to the incoming slide, so a `cancel` sent through the
 * ordinary `requestEdit` would carry the *new* slide id and be dropped by the old frame's slide
 * guard. Left alone, that is a frame showing text the deck does not have, which disappears at the
 * next unrelated re-render, and an element that is still directly typeable with no session behind it.
 *
 * So a session captures its sender at `begin` (`pinEdit`), bound to the frame and slide id that were
 * current then, and every parent-side end — the slide switch, a bytes change, unmount, and a refusal
 * that has to `revert` — addresses *that* frame. It is the same "capture at the start of the gesture"
 * discipline the drag path applies to its pointer target. The one end that does not need it is
 * `SL_READY`, where the element itself is gone.
 *
 * ## Leaving Design Mode finishes the session rather than dropping it
 *
 * Turning Design Mode off — the toggle, `Ctrl/⌘+D`, or Present, which forces it off — unmounts the
 * overlay, and with it the bridge listener that would have heard the frame’s `SL_EDIT`. The click
 * that does it also blurs the editing host, so the frame ends its own session and keeps the typed
 * text; the parent simply was not listening any more. Round 6 cancelled that caret at unmount, which
 * put the pre-edit text back and threw the user’s sentence away without saying so (round-7 major,
 * 3/3 in the built app) — someone who types and then hits Present to see how it looks has not asked
 * to lose the words, and every other exit from a session keeps them.
 *
 * So unmount *finishes* the session instead: `PinnedEdit.finish` sends the frame a `commit` and
 * hears the answer on a one-shot listener of its own, which outlives this hook by design (see
 * `useDesignBridge`). The answer is the same string whichever state the frame is in — a session it
 * still has open ends with `endEdit(false)`, one it already closed on the blur answers from the live
 * DOM — and it goes through the same `commitText` as every other exit, so an over-cap or forbidden
 * value is still refused and put back. Only a frame that never answers falls back to cancelling:
 * text the parent could not read is text it cannot vouch for.
 *
 * ## The untrusted-text rule
 *
 * The committed string arrives over postMessage from a realm the slide's own JS shares, so it is
 * untrusted (§2.2). This hook never treats it as markup: it re-derives the element from the parent's
 * own `SlideMap` by the parent-tracked `slId` and hands the string to `resolveTextEdit`, which
 * escapes it into a text-node position and refuses any edit that would break the slide contract.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SlEditEventPayload } from '../../../../shared/design/bridge-protocol'
import { buildSlideMap } from '../../../../shared/design/slide-map'
import {
  resolveTextEdit,
  textEditBlock,
  type TextEditBlock,
  type TextEditRefusal,
} from '../../../../shared/design/text-edit'
import { resolveElement } from '../../../../shared/design/property-model'
import { getSlideHtml, useDeckStore } from '../../stores/deckStore'
import { useDesignStore } from './designStore'
import { setActiveTextEditSession } from './textEditSession'
import type { DesignBridgeApi, PinnedEdit } from './useDesignBridge'

export interface TextEditingOptions {
  readonly slideId: string
  readonly requestEdit: DesignBridgeApi['requestEdit']
  /** Pins a session's sender to the frame it opened on — see `ending a session on its own frame`. */
  readonly pinEdit: DesignBridgeApi['pinEdit']
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
  /** A refused edit to tell the user about, or `null`. Cleared by `dismissNotice`. */
  readonly notice: string | null
  /** Drop the current notice — the user acknowledged it, or started editing again. */
  readonly dismissNotice: () => void
}

/** What to tell the user about an edit that was refused. One sentence, no jargon, no id. */
const REFUSAL_NOTICE: Readonly<Record<TextEditRefusal, string>> = {
  'too-long': 'That text is too long to store on a slide, so the element was left as it was.',
  'not-editable': 'That element can no longer be edited here, so it was left as it was.',
  'unknown-element': 'That element is no longer on this slide, so the edit was not applied.',
  'forbidden-token': 'That text is not allowed in a slide, so the element was left as it was.',
}

/**
 * What to tell the user about a caret that would not open. Same voice as `REFUSAL_NOTICE`, different
 * tense: nothing was attempted yet, so each of these says why *this* element cannot take a caret and,
 * where there is one, where the text can be changed instead.
 */
const BLOCK_NOTICE: Readonly<Record<TextEditBlock, string>> = {
  'mixed-content':
    'This text has formatting inside it, so it can’t be edited on the canvas yet — ask Claude to change it.',
  'not-text': 'There is no text on this element to edit.',
  'too-long': 'This text is too long to edit on the canvas — use the Content field in the panel.',
  locked: 'This element is locked, so its text can’t be edited.',
  'unknown-element': 'That element is no longer on this slide.',
}

/**
 * End a caret from the parent: take the `contenteditable` away and put the element back to the text
 * the session opened with. Both actions, always, because the parent cannot know which of the frame's
 * two states it is talking to.
 *
 * `cancel` reaches a session the frame still has **open**. `revert` (`frameScript`'s `revertEdit`,
 * over the `lastEnded` it keeps for exactly this) reaches one the frame has already **closed by
 * itself** — and a re-render is precisely the thing that closes one first: it blurs the editing host,
 * whose `endEdit(false)` drops the `contenteditable` and deliberately keeps the typed text, while the
 * `SL_EDIT` it posts back arrives too late to be the session the parent still believes in. That is
 * the round-6 blocker: a `deck:updated` leaving the edited slide's own bytes untouched (the agent
 * writing another slide, or the deck re-sent) left the frame showing text no document contained,
 * which vanished silently at the next unrelated commit.
 *
 * Sending both is safe, not merely convenient: `revertEdit` applies once, only to that sl-id, and
 * only while the node is still in the document, so on the open-session path it lands on the text
 * `cancel` just restored and writes the same value. It is the one-two `commitText` already sends for
 * a refused commit.
 */
function endFrameCaret(session: PinnedEdit | null): void {
  session?.send('cancel')
  session?.send('revert')
}

/** The Edit-menu label for a committed text edit, trimmed so the menu stays readable. */
function commitLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return 'Clear text'
  return `Edit text "${flat.length > 24 ? `${flat.slice(0, 24)}…` : flat}"`
}

export function useTextEditing(options: TextEditingOptions): TextEditingApi {
  const { slideId, requestEdit, pinEdit } = options
  const editing = useDesignStore((state) => state.editing)
  const beginEditing = useDesignStore((state) => state.beginEditing)
  const endEditing = useDesignStore((state) => state.endEditing)
  const [notice, setNotice] = useState<string | null>(null)
  const dismissNotice = useCallback((): void => {
    setNotice(null)
  }, [])

  // Read through a ref inside callbacks that outlive a render (the frame's event can arrive at any
  // time), so a stale closure can never commit against the wrong session.
  const editingRef = useRef(editing)
  // The open session's sender, pinned to the frame the caret is actually in. Set when the frame
  // confirms a `begin` and cleared by every path that ends the session.
  const sessionFrameRef = useRef<PinnedEdit | null>(null)
  useEffect(() => {
    const previous = editingRef.current
    editingRef.current = editing
    // An open session always knows which frame its caret is in, however the flag came to be set.
    // `beginEdit` pins before it asks, which is the frame that will answer; this fills in for the
    // other way the store can open one — `beginEditing` called directly — so `cancelSession` never
    // has nothing to talk to.
    //
    // `previous === null` is what makes that a pin rather than a re-pin, and it is load-bearing:
    // this effect also re-runs whenever `pinEdit` changes identity, which is on every slide change,
    // while `editing` is still set. Pinning there would bind an open session to the *incoming*
    // frame, and the slide switch that follows would cancel the caret on a frame that never had one
    // — the round-5 blocker, from the other end.
    if (previous === null && editing !== null && sessionFrameRef.current === null) {
      sessionFrameRef.current = pinEdit(editing)
    }
    // The store closed the session behind this hook's back — `setSelection` of another element, a
    // shift-click, a marquee — and the frame still has a live `contenteditable`. Tell it, or the two
    // disagree about whether a caret exists. Every end this hook performs itself nulls the ref
    // *before* the store, so those never arrive here with `previous` set.
    if (previous === null || editing !== null) return
    endFrameCaret(sessionFrameRef.current)
    sessionFrameRef.current = null
  }, [editing, pinEdit])

  /**
   * Why `slId` cannot take a caret in the *current* bytes, or `null` when it can. Internal: the
   * overlay derives the same answer from the map it already builds, and exporting a second path
   * invites the two to disagree.
   */
  const editBlock = useCallback(
    (slId: string): TextEditBlock | null => {
      const source = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (source === undefined) return 'unknown-element'
      return textEditBlock(resolveElement(buildSlideMap(slideId, source), slId))
    },
    [slideId],
  )

  /** Close the session in the store. For the paths where the frame has already ended its own. */
  const dropSession = useCallback((): void => {
    editingRef.current = null
    sessionFrameRef.current = null
    endEditing()
  }, [endEditing])

  /**
   * End a session the *parent* is abandoning: put the frame's element back to the text the caret
   * opened with and take the `contenteditable` away, then drop the flag. Addressed to the frame the
   * session was pinned to at `begin`, which since M8.2 may no longer be the one the bridge is bound
   * to — see `pinEdit`, and see `endFrameCaret` for why ending one takes two messages.
   */
  const cancelSession = useCallback((): void => {
    endFrameCaret(sessionFrameRef.current)
    dropSession()
  }, [dropSession])

  // The `begin` this hook is waiting on. Only the newest request may open a session; a reply to an
  // older one — an element asked for and then abandoned before the frame answered — is dropped.
  const pendingRef = useRef<string | null>(null)

  const beginEdit = useCallback(
    (slId: string): boolean => {
      // A new caret supersedes whatever the last one was told; leaving the notice up would attach it
      // to the wrong element.
      setNotice(null)
      // Refusing to open is right for mixed content, a lock or an over-cap value — refusing
      // *silently* was the bug this milestone exists to fix, in miniature: the user double-clicks
      // text and nothing whatsoever happens (round-5 major). Say which of those it is instead.
      const block = editBlock(slId)
      if (block !== null) {
        setNotice(BLOCK_NOTICE[block])
        return false
      }
      pendingRef.current = slId
      // The frame this caret will live in, captured before the request rather than in the reply —
      // the same frame `requestEdit` is about to address, whatever the bridge is bound to later.
      const session = pinEdit(slId)
      requestEdit(slId, 'begin', (result) => {
        // A newer request superseded this one: the user asked for another element before the frame
        // answered. The frame may have opened this caret anyway and nothing here will ever own it,
        // so close it rather than leave a `contenteditable` with no session behind it.
        if (pendingRef.current !== slId) {
          session.send('cancel')
          return
        }
        pendingRef.current = null
        // `null` is the frame saying it has no such element — or the bridge answering for a frame
        // that never will, because the slide moved on under the request. Same treatment either way:
        // close whatever may have opened, and say so rather than do nothing visible.
        if (result === null) {
          session.send('cancel')
          setNotice(BLOCK_NOTICE['unknown-element'])
          return
        }
        // The frame judges editability on its live DOM, which author JS may have changed since the
        // source was parsed (a script that split the text into spans). Declined means no caret, and
        // `editing` was never set, so nothing is stranded — but it still has to be said out loud.
        if (!result.editing) {
          setNotice(BLOCK_NOTICE['mixed-content'])
          return
        }
        // The selection moved on while the frame was answering: the caret it just opened is on an
        // element nobody has selected, so close it rather than draw a caret frame around another.
        if (useDesignStore.getState().selection?.slId !== slId) {
          session.send('cancel')
          return
        }
        sessionFrameRef.current = session
        editingRef.current = slId
        beginEditing(slId)
      })
      return true
    },
    [editBlock, beginEditing, requestEdit, pinEdit],
  )

  /**
   * The single commit point. Re-derives the element from current bytes and the parent-tracked id,
   * then writes at most one `setSlideHtml` — the whole session's undo entry.
   */
  const commitText = useCallback(
    (slId: string, text: string, session: PinnedEdit | null): void => {
      const source = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (source === undefined) return
      const outcome = resolveTextEdit(buildSlideMap(slideId, source), slId, text)
      // Nothing to write, and nothing worth saying: an untouched caret must not push an undo entry.
      if (outcome.kind === 'unchanged') return
      // Refused. The frame is still showing the value that was turned down, so put it back before
      // anything else can make the mismatch look like a save — see the header.
      if (outcome.kind === 'refused') {
        session?.send('revert')
        setNotice(REFUSAL_NOTICE[outcome.reason])
        return
      }
      useDeckStore.getState().setSlideHtml(slideId, outcome.source, slId, commitLabel(text))
    },
    [slideId],
  )

  const onFrameEditEnd = useCallback(
    (payload: SlEditEventPayload): void => {
      // Only the session the parent believes is open may commit. A forged event naming another
      // element is dropped here, before it can reach the source map.
      if (editingRef.current !== payload.slId) return
      // Read before the drop clears it: a refusal has to reach the frame this session was in.
      const session = sessionFrameRef.current
      dropSession()
      commitText(payload.slId, payload.text, session)
    },
    [dropSession, commitText],
  )

  // The commit a finishing session lands on, held in a ref rather than named in the effect below:
  // `commitText` is a fresh function on every slide change, and naming it in that effect's deps
  // would run the cleanup on every slide change — turning an ordinary switch into an unmount.
  const commitTextRef = useRef(commitText)
  useEffect(() => {
    commitTextRef.current = commitText
  }, [commitText])

  // Unmount with a session open — Design Mode turned off, Present, the deck emptied. The bridge's
  // listener goes with the overlay in the same commit, so the frame's own `SL_EDIT` has nobody left
  // to reach; `finish` brings a one-shot listener of its own for exactly that reason, and the typed
  // text is committed rather than discarded (see the header). The store flag drops immediately
  // either way: it must never outlive the overlay, whatever the frame goes on to answer.
  useEffect(() => {
    return () => {
      const slId = editingRef.current
      const session = sessionFrameRef.current
      if (slId === null) return
      dropSession()
      if (session === null) return
      session.finish((text) => {
        // The frame never answered: it is gone, or its script is dead. Put the element back rather
        // than leave it showing text no document contains (round-6).
        if (text === null) {
          endFrameCaret(session)
          return
        }
        commitTextRef.current(slId, text, session)
      })
    }
  }, [dropSession])

  // The slide changed under an open session. The `slId` refers to the *previous* slide's map, so
  // committing would write the wrong element; the session is abandoned instead.
  //
  // Abandoning has to be said to the frame, and that is the part M8.2 changed. Before lazy mounting,
  // a switch replaced the one mounted frame and the caret died with the document, so clearing the
  // store flag was the whole job. Now the outgoing slide's frame stays mounted as a hidden ±1
  // neighbour, keeping its `contenteditable` and the characters the user typed into it — text no
  // document contains, which then vanishes at whatever unrelated moment re-renders that frame, and a
  // §2.1 frozen frame that is directly typeable with no session behind it (round-5 blocker,
  // reproduced in the built app). So the pinned frame is told to cancel, which restores the text the
  // caret opened with and takes the `contenteditable` away.
  const slideRef = useRef(slideId)
  useEffect(() => {
    if (slideRef.current === slideId) return
    slideRef.current = slideId
    // A notice names an element on the slide the user just left; carrying it over would attach it to
    // whatever the new slide has (observed in the built app, where it survived a there-and-back).
    setNotice(null)
    if (editingRef.current !== null) cancelSession()
  }, [slideId, cancelSession])

  // The slide's bytes changed under an open session from outside this hook — see the header. The
  // frame does reload with the new bytes here, so the cancel is usually a no-op that lands on a fresh
  // document with no session; it is sent anyway rather than raced against the reload. A commit from
  // this hook never trips this: it clears `editing` first.
  const slideHtml = useDeckStore((state) => state.slideHtml)
  const source = getSlideHtml(slideHtml, slideId)
  const sourceRef = useRef(source)
  useEffect(() => {
    if (sourceRef.current === source) return
    sourceRef.current = source
    if (editingRef.current !== null) cancelSession()
  }, [source, cancelSession])

  // A fresh frame document while the flag is set: whatever caused the reload, the element the caret
  // was in no longer exists, so there is nothing to cancel — only the flag has to go.
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

  return { beginEdit, onFrameEditEnd, onFrameReady, editing, notice, dismissNotice }
}
