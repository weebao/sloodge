/**
 * The `mcp__slides__*` tool contract, as pure logic (50-agent-integration.md §6).
 *
 * This is the testable core of the in-process MCP slide-tool server: zod input schemas, the
 * `SlideToolHost` seam the handlers mutate through, and one pure handler per tool. It imports no
 * SDK and no Electron — `src/main/agent/tools.ts` wraps these handlers in the SDK's `tool()` /
 * `createSdkMcpServer`, and `src/main/agent/deck-host.ts` implements `SlideToolHost` on top of the
 * M1.2 command layer + M1.3 history. Tests drive the handlers with a fake host and a fake screenshot
 * capturer — no SDK, no renderer, no subprocess.
 *
 * ## Two invariants this layer enforces
 *
 *  1. **Every mutation goes through the host, which goes through a command** (§6, M1.2). Handlers
 *     never touch a deck directly; they build a request, the host turns it into a `DocCommand` and
 *     dispatches it through `DocumentHistory` tagged `source: "agent"`, so a Ctrl+Z reverses an
 *     agent edit exactly like a manual one. A handler that "succeeds" having changed nothing is the
 *     failure mode the command layer exists to prevent, so the host returns a typed error, never a
 *     silent no-op.
 *
 *  2. **Agent HTML is untrusted and is validated before it enters the document** (§6, 30-slide-
 *     format.md §6.4). `create` and `update` run `validateSlideContract` (Tier-1 static lint) first;
 *     on any error-severity issue the handler returns `isError: true` with a rule-tagged message the
 *     model can fix against, and the host is never called. This is the write half of the
 *     validator→fix loop that drove the skills to 100% adversarial confidence.
 *
 * ## Return shape
 *
 * `{ content, structuredContent?, isError? }` — structurally the MCP `CallToolResult`. The §6 rule
 * "if you set `structuredContent`, put everything the model needs in it" is honoured: `read_slide`
 * puts the HTML in both a text block *and* `structuredContent.html`, and `screenshot_slide` returns
 * only an image block with no `structuredContent` (so the image is never dropped as a duplicate).
 */

import { z } from 'zod'
import { CapabilitySchema, type SlideCapability } from '../document/types'
import { contractErrorSummary, validateSlideContract } from '../document/slide-contract'

/* -------------------------------------------------------------------------------------------- *
 * Result + host types
 * -------------------------------------------------------------------------------------------- */

export type SlideToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

export type SlideToolResult = {
  readonly content: SlideToolContent[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
}

/** A slide as the host resolves it for reads. `index` is 1-based (what the model is shown). */
export type ResolvedSlide = {
  readonly id: string
  readonly index: number
  readonly title: string
  readonly notes: string | null
  readonly html: string
  readonly capabilities: readonly SlideCapability[]
}

export type SlideRef = { readonly slideId?: string; readonly index?: number }

/**
 * A host operation outcome. `code` is stable enough for a caller to branch on, `message` is written
 * for the model to act on ("No slide at index 9; the deck has 5 slides").
 */
export type HostOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: HostErrorCode; readonly message: string }

export type HostErrorCode =
  | 'slide-not-found'
  | 'index-out-of-range'
  | 'invalid'
  | 'screenshot-unavailable'
  /** The authoritative deck lives in the renderer (M2.6); it went away mid-call. */
  | 'renderer-unavailable'
  | 'internal'

export type CreateSlideRequest = {
  readonly html: string
  readonly title: string
  readonly notes?: string
  readonly capabilities: readonly SlideCapability[]
  /** 1-based insert position; append when omitted. */
  readonly position?: number
}

export type UpdateSlideRequest = {
  readonly slideId: string
  readonly html?: string
  readonly notes?: string | null
}

export type ReorderRequest = { readonly slideId: string; readonly toPosition: number }

/**
 * The seam every tool handler mutates and reads through. The concrete implementation
 * (`src/main/agent/deck-host.ts`) builds `DocCommand`s and dispatches them through the authoritative
 * renderer deck over IPC (M2.6); tests supply a fake. Every mutating method is expected to be
 * undoable at the history layer.
 *
 * **Async since M2.6.** The authoritative deck is renderer-side, so a read or a write is a round-trip
 * — every method returns a `Promise`. `await`-ing a fake that resolves synchronously is free, so the
 * pure handler tests read unchanged.
 */
