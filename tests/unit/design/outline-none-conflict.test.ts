import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `outline-none` / `outline-hidden` must never share a class string with an outline-based ring.
 *
 * Tailwind v4 compiles both `outline-none` and `outline-hidden` to `--tw-outline-style: none;
 * outline-style: none` (the same two declarations in lib.js), and every width utility — `outline-2`
 * included — to `outline-style: var(--tw-outline-style)`. So a class string that spells either of them
 * beside `focus-visible:outline-2 …` (the shared `FOCUS_RING`, R6) paints **no ring at all** on focus:
 * the variable wins, silently, in every browser. M8b.3 surface 6 found this while retiring the
 * thumbnail rail's `outline-none focus-visible:ring-2 …` — the old ring was a box-shadow, which
 * `outline-none` does not touch, so the shipped ring was alive; it is the move onto the outline-based
 * recipe that turns a leftover `outline-none` into a dead ring. Nothing else guards the combination:
 * `--check` counts colour columns, `focus-ring.test.tsx` asserts the recipe is present, and neither
 * sees the class that cancels it.
 *
 * What is scanned: every `.tsx` under `src/renderer/src`, comments blanked first (a comment that names
 * the pair is prose, not a class — this file's own first run flagged the rail's rationale comment),
 * template literals collapsed onto one logical line so a multi-line `className={`…`}` is one string,
 * and one level of `${…}` resolved from the same (blanked) text: a string constant of any casing, an
 * alias (`const ring = FOCUS_RING`), an object of strings whose values are unioned behind any accessor
 * chain (`${VARIANT[variant]}` on `Button.tsx:45` is judged against every variant; `${TONE[tone].klass}`
 * against every tone), and a ternary `${c ? A : B}` whose arms are identifiers or string literals
 * (`${exiting ? SCRIM_EXIT : ''}`, Dialog.tsx's shape and the only shape the tree has) as the union of
 * both arms. The brace walk steps over string literals and comments, so a `}` inside a class string or
 * a comment does not truncate the object. A logical line that carries a bare or
 * variant-prefixed `outline-none` **or `outline-hidden`** **and** either `FOCUS_RING` or a
 * bare/variant-prefixed `outline-<anything else>` is an offender, named by file and line.
 *
 * What it knowingly does not see: an `outline-none` and a ring on the same element assembled from two
 * separate expressions (`clsx(a, b)`, or a spread of props — a spread *source* is a runtime value the
 * scanner cannot follow), a ring inherited from a wrapper component's own class string, a constant
 * imported from another file (only `FOCUS_RING` is known by name), and a ternary whose arms are
 * accessor chains or calls (`${c ? V.a : V.b}`). Those are review items; this file is the guard for
 * the shapes the tree actually uses.
 *
 * Mutations (M8b.3 surface 6, rounds 2 and 3): `outline-none` appended to `ThumbnailRail.tsx`'s card
 * button beside `${FOCUS_RING}` → `ThumbnailRail.tsx:163 → outline-none + FOCUS_RING`; `outline-none`
 * added to `Button.tsx`'s `BASE` constant → `Button.tsx:45` (the className line, with `BASE` inlined);
 * `focus-visible:outline-none` appended to a `SlideContextMenu.tsx` item → `SlideContextMenu.tsx:178`;
 * `outline-hidden` beside the card's ring and `focus-visible:outline-hidden` on the item → the same two
 * lines (review r2 found both passing when only `none` was matched); `outline-none` written into
 * `Button.tsx`'s `VARIANT.subtle` → `Button.tsx:45` through the unioned object (r2: it killed the ring
 * on every subtle `Button`, this PR's "+ New" included, with every suite green); a camelCase
 * `const railBase = 'outline-none'` interpolated beside the ring, and `const ring = FOCUS_RING` used as
 * `${ring}` beside an `outline-none`, each → `ThumbnailRail.tsx:163`. Round 4, the comment
 * asymmetry: `// the surface's one action (M8b.0)` above `primary:` plus `outline-none` on `primary`
 * → `Button.tsx` line 46 of the mutated file, the className line shifted by the comment (review r3 had
 * it 20/20 green with the ring dead on every primary button); a `}`
 * in a comment inside `VARIANT`, a `}` inside a variant's class string, and a `// const BASE = ''`
 * written in a comment after the real `BASE` each → `Button.tsx:45` still; `${selected ? killer :
 * quiet}` with `const killer = 'outline-none'` and a nested `${TONES.a.klass}` on the rail button
 * each → `ThumbnailRail.tsx`'s className line (165 / 164 in the mutated files); an apostrophe comment inside `VARIANT` with no killer stays green.
 * Round 5: `${variant === 'link' ? LINK_EXTRA : ''}` in `Button.tsx`'s className with
 * `const LINK_EXTRA = 'outline-none'` (review r4's T1c — the mixed form the two-identifier regex
 * missed, 20/20 green with the ring dead on every link button) → `Button.tsx`; a `'/*'` inside a
 * variant's class string followed by a real block comment later in the file, and the round-3
 * apostrophe in a TRAILING comment inside `VARIANT`, each → `Button.tsx` (review r4's CS and TC, both
 * 20/20 green under the two-regex blanking). `SelectionOverlay.tsx`'s lone
 * `outline-none` (no ring intended) and `FontFamilyControl.tsx`'s two (`focus:border-accent`, no
 * outline ring) stay green — the rule is the pair, not the class.
 */

