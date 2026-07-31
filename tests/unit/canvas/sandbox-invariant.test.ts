import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A grep, deliberately.
 *
 * `slide-frame.test.tsx` pins the one frame that exists today. This pins the *rule*, and fails the
 * build the day a second frame appears — a Present window, an export renderer, a Design Mode
 * overlay — where no component test is watching yet. `allow-same-origin` together with
 * `allow-scripts` is not a weakened sandbox, it is no sandbox: the framed document can reach
 * `window.parent` and delete its own `sandbox` attribute.
 */

/**
 * Comments are stripped first, so the security notes that *discuss* the token (and must keep
 * discussing it) do not trip the check. Crude on purpose — a real parser here would be a second
 * thing to trust. A false positive costs one confused minute; a false negative costs the sandbox.
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '')
    .replaceAll(/<!--[\s\S]*?-->/g, '')
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => sourceFiles(join(dir, entry.name))),
  )
  const here = entries
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx|html)$/.test(entry.name))
    .map((entry) => join(dir, entry.name))
  return [...here, ...nested.flat()]
}

describe('iframe sandbox posture', () => {
  it('no source file anywhere grants allow-same-origin', async () => {
    const root = join(process.cwd(), 'src')
    const files = await sourceFiles(root)
    expect(files.length).toBeGreaterThan(0)

    const flagged = await Promise.all(
      files.map(async (file) =>
        stripComments(await readFile(file, 'utf8')).includes('allow-same-origin') ? file : null,
      ),
    )

    expect(flagged.filter((file) => file !== null)).toEqual([])
  })
})
