/**
 * The installed-font family dropdown (M3.10) — a searchable listbox that previews each face in
 * itself and commits the pick as one undoable edit.
 *
 * ## Why this is a custom listbox and not a `<select>`
 *
 * A native `<select>` would have given keyboard behaviour, one `change` event and one undo entry for
 * free, and it is what `ColorControls` does in spirit by delegating to the OS colour picker. It
 * cannot do the one thing this control exists for: `<option>` contents are drawn by the OS, so a
 * `font-family` on them is ignored on Windows — the user would get 341 identical-looking rows and no
 * reason to prefer this over typing a name. Previewing each face requires styled DOM, and styled DOM
 * means owning the ARIA and the keyboard. That is the trade this file pays for.
 *
 * ## Painting 341 faces without painting 341 faces
 *
 * Every rendered row sets `font-family`, which forces the browser to load and rasterise that face.
 * Doing it for the whole list is the difference between an instant dropdown and a visible stall, and
 * it grows with the user's font collection. So the list is windowed: rows are a fixed
 * `ROW_HEIGHT_PX` tall, the scroll position decides which slice exists in the DOM, and everything
 * else is two spacer divs. At most `VIEWPORT_ROWS + 2 * OVERSCAN_ROWS` faces are ever live.
 *
 * The heights are constants rather than measurements on purpose: a `ResizeObserver`/`clientHeight`
 * approach reports 0 in happy-dom, so the windowing would be untestable exactly where its off-by-one
 * bugs live. Fixed geometry means the same arithmetic runs in the test and in the app.
 *
 * ## The preview is the write
 *
 * A row's preview style comes from `buildFontFamilyValue` — the same composer that produces the
 * declaration written into the slide. There is no second code path that could render one thing and
 * save another, and the escaping that makes the value safe to write is the escaping that makes it
 * safe to preview.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'

import {
  SYSTEM_FONT_GROUP,
  buildFontFamilyValue,
  isSystemGroupFamily,
  readPickedFontFamily,
} from '../../../../shared/fonts/family'
import { isSystemFont } from '../../../../shared/fonts/system-fonts'
import type { SystemFontsResponse } from '../../../../shared/ipc-contract'
import { getBridge } from '../../host/bridge'

/** Row geometry. See the windowing note in the file header — these are constants for a reason. */
const ROW_HEIGHT_PX = 28
const VIEWPORT_ROWS = 8
const OVERSCAN_ROWS = 4

const LIST_HEIGHT_PX = ROW_HEIGHT_PX * VIEWPORT_ROWS

/** Loads the machine's families. Injected by tests; defaults to the preload bridge. */
export type SystemFontLoader = () => Promise<SystemFontsResponse>

const NO_FONTS: SystemFontsResponse = { families: [], source: 'none' }

/**
 * One shared, session-long fetch. Enumeration is a subprocess spawn in main, so every open after the
 * first must be free, and two panels opening at once must not queue two spawns. Module scope rather
 * than component state because the answer is a property of the machine, not of a mounted panel.
 */
let sharedFonts: Promise<SystemFontsResponse> | null = null

function loadFromBridge(): Promise<SystemFontsResponse> {
  sharedFonts ??= (getBridge()?.listSystemFonts?.() ?? Promise.resolve(NO_FONTS))
    .catch(() => NO_FONTS)
    .then((result) => {
      // A failure is not an answer, so it is not cached. `src/main/fonts/install.ts` goes out of
      // its way not to memoise a rejection for exactly this reason, and holding onto the empty
      // result here would have thrown that protection away one layer up: one transient spawn
      // failure and the user is on system fonts only until they restart the app.
      if (result.source === 'none' && result.families.length === 0) sharedFonts = null
      return result
    })
  return sharedFonts
}

type Row =
  | { readonly kind: 'header'; readonly key: string; readonly label: string }
  | { readonly kind: 'font'; readonly key: string; readonly name: string }

/**
 * Build the flat row list: the system group first (the faces that survive export), then everything
 * else the machine has. Headers ride in the same array as the fonts so the windowing arithmetic has
 * a single index space; arrow navigation skips them.
 */
