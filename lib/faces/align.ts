/**
 * Face alignment for the embedder (pure, unit-tested).
 * Five landmarks → least-squares similarity transform onto the standard 112×112 ArcFace template
 * (what OpenCV's FaceRecognizerSF.alignCrop does), then a bilinear warp of the RGB source.
 */

export const ALIGN_EDGE = 112;
/** right eye, left eye, nose, right mouth, left mouth (same order as YuNet landmarks) */
export const ARCFACE_112: [number, number][] = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041],
];

/** x' = a·x − b·y + tx,  y' = b·x + a·y + ty */
export interface Similarity { a: number; b: number; tx: number; ty: number }

/** Least-squares similarity (rotation + uniform scale + translation, no reflection) mapping src → dst. */
export function estimateSimilarity(src: [number, number][], dst: [number, number][]): Similarity {
  const n = src.length;
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) { msx += src[i][0]; msy += src[i][1]; mdx += dst[i][0]; mdy += dst[i][1]; }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - msx, sy = src[i][1] - msy;
    const dx = dst[i][0] - mdx, dy = dst[i][1] - mdy;
    num1 += sx * dx + sy * dy;
    num2 += sx * dy - sy * dx;
    den += sx * sx + sy * sy;
  }
  if (den === 0) return { a: 1, b: 0, tx: mdx - msx, ty: mdy - msy };
  const a = num1 / den, b = num2 / den;
  return { a, b, tx: mdx - (a * msx - b * msy), ty: mdy - (b * msx + a * msy) };
}

export function invertSimilarity(m: Similarity): Similarity {
  const s2 = m.a * m.a + m.b * m.b;
  const a = m.a / s2, b = -m.b / s2;
  return { a, b, tx: -(a * m.tx - b * m.ty), ty: -(b * m.tx + a * m.ty) };
}

export const applySimilarity = (m: Similarity, x: number, y: number): [number, number] => [m.a * x - m.b * y + m.tx, m.b * x + m.a * y + m.ty];

/**
 * Warp a packed RGB image with `m` (source → output coordinates) into an edge×edge RGB crop.
 * Pixels that fall outside the source are black, like cv::warpAffine's default border.
 */
export function warpRGB(src: Uint8Array | Buffer, w: number, h: number, m: Similarity, edge = ALIGN_EDGE): Uint8Array {
  const inv = invertSimilarity(m);
  const out = new Uint8Array(edge * edge * 3);
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const [sx, sy] = applySimilarity(inv, x, y);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * w + x0) * 3, i10 = i00 + 3, i01 = i00 + w * 3, i11 = i01 + 3;
      const o = (y * edge + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return out;
}

/** Align one face from its landmarks. */
export function alignFace(src: Uint8Array | Buffer, w: number, h: number, landmarks: [number, number][]): Uint8Array {
  return warpRGB(src, w, h, estimateSimilarity(landmarks, ARCFACE_112));
}

/** Aligned RGB crop → SFace input (1×3×112×112, RGB, 0–255, no normalisation; OpenCV swaps BGR→RGB). */
export function toSFaceInput(rgb: Uint8Array): Float32Array {
  const plane = ALIGN_EDGE * ALIGN_EDGE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = rgb[i * 3];
    out[plane + i] = rgb[i * 3 + 1];
    out[2 * plane + i] = rgb[i * 3 + 2];
  }
  return out;
}
