/**
 * Ultra-small placeholders: a 4×3 (or 3×4) grid of RGB colors, e.g. "4x3:<48 base64 chars>".
 * ~52 characters per item instead of ~800 for a tiny WebP (whose header alone is ~750).
 * The browser turns it back into a 4×3 BMP data URL and shows it blurred: no request.
 */
export const LQIP_RE = /^([1-8])x([1-8]):([A-Za-z0-9+/]+={0,2})$/;

export function encodeLqipPixels(rgba: Uint8ClampedArray, w: number, h: number): string {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++) { rgb[j++] = rgba[i * 4]; rgb[j++] = rgba[i * 4 + 1]; rgb[j++] = rgba[i * 4 + 2]; }
  let s = "";
  for (const b of rgb) s += String.fromCharCode(b);
  return `${w}x${h}:${btoa(s)}`;
}

const cache = new Map<string, string>();

/** "4x3:…" → data:image/bmp URL (24-bit, bottom-up rows). Memoized. */
export function lqipToDataUrl(p: string): string | undefined {
  const hit = cache.get(p);
  if (hit) return hit;
  const m = LQIP_RE.exec(p);
  if (!m) return undefined;
  const w = +m[1], h = +m[2];
  const rgb = atob(m[3]);
  if (rgb.length !== w * h * 3) return undefined;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowSize * h;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4d; dv.setUint32(2, size, true); dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, 24, true); dv.setUint32(34, rowSize * h, true);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 3;
      b[row + x * 3] = rgb.charCodeAt(k + 2); b[row + x * 3 + 1] = rgb.charCodeAt(k + 1); b[row + x * 3 + 2] = rgb.charCodeAt(k);
    }
  }
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  const url = `data:image/bmp;base64,${btoa(s)}`;
  cache.set(p, url);
  return url;
}
