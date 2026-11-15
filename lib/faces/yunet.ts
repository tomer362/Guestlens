/**
 * YuNet face detector: pre- and post-processing (pure, unit-tested; the ONNX call lives in model.ts).
 *
 * Model: OpenCV Zoo `face_detection_yunet_2023mar.onnx` (MIT). Input 1×3×640×640, BGR, 0–255,
 * no normalisation. Outputs per stride s ∈ {8,16,32}: cls_s [N], obj_s [N], bbox_s [N×4], kps_s [N×10],
 * N = (640/s)². Decoding mirrors OpenCV's FaceDetectorYN (modules/objdetect/src/face_detect.cpp).
 */

export interface Detection {
  /** [x, y, w, h] in source-image pixels */
  box: [number, number, number, number];
  score: number;
  /** right eye, left eye, nose tip, right mouth corner, left mouth corner (the person's right = image left) */
  landmarks: [number, number][];
}

export interface Letterbox { size: number; scale: number; w: number; h: number }

/** Scale that fits a w×h image inside the detector square (top-left aligned, zero padding). */
export function letterbox(w: number, h: number, size: number): Letterbox {
  const scale = Math.min(size / w, size / h);
  return { size, scale, w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * Packed RGB (already resized to lb.w × lb.h) → NCHW BGR float tensor of lb.size², zero-padded.
 */
export function toYunetInput(rgb: Uint8Array | Buffer, lb: Letterbox): Float32Array {
  const { size, w, h } = lb;
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = y * size + x;
      out[d] = rgb[s + 2]; // B
      out[plane + d] = rgb[s + 1]; // G
      out[2 * plane + d] = rgb[s]; // R
    }
  }
  return out;
}

export const YUNET_STRIDES = [8, 16, 32] as const;
const OUTPUT_ORDER = ["cls_8", "cls_16", "cls_32", "obj_8", "obj_16", "obj_32", "bbox_8", "bbox_16", "bbox_32", "kps_8", "kps_16", "kps_32"];

/** Map ONNX outputs by name, falling back to OpenCV's documented output order. */
export function namedOutputs(names: readonly string[], data: Float32Array[]): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  const byName = OUTPUT_ORDER.every((n) => names.includes(n));
  OUTPUT_ORDER.forEach((n, i) => { out[n] = byName ? data[names.indexOf(n)] : data[i]; });
  for (const n of OUTPUT_ORDER) if (!out[n]) throw new Error(`yunet_output_missing_${n}`);
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Decode raw outputs into detections in source-image coordinates (before NMS). */
export function decodeYunet(out: Record<string, Float32Array>, lb: Letterbox, minScore: number): Detection[] {
  const dets: Detection[] = [];
  for (const s of YUNET_STRIDES) {
    const cols = Math.floor(lb.size / s), rows = Math.floor(lb.size / s);
    const cls = out[`cls_${s}`], obj = out[`obj_${s}`], bbox = out[`bbox_${s}`], kps = out[`kps_${s}`];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (score < minScore) continue;
        const cx = (c + bbox[i * 4]) * s, cy = (r + bbox[i * 4 + 1]) * s;
        const w = Math.exp(bbox[i * 4 + 2]) * s, h = Math.exp(bbox[i * 4 + 3]) * s;
        const k = 1 / lb.scale;
        const landmarks: [number, number][] = [];
        for (let n = 0; n < 5; n++) landmarks.push([(kps[i * 10 + 2 * n] + c) * s * k, (kps[i * 10 + 2 * n + 1] + r) * s * k]);
        dets.push({ box: [(cx - w / 2) * k, (cy - h / 2) * k, w * k, h * k], score, landmarks });
      }
    }
  }
  return dets;
}

export function iou(a: Detection["box"], b: Detection["box"]): number {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a[2] * a[3] + b[2] * b[3] - inter;
  return u > 0 ? inter / u : 0;
}

/** Greedy non-maximum suppression (OpenCV uses IoU 0.3). */
export function nms(dets: Detection[], threshold = 0.3, topK = 200): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  for (const d of sorted) {
    if (keep.length >= topK) break;
    if (keep.every((k) => iou(k.box, d.box) <= threshold)) keep.push(d);
  }
  return keep;
}

/** Clip a detection to the image; drops it if it ends up (nearly) empty. */
export function clipToImage(d: Detection, w: number, h: number): Detection | null {
  const x1 = Math.max(0, d.box[0]), y1 = Math.max(0, d.box[1]);
  const x2 = Math.min(w, d.box[0] + d.box[2]), y2 = Math.min(h, d.box[1] + d.box[3]);
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  return { ...d, box: [x1, y1, x2 - x1, y2 - y1] };
}