export function buildFontRows(installed: readonly string[], filter: string): Row[] {
  const needle = filter.trim().toLowerCase()
  const matches = (name: string): boolean =>
    needle.length === 0 || name.toLowerCase().includes(needle)

  const system = SYSTEM_FONT_GROUP.map((entry) => entry.name).filter(matches)
  const others = installed.filter((name) => !isSystemGroupFamily(name) && matches(name))

  const rows: Row[] = []
  if (system.length > 0) {
    rows.push({ kind: 'header', key: 'h:system', label: 'System' })
    for (const name of system) rows.push({ kind: 'font', key: `s:${name}`, name })
  }
  if (others.length > 0) {
    rows.push({ kind: 'header', key: 'h:installed', label: 'Installed' })
    for (const name of others) rows.push({ kind: 'font', key: `i:${name}`, name })
  }
  return rows
}

/** The slice of rows that should exist in the DOM for a given scroll offset. */
export function visibleRange(rowCount: number, scrollTop: number): { start: number; end: number } {
  const first = Math.floor(scrollTop / ROW_HEIGHT_PX)
  const start = Math.max(0, first - OVERSCAN_ROWS)
  const end = Math.min(rowCount, first + VIEWPORT_ROWS + OVERSCAN_ROWS)
  return { start, end: Math.max(start, end) }
}

/** Scroll offset that brings a row fully into view, moving as little as possible. */
export function scrollTopFor(index: number, current: number): number {
  const top = index * ROW_HEIGHT_PX
  if (top < current) return top
  const bottom = top + ROW_HEIGHT_PX
  if (bottom > current + LIST_HEIGHT_PX) return bottom - LIST_HEIGHT_PX
  return current
}

export interface FontFamilyControlProps {
  /** The element's current `font-family` declaration as the source has it, or `null`. */
  readonly current: string | null
  /** Commit a picked face. Called once per pick — see the one-undo-entry note in `PropertyPanel`. */
  readonly onPick: (name: string) => void
  /** Test/demo seam, mirroring `PropertyPanel`'s `picker`. Omit to use the preload bridge. */
  readonly loadFonts?: SystemFontLoader
  /**
   * Focus-restore flag owned by a component *above* the commit-keyed subtree — see the focus note
   * on the effect that consumes it. Omit when this control is not rendered inside one.
   */
  readonly focusOnRemount?: RefObject<boolean>
}

