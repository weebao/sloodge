# 20 — UI Wireframes (ASCII)

The shell mirrors PowerPoint's layout exactly, with one addition: a chat panel docked on the current-slide side. All chrome is the app's (React); only the slide canvas content is AI-generated HTML in a sandboxed iframe.

## Main window (Edit view)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  File   Edit                                            sloodge — MyDeck.sloodge ─ □ ✕│  ← native/menu bar
├──────────────────────────────────────────────────────────────────────────────────────┤
│ [Home]                                                                                │  ← tab strip (v1: Home only)
│ ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│ │ B  I  U  S │ Font ▾ │ 24 ▾ │ A🎨 │ ≡ ≣ ≡ │ ⬚ Shape │ 🖼 Image │ ✦ Design Mode │  │  ← formatting toolbar
│ └─────────────────────────────────────────────────────────────────────────────────┘  │
├────────────┬────────────────────────────────────────────────────┬────────────────────┤
│  SLIDES    │                CANVAS (16:9, letterboxed)          │   CHAT             │
│ ┌────────┐ │  ┌──────────────────────────────────────────────┐  │ ┌────────────────┐ │
│ │ 1 ▣    │ │  │                                              │  │ │ ⏺ Claude       │ │
│ │ [thumb]│ │  │                                              │  │ │ I updated the  │ │
│ └────────┘ │  │        sandboxed iframe                      │  │ │ chart colors…  │ │
│ ┌────────┐ │  │        (current slide, 1280×720,             │  │ │                │ │
│ │ 2 ▣  ◀━┿━│  │         scaled to fit)                       │  │ │ ⏺ You          │ │
│ │ [thumb]│ │  │                                              │  │ │ make bars blue │ │
│ └────────┘ │  │                                              │  │ ├────────────────┤ │
│ ┌────────┐ │  │                                              │  │ │ ┌────────────┐ │ │
│ │ 3 ▣    │ │  └──────────────────────────────────────────────┘  │ │ │ Ask Claude…│ │ │
│ │ [thumb]│ │   ◇ selection overlay renders above iframe         │ │ └────────────┘ │ │
│ └────────┘ │     when Design Mode is on                         │ │ [⊕ctx] [Send ➤]│ │
│  [+ New]   │                                                    │ └────────────────┘ │
├────────────┴────────────────────────────────────────────────────┴────────────────────┤
│ Slide 2 of 8 │ theme: Ocean │ ⚠ 0 issues │ $0.42 session │        [🖵 Present]        │  ← status bar
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Notes:
- Left rail: drag-to-reorder thumbnails (live mini-renders, throttled), right-click context menu (duplicate/delete), `[+ New]` appends an empty slide.
- Chat panel: streams agent output; tool-call chips ("✎ editing slide 2…") appear inline; slides hot-update as the agent writes. `[⊕ctx]` shows the current attachment context (e.g. selected element from Design Mode).
- Status bar: deck position, theme, validation issues (slide-contract lint), session cost from the Agent SDK, and **Present**.

## Menu bar

```
File                          Edit
├─ New            Ctrl/⌘+N    ├─ Undo         Ctrl/⌘+Z
├─ Open…          Ctrl/⌘+O    ├─ Redo   Ctrl+Y / ⇧⌘Z
├─ Export ▸                   ├─ ──────────────
│   ├─ Export as PPTX…        ├─ Cut          Ctrl/⌘+X
│   ├─ Export as PDF…         ├─ Copy         Ctrl/⌘+C
│   └─ Export as HTML…        ├─ Paste        Ctrl/⌘+V
├─ ──────────────             ├─ Paste and Match Style (macOS)
└─ Close (macOS) /            ├─ Delete
   Quit (Win, Linux)          └─ Select All   Ctrl/⌘+A
```
Accelerators use `CmdOrCtrl` so they are OS-native automatically. (Save/Save As ship too — Ctrl/⌘+S — even though not in the original menu spec; a deck editor without Save is a footgun. Flagged as an addition.)

## Design Mode active (canvas detail)

```
┌── CANVAS ────────────────────────────────────────────────┐
│  breadcrumb: slide › .grid › .card:nth(2) › h3           │
│  ┌────────────────────────────────────────────────────┐  │
│  │   Why Startups Fail                                │  │
│  │  ┌─────────────┐   ┏━━━━━━━━━━━━━┓ ← selected      │  │
│  │  │ ○ No market │   ┃ ● Ran out   ┃   (handles ■    │  │
│  │  │   need      │   ┃   of cash ■←╂── on corners)   │  │
│  │  └─────────────┘   ┗━━━━━━━━━━━━━┛                 │  │
│  │  ┌─────────────┐   ┌─────────────┐                 │  │
│  │  │ ○ Wrong team│   │ ○ Outcompete│                 │  │
│  │  └─────────────┘   └─────────────┘                 │  │
│  └────────────────────────────────────────────────────┘  │
│ ┌ Properties ─────────────────────────────────────────┐  │
│ │ Text [Ran out of cash]  Size [26▾] W [700▾]         │  │
│ │ Color [#f0f2f5] Fill [#1a2035] X 672 Y 214 W 512 H 180 │
│ │            [Ask Claude about this element…]         │  │
│ └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```
- Hover = light outline; click = selection + handles + properties panel (docked bottom of canvas).
- Property edits are **local and instant** (no LLM, no credits — v0 lesson): they patch the slide HTML source and hot-reload.
- "Ask Claude about this element" sends the element context bundle to chat (`[⊕ctx]` chip appears).

## Present mode (fullscreen)

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                 slide, scaled to screen,                 │
│               animations + interactivity live            │
│                                                          │
│                                                          │
│  (auto-hiding controls, bottom center, on mouse move:)   │
│              ◀  ▶     2 / 8     ⏹ Esc                    │
└──────────────────────────────────────────────────────────┘
```
- Keys: →/Space/PgDn next, ←/PgUp prev, Esc exit, B blank. Click-through is allowed only on interactive elements (charts stay clickable when presenting).

## Export dialog

```
┌ Export ───────────────────────────────────┐
│  Format:  (•) PPTX  ( ) PDF  ( ) HTML     │
│  Slides:  (•) All   ( ) Current  ( ) 1-4  │
│  PPTX fidelity: (•) Auto (structured,     │
│      raster fallback)  ( ) Always raster  │
│  ⚠ Animations export as final frame       │
│  [Cancel]                       [Export]  │
│  ▓▓▓▓▓▓▓░░░░░ 7/12 slides…                │
└───────────────────────────────────────────┘
```

## First-run / settings (API key)

```
┌ Welcome to sloodge ───────────────────────┐
│  Claude API key:  [sk-ant-…        ] 👁    │
│  Model: [claude-sonnet-5 ▾]               │
│  Monthly budget cap: [$10 ▾]              │
│  Stored securely in your OS keychain.     │
│                              [Continue]   │
└───────────────────────────────────────────┘
```
