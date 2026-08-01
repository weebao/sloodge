import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { partialPathFor, writeExportAtomic } from '../../../src/main/export/write'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sloodge-export-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('writeExportAtomic', () => {
  it('writes the exact bytes to the chosen path', async () => {
    const dir = await tempDir()
    const out = join(dir, 'deck.pdf')
    const bytes = new Uint8Array([37, 80, 68, 70, 1, 2, 3])
    await writeExportAtomic(out, bytes)
    expect(new Uint8Array(await readFile(out))).toEqual(bytes)
  })

  it('leaves no .partial staging file behind on success', async () => {
    const dir = await tempDir()
    const out = join(dir, 'deck.pdf')
    await writeExportAtomic(out, new Uint8Array([1]))
    const entries = await readdir(dir)
    expect(entries).toEqual(['deck.pdf'])
    expect(entries).not.toContain('deck.pdf.partial')
  })

  it('names the staging path predictably', () => {
    expect(partialPathFor('/x/deck.pdf')).toBe('/x/deck.pdf.partial')
  })

  it('removes the staging file and rethrows when the rename target is unwritable', async () => {
    const dir = await tempDir()
    // The output path is a directory, so `rename(partial, out)` fails — the staging file must go.
    const out = join(dir, 'adir')
    await mkdtemp(join(dir, 'adir-')) // ensure dir exists sibling; then make `out` a dir
    await rm(out, { force: true }).catch(() => undefined)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(out)
    await expect(writeExportAtomic(out, new Uint8Array([1]))).rejects.toBeInstanceOf(Error)
    const entries = await readdir(dir)
    expect(entries.some((name) => name.endsWith('.partial'))).toBe(false)
  })
})
