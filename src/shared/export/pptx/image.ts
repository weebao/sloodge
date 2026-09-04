/**
 * The shape of an image the writer may embed (M4.8a). Every picture in a `.pptx` — the raster
 * fallback, a full-bleed background, a future sub-region capture — is a data URL produced by our
 * own offscreen window's `capturePage`, so anything else reaching the writer is a pipeline defect,
 * not user input. Checked at the writer edge so a malformed or oversized string never reaches
 * pptxgenjs, which would embed it as a broken media part without complaint.
 *
 * It is a **shape gate, not a content gate** (review r4): it enforces the scheme, the MIME type, the
 * base64 alphabet and the size cap, and never decodes the payload, so `data:image/png;base64,` over
 * arbitrary base64 passes. That is deliberate at this layer — a PPTX media part is an inert zip
 * entry that PowerPoint never parses as markup, and the one image type it renders that could carry
 * script, `image/svg+xml`, is refused here along with `text/html`, remote schemes, uppercase
 * variants and `;charset=` parameter insertion. Decoding and checking the PNG/JPEG magic bytes is
 * M4.8b's, alongside the sub-region capture that will produce more of these.
 */

/** PNG or JPEG, base64. Exactly what `nativeImage.toPNG()`/`toJPEG()` encode to. */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/

/** Upper bound on an embedded image string. A 2× capture of a 1280×720 slide is ~4–8 MB as PNG. */
export const MAX_IMAGE_DATA_URL_BYTES = 64 * 1024 * 1024

export function isImageDataUrl(value: string): boolean {
  return value.length <= MAX_IMAGE_DATA_URL_BYTES && IMAGE_DATA_URL.test(value)
}