const RENDERER = join(process.cwd(), 'src', 'renderer', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out.toSorted()
}

/** `outline-hidden` is the same declaration pair as `outline-none` in Tailwind v4's lib.js. */
const OUTLINE_NONE = /(?<![\w-])(?:[\w-]+:)*outline-(?:none|hidden)(?![\w-])/
const OUTLINE_RING = /(?<![\w-])(?:[\w-]+:)*outline-(?!none(?![\w-])|hidden(?![\w-]))[\w-]+/

/**
 * Comments blanked — same length, newlines kept (the inventory script's rule) — so a rationale comment
 * that *names* the pair is not counted as one. Applied ONCE, to the text both passes read: review r3
 * found `constants()` reading the raw source while `logicalLines()` read the blanked one, so an
 * apostrophe in an ordinary comment (`// the surface's one action`) inside `VARIANT` unbalanced the
 * quote pairing for the constant pass alone, dropped the object's real values, and hid an
 * `outline-none` on `primary` from every suite while the ring was dead on every primary `Button`.
 *
 * A character walk rather than two regexes (review r4): a `//` or `/*` inside a string literal is
 * not a comment (`slide://…`, a `'/*'` class value would otherwise open a comment that swallows the
 * object after it), a `//` after code on the same line IS one (the round-3 apostrophe class in a
 * trailing comment escaped the whole-line regex), and a regex literal's quotes must not open a string
 * (`/['"]/` would). Every blanked span is checked by the test below to start with `//` or `/*` in
 * the source — blanking may remove comments and nothing else.
 */
function blankComments(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  let prev = ''
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1] ?? ''
    if (ch === "'" || ch === '"' || ch === '`') {
      let k = i + 1
      while (k < source.length && source[k] !== ch) k += source[k] === '\\' ? 2 : 1
      i = k + 1
      prev = ch
      continue
    }
    if (ch === '/' && next === '/') {
      let k = i
      while (k < source.length && source[k] !== '\n') k += 1
      blank(i, k)
      i = k
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const k = end === -1 ? source.length : end + 2
      blank(i, k)
      i = k
      continue
    }
    if (ch === '/' && /[(,=:[!&|?{};\n]|^$/.test(prev)) {
      // A regex literal: skip to its closing `/`, honouring escapes and character classes.
      let k = i + 1
      let inClass = false
      while (k < source.length && source[k] !== '\n') {
        const c = source[k]!
        if (c === '\\') k += 2
        else if (inClass) {
          if (c === ']') inClass = false
          k += 1
        } else if (c === '[') {
          inClass = true
          k += 1
        } else if (c === '/') break
        else k += 1
      }
      i = k + 1
      prev = '/'
      continue
    }
    if (!/\s/.test(ch)) prev = ch
    i += 1
  }
  return out.join('')
}

/**
 * Every span `blankComments` changed, as it read in the source — for the self-check below. A span
 * starts at a changed character and runs across whitespace (the spaces inside a comment are the same
 * spaces after blanking) to the next unchanged non-space character.
 */
function blankedSpans(source: string, blanked: string): string[] {
  const spans: string[] = []
  let i = 0
  while (i < source.length) {
    if (source[i] === blanked[i]) {
      i += 1
      continue
    }
    let k = i
    while (k < source.length && (source[k] !== blanked[k] || /\s/.test(source[k]!))) k += 1
    spans.push(source.slice(i, k).trimEnd())
    i = k
  }
  return spans
}

/**
 * Template literals folded onto one logical line; the reported number is the line the literal starts
 * on. `source` is already comment-blanked.
 */
function logicalLines(source: string): { line: number; text: string }[] {
  const stripped = source
  const out: { line: number; text: string }[] = []
  let line = 1
  let buffer = ''
  let start = 1
  let inTemplate = false
  for (const ch of stripped) {
    if (ch === '`') inTemplate = !inTemplate
    if (ch === '\n') {
      line += 1
      if (inTemplate) {
        buffer += ' '
        continue
      }
      out.push({ line: start, text: buffer })
      buffer = ''
      start = line
      continue
    }
    buffer += ch
  }
  out.push({ line: start, text: buffer })
  return out
}