export type SlideToolHost = {
  resolve(ref: SlideRef): Promise<ResolvedSlide | null>
  list(): Promise<ReadonlyArray<{ id: string; index: number; title: string }>>
  count(): Promise<number>
  create(request: CreateSlideRequest): Promise<HostOutcome<{ slideId: string; index: number }>>
  update(
    request: UpdateSlideRequest,
  ): Promise<HostOutcome<{ slideId: string; index: number; revision: number }>>
  reorder(request: ReorderRequest): Promise<HostOutcome<{ order: string[] }>>
  /**
   * Render a slide to a PNG. The renderer/offscreen wiring is injected — a host with no capturer
   * returns `screenshot-unavailable`, which is the deferred-render seam (see deck-host.ts).
   */
  screenshot(slideId: string, atMs: number): Promise<HostOutcome<{ pngBase64: string }>>
}

/* -------------------------------------------------------------------------------------------- *
 * Schemas — single source for both the SDK tool() shape and standalone parsing in tests
 * -------------------------------------------------------------------------------------------- */

const HtmlSchema = z
  .string()
  .min(1)
  .describe(
    'A complete, self-contained HTML document for one slide: a <div class="slide"> root at ' +
      'exactly 1280x720 with overflow:hidden. No external resources — no CDN scripts, no web ' +
      'fonts, no remote images; inline everything as data: URIs. No network or storage APIs.',
  )

const CapabilitiesSchema = z
  .array(CapabilitySchema)
  .describe(
    'What the slide does, so the linter can check it. "static" for a plain slide; add ' +
      '"interactive-js" if it has a <script> (then it needs one [data-hover-target] and one ' +
      '[data-click-target]); "css-animation"/"smil-animation" if it animates.',
  )

export const createSlideSchema = z.object({
  html: HtmlSchema,
  title: z.string().min(1).max(200).describe('Short human-readable slide title for the rail'),
  capabilities: CapabilitiesSchema.optional(),
  position: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based insert position; appends to the end if omitted'),
  notes: z.string().optional().describe('Speaker notes, plain text'),
})

export const updateSlideSchema = z.object({
  slideId: z.string().min(1).describe('Slide id from read_slide / create_slide'),
  html: HtmlSchema.optional().describe('Full replacement HTML. Omit to change notes only.'),
  notes: z
    .string()
    .nullable()
    .optional()
    .describe('Replacement speaker notes; null removes them. Omit to leave notes unchanged.'),
})

export const readSlideSchema = z.object({
  slideId: z.string().min(1).optional().describe('Slide id. Provide this or index.'),
  index: z.number().int().min(1).optional().describe('1-based slide index.'),
})

export const reorderSchema = z.object({
  slideId: z.string().min(1),
  toPosition: z.number().int().min(1).describe('1-based target position'),
})

export const screenshotSchema = z.object({
  slideId: z.string().min(1),
  atMs: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe('For animated slides, capture this many ms after load. Default 0.'),
})

export type CreateSlideArgs = z.infer<typeof createSlideSchema>
export type UpdateSlideArgs = z.infer<typeof updateSlideSchema>
export type ReadSlideArgs = z.infer<typeof readSlideSchema>
export type ReorderArgs = z.infer<typeof reorderSchema>
export type ScreenshotArgs = z.infer<typeof screenshotSchema>

/* -------------------------------------------------------------------------------------------- *
 * Tool metadata (names + descriptions), shared by the SDK glue and its tests
 * -------------------------------------------------------------------------------------------- */

export const SLIDE_TOOL_NAMES = {
  create: 'create_slide',
  update: 'update_slide',
  read: 'read_slide',
  reorder: 'reorder',
  screenshot: 'screenshot_slide',
} as const

/* -------------------------------------------------------------------------------------------- *
 * Result builders
 * -------------------------------------------------------------------------------------------- */

function text(message: string): SlideToolResult {
  return { content: [{ type: 'text', text: message }] }
}

function errorResult(message: string): SlideToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function hostErrorMessage<T>(outcome: HostOutcome<T> & { ok: false }): string {
  return outcome.message
}

/* -------------------------------------------------------------------------------------------- *
 * Handlers — pure: args + host -> result. No throwing; every failure is a value.
 * -------------------------------------------------------------------------------------------- */

