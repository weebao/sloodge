/**
 * The HTML export's one impure step (M4.4): turn the pure builder's `{ path: bytes }` map into a zip.
 *
 * Everything interesting already happened in `src/shared/export/html-bundle.ts`. This module exists
 * because zipping needs a library and the builder must not, and it is deliberately the smallest
 * possible amount of code — the tests for it are round-trips (`build → zip → unzip → compare`)
 * rather than assertions about zip internals.
 *
 * ## Why `fflate`, and why `zipSync`
 *
 * `fflate` is already a dependency: `document/store.ts` uses it for the `.sloodge` archive. Adding a
 * second zip library to write a second kind of zip would be indefensible, so this reuses it.
 *
 * `zipSync` rather than the async `zip`, for the reason `store.ts` documents at length: fflate's
 * async path starts *every* member at once with no concurrency limit, spawning a `worker_threads`
 * Worker per member over a size threshold, so peak memory is the sum of every member's buffers plus
 * a V8 isolate and a structured-clone copy each. A 30-slide deck of self-contained documents with
 * `data:` images is exactly the shape that blows up. The synchronous path is bounded, and an export
 * that already spent seconds rendering slides does not need the milliseconds.
 *
 * ## The top-level folder
 *
 * Every path is prefixed with a single root directory named after the deck. Unzipping `deck.zip`
 * therefore yields one `deck/` folder rather than scattering `index.html`, `deck.json` and `slides/`
 * into whatever directory the user was in — the "zip bomb" of tidiness complaints. The prefix is
 * applied here rather than in the builder so the builder's paths stay bundle-relative and its tests
 * stay about content.
 */

import { zipSync } from 'fflate'

/**
 * The fixed modification time stamped on every bundle member.
 *
 * A zip's DOS timestamp field can only represent 1980–2099, so the obvious "epoch" choice of `0` is
 * rejected outright by fflate. This is a local-time `Date` rather than a UTC instant on purpose:
 * fflate reads the calendar components with the local-time getters, so a UTC instant near a year
 * boundary would land on a different stored value — and, at 1980-01-01Z, out of range entirely — for
 * anyone west of Greenwich. Fixed local components are the same bytes in every timezone.
 *
 * Stamping a constant is what makes the output **byte-deterministic**: exporting an unchanged deck
 * twice produces an identical archive, so a bundle stays diffable and the round-trip test can assert
 * on bytes rather than on size.
 */
const BUNDLE_MTIME = new Date(2000, 0, 1, 0, 0, 0)

/**
 * A filesystem-safe directory/file stem from a deck title. Mirrors `defaultPdfFileName`'s slugging so
 * `Deck.pdf` and `Deck.zip` come out of the same title identically, and falls back to `deck` for a
 * title that reduces to nothing.
 */
export function bundleRootName(deckTitle: string): string {
  const stem = deckTitle
    .trim()
    .replace(/[^\p{L}\p{N} _-]+/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 80)
  return stem === '' ? 'deck' : stem
}

/** The default save-dialog filename for an HTML export. */
export function defaultHtmlFileName(deckTitle: string): string {
  return `${bundleRootName(deckTitle)}.zip`
}

/**
 * Zip a bundle.
 *
 * `level: 6` (fflate's default) across the board: slide documents are HTML with embedded `data:`
 * URIs, which is text-shaped and compresses well, and no member here needs the STORED-first
 * treatment the OPC-style `.sloodge` archive gives its `mimetype` entry — a bundle zip is an
 * ordinary zip that any tool may open however it likes.
 *
 * `BUNDLE_MTIME` makes the output byte-deterministic; see its docstring for why it is a fixed
 * in-range local date rather than the epoch.
 */
export function zipHtmlBundle(
  files: ReadonlyMap<string, Uint8Array>,
  rootName: string,
): Uint8Array {
  const members: Record<string, Uint8Array> = {}
  for (const [path, bytes] of files) {
    members[`${rootName}/${path}`] = bytes
  }
  return zipSync(members, { mtime: BUNDLE_MTIME })
}
