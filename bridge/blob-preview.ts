/**
 * A small WebP of a journal picture, for a phone that only needs to SEE it (Dogr build).
 *
 * `GET /api/blobs/<hash>?view=preview` answers with a picture no longer than {@link PREVIEW_EDGE} pixels, written as a lossy WebP,
 * when that is smaller than the stored file. The same address without the query is the original, byte for byte, and is what a
 * phone asks for when the person opens a picture, shares it or attaches it. A client or a Collie that does not know the query
 * gets the original: the query is ignored by every route that does not read it, so nothing has to be negotiated.
 *
 * **It can only make things smaller, and it can never fail the request.** Anything that is not a still PNG or JPEG (a GIF or a WebP
 * may be animated, and the conversion keeps one frame), a picture with too many pixels, a decoder that is missing or throws, or a
 * result that is not smaller than the stored file: the caller serves the original. Conversions run two at a time, so a thread of
 * pictures opened at once cannot hold the machine's memory or its processor.
 *
 * Why WebP: on real pi screenshots (50 PNG and 50 JPEG from one machine) lossy WebP at quality 80 came out at about 22 percent of
 * the PNGs and 51 percent of the JPEGs, where a JPEG made the PNGs 44 percent and the JPEGs 104 percent. WebKit on a phone draws it,
 * and so does the system's image decoder behind the app's own picture window.
 *
 * A new file of the Dogr build, so that upstream's files stay as they are (see AGENTS.md, "Collie submodule").
 * TEST:bridge/blob-preview.test.ts
 */

/** The longest edge, in pixels, of a preview: about the width of a phone screen. A smaller picture is not enlarged. */
export const PREVIEW_EDGE = 1080;

/** The WebP quality of a preview (0 to 100). */
export const PREVIEW_QUALITY = 80;

/** A picture with more pixels than this is not converted (decoding it would need a large buffer); the original is served. */
export const PREVIEW_MAX_PIXELS = 40_000_000;

/** How many conversions run at the same time. */
export const PREVIEW_PARALLEL = 2;

/** The content type of a preview. */
export const PREVIEW_TYPE = "image/webp";

/** The stored types a preview is made of: still pictures only. */
const PREVIEWABLE: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

/** How many conversions are running now. */
let running = 0;

/** The conversions waiting for a place, oldest first. */
const waiting: (() => void)[] = [];

/**
 * Wait for one of the {@link PREVIEW_PARALLEL} places.
 * @returns A function that gives the place back; call it exactly once.
 */
async function takePlace(): Promise<() => void> {
  if (running >= PREVIEW_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  else running += 1;
  // A place handed on by `give` stays counted, so `running` only goes down when nobody is waiting.
  let given = false;
  return () => {
    if (given) return;
    given = true;
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  };
}

/**
 * Whether the preview of a picture of this type is made at all.
 * @param type The content type read off the stored bytes (`sniffBlobType`).
 * @returns True for a PNG or a JPEG.
 */
export function canPreview(type: string): boolean {
  return PREVIEWABLE.has(type);
}

/**
 * Make the preview of one picture.
 * @param bytes The stored file.
 * @param type The content type read off its bytes.
 * @returns The WebP bytes, or null when the original should be served: a type that is not previewed, no image decoder in this
 *   runtime, a picture over {@link PREVIEW_MAX_PIXELS}, a decode or encode error, or a result that is not smaller than `bytes`.
 */
export async function makePreview(bytes: Uint8Array, type: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!canPreview(type) || Bun.Image === undefined) return null;
  const release = await takePlace();
  try {
    // `maxPixels` makes the decoder refuse a file that claims a huge canvas before it allocates anything. EXIF turning is applied
    // by default (`autoOrient`), so a photo is upright in the preview whatever its file said.
    const source = new Bun.Image(bytes, { maxPixels: PREVIEW_MAX_PIXELS });
    const { width, height } = await source.metadata();
    if (width <= 0 || height <= 0) return null;
    const turned = new Bun.Image(bytes, { maxPixels: PREVIEW_MAX_PIXELS });
    const sized =
      Math.max(width, height) > PREVIEW_EDGE
        ? turned.resize(PREVIEW_EDGE, PREVIEW_EDGE, { fit: "inside", withoutEnlargement: true })
        : turned;
    const out = await sized.webp({ quality: PREVIEW_QUALITY }).bytes();
    // A copy, so the answer is a plain ArrayBuffer-backed array that a Response body accepts.
    return out.byteLength > 0 && out.byteLength < bytes.byteLength ? new Uint8Array(out) : null;
  } catch {
    // Any failure is "serve the original": a preview is a saving, never a requirement.
    return null;
  } finally {
    release();
  }
}
