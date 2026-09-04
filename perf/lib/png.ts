/**
 * A minimal, deterministic PNG encoder for the image-laden stress archetype.
 *
 * Why encode real PNGs instead of embedding an SVG or a 1x1 placeholder: the archetype exists to
 * make Chromium do *raster* work — decode, upload a texture, hold a decoded bitmap in the renderer's
 * image cache. A `data:image/svg+xml` costs parse and paint but no decode; a 1x1 PNG scaled up costs
 * nothing at all. Both would produce a stress deck the app treats as trivial, which is the specific
 * failure mode this milestone has to avoid.
 *
 * Determinism: pixel values come from the caller's seeded `Rng`, and DEFLATE is `fflate`'s
 * `zlibSync` at a fixed level, so the same seed yields byte-identical PNGs on every run and machine.
 *
 * Scope: 8-bit truecolour (colour type 2), no interlacing, no palette, no ancillary chunks. That is
 * the smallest encoder that produces a file Chromium decodes on the normal raster path.
 */

import { zlibSync } from 'fflate'
import type { Rng } from './prng'

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

/** CRC-32 (IEEE 802.3), the polynomial PNG chunk checksums use. Table built once, lazily. */
let crcTable: Uint32Array | null = null

function crc32Table(): Uint32Array {
  if (crcTable !== null) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

/** CRC-32 of a byte range, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  const table = crc32Table()
  let c = 0xffffffff
  for (const byte of bytes) {
    c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Build one PNG chunk: length, type, payload, CRC over type+payload. */
function chunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.codePointAt(0) ?? 0))
  const body = concat([typeBytes, payload])
  return concat([u32(payload.length), body, u32(crc32(body))])
}

export type PngOptions = {
  readonly width: number
  readonly height: number
  /** Seeded source for the tint variation between generated images. */
  readonly rng: Rng
}

/**
 * Encode a deterministic RGB PNG.
 *
 * The pixel field is a smooth two-axis gradient with a seeded hue offset plus a coarse block
 * pattern. Deliberately *not* white noise: noise is incompressible, so a 320x200 noise image would
 * be ~190 KB of base64 and the deck size, not the render cost, would dominate every measurement.
 * A structured field compresses to a few KB while still producing a full-size decoded bitmap in the
 * renderer — which is the cost we actually want to provoke.
 *
 * @throws RangeError for non-positive or non-integer dimensions.
 */
export function encodePng({ width, height, rng }: PngOptions): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`PNG dimensions must be positive integers, got ${width}x${height}`)
  }

  const hueShift = Math.floor(rng() * 256)
  const blockSize = 8 + Math.floor(rng() * 24)

  // Scanlines are filter type 1 ("Sub": each byte is stored as the difference from the same channel
  // three bytes to its left). With filter 0 a smooth gradient stores a different byte in every pixel
  // and DEFLATE achieves almost nothing — measured at ~104 KB for a 240x150 image, which made the
  // image archetype's *deck size* rather than its render cost dominate every measurement. Sub turns
  // a horizontal gradient into a near-constant byte stream, which is what makes these images a few
  // KB each while still decoding to a full-size bitmap.
  const bpp = 3
  const stride = width * bpp + 1
  const raw = new Uint8Array(stride * height)
  const row = new Uint8Array(width * bpp)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const block = (Math.floor(x / blockSize) + Math.floor(y / blockSize)) % 2 === 0 ? 24 : 0
      const offset = x * bpp
      row[offset] = (Math.floor((x / width) * 255) + hueShift + block) % 256
      row[offset + 1] = (Math.floor((y / height) * 255) + block) % 256
      row[offset + 2] = (Math.floor(((x + y) / (width + height)) * 255) + hueShift) % 256
    }
    const rowStart = y * stride
    raw[rowStart] = 1
    for (let i = 0; i < row.length; i += 1) {
      const current = row[i] ?? 0
      const left = i >= bpp ? (row[i - bpp] ?? 0) : 0
      raw[rowStart + 1 + i] = (current - left) & 0xff
    }
  }

  const ihdr = concat([
    u32(width),
    u32(height),
    Uint8Array.from([8, 2, 0, 0, 0]), // 8-bit, truecolour, deflate, adaptive filter, no interlace
  ])

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}

/** Encode a PNG and wrap it as a `data:` URI — the only image form the slide contract permits. */
export function encodePngDataUri(options: PngOptions): string {
  const bytes = encodePng(options)
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}
