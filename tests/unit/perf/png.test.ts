/**
 * The deterministic PNG encoder behind the image-laden stress archetype.
 *
 * These images have to be *real* — Chromium must decode them onto its normal raster path — or the
 * archetype measures nothing. So the assertions check the actual container: a known-answer CRC-32,
 * every chunk's checksum recomputed independently, and an IDAT stream that inflates back to exactly
 * the scanline layout the header promises.
 */

import { describe, expect, it } from 'vitest'
import { unzlibSync } from 'fflate'
import { crc32, encodePng, encodePngDataUri } from '../../../perf/lib/png'
import { mulberry32 } from '../../../perf/lib/prng'

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

type Chunk = { type: string; data: Uint8Array; crc: number; crcOk: boolean }

/** Walk the PNG chunk stream, verifying each CRC independently of the encoder. */
function parseChunks(png: Uint8Array): Chunk[] {
  const chunks: Chunk[] = []
  let offset = 8
  while (offset < png.length) {
    const length = readU32(png, offset)
    const type = String.fromCharCode(...png.slice(offset + 4, offset + 8))
    const data = png.slice(offset + 8, offset + 8 + length)
    const crc = readU32(png, offset + 8 + length)
    const expected = crc32(png.slice(offset + 4, offset + 8 + length))
    chunks.push({ type, data, crc, crcOk: crc === expected })
    offset += 12 + length
  }
  return chunks
}

describe('crc32', () => {
  it('matches the standard check vector for "123456789"', () => {
    // CRC-32/ISO-HDLC check value, 0xCBF43926 — an external known answer, not a self-comparison.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('encodePng', () => {
  it('emits the PNG signature', () => {
    const png = encodePng({ width: 16, height: 8, rng: mulberry32(1) })
    expect(Array.from(png.slice(0, 8))).toStrictEqual(SIGNATURE)
  })

  it('emits IHDR, IDAT and IEND in order, each with a valid CRC', () => {
    const png = encodePng({ width: 24, height: 12, rng: mulberry32(2) })
    const chunks = parseChunks(png)
    expect(chunks.map((c) => c.type)).toStrictEqual(['IHDR', 'IDAT', 'IEND'])
    expect(chunks.every((c) => c.crcOk)).toBe(true)
  })

  it('declares the dimensions and colour type it was asked for', () => {
    const png = encodePng({ width: 40, height: 25, rng: mulberry32(3) })
    const ihdr = parseChunks(png)[0]
    expect(ihdr).toBeDefined()
    expect(readU32(ihdr?.data ?? new Uint8Array(0), 0)).toBe(40)
    expect(readU32(ihdr?.data ?? new Uint8Array(0), 4)).toBe(25)
    expect(ihdr?.data[8]).toBe(8) // bit depth
    expect(ihdr?.data[9]).toBe(2) // colour type 2 = truecolour RGB
    expect(ihdr?.data[12]).toBe(0) // no interlace
  })

  it('inflates to exactly one filter byte plus width*3 bytes per row', () => {
    const width = 32
    const height = 10
    const png = encodePng({ width, height, rng: mulberry32(4) })
    const idat = parseChunks(png).find((c) => c.type === 'IDAT')
    expect(idat).toBeDefined()
    const raw = unzlibSync(idat?.data ?? new Uint8Array(0))
    expect(raw.length).toBe((width * 3 + 1) * height)
    for (let y = 0; y < height; y += 1) {
      // Filter type 1 ("Sub") on every scanline — the choice that makes these images a few KB
      // instead of ~100 KB. A regression to filter 0 would show up here.
      expect(raw[y * (width * 3 + 1)]).toBe(1)
    }
  })

  it('reconstructs to in-range pixels that are not all identical', () => {
    const width = 24
    const height = 12
    const png = encodePng({ width, height, rng: mulberry32(5) })
    const idat = parseChunks(png).find((c) => c.type === 'IDAT')
    const raw = unzlibSync(idat?.data ?? new Uint8Array(0))
    const stride = width * 3 + 1
    const seen = new Set<number>()
    for (let y = 0; y < height; y += 1) {
      const row = new Uint8Array(width * 3)
      for (let i = 0; i < row.length; i += 1) {
        // Inverse of the Sub filter: add back the byte three positions to the left.
        const left = i >= 3 ? (row[i - 3] ?? 0) : 0
        row[i] = ((raw[y * stride + 1 + i] ?? 0) + left) & 0xff
      }
      for (const value of row) seen.add(value)
    }
    expect(seen.size).toBeGreaterThan(8)
  })

  it('is deterministic for a given seed and differs across seeds', () => {
    const a = encodePng({ width: 20, height: 10, rng: mulberry32(9) })
    const b = encodePng({ width: 20, height: 10, rng: mulberry32(9) })
    const c = encodePng({ width: 20, height: 10, rng: mulberry32(10) })
    expect([...b]).toStrictEqual([...a])
    expect([...c]).not.toStrictEqual([...a])
  })

  it('rejects non-positive or fractional dimensions', () => {
    expect(() => encodePng({ width: 0, height: 4, rng: mulberry32(1) })).toThrow(RangeError)
    expect(() => encodePng({ width: 4, height: -1, rng: mulberry32(1) })).toThrow(RangeError)
    expect(() => encodePng({ width: 4.5, height: 4, rng: mulberry32(1) })).toThrow(RangeError)
  })
})

describe('encodePngDataUri', () => {
  it('produces a data: URI, the only image form the slide contract permits', () => {
    const uri = encodePngDataUri({ width: 8, height: 8, rng: mulberry32(1) })
    expect(uri.startsWith('data:image/png;base64,')).toBe(true)
    const bytes = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64')
    expect(Array.from(bytes.subarray(0, 8))).toStrictEqual(SIGNATURE)
  })
})
