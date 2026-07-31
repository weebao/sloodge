/**
 * Lexicographically-sortable, collision-resistant ids for slides and elements.
 *
 * ULID-shaped: 10 chars of Crockford-base32 millisecond timestamp followed by
 * 16 chars of randomness. Sorting ids sorts by creation time, which is what
 * makes them usable as stable `data-sl-id` values and as deck-order tiebreaks.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_LEN = ENCODING.length
const TIME_LEN = 10
const RANDOM_LEN = 16

/** Largest timestamp representable in 10 base32 chars (2^50 - 1 ms). */
export const MAX_ULID_TIME = 281_474_976_710_655

export function encodeTime(now: number, length: number = TIME_LEN): string {
  if (!Number.isInteger(now) || now < 0) {
    throw new TypeError(`Timestamp must be a non-negative integer, got ${String(now)}`)
  }
  if (now > MAX_ULID_TIME) {
    throw new RangeError(`Timestamp ${String(now)} exceeds ULID range`)
  }

  let remaining = now
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out = ENCODING.charAt(remaining % ENCODING_LEN) + out
    remaining = Math.floor(remaining / ENCODING_LEN)
  }
  return out
}

function encodeRandom(length: number = RANDOM_LEN): string {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)

  let out = ''
  for (const byte of bytes) {
    out += ENCODING.charAt(byte % ENCODING_LEN)
  }
  return out
}

/** Generate a new id. `now` is injectable so tests stay deterministic. */
export function createSlideId(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

const ID_PATTERN = new RegExp(`^[${ENCODING}]{${String(TIME_LEN + RANDOM_LEN)}}$`)

export function isSlideId(value: string): boolean {
  return ID_PATTERN.test(value)
}
