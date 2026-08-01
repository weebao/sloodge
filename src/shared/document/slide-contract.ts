/**
 * Tier-1 static validation of the slide HTML contract (§3.2, §6.1 of 30-slide-format.md).
 *
 * The agent's slide HTML is **untrusted** (50-agent-integration.md §6): it arrives from a model
 * over the MCP tool boundary and must be checked before it enters the document. This module is the
 * gate — a pure, browser-free, parse5-only lint that a `mcp__slides__create_slide` /
 * `update_slide` handler runs *before* dispatching a command, so a malformed slide never reaches
 * the deck and the agent gets an actionable error it can self-correct against (the validator→fix
 * loop of §6.4).
 *
 * ## Which tier this is, and what is deferred
 *
 * §6 defines three tiers. This is **Tier 1 only** — the rules that are decidable from source text
 * with parse5 and regex, in well under a millisecond, with no browser:
 *
 *  - **Self-containment** SL-S01..S04 (no external subresources, no `@font-face`, no network /
 *    storage / eval APIs). These are the security-load-bearing rules: a slide that phones home or
 *    reaches `localStorage` is rejected outright.
 *  - **Geometry** SL-G01/G03/G05 (the 1280x720 `.slide` root, the mandatory resets, no
 *    `position:fixed` / viewport units).
 *  - **Capabilities** SL-I01/I02, SL-A01, SL-H01 (testing hooks and animation present iff declared;
 *    no *undeclared* script or animation — the model must say what its slide does).
 *  - **Typography** SL-C01 (nothing below 16px) as a warning.
 *
 * Tier 2 (rendered checks: real overflow, contrast against painted pixels, console errors) and
 * Tier 3 (behavioural: animation actually animates, hover reveals a tooltip) need an offscreen
 * render and belong to the `screenshot_slide` / export render path — they are **deliberately not**
 * here. `validateSlideContract` is what gates a write; the rendered tiers refine the cached
 * `slides[id].validation` afterwards.
 *
 * ## `data-sl-id` is intentionally NOT enforced (SL-D01 omitted)
 *
 * §3.3 is explicit: Sloodge stamps `data-sl-id`, the model is "permitted but not required" to emit
 * it. Enforcing SL-D01 here would reject every clean agent slide. The stamping pass
 * (`buildSlideMap` / `instrument`) owns that attribute downstream; this gate must not pre-empt it.
 *
 * ## Conservatism
 *
 * The API/subresource scans (SL-S01, SL-S04) run over the raw source, so a slide whose *visible
 * text* contains the literal `fetch(` or `localStorage` is flagged. That is the §6.1 definition
 * ("Source contains none of …") and the safe direction: a false-positive is an actionable message
 * the agent can rephrase around; a false-negative is a slide that escaped the sandbox.
 */

import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type SlideCapability,
  type SlideValidationIssue,
} from './types'

type Element = DefaultTreeAdapterTypes.Element
type ChildNode = DefaultTreeAdapterTypes.ChildNode
type ParentNode = DefaultTreeAdapterTypes.ParentNode

export type SlideContractResult = {
  /** True when there are no `error`-severity issues. `warn`/`info` do not block a write. */
  readonly ok: boolean
  readonly issues: readonly SlideValidationIssue[]
}

const ANIMATION_CAPABILITIES: ReadonlySet<SlideCapability> = new Set([
  'css-animation',
  'smil-animation',
])

const SMIL_TAGS: ReadonlySet<string> = new Set(['animate', 'animatetransform', 'animatemotion'])

/**
 * APIs forbidden by SL-S04 / SL-S05: the ones that open a socket, touch storage, or run string
 * code — none of which a self-contained, stateless, sandboxed slide may use.
 */
const FORBIDDEN_API_TOKENS: readonly string[] = [
  'fetch(',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'localStorage',
  'indexedDB',
  'document.cookie',
  'alert(',
  'confirm(',
  'prompt(',
  'eval(',
  'new Function(',
]

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node
}

function attr(element: Element, name: string): string | undefined {
  for (const a of element.attrs) if (a.name === name) return a.value
  return undefined
}

function hasAttr(element: Element, name: string): boolean {
  return element.attrs.some((a) => a.name === name)
}

/** Element token set from `class`, so `class="foo slide bar"` matches `.slide`. */
function hasClassToken(element: Element, token: string): boolean {
  const value = attr(element, 'class')
  if (value === undefined) return false
  return value.split(/\s+/).includes(token)
}

type Collected = {
  slideRoots: Element[]
  scripts: Element[]
  hoverTargets: number
  clickTargets: number
  badImages: string[]
  smilAnimated: boolean
  body: Element | null
}

