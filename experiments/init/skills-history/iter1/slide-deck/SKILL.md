---
name: slide-deck
description: Creates presentation slides as self-contained HTML files with fixed 1280x720 layout, presentation-grade typography, and inline SVG decoration. Use when asked to create a title slide, content slide, comparison slide, or any static presentation slide in HTML/CSS.
---

# slide-deck

Produce ONE self-contained HTML file per slide. No external resources (no CDN, no web fonts, no images) — everything inline.

## Hard layout contract
- The slide is EXACTLY 1280x720. Root element: `<div class="slide">` with `width:1280px;height:720px;overflow:hidden;position:relative;box-sizing:border-box`.
- Set `html,body{margin:0;padding:0}` and `*,*::before,*::after{box-sizing:border-box}`. The page must have zero scroll: `document.documentElement.scrollWidth <= 1280` and `scrollHeight <= 720`. This is machine-checked; any overflow fails.
- Never let content touch the edges: minimum 48px padding on the slide root (footers/motifs pinned with absolute positioning may sit inside that margin).

## Typography (presentation-grade — read from 10 feet away)
- Font stack: `-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`.
- Title slides: main title 64–88px bold; subtitle/speaker 24–32px.
- Content slides: slide title 40–48px bold; section headings 26–30px bold; body 20–24px; footer/slide-number 16–18px.
- Line-height 1.3–1.5 for body. Never justify text. Max ~14 words per body line.
- Contrast: text must meet WCAG AA against its actual background (4.5:1). On dark themes use #f0f0f5-ish text, never pure gray-on-gray.

## Content fidelity — the #1 failure mode
- Honor counts LITERALLY: "exactly 4 reasons" = exactly 4, "4 rows" = 4 rows, "slide number 7" = the digit 7 visible in the footer.
- Every named element in the request (footer, banner, verdict, labels, icons) must be visibly present and identifiable.
- Grid/column requests are structural: "2x2 grid" = CSS grid with 2 columns and 2 rows, visually even gaps; "two-column comparison" = two clearly delineated columns with aligned rows.

## Visual design
- Pick ONE accent color and derive the palette from it; backgrounds either near-white (#fafbfc) or rich dark (#0d1220–#1a2035 range), per the requested aesthetic.
- Cards/cells: subtle border or elevation (`border:1px solid rgba(...,0.12)` or soft shadow), border-radius 10–16px, consistent internal padding (20–28px).
- Inline SVG icons: 36–48px, `stroke-width:2`, consistent style across the slide (all outline or all filled), `viewBox` set, drawn by hand with simple primitives — keep them recognizable (a lightbulb must read as a lightbulb).
- Decorative motifs (waves, gradients) go behind content (`position:absolute; z-index:0`; content `z-index:1`) and must not reduce text contrast where they overlap text.

## Self-check before returning
1. Count every requested item in your HTML and match against the prompt.
2. Mentally render at 1280x720: does anything overflow, collide, or clip? Long headings wrap — reserve space.
3. Is every text/background pairing readable?
4. Is the footer/slide-number present if requested, inside the viewport?
