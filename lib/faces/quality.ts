/**
 * How useful a face is for grouping (pure, unit-tested). Only good faces may start a new person;
 * blurry, tiny or side-on faces can still join one. The best face becomes the person's cover.
 */
import { ALIGN_EDGE } from "./align";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Variance of the Laplacian on the aligned crop's luma: the classic focus measure. */
export function sharpness(alignedRGB: Uint8Array, edge = ALIGN_EDGE): number {
  const g = new Float32Array(edge * edge);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * alignedRGB[i * 3] + 0.587 * alignedRGB[i * 3 + 1] + 0.114 * alignedRGB[i * 3 + 2];
  let sum = 0, sum2 = 0, n = 0;
  // inner region only: alignment leaves black borders on tilted faces
  for (let y = 8; y < edge - 8; y++) {
    for (let x = 8; x < edge - 8; x++) {
      const i = y * edge + x;
      const l = g[i - 1] + g[i + 1] + g[i - edge] + g[i + edge] - 4 * g[i];
      sum += l; sum2 += l * l; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/**
 * 1 = looking at the camera, 0 = turned well away. Uses how far the nose sits from the eyes'
 * midpoint along the eye line, relative to eye distance (a cheap yaw estimate).
 */
export function frontalness(lm: [number, number][]): number {
  const [re, le, nose] = lm;
  const ex = le[0] - re[0], ey = le[1] - re[1];
  const d = Math.hypot(ex, ey);
  if (d < 1e-6) return 0;
  const mx = (re[0] + le[0]) / 2, my = (re[1] + le[1]) / 2;
  const offset = ((nose[0] - mx) * ex + (nose[1] - my) * ey) / (d * d);
  return clamp01(1 - Math.abs(offset) * 2.5);
}

export interface QualityInput { score: number; box: [number, number, number, number]; landmarks: [number, number][]; sharp: number }

/** 0..1: detector confidence × size × frontal × focus, each softened so no single term zeroes it. */
export function faceQuality({ score, box, landmarks, sharp }: QualityInput): number {
  const side = Math.min(box[2], box[3]);
  const size = clamp01((side - 24) / (112 - 24));
  const front = frontalness(landmarks);
  const focus = clamp01(sharp / 120);
  return clamp01(score) * (0.4 + 0.6 * size) * (0.3 + 0.7 * front) * (0.3 + 0.7 * focus);
}