/**
 * What a `${…}` inside a class template can stand for, one level deep, from declarations in the same
 * file: `const name = '…'` (any casing — a camelCase constant is as good a hiding place as `BASE`);
 * `const name = FOCUS_RING` and other one-identifier aliases, which resolve to the target's text; and
 * `const NAME … = { key: '…', … }` objects such as `Button.tsx`'s `VARIANT`, whose string values are
 * unioned so `${VARIANT[variant]}` / `${VARIANT.subtle}` is judged against every variant at once — an
 * `outline-none` in one variant kills the ring on every element of that variant.
 */
function constants(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of source.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\b[^=\n]*=\s*(['"`])([\s\S]*?)\2/g,
  )) {
    out.set(m[1]!, m[3]!.replace(/\s+/g, ' '))
  }
  for (const m of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\b[^=\n]*=\s*\{/g)) {
    // Brace walk that steps over string literals, so a `}` inside a class string cannot end the
    // object early and drop the values after it.
    let depth = 1
    let i = m.index + m[0].length
    let quote: string | null = null
    while (i < source.length && depth > 0) {
      const ch = source[i]!
      if (quote !== null) {
        if (ch === '\\') i += 1
        else if (ch === quote) quote = null
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i += 1
        continue
      } else if (ch === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2)
        i = end === -1 ? source.length : end + 2
        continue
      } else if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      i += 1
    }
    const body = source.slice(m.index + m[0].length, i - 1)
    const values = [...body.matchAll(/(['"`])([\s\S]*?)\1/g)].map((v) => v[2]!.replace(/\s+/g, ' '))
    if (values.length > 0) out.set(m[1]!, values.join(' '))
  }
  for (const m of source.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\b[^=\n]*=\s*([A-Za-z_$][\w$]*)\s*$/gm,
  )) {
    const target = m[2]!
    out.set(m[1]!, target === 'FOCUS_RING' ? 'FOCUS_RING' : (out.get(target) ?? target))
  }
  return out
}

describe('outline-none never shares a class string with an outline ring', () => {
  it('no renderer class string pairs outline-none / outline-hidden with FOCUS_RING or an outline-* utility', () => {
    const offenders: string[] = []
    let ringLines = 0
    const files = walk(RENDERER)
    for (const file of files) {
      const raw = readFileSync(file, 'utf8')
      const source = blankComments(raw)
      // Blanking may remove comments and nothing else: same length, and every changed span starts
      // with a comment opener in the source (measured in review r4 against @babel/parser — 33
      // files, 2,556 literal tokens, 0 altered — and kept true here for the walk that replaced it).
      expect(source.length, `${relative(process.cwd(), file)}: blanking changed the length`).toBe(
        raw.length,
      )
      for (const span of blankedSpans(raw, source)) {
        expect(span, `${relative(process.cwd(), file)}: blanked non-comment text`).toMatch(
          /^\/[/*]/,
        )
      }
      const known = constants(source)
      for (const { line, text } of logicalLines(source)) {
        const expanded = text
          // `${NAME}`, `${NAME[k]}`, `${NAME.k}`, `${NAME[k].klass}` — any accessor chain resolves to
          // the union of NAME's string values, so a nested object is judged whole (Notice.tsx's shape).
          .replace(
            /\$\{([A-Za-z_$][\w$]*)(?:\[[^\]}]*\]|\.[\w$]+)*\}/g,
            (m, name: string) => known.get(name) ?? m,
          )
          // `${cond ? A : B}` where each arm is an identifier or a string literal — `${exiting ?
          // SCRIM_EXIT : ''}` at Dialog.tsx:187 is the tree's shape, 16 of 16 ternary interpolations
          // being of that mixed kind (review r4) — is the union of both arms.
          .replace(
            /\$\{[^}?]*\?\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*\}/g,
            (_m, a: string, b: string) => {
              const arm = (x: string): string =>
                /^['"]/.test(x) ? x.slice(1, -1) : (known.get(x) ?? x)
              return `${arm(a)} ${arm(b)}`
            },
          )
        const hasRing = expanded.includes('FOCUS_RING') || OUTLINE_RING.test(expanded)
        if (hasRing) ringLines += 1
        if (hasRing && OUTLINE_NONE.test(expanded)) {
          const killer = OUTLINE_NONE.exec(expanded)?.[0] ?? 'outline-none'
          const ring = expanded.includes('FOCUS_RING')
            ? 'FOCUS_RING'
            : (OUTLINE_RING.exec(expanded)?.[0] ?? 'outline-*')
          offenders.push(`${relative(process.cwd(), file)}:${String(line)} → ${killer} + ${ring}`)
        }
      }
    }
    // Non-vacuity: the scanner must be reading a real tree with real rings in it.
    expect(files.length, 'no .tsx files found under src/renderer/src').toBeGreaterThan(20)
    expect(
      ringLines,
      'no FOCUS_RING / outline-* consumer found — the scanner lost its subject',
    ).toBeGreaterThan(5)
    expect(
      offenders,
      'outline-none / outline-hidden set --tw-outline-style: none, which outline-2 reads back — the ring would not paint',
    ).toEqual([])
  })
})