export async function runCreateSlide(
  host: SlideToolHost,
  args: CreateSlideArgs,
): Promise<SlideToolResult> {
  const capabilities: readonly SlideCapability[] = args.capabilities ?? ['static']
  const validation = validateSlideContract(args.html, capabilities)
  if (!validation.ok) {
    return errorResult(`slide HTML rejected — ${contractErrorSummary(validation)}`)
  }

  const request: CreateSlideRequest = {
    html: args.html,
    title: args.title,
    capabilities,
    ...(args.notes !== undefined ? { notes: args.notes } : {}),
    ...(args.position !== undefined ? { position: args.position } : {}),
  }
  const outcome = await host.create(request)
  if (!outcome.ok) return errorResult(hostErrorMessage(outcome))

  return {
    content: [
      { type: 'text', text: `Created slide ${String(outcome.value.index)}: "${args.title}"` },
    ],
    structuredContent: { slideId: outcome.value.slideId, index: outcome.value.index },
  }
}

export async function runUpdateSlide(
  host: SlideToolHost,
  args: UpdateSlideArgs,
): Promise<SlideToolResult> {
  if (args.html === undefined && args.notes === undefined) {
    return errorResult('update_slide needs at least one of html or notes')
  }

  const current = await host.resolve({ slideId: args.slideId })
  if (current === null) {
    return errorResult(`no slide with id ${args.slideId}`)
  }

  if (args.html !== undefined) {
    // Validated against the slide's *existing* capabilities: there is no command to change a
    // slide's declared capabilities today (M1.2 has slide.setHtml/setNotes only), so an edit that
    // introduces a script into a slide declared "static" is rejected with an actionable SL-H01
    // rather than silently accepted — the agent recreates the slide instead.
    const validation = validateSlideContract(args.html, current.capabilities)
    if (!validation.ok) {
      return errorResult(`slide HTML rejected — ${contractErrorSummary(validation)}`)
    }
  }

  const request: UpdateSlideRequest = {
    slideId: args.slideId,
    ...(args.html !== undefined ? { html: args.html } : {}),
    ...(args.notes !== undefined ? { notes: args.notes } : {}),
  }
  const outcome = await host.update(request)
  if (!outcome.ok) return errorResult(hostErrorMessage(outcome))

  return {
    content: [{ type: 'text', text: `Updated slide ${String(outcome.value.index)}.` }],
    structuredContent: {
      slideId: outcome.value.slideId,
      index: outcome.value.index,
      revision: outcome.value.revision,
    },
  }
}

export async function runReadSlide(
  host: SlideToolHost,
  args: ReadSlideArgs,
): Promise<SlideToolResult> {
  if (args.slideId === undefined && args.index === undefined) {
    return errorResult('read_slide needs a slideId or an index')
  }
  const slide = await host.resolve({
    ...(args.slideId !== undefined ? { slideId: args.slideId } : {}),
    ...(args.index !== undefined ? { index: args.index } : {}),
  })
  if (slide === null) {
    const ref = args.slideId ?? `index ${String(args.index)}`
    const count = await host.count()
    return errorResult(`no slide at ${String(ref)}; the deck has ${String(count)} slides`)
  }
  return {
    // HTML in the text block *and* structuredContent: the §6 rule is that when structuredContent is
    // set the text is dropped, so the metadata JSON carries `html` too.
    content: [{ type: 'text', text: slide.html }],
    structuredContent: {
      slideId: slide.id,
      index: slide.index,
      title: slide.title,
      notes: slide.notes,
      capabilities: slide.capabilities,
      html: slide.html,
    },
  }
}

export async function runReorder(host: SlideToolHost, args: ReorderArgs): Promise<SlideToolResult> {
  const outcome = await host.reorder({ slideId: args.slideId, toPosition: args.toPosition })
  if (!outcome.ok) return errorResult(hostErrorMessage(outcome))
  return {
    content: [{ type: 'text', text: `Moved to position ${String(args.toPosition)}.` }],
    structuredContent: { order: outcome.value.order },
  }
}

export async function runScreenshot(
  host: SlideToolHost,
  args: ScreenshotArgs,
): Promise<SlideToolResult> {
  const slide = await host.resolve({ slideId: args.slideId })
  if (slide === null) return errorResult(`no slide with id ${args.slideId}`)
  const outcome = await host.screenshot(args.slideId, args.atMs ?? 0)
  if (!outcome.ok) return errorResult(hostErrorMessage(outcome))
  // No structuredContent: setting it would drop the text but *keep* the image while relying on
  // undefined-feeling behaviour; an image-only result is unambiguous (§6).
  return { content: [{ type: 'image', data: outcome.value.pngBase64, mimeType: 'image/png' }] }
}

/** Re-export so a caller building result assertions in a test does not reimplement the shape. */
export { text as slideToolText, errorResult as slideToolError }
