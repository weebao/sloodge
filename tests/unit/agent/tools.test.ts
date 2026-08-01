import { describe, expect, it, vi } from 'vitest'

// Mock the SDK facade so this test needs neither the real SDK nor electron (client.ts imports both).
// The mocked `tool`/`createSdkMcpServer` just capture their arguments so we can assert the wiring.
vi.mock('../../../src/main/agent/client', () => ({
  tool: vi.fn(
    (
      name: string,
      description: string,
      inputSchema: unknown,
      handler: unknown,
      extras: unknown,
    ) => ({
      name,
      description,
      inputSchema,
      handler,
      extras,
    }),
  ),
  createSdkMcpServer: vi.fn((options: unknown) => options),
}))

import { createSlidesServer } from '../../../src/main/agent/tools'
import {
  SLIDE_TOOL_NAMES,
  type HostOutcome,
  type SlideToolHost,
} from '../../../src/shared/agent/slide-tools'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'

function ok<T>(value: T): HostOutcome<T> {
  return { ok: true, value }
}

type CapturedTool = {
  name: string
  description: string
  inputSchema: unknown
  handler: (args: unknown) => Promise<unknown>
  extras?: { annotations?: { readOnlyHint?: boolean }; alwaysLoad?: boolean }
}

function fakeHost(): SlideToolHost {
  return {
    resolve: vi.fn(async () => null),
    list: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    create: vi.fn(async () => ok({ slideId: 's_x' as SlideId, index: 1 })),
    update: vi.fn(async () => ok({ slideId: 's_x' as SlideId, index: 1, revision: 1 })),
    reorder: vi.fn(async () => ok({ order: [] as string[] })),
    screenshot: vi.fn(async () => ok({ pngBase64: 'x' })),
  }
}

describe('createSlidesServer — SDK registration', () => {
  it('registers the five slide tools under the "slides" server', () => {
    const server = createSlidesServer(fakeHost()) as unknown as {
      name: string
      version: string
      tools: CapturedTool[]
    }
    expect(server.name).toBe('slides')
    const names = server.tools.map((t) => t.name)
    expect(names).toEqual([
      SLIDE_TOOL_NAMES.create,
      SLIDE_TOOL_NAMES.update,
      SLIDE_TOOL_NAMES.read,
      SLIDE_TOOL_NAMES.reorder,
      SLIDE_TOOL_NAMES.screenshot,
    ])
  })

  it('marks the per-turn drivers alwaysLoad and the read-only tools readOnly', () => {
    const server = createSlidesServer(fakeHost()) as unknown as { tools: CapturedTool[] }
    const byName = new Map(server.tools.map((t) => [t.name, t]))
    expect(byName.get(SLIDE_TOOL_NAMES.create)?.extras?.alwaysLoad).toBe(true)
    expect(byName.get(SLIDE_TOOL_NAMES.update)?.extras?.alwaysLoad).toBe(true)
    expect(byName.get(SLIDE_TOOL_NAMES.read)?.extras?.alwaysLoad).toBe(true)
    expect(byName.get(SLIDE_TOOL_NAMES.reorder)?.extras?.alwaysLoad).toBeUndefined()
    expect(byName.get(SLIDE_TOOL_NAMES.read)?.extras?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get(SLIDE_TOOL_NAMES.screenshot)?.extras?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get(SLIDE_TOOL_NAMES.create)?.extras?.annotations?.readOnlyHint).toBe(false)
  })

  it('routes a registered handler through to the host', async () => {
    const host = fakeHost()
    const server = createSlidesServer(host) as unknown as { tools: CapturedTool[] }
    const createTool = server.tools.find((t) => t.name === SLIDE_TOOL_NAMES.create)!
    const result = (await createTool.handler({
      html: createStarterSlideHtml({ id: 's_01H8XQZ4P7K2M9NB3VYRTC6FDA' as SlideId, title: 'H' }),
      title: 'H',
    })) as { isError?: boolean }
    expect(host.create).toHaveBeenCalledOnce()
    expect(result.isError).toBeUndefined()
  })
})
