/**
 * The SDK glue for the `mcp__slides__*` server — the thin layer that wraps the pure handlers of
 * `src/shared/agent/slide-tools.ts` in the Agent SDK's `tool()` / `createSdkMcpServer` and hands the
 * result to the query as an in-process MCP server (50-agent-integration.md §6).
 *
 * "Thin" is the point: all decisions (contract validation, command dispatch, result shaping) live in
 * the pure handlers, which are unit-tested with a fake host and no SDK. This file only binds names,
 * descriptions and zod schemas to those handlers, so an SDK breaking change is a mechanical fix here
 * and the contract logic is untouched. `tool` and `createSdkMcpServer` are imported from `./client`
 * — the single file allowed to import `@anthropic-ai/claude-agent-sdk` (11-tech-stack.md R3) — so
 * this file adds no new dependency on the SDK package.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from './client'
import {
  createSlideSchema,
  reorderSchema,
  runCreateSlide,
  runReadSlide,
  runReorder,
  runScreenshot,
  runUpdateSlide,
  readSlideSchema,
  screenshotSchema,
  SLIDE_TOOL_NAMES,
  updateSlideSchema,
  type CreateSlideArgs,
  type ReadSlideArgs,
  type ReorderArgs,
  type ScreenshotArgs,
  type SlideToolHost,
  type UpdateSlideArgs,
} from '../../shared/agent/slide-tools'

/**
 * The SDK's `tool()` handler returns a `CallToolResult` (imported by the SDK from
 * `@modelcontextprotocol/sdk`, but not re-exported). Derive the type from `tool`'s own signature so
 * this file needs no second package import and the return casts below stay honest.
 */
type ToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>

/**
 * Build the in-process `slides` MCP server for one deck host. The key in `mcpServers` becomes the
 * `mcp__{key}__{tool}` segment, so this server surfaces as `mcp__slides__create_slide`, etc.
 *
 * `alwaysLoad` on the three per-turn drivers (create/update/read) keeps their schemas in the prompt
 * rather than deferred behind tool search — a seven-round-trip saving on every editing turn.
 * `reorder` and `screenshot_slide` stay deferred (rarer). `readOnlyHint` lets the harness batch the
 * read-only tools in parallel (§6).
 */
export function createSlidesServer(host: SlideToolHost): McpSdkServerConfigWithInstance {
  const createTool = tool(
    SLIDE_TOOL_NAMES.create,
    'Create a new slide and insert it into the deck. Use when the user asks to add or generate a slide.',
    createSlideSchema.shape,
    async (args) => (await runCreateSlide(host, args as CreateSlideArgs)) as ToolResult,
    { annotations: { readOnlyHint: false }, alwaysLoad: true },
  )

  const updateTool = tool(
    SLIDE_TOOL_NAMES.update,
    'Replace the HTML and/or speaker notes of an existing slide. Call read_slide first if you do not have the current HTML.',
    updateSlideSchema.shape,
    async (args) => (await runUpdateSlide(host, args as UpdateSlideArgs)) as ToolResult,
    { annotations: { readOnlyHint: false }, alwaysLoad: true },
  )

  const readTool = tool(
    SLIDE_TOOL_NAMES.read,
    "Return one slide's full HTML, title, notes, index and capabilities. Use before editing a slide.",
    readSlideSchema.shape,
    async (args) => (await runReadSlide(host, args as ReadSlideArgs)) as ToolResult,
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  )

  const reorderTool = tool(
    SLIDE_TOOL_NAMES.reorder,
    'Move a slide to a new 1-based position in the deck.',
    reorderSchema.shape,
    async (args) => (await runReorder(host, args as ReorderArgs)) as ToolResult,
    { annotations: { readOnlyHint: false } },
  )

  const screenshotTool = tool(
    SLIDE_TOOL_NAMES.screenshot,
    'Render a slide and return a PNG. Use to visually verify a slide you created or edited before reporting done.',
    screenshotSchema.shape,
    async (args) => (await runScreenshot(host, args as ScreenshotArgs)) as ToolResult,
    { annotations: { readOnlyHint: true } },
  )

  return createSdkMcpServer({
    name: 'slides',
    version: '1.0.0',
    tools: [createTool, updateTool, readTool, reorderTool, screenshotTool],
  })
}