export function FontFamilyControl({
  current,
  onPick,
  loadFonts,
  focusOnRemount,
}: FontFamilyControlProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [scrollTop, setScrollTop] = useState(0)
  const [fonts, setFonts] = useState<SystemFontsResponse | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number): string => `${baseId}-opt-${index}`

  const picked = readPickedFontFamily(current)
  const rows = useMemo(() => buildFontRows(fonts?.families ?? [], filter), [fonts, filter])

  // Fetch on first open, never on mount: a panel that is merely visible must not spawn a subprocess.
  useEffect(() => {
    if (!open || fonts !== null) return
    let live = true
    void (loadFonts ?? loadFromBridge)().then((result) => {
      if (live) setFonts(result)
    })
    return () => {
      live = false
    }
  }, [open, fonts, loadFonts])

  // `rows`/`picked` are read by the open-effect below but must not *trigger* it: re-running on every
  // keystroke would yank the cursor back to the current face while the user is filtering. The
  // latest-value refs keep the effect's dependencies down to the two events that should reset the
  // cursor — the popover opening, and the font list arriving.
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const pickedRef = useRef(picked)
  pickedRef.current = picked

  /**
   * Has the user moved the cursor since the popover opened? The enumeration resolves asynchronously,
   * and re-homing the cursor when it lands would undo an arrow-key move the user had already made —
   * their keystroke would simply vanish, more often on a slower machine where the spawn takes
   * longer. So the arrival only re-homes a cursor nobody has touched.
   */
  const cursorMovedRef = useRef(false)

  /** Did the popover open from ArrowUp, which APG says lands on the *last* option? */
  const openAtEndRef = useRef(false)

  // Opening lands the active row on the current face so Enter is a no-op rather than a surprise; so
  // does the font list arriving, since an installed pick is not in the list until then.
  useEffect(() => {
    if (!open || cursorMovedRef.current) return
    // ArrowUp asks for the *last* option, and until the enumeration lands the only rows are the
    // System group — so hold the intent rather than spend it on the last system face.
    if (openAtEndRef.current && fonts === null) return
    const list = rowsRef.current
    const index = openAtEndRef.current
      ? list.findLastIndex((row) => row.kind === 'font')
      : list.findIndex((row) => row.kind === 'font' && row.name === pickedRef.current)
    const target = index >= 0 ? index : list.findIndex((row) => row.kind === 'font')
    openAtEndRef.current = false
    setActiveIndex(target)
    setScrollTop(target > 0 ? scrollTopFor(target, 0) : 0)
  }, [open, fonts])

  // Keyboard navigation moves the window as well as the cursor, so the active row is always mounted.
  useEffect(() => {
    const list = listRef.current
    if (list !== null && list.scrollTop !== scrollTop) list.scrollTop = scrollTop
  }, [scrollTop])

  /**
   * Return focus to the trigger after a pick — across the remount the pick itself causes.
   *
   * `close(true)` focuses the trigger synchronously, which is correct for Escape and for a
   * click-away. It is not enough for a pick: committing changes `map.sourceHash`, and
   * `PropertyPanel` keys the whole field subtree on it, so React replaces the very button that was
   * focused a microsecond earlier and the document is left focused on `<body>` — a keyboard user
   * who picks a font is dumped at the top of the page. The flag therefore lives on a ref the panel
   * owns, above the key, so the *replacement* trigger can claim focus when it mounts.
   *
   * No dependency array on purpose: the flag is consumed on whichever commit comes first, whether
   * this component remounted (the usual case) or merely re-rendered (a pick that writes an
   * identical value changes no hash). Either way it cannot survive into a later, unrelated mount
   * and steal focus there.
   */
  useEffect(() => {
    if (focusOnRemount?.current !== true) return
    focusOnRemount.current = false
    triggerRef.current?.focus()
  })

  const close = useCallback((focusTrigger: boolean): void => {
    setOpen(false)
    setFilter('')
    cursorMovedRef.current = false
    openAtEndRef.current = false
    if (focusTrigger) triggerRef.current?.focus()
  }, [])

  // Click-away. `pointerdown` rather than `click` so the popover is gone before the click lands on
  // whatever is underneath it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (root !== null && !root.contains(event.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, close])

  const choose = useCallback(
    (name: string): void => {
      if (focusOnRemount !== undefined) focusOnRemount.current = true
      onPick(name)
      close(true)
    },
    [onPick, close, focusOnRemount],
  )

  // Focus can still leave without Tab — a click into another field, a programmatic `focus()` — and
  // once it has, the listbox is orphaned over the panel with `aria-activedescendant` pointing at a
  // listbox the focused element does not own. Closing on focus *landing outside* fixes that.
  // `relatedTarget === null` is deliberately not treated as leaving: that is what a mousedown on a
  // non-focusable row reports, and closing there would cancel the pick the click is about to make.
  // Genuine click-aways are the `pointerdown` handler's job.
  useEffect(() => {
    const root = rootRef.current
    if (!open || root === null) return
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget
      if (next instanceof Node && !root.contains(next)) close(false)
    }
    root.addEventListener('focusout', onFocusOut)
    return () => {
      root.removeEventListener('focusout', onFocusOut)
    }
  }, [open, close])

  const step = useCallback(
    (from: number, delta: number): number => {
      for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
        if (rows[i]?.kind === 'font') return i
      }
      return from
    },
    [rows],
  )

  /** A page is one viewport, walked a selectable row at a time so headers do not consume steps. */
  const page = useCallback(
    (from: number, delta: number): number => {
      let index = from
      for (let i = 0; i < VIEWPORT_ROWS; i += 1) {
        const next = step(index, delta)
        if (next === index) break
        index = next
      }
      return index
    },
    [step],
  )

  const moveTo = useCallback((index: number): void => {
    cursorMovedRef.current = true
    setActiveIndex(index)
    setScrollTop((previous) => scrollTopFor(index, previous))
  }, [])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      // `close(true)` moves focus to the trigger *before* the default action runs, so Tab
      // continues from the combobox's own tab stop and lands on the next control after it.
      // Deliberately not `preventDefault`ed: swallowing Tab would trap a keyboard user in a
      // popover that is already dismissed.
      if (event.key === 'Tab') {
        close(true)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        // A non-empty filter is a state the user can otherwise only leave by reopening the
        // popover, so the first Escape clears it and the second dismisses (APG).
        if (filter !== '') {
          setFilter('')
          setScrollTop(0)
          return
        }
        close(true)
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveTo(step(activeIndex, 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveTo(step(activeIndex, -1))
        return
      }
      // Home/End/PageUp/PageDown navigate the list rather than the caret. The input is a filter,
      // never prose — a few characters the user can reach with an arrow — while the list behind it
      // is hundreds of rows, which is where the keys earn their keep.
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        // Walking forward from before the list, or back from past its end, lands on the first or
        // last selectable row without a second notion of what "selectable" means.
        const target = event.key === 'End' ? step(rows.length, -1) : step(-1, 1)
        if (rows[target]?.kind === 'font') moveTo(target)
        return
      }
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault()
        moveTo(page(activeIndex, event.key === 'PageDown' ? 1 : -1))
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const row = rows[activeIndex]
        if (row?.kind === 'font') choose(row.name)
      }
    },
    [activeIndex, rows, step, moveTo, choose, close, page, filter],
  )

  const onFilterChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    setFilter(event.target.value)
    setScrollTop(0)
  }, [])

  // Type-to-filter re-flows the list, so the previous active index means nothing. Land on the first
  // match instead of leaving the cursor pointing at a row that scrolled away.
  useEffect(() => {
    if (!open) return
    setActiveIndex((previous) =>
      rows[previous]?.kind === 'font' ? previous : rows.findIndex((row) => row.kind === 'font'),
    )
  }, [rows, open])

  const onListScroll = useCallback((event: React.UIEvent<HTMLUListElement>): void => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  // The three APG openers. Alt+ArrowDown is the "open without moving the cursor" spelling — which is
  // what the effect above does anyway, since it homes on the current face — and ArrowUp opens onto
  // the last option. Enter and Space need no branch: they fire the button's own click.
  const onTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openAtEndRef.current = event.key === 'ArrowUp'
    setOpen(true)
  }, [])

  const toggle = useCallback((): void => {
    setOpen((previous) => !previous)
  }, [])

  const { start, end } = visibleRange(rows.length, scrollTop)
  const visible = rows.slice(start, end)

  // Spacer heights stand in for the rows that are not mounted, so the scrollbar reflects the whole
  // list. Memoised because a fresh object literal in a JSX prop re-renders the child every time.
  const topSpacer = useMemo<CSSProperties>(() => ({ height: start * ROW_HEIGHT_PX }), [start])
  const bottomSpacer = useMemo<CSSProperties>(
    () => ({ height: Math.max(0, (rows.length - end) * ROW_HEIGHT_PX) }),
    [rows.length, end],
  )

  // The warning asks the *export* layer's question, not "is it in the system group" — see
  // `SYSTEM_FONT_GROUP`. `picked` is the face, `current` the whole stack; either answers it.
  const showWarning = picked !== null && !isSystemFont(picked)

  return (
    <div ref={rootRef} className="relative flex items-center gap-1.5">
      <span className="text-chrome-muted dark:text-ink-muted">Font</span>
      <button
        ref={triggerRef}
        type="button"
        data-testid="prop-fontFamily"
        aria-label="Font family"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
        className="flex min-w-0 max-w-44 flex-1 items-center justify-between gap-1 rounded border border-chrome-line bg-white px-1.5 py-0.5 text-left text-shell-fg outline-none focus:border-accent dark:border-ink-line dark:bg-ink dark:text-ink-fg"
      >
        <span className="truncate">{picked ?? 'Default'}</span>
        <span aria-hidden="true" className="text-chrome-muted dark:text-ink-muted">
          ▾
        </span>
      </button>

      {showWarning ? (
        <span
          role="status"
          data-testid="font-export-warning"
          // Wraps rather than truncates: a caveat cut off mid-word ("…exports emb…") reads as a
          // rendering bug, and this one has to be readable to do its job. The cap and the copy were
          // then set against each other by measurement in the built app, not by eye: 32rem computes
          // to 512px, this string measures 485px on one line there, and showing or hiding the
          // warning leaves the property panel at 279.5px either way. The longer wording it replaced
          // measured 631px, wrapped to two lines, and grew the panel by 9px on every non-system
          // pick. `title` carries the full sentence for anyone who wants the rest of it.
          className="max-w-[32rem] rounded border border-dashed border-amber-500/60 px-1.5 py-0.5 text-[11px] leading-tight text-amber-800 dark:text-amber-200"
          title="Won't travel: PDF and HTML exports embed nothing; PPTX names the font and falls back on machines that do not have it"
        >
          Won&apos;t travel: PDF and HTML exports embed no fonts; PPTX falls back without this one
        </span>
      ) : null}

      {open ? (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-md border border-chrome-line bg-white p-1 shadow-lg dark:border-ink-line dark:bg-ink">
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-label="Filter fonts"
            aria-expanded={true}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            data-testid="font-filter"
            value={filter}
            onChange={onFilterChange}
            onKeyDown={onKeyDown}
            placeholder="Search fonts…"
            className="mb-1 w-full rounded border border-chrome-line bg-white px-1.5 py-0.5 text-shell-fg outline-none focus:border-accent dark:border-ink-line dark:bg-ink dark:text-ink-fg"
          />
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Font family"
            data-testid="font-listbox"
            // An *explicit* `tabindex` is what keeps this out of the tab order. Chromium's
            // keyboard-focusable-scrollers rule puts an overflowing container with no focusable
            // children into sequential focus by itself, and the IDL `tabIndex` already reads -1
            // there, so only the attribute distinguishes the two states. Without it Tab parked
            // focus on the list — still inside `rootRef`, so `focusout` saw nothing leave — and
            // left an open popover whose arrows scrolled instead of navigating.
            tabIndex={-1}
            onScroll={onListScroll}
            style={LIST_STYLE}
            className="overflow-y-auto"
          >
            <li aria-hidden="true" style={topSpacer} />
            {visible.map((row, offset) => {
              const index = start + offset
              return row.kind === 'header' ? (
                <li
                  key={row.key}
                  role="presentation"
                  style={ROW_STYLE}
                  className="flex items-center px-1.5 text-[10px] font-semibold uppercase tracking-wide text-chrome-muted dark:text-ink-muted"
                >
                  {row.label}
                </li>
              ) : (
                <FontOption
                  key={row.key}
                  id={optionId(index)}
                  name={row.name}
                  active={index === activeIndex}
                  selected={row.name === picked}
                  onChoose={choose}
                />
              )
            })}
            <li aria-hidden="true" style={bottomSpacer} />
          </ul>
          {rows.length === 0 ? (
            <p
              data-testid="font-empty"
              className="px-1.5 py-1 text-chrome-muted dark:text-ink-muted"
            >
              No matching fonts.
              {/* Without this, a face the allow-list dropped (see the header of
                  `shared/fonts/family.ts`) is indistinguishable from a typo. Said once, about the
                  rule, rather than naming individual font files.

                  Deliberately here and not in a persistent footer carrying the drop count (review
                  r4's suggestion): this fires at the one moment the drop is discoverable — someone
                  hunting for a face and not finding it — whereas a count would sit under every
                  dropdown open forever on the machine that has 46 of them. */}
              {(fonts?.families.length ?? 0) > 0
                ? ' Faces with unusual characters in their names aren\u2019t listed.'
                : null}
            </p>
          ) : null}
          {fonts !== null && fonts.source === 'none' && fonts.families.length === 0 ? (
            // `source` earns its place in the response here: an empty list because enumeration was
            // not possible reads very differently from a machine that genuinely has nothing extra.
            <p
              data-testid="font-unavailable"
              className="px-1.5 py-1 text-[11px] text-chrome-muted dark:text-ink-muted"
            >
              Installed fonts aren&apos;t available here — system fonts only.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const LIST_STYLE: CSSProperties = { maxHeight: LIST_HEIGHT_PX }
const ROW_STYLE: CSSProperties = { height: ROW_HEIGHT_PX }

interface FontOptionProps {
  readonly id: string
  readonly name: string
  readonly active: boolean
  readonly selected: boolean
  readonly onChoose: (name: string) => void
}

/**
 * Its own component so the click handler is one `useCallback` per row rather than a fresh arrow
 * allocated for every row on every render — the react-perf discipline `ColorControls` follows.
 */
function FontOption({ id, name, active, selected, onChoose }: FontOptionProps): JSX.Element {
  const onClick = useCallback((): void => {
    onChoose(name)
  }, [onChoose, name])

  // The preview stack is the value that would be written. `null` cannot happen for a name that
  // passed the allow-list, but falling back to inherit is the right answer if it ever does.
  const style = useMemo<CSSProperties>(
    () => ({ height: ROW_HEIGHT_PX, fontFamily: buildFontFamilyValue(name) ?? 'inherit' }),
    [name],
  )

  return (
    <li
      id={id}
      role="option"
      // Only the picked row carries it. `aria-selected="false"` on all ten rows announces ten
      // negatives where the useful statement is the single positive, or its absence.
      aria-selected={selected ? true : undefined}
      data-testid={`font-option-${name}`}
      data-active={active ? 'true' : undefined}
      onClick={onClick}
      style={style}
      className={`flex cursor-default items-center truncate rounded px-1.5 text-[13px] text-shell-fg dark:text-ink-fg ${
        active ? 'bg-accent/20' : ''
      } ${selected ? 'font-semibold' : ''}`}
    >
      {name}
    </li>
  )
}
