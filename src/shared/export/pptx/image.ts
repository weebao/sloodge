/**
 * The shape of an image the writer may embed (M4.8a). Every picture in a `.pptx` — the raster
 * fallback, a full-bleed background, a future sub-region capture — is a data URL produced by our
 * own offscreen window's `capturePage`, so anything else reaching the writer is a pipeline defect,
 * not user input. Checked at the writer edge so a malformed or oversized string never reaches
 * pptxgenjs, which would embed it as a broken media part without complaint.
 */

/** PNG or JPEG, base64. Exactly what `nativeImage.toPNG()`/`toJPEG()` encode to. */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/

/** Upper bound on an embedded image string. A 2× capture of a 1280×720 slide is ~4–8 MB as PNG. */
export const MAX_IMAGE_DATA_URL_BYTES = 64 * 1024 * 1024

export function isImageDataUrl(value: string): boolean {
  return value.length <= MAX_IMAGE_DATA_URL_BYTES && IMAGE_DATA_URL.test(value)
}