function collect(document: DefaultTreeAdapterTypes.Document): Collected {
  const out: Collected = {
    slideRoots: [],
    scripts: [],
    hoverTargets: 0,
    clickTargets: 0,
    badImages: [],
    smilAnimated: false,
    body: null,
  }

  const walk = (node: ParentNode): void => {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue
      const tag = child.tagName
      if (tag === 'body') out.body = child
      if (hasClassToken(child, 'slide')) out.slideRoots.push(child)
      if (tag === 'script') out.scripts.push(child)
      if (hasAttr(child, 'data-hover-target')) out.hoverTargets += 1
      if (hasAttr(child, 'data-click-target')) out.clickTargets += 1
      if (SMIL_TAGS.has(tag)) out.smilAnimated = true
      if (tag === 'img') {
        const src = attr(child, 'src')
        if (src !== undefined && !isInlineSource(src)) out.badImages.push(src)
      }
      if (tag === 'image') {
        const href = attr(child, 'href') ?? attr(child, 'xlink:href')
        if (href !== undefined && !isInlineSource(href)) out.badImages.push(href)
      }
      walk(child)
    }
  }

  walk(document)
  return out
}

function isInlineSource(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v.startsWith('data:') || v.startsWith('sloodge-asset:')
}

/** The concatenated text of every `<style>` element, for CSS-level checks. */
function styleText(html: string): string {
  let out = ''
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) out += `\n${match[1] ?? ''}`
  return out
}

/** The last *element* child of `<body>` (text/comment nodes ignored), or null. */
function lastElementChild(body: Element): Element | null {
  for (let i = body.childNodes.length - 1; i >= 0; i -= 1) {
    const node = body.childNodes[i]
    if (node && isElement(node)) return node
  }
  return null
}

function issue(
  rule: string,
  severity: SlideValidationIssue['severity'],
  message: string,
): SlideValidationIssue {
  return { rule, severity, message }
}

/**
 * Validate one slide document against the Tier-1 contract.
 *
 * `capabilities` is what the generator *declares* (the manifest's `capabilities`, or the tool's
 * `capabilities` argument). SL-H01 checks the file against it in both directions the source can
 * decide: a `<script>` requires `interactive-js`, an `@keyframes`/SMIL animation requires an
 * animation capability. The reverse (declared-but-absent) is left to the rendered tiers, which can
 * actually observe motion — a slide that declares animation it will add on a later edit must not be
 * rejected at write time.
 */
