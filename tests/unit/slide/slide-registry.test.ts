import { describe, expect, it } from 'vitest'
import { DEFAULT_ARCHIVE_LIMITS } from '../../../src/main/document/store'
import { DEFAULT_SLIDE_REGISTRY_LIMITS, SlideRegistry } from '../../../src/main/slide/registry'
import { isSlideDocumentId } from '../../../src/shared/slide-protocol'

/** Byte counting stays real; only the ceilings shrink so the caps are reachable in a unit test. */
function smallRegistry(limits: Partial<typeof DEFAULT_SLIDE_REGISTRY_LIMITS>): SlideRegistry {
  return new SlideRegistry({ limits })
}

function publishedId(registry: SlideRegistry, html: string): string {
  const result = registry.publish(html)
  if (!result.ok) throw new Error(`expected publish to succeed, got ${result.refusal.reason}`)
  return result.id
}

describe('SlideRegistry publish/get/revoke', () => {
  it('serves back exactly the document it was given', () => {
    const registry = new SlideRegistry()
    const html = '<!doctype html><html><body>slide</body></html>'
    const id = publishedId(registry, html)

    expect(isSlideDocumentId(id)).toBe(true)
    expect(registry.get(id)).toBe(html)
    expect(registry.size).toBe(1)
  })

  it('gives every publish its own id, even for identical html', () => {
    const registry = new SlideRegistry()
    const first = publishedId(registry, '<html>same</html>')
    const second = publishedId(registry, '<html>same</html>')

    // Deduplicating by content would be a lifetime bug, not an optimisation: two frames sharing an
    // id means the first unmount revokes the document the second one is still displaying.
    expect(first).not.toBe(second)
    expect(registry.size).toBe(2)
  })

  it('drops a document on revoke, and reports a second revoke as a no-op', () => {
    const registry = new SlideRegistry()
    const id = publishedId(registry, '<html>x</html>')

    expect(registry.revoke(id)).toBe(true)
    expect(registry.get(id)).toBeUndefined()
    expect(registry.size).toBe(0)
    expect(registry.totalBytes).toBe(0)

    // Idempotent: the renderer's effect cleanup can legitimately fire twice under StrictMode.
    expect(registry.revoke(id)).toBe(false)
  })

  it('returns undefined for an id it never issued', () => {
    const registry = new SlideRegistry()
    publishedId(registry, '<html>x</html>')
    expect(registry.get('f'.repeat(32))).toBeUndefined()
  })

  /**
   * The reason the scheme has no path-traversal surface: the lookup key is validated against the
   * issued-id shape, and behind it is a `Map`, not a filesystem. None of these can name a document
   * — not because a normalizer rejected them, but because there is nothing to normalize.
   */
  it.each([
    ['a relative path', '../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a windows path', 'C:\\windows\\system32'],
    ['a prototype key', '__proto__'],
    ['a constructor key', 'constructor'],
    ['a number', 7],
    ['null', null],
  ])('never resolves %s', (_label, key) => {
    const registry = new SlideRegistry()
    publishedId(registry, '<html>secret</html>')
    expect(registry.get(key)).toBeUndefined()
    expect(registry.revoke(key)).toBe(false)
  })

  /**
   * The reclamation path for a renderer that disappears without running a single effect cleanup —
   * a reload, an HMR full refresh, a crashed render process. Without it a few dozen dev-loop
   * reloads walk the aggregate budget to the cap, after which every publish is refused and slides
   * silently render blank.
   */
  it('drops every document belonging to one renderer and leaves the others alone', () => {
    const registry = new SlideRegistry()
    const mine = publishedId(registry, '<html>a</html>')
    publishedId(registry, '<html>b</html>')
    const theirs = registry.publish('<html>c</html>', 7)
    if (!theirs.ok) throw new Error('publish failed')

    // The two above were published with the default owner, distinct from 7.
    expect(registry.revokeOwner(7)).toBe(1)

    expect(registry.get(theirs.id)).toBeUndefined()
    expect(registry.get(mine)).toBe('<html>a</html>')
    expect(registry.size).toBe(2)
  })

  it('returns the aggregate byte budget when an owner is dropped', () => {
    const registry = new SlideRegistry()
    registry.publish('aaaaaa', 3)
    registry.publish('bbbb', 3)
    expect(registry.totalBytes).toBe(10)

    expect(registry.revokeOwner(3)).toBe(2)

    expect(registry.totalBytes).toBe(0)
    expect(registry.size).toBe(0)
  })

  it('reports nothing dropped for a renderer that never published', () => {
    const registry = new SlideRegistry()
    publishedId(registry, '<html>a</html>')
    expect(registry.revokeOwner(99)).toBe(0)
    expect(registry.size).toBe(1)
  })

  it('clears everything at once', () => {
    const registry = new SlideRegistry()
    const id = publishedId(registry, '<html>x</html>')
    publishedId(registry, '<html>y</html>')

    registry.clear()

    expect(registry.size).toBe(0)
    expect(registry.totalBytes).toBe(0)
    expect(registry.get(id)).toBeUndefined()
  })
})

