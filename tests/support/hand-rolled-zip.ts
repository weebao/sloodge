/**
 * A zip writer for shapes `fflate`'s `zipSync` cannot emit, so the hardened reader can be tested
 * against files only a hostile or broken producer writes.
 *
 * Today that is one shape: a central directory that lists the same entry name twice. `zipSync`
 * takes an object, so duplicate keys collapse before it ever runs — the only way to build the file
 * is by hand. Every member is STORED, which keeps the writer to its point (offsets and the central
 * directory) rather than a deflate implementation; the reader treats STORED and DEFLATE identically
 * once a member is located, so nothing about the shape under test depends on the method.
 *
 * CRCs are left at zero deliberately. Nothing in `archive.ts` verifies them — a STORED member is
 * `source.slice()` — so writing real ones would assert a property this reader does not have.
 */

import { strToU8 } from 'fflate'

export type HandRolledEntry = {
  /** The name as it goes into both headers, byte for byte. Duplicates are written, not merged. */
  readonly name: string
  readonly bytes: Uint8Array | string
}

/**
 * A zip holding `entries` in the order given, each with its own local header and its own central
 * directory record. Names are written verbatim, so passing the same name twice produces exactly the
 * archive OPC forbids and readers disagree about.
 */
export function handRolledZip(entries: readonly HandRolledEntry[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = strToU8(entry.name)
    const payload = typeof entry.bytes === 'string' ? strToU8(entry.bytes) : entry.bytes

    const local = new Uint8Array(30 + name.length + payload.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x0403_4b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, 0, true) // STORED
    localView.setUint32(18, payload.length, true) // compressed size
    localView.setUint32(22, payload.length, true) // uncompressed size
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(payload, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x0201_4b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, 0, true) // STORED
    centralView.setUint32(20, payload.length, true)
    centralView.setUint32(24, payload.length, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, localOffset, true)
    central.set(name, 46)
    centrals.push(central)

    localOffset += local.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x0605_4b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, localOffset, true)

  const out = new Uint8Array(localOffset + centralSize + eocd.length)
  let at = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at)
    at += part.length
  }
  return out
}
