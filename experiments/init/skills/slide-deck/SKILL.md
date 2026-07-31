---
name: slide-deck
description: Creates presentation slides as self-contained HTML files with fixed 1280x720 layout, presentation-grade typography, and inline SVG decoration. Use when asked to create a title slide, content slide, comparison slide, or any static presentation slide in HTML/CSS.
---

# slide-deck

Produce ONE self-contained HTML file per slide. No external resources (no CDN, no web fonts, no images) — everything inline.

## HARD RULES — violating any of these fails the slide outright
1. **Text is a closed set.** The slide may contain ONLY the text the request names (plus purely numeric axis/label text a chart requires). NO invented kickers, eyebrows, taglines, subtitles, category labels, or footer echoes of the title. Before returning, list every text node and point to the words in the request that demanded it — delete any node you can't justify.
2. **Verbatim strings.** Copy each requested string character-for-character ("Dept." stays "Dept.").
3. **Icons come from icons.md.** Read `icons.md` in this skill directory and copy paths exactly — NEVER draw your own icon paths.
4. **Validate by rendering.** After writing the file, run:
   `export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH" && node /home/baoro/stuff/random/sloodge/experiments/init/harness/render.mjs <your-file> /tmp/claude-1000/-home-baoro-stuff-random-sloodge/e0c46df0-cfa4-4efa-9f79-3438b9af54d1/scratchpad/selfcheck-<case-id>`
   then Read the produced t0.png at full attention: check every hard rule, every layout/contrast rule, and everything the request asked for, as a hostile reviewer would. Fix and re-render until clean. Do not return until the screenshot passes.

## Hard layout contract
- The slide is EXACTLY 1280x720. Root element: `<div class="slide">` with `width:1280px;height:720px;overflow:hidden;position:relative;box-sizing:border-box`.
- Set `html,body{margin:0;padding:0}` and `*,*::before,*::after{box-sizing:border-box}`. The page must have zero scroll: `document.documentElement.scrollWidth <= 1280` and `scrollHeight <= 720`. This is machine-checked; any overflow fails.
- Never let content touch the edges: minimum 48px padding on the slide root (footers/motifs pinned with absolute positioning may sit inside that margin).

## Typography (presentation-grade — read from 10 feet away)
- Font stack: `-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`.
- Title slides: main title 64–88px bold; subtitle/speaker 24–32px.
- Content slides: slide title 40–48px bold; section headings 26–30px bold; body 20–24px; footer/slide-number 16–18px.
- Line-height 1.3–1.5 for body. Never justify text. Max ~14 words per body line.
- ABSOLUTE MINIMUM font size anywhere on the slide is 18px (footers, badges, captions included); body/cell text is 20px MINIMUM — 19px fails review. When in doubt, go bigger.
- Contrast: EVERY text node — including footers, slide numbers, badges, muted captions — must meet WCAG AA (4.5:1) against its actual background. Compute it: #8a92a3 on #fafbfc is ~2.9:1 and FAILS; use #5a6478 or darker for muted text on light backgrounds, #aab4c8 or lighter on dark.
- Composition: if a decorative band/motif occupies the bottom of the slide, center the content block OPTICALLY within the space above the band: the gap above the content block should roughly equal the gap between the block and the band (±20px). Verify this in your rendered screenshot.

## Content fidelity — the #1 failure mode
- Honor counts LITERALLY: "exactly 4 reasons" = exactly 4, "4 rows" = 4 rows, "slide number 7" = the digit 7 visible in the footer.
- Copy requested strings VERBATIM: "Marine Biology Dept." stays "Dept." — never expand abbreviations, rephrase, or retitle.
- Add NOTHING that wasn't requested: no invented kickers/taglines/eyebrow lines, no extra page numbers, no repeating the title in a footer, no decorative text. Requested elements only.
- Every named element in the request (footer, banner, verdict, labels, icons) must be visibly present and identifiable.
- Icon semantics must match the content's sentiment: a failure reason never gets an upward-growth arrow; pick an icon a viewer would caption with the same word as the heading.
- Grid/column requests are structural: "2x2 grid" = CSS grid with 2 columns and 2 rows, visually even gaps; "two-column comparison" = two clearly delineated columns with aligned rows.

## Visual design
- Pick ONE accent color and derive the palette from it; backgrounds either near-white (#fafbfc) or rich dark (#0d1220–#1a2035 range), per the requested aesthetic.
- Cards/cells: subtle border or elevation (`border:1px solid rgba(...,0.12)` or soft shadow), border-radius 10–16px, consistent internal padding (20–28px). Keep ≥24px clear space between any content block and a banner/footer below it (shadows included).
- Badges/pills holding text must use SOLID backgrounds (no translucency — blended contrast is unpredictable and fails AA audits). Compute contrast against the actual final background.
- Inline SVG icons: 36–48px rendered size, copied exactly from `icons.md` (hard rule 3), consistent stroke style across the slide.
- Decorative motifs (waves, gradients) go behind content (`position:absolute; z-index:0`; content `z-index:1`) and must not reduce text contrast where they overlap text.

## Space & composition
- Cards/cells size to their content: no empty band taller than ~60px inside a card or at the bottom of the slide. If content is short, increase font sizes/padding or reduce the container, don't leave voids.
- Decorative paths (waves etc.) must extend PAST the slide edges (start x<0, end x>1280) so no cusp/termination artifact is visible at the borders.
- For negated concepts ("No market need") avoid icons whose plain reading asserts the positive (a bullseye reads "on target"); prefer a neutral icon (search, package) — the icon must not contradict the heading.

## Self-check before returning
1. Count every requested item in your HTML and match against the prompt.
2. Mentally render at 1280x720: does anything overflow, collide, or clip? Long headings wrap — reserve space.
3. Is every text/background pairing readable?
4. Is the footer/slide-number present if requested, inside the viewport?
