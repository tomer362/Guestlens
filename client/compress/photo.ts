import { encodeLqipPixels } from "@/lib/lqip";
const MAX_EDGE = 2048;
/** Grid tiles are ~117 CSS px squares → ~350 device px at DPR 3. */
const THUMB_EDGE = 360;
const THUMB_QUALITY = 0.6;
/** Long edge of the inline color-grid placeholder. */
const LQIP_EDGE = 4;
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

function canvas2d(w: number, h: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    return { c, ctx: c.getContext("2d")! as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D };
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return { c, ctx: c.getContext("2d")! };
}

async function toBlob(c: OffscreenCanvas | HTMLCanvasElement, type: string, q: number): Promise<Blob | null> {
  if ("convertToBlob" in c) return c.convertToBlob({ type, quality: q }).catch(() => null);
  return new Promise((r) => c.toBlob(r, type, q));
}

/**
 * Square, center-cropped thumbnail: exactly what the grid shows, so no pixels are
 * wasted on cropped-away edges and the tile is never upscaled.
 */
export async function encodeSquareThumb(src: CanvasImageSource, sw: number, sh: number): Promise<Encoded> {
  const side = Math.min(sw, sh);
  const size = Math.min(THUMB_EDGE, side);
  const { c, ctx } = canvas2d(size, size);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, size, size);
  const type = (await supportsWebpEncode()) ? "image/webp" : "image/jpeg";
  let blob = await toBlob(c, type, THUMB_QUALITY);
  if (!blob || blob.type !== type) {
    // OffscreenCanvas without WebP: redo on a DOM canvas
    const d = document.createElement("canvas"); d.width = d.height = size;
    const dctx = d.getContext("2d")!; dctx.imageSmoothingQuality = "high";
    dctx.drawImage(src, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, size, size);
    blob = await new Promise<Blob | null>((r) => d.toBlob(r, type, THUMB_QUALITY));
  }
  if (!blob) throw new Error("encode_failed");
  return { blob, type, width: size, height: size };
}

/** 4×3 color grid placeholder (see lib/lqip.ts), ~52 characters. */
export async function encodeLqip(src: CanvasImageSource, sw: number, sh: number): Promise<string | undefined> {
  try {
    const s = LQIP_EDGE / Math.max(sw, sh);
    const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    return encodeLqipPixels(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return undefined;
  }
}

export async function makeThumbs(src: CanvasImageSource, sw: number, sh: number) {
  const [thumb, lqip] = await Promise.all([encodeSquareThumb(src, sw, sh), encodeLqip(src, sw, sh)]);
  return { thumb, lqip };
}

export class DecodeError extends Error { constructor() { super("decode_failed"); } }

type Decoded = { src: CanvasImageSource; w: number; h: number; close: () => void };

const looksHeic = (f: Blob) => /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test((f as File).name ?? "");

async function viaImg(blob: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await (img.decode ? img.decode() : new Promise((res, rej) => { img.onload = res; img.onerror = rej; }));
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  // <img> applies EXIF orientation in every current browser
  return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

/**
 * Decode any picked photo, most capable path first:
 *  1. createImageBitmap with EXIF orientation      (all current browsers)
 *  2. createImageBitmap without options            (older Safari rejects the options bag)
 *  3. <img> + decode()                             (anything the browser can display)
 *  4. HEIC/HEIF → WASM decoder, loaded only here   (Chrome/Firefox/Samsung can't decode
 *                                                    Samsung "high efficiency" photos)
 */
/** Minimal OffscreenCanvas stand-in (older Firefox) for the HEIC decoder; real one is used when present. */
function ensureOffscreenCanvas() {
  const g = globalThis as { OffscreenCanvas?: unknown };
  if (typeof g.OffscreenCanvas !== "undefined" || typeof document === "undefined") return;
  g.OffscreenCanvas = function (w: number, h: number) {
    const c = document.createElement("canvas") as HTMLCanvasElement & { convertToBlob?: (o?: { type?: string; quality?: number }) => Promise<Blob> };
    c.width = w; c.height = h;
    c.convertToBlob = (o) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), o?.type, o?.quality));
    return c;
  };
}

async function decodePhoto(file: Blob): Promise<Decoded> {
  const bmp = (b: ImageBitmap): Decoded => ({ src: b, w: b.width, h: b.height, close: () => b.close() });
  if (typeof createImageBitmap === "function") {
    try { return bmp(await createImageBitmap(file, { imageOrientation: "from-image" })); } catch {}
    try { return bmp(await createImageBitmap(file)); } catch {}
  }
  try { return await viaImg(file); } catch {}
  if (looksHeic(file)) {
    try {
      ensureOffscreenCanvas(); // heic-to draws on `new OffscreenCanvas(...)`
      const { heicTo } = await import("heic-to/next");
      const jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.92 });
      if (typeof createImageBitmap === "function") {
        try { return bmp(await createImageBitmap(jpeg)); } catch {}
      }
      return await viaImg(jpeg);
    } catch {}
  }
  throw new DecodeError();
}

/**
 * 16 MP phone photo (~6.5 MB) → 2048 px WebP q75 (~600 KB) + 360 px square thumb.
 * Re-encoding drops EXIF/GPS; orientation is applied while decoding.
 */
export async function compressPhoto(file: Blob): Promise<{ main: Encoded; thumb: Encoded; lqip?: string }> {
  const d = await decodePhoto(file);
  try {
    const main = await encodeScaled(d.src, d.w, d.h, MAX_EDGE);
    const { thumb, lqip } = await makeThumbs(d.src, d.w, d.h);
    return { main, thumb, lqip };
  } finally {
    d.close();
  }
}

export { THUMB_EDGE };