export function validateSlideContract(
  html: string,
  capabilities: readonly SlideCapability[] = ['static'],
): SlideContractResult {
  const issues: SlideValidationIssue[] = []
  const caps = new Set(capabilities)
  const css = styleText(html)
  const cssPacked = css.replace(/\s+/g, '').toLowerCase()
  const source = html
  const sourcePacked = source.replace(/\s+/g, '').toLowerCase()

  // --- SL-S01: no external subresources -------------------------------------------------------
  if (
    /<link\b[^>]*\bhref\s*=/i.test(source) ||
    /<script\b[^>]*\bsrc\s*=/i.test(source) ||
    cssPacked.includes('@import') ||
    /url\(\s*['"]?\s*(?:https?:)?\/\//i.test(source)
  ) {
    issues.push(
      issue(
        'SL-S01',
        'error',
        'external subresource (link/script src, @import, or remote url()) is forbidden; inline everything',
      ),
    )
  }

  // --- SL-S03: no web fonts -------------------------------------------------------------------
  if (cssPacked.includes('@font-face')) {
    issues.push(issue('SL-S03', 'error', '@font-face is forbidden; use the system font stack only'))
  }

  // --- SL-S04/S05: no network / storage / eval APIs -------------------------------------------
  const forbidden = FORBIDDEN_API_TOKENS.filter((token) =>
    sourcePacked.includes(token.replace(/\s+/g, '').toLowerCase()),
  )
  if (forbidden.length > 0) {
    issues.push(
      issue(
        'SL-S04',
        'error',
        `forbidden runtime API(s) present: ${forbidden.join(', ')} — slides are self-contained, stateless and offline`,
      ),
    )
  }

  // --- SL-G05: no position:fixed, no viewport units -------------------------------------------
  if (cssPacked.includes('position:fixed')) {
    issues.push(issue('SL-G05', 'error', 'position:fixed is forbidden (breaks the print pass)'))
  }
  if (/\b\d*\.?\d+(?:vh|vw|dvh)\b/i.test(css)) {
    issues.push(
      issue('SL-G05', 'error', 'viewport units (vh/vw/dvh) are forbidden; use px against 1280x720'),
    )
  }

  // --- SL-C01: nothing below 16px (warning) ---------------------------------------------------
  const belowMin: number[] = []
  const fontSize = /font-size\s*:\s*(\d*\.?\d+)px/gi
  let fs: RegExpExecArray | null
  while ((fs = fontSize.exec(css)) !== null) {
    const px = Number(fs[1])
    if (Number.isFinite(px) && px < 16) belowMin.push(px)
  }
  if (belowMin.length > 0) {
    issues.push(
      issue('SL-C01', 'warn', `font-size below the 16px minimum: ${belowMin.join('px, ')}px`),
    )
  }

  // --- Structural rules (parse5) --------------------------------------------------------------
  const document = parse(html)
  const collected = collect(document)

  // SL-G01: exactly one .slide root, sized 1280x720.
  if (collected.slideRoots.length === 0) {
    issues.push(issue('SL-G01', 'error', 'no root element with class="slide"'))
  } else if (collected.slideRoots.length > 1) {
    issues.push(
      issue(
        'SL-G01',
        'error',
        `${collected.slideRoots.length} .slide roots found; there must be one`,
      ),
    )
  }
  if (
    !cssPacked.includes(`width:${String(CANVAS_WIDTH)}px`) ||
    !cssPacked.includes(`height:${String(CANVAS_HEIGHT)}px`)
  ) {
    issues.push(
      issue(
        'SL-G01',
        'error',
        `the .slide root must be exactly ${String(CANVAS_WIDTH)}x${String(CANVAS_HEIGHT)}px`,
      ),
    )
  }

  // SL-G03: mandatory resets.
  if (!cssPacked.includes('box-sizing:border-box')) {
    issues.push(issue('SL-G03', 'error', 'the universal box-sizing:border-box reset is required'))
  }
  if (!cssPacked.includes('margin:0') || !cssPacked.includes('padding:0')) {
    issues.push(issue('SL-G03', 'error', 'html,body{margin:0;padding:0} reset is required'))
  }

  // SL-I02: the <script>, if any, is the last element of <body>.
  if (collected.scripts.length > 0 && collected.body) {
    const last = lastElementChild(collected.body)
    if (last === null || last.tagName !== 'script') {
      issues.push(issue('SL-I02', 'error', '<script> must be the last element of <body>'))
    }
  }

  // SL-H01: declared capabilities must cover what the file actually contains.
  if (collected.scripts.length > 0 && !caps.has('interactive-js')) {
    issues.push(
      issue(
        'SL-H01',
        'error',
        'slide contains a <script> but capabilities does not include "interactive-js"',
      ),
    )
  }
  const hasAnimation = cssPacked.includes('@keyframes') || collected.smilAnimated
  const declaresAnimation = [...caps].some((cap) => ANIMATION_CAPABILITIES.has(cap))
  if (hasAnimation && !declaresAnimation) {
    issues.push(
      issue(
        'SL-H01',
        'error',
        'slide contains animation but capabilities declares no *-animation capability',
      ),
    )
  }

  // SL-I01: interactive slides carry exactly one hover and one click testing hook.
  if (caps.has('interactive-js')) {
    if (collected.hoverTargets !== 1) {
      issues.push(
        issue(
          'SL-I01',
          'error',
          `interactive slide must have exactly one [data-hover-target] (found ${String(collected.hoverTargets)})`,
        ),
      )
    }
    if (collected.clickTargets !== 1) {
      issues.push(
        issue(
          'SL-I01',
          'error',
          `interactive slide must have exactly one [data-click-target] (found ${String(collected.clickTargets)})`,
        ),
      )
    }
  }

  // SL-A01: a declared animation must actually be present.
  if (declaresAnimation && !hasAnimation) {
    issues.push(
      issue(
        'SL-A01',
        'error',
        'capabilities declares an animation but the slide has no @keyframes or SMIL element',
      ),
    )
  }

  // SL-S02: images must be inline (data:) or a sloodge-asset: reference.
  for (const src of collected.badImages) {
    issues.push(
      issue('SL-S02', 'error', `image source must be a data: or sloodge-asset: URI, not ${src}`),
    )
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues }
}

/** A one-line, agent-actionable summary of the error issues, for a tool's `isError` message. */
export function contractErrorSummary(result: SlideContractResult): string {
  const errors = result.issues.filter((i) => i.severity === 'error')
  if (errors.length === 0) return 'slide is contract-valid'
  return errors.map((i) => `${i.rule}: ${i.message}`).join('; ')
}
