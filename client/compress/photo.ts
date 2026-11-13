const MAX_EDGE = 2048;
const THUMB_EDGE = 400;
const QUALITY = 0.75;

export interface Encoded { blob: Blob; type: "image/webp" | "image/jpeg"; width: number; height: number; }

function fit(w: number, h: number, max: number) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

let webpOk: boolean | undefined;
async function supportsWebpEncode(): Promise<boolean> {
  if (webpOk !== undefined) return webpOk;
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const b = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", 0.5));
  return (webpOk = b?.type === "image/webp"); // older Safari silently returns PNG
}

/** Draw any CanvasImageSource scaled to `max` long edge and encode WebP (JPEG fallback). */
export async function encodeScaled(src: CanvasImageSource, sw: number, sh: number, max: number, q = QUALITY): Promise<Encoded> {
  const { w, h } = fit(sw, sh, max);
  const webp = await supportsWebpEncode();
  const type = webp ? "image/webp" : "image/jpeg";
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    blob = await c.convertToBlob({ type, quality: q }).catch(() => null);
  } else blob = null;
  if (!blob || blob.type !== type) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, q));
  }
  if (!blob) throw new Error("encode_failed");
  return { blob, type, width: w, height: h };
}

/**
 * 16 MP phone photo (~6.5 MB) → 2048 px WebP q75 (~600 KB) + 400 px thumb.
 * Re-encoding drops EXIF/GPS. createImageBitmap applies EXIF orientation.
 */
export async function compressPhoto(file: Blob): Promise<{ main: Encoded; thumb: Encoded }> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const main = await encodeScaled(bmp, bmp.width, bmp.height, MAX_EDGE);
    const thumb = await encodeScaled(bmp, bmp.width, bmp.height, THUMB_EDGE, 0.7);
    return { main, thumb };
  } finally {
    bmp.close();
  }
}

export { THUMB_EDGE };