describe('SlideRegistry limits', () => {
  it('refuses a document over the per-document byte cap', () => {
    const registry = smallRegistry({ maxDocumentBytes: 8 })

    expect(registry.publish('a'.repeat(8)).ok).toBe(true)
    const refused = registry.publish('a'.repeat(9))

    expect(refused).toEqual({ ok: false, refusal: { reason: 'too-large', bytes: 9, limit: 8 } })
    expect(registry.size).toBe(1)
  })

  // The cap is UTF-8 bytes, not characters. A cap counted in `String.length` would let a document
  // of multi-byte characters occupy several times the memory it was allowed.
  it('counts multi-byte characters by their utf-8 length', () => {
    const registry = smallRegistry({ maxDocumentBytes: 8 })
    // Three characters, nine bytes.
    const refused = registry.publish('日本語')

    expect(refused).toEqual({ ok: false, refusal: { reason: 'too-large', bytes: 9, limit: 8 } })
  })

  it('refuses once the document count is reached', () => {
    const registry = smallRegistry({ maxDocuments: 2 })
    publishedId(registry, '<a>')
    publishedId(registry, '<b>')

    expect(registry.publish('<c>')).toEqual({
      ok: false,
      refusal: { reason: 'too-many-documents', limit: 2 },
    })
  })

  it('refuses once the aggregate byte budget would be exceeded, and recovers after a revoke', () => {
    const registry = smallRegistry({ maxTotalBytes: 10 })
    const id = publishedId(registry, 'aaaaaa') // 6 bytes
    expect(registry.totalBytes).toBe(6)

    expect(registry.publish('bbbbb')).toEqual({
      ok: false,
      refusal: { reason: 'registry-full', bytes: 5, limit: 10 },
    })

    // Revoking must return the budget, or a long editing session degrades into permanent refusal.
    registry.revoke(id)
    expect(registry.totalBytes).toBe(0)
    expect(registry.publish('bbbbb').ok).toBe(true)
  })

  it('refuses a non-string outright', () => {
    const registry = new SlideRegistry()
    expect(registry.publish(42)).toEqual({ ok: false, refusal: { reason: 'not-a-string' } })
    expect(registry.publish(undefined).ok).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('retries on an id collision rather than overwriting a live document', () => {
    // A generator that repeats itself once, which a 128-bit CSPRNG will not do in the life of the
    // universe — but "the second publish silently replaced the first" is the failure mode worth
    // making impossible rather than improbable.
    const ids = ['a'.repeat(32), 'a'.repeat(32), 'b'.repeat(32)]
    let next = 0
    const registry = new SlideRegistry({
      createId: () => ids[next++] ?? 'c'.repeat(32),
    })

    const first = publishedId(registry, '<html>first</html>')
    const second = publishedId(registry, '<html>second</html>')

    expect(first).toBe('a'.repeat(32))
    expect(second).toBe('b'.repeat(32))
    expect(registry.get(first)).toBe('<html>first</html>')
  })

  /**
   * The registry holds the same objects the document model holds — a deck's slide HTML — so its
   * ceilings are the document model's ceilings. Drift in either direction is a bug: looser here
   * means content that cannot be opened can still be published; tighter means a deck that opens
   * cannot be displayed.
   */
  it('mirrors the document model archive limits', () => {
    expect(DEFAULT_SLIDE_REGISTRY_LIMITS).toEqual({
      maxDocumentBytes: DEFAULT_ARCHIVE_LIMITS.maxEntryBytes,
      maxDocuments: DEFAULT_ARCHIVE_LIMITS.maxEntries,
      maxTotalBytes: DEFAULT_ARCHIVE_LIMITS.maxTotalBytes,
    })
  })
})
