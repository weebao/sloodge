/**
 * The one open in-frame text-edit session, as seen by the Edit menu (M3.11).
 *
 * `editActions.ts` routes a menu Undo/Redo by asking "who owns this chord right now?". For a parent
 * `<input>` the answer is `document.activeElement`; for a caret inside the slide frame it is not —
 * `activeElement` is then the `<iframe>` element, which looks like nothing editable, and the router
 * would run the *deck's* undo: the bytes change, the frame reloads, the typed text is gone. So the
 * session announces itself here while it is open, and the router checks this before falling through
 * to the document stack.
 *
 * A module-level slot rather than a store field because it holds behaviour (how to forward the
 * chord), not state, and because the invariant it encodes — at most one caret across the app — is
 * exactly what a singleton says. `useTextEditing` registers on `designStore.editing` becoming
 * non-null and clears on it becoming null, so every path that ends a session (commit, cancel, slide
 * switch, frame reload, remote deck replacement) unregisters through the same effect.
 */

export interface FrameTextEditSession {
  /** Step the field's own undo stack inside the frame. */
  readonly undo: () => void
  /** Step the field's own redo stack inside the frame. */
  readonly redo: () => void
}

let active: FrameTextEditSession | null = null

export function setActiveTextEditSession(session: FrameTextEditSession | null): void {
  active = session
}

/** The open session's chord forwarder, or `null` when no caret is open in any frame. */
export function activeTextEditSession(): FrameTextEditSession | null {
  return active
}
