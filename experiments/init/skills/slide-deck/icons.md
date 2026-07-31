# Vetted inline SVG icons — COPY EXACTLY, do not freehand your own

Hand-drawn icon paths are the #1 source of visual defects (stray strokes, upside-down glyphs, colliding shapes). Use these tested outline icons verbatim. Wrapper (set size via width/height, color via `color` on a parent or `stroke`):

```html
<svg width="44" height="44" viewBox="-2 -2 28 28" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">…paths…</svg>
```
(The `-2 -2 28 28` viewBox leaves stroke breathing room so no glyph edge is clipped flush.)

| Meaning | Inner SVG |
|---|---|
| failure / rejection | `<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>` |
| money / cash / funding | `<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>` |
| team / people | `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>` |
| decline / losing | `<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>` |
| growth / rising | `<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>` |
| target / market / goal | `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>` |
| timing / speed / deadline | `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>` |
| warning / risk | `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>` |
| success / done | `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.27"/>` |
| energy / speed / power | `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>` |
| activity / monitoring | `<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>` |
| search / discovery | `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>` |
| product / package | `<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>` |
| chart / metrics | `<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>` |

Pick the row whose *meaning* matches your content's sentiment. If nothing matches, use the closest abstract one (target, zap, activity) — never invent new paths.
