/**
 * One image in → faces out: decode (sharp), detect (YuNet), align, embed (SFace), score, crop.
 * Server-only. The image is the 2048 px WebP/JPEG the phone already uploaded (or a video's poster).
 */
import sharp from "sharp";
import { FACES } from "@/lib/config";
import { alignFace, toSFaceInput } from "./align";
import { runDetector, runEmbedder } from "./model";
import { faceQuality, sharpness } from "./quality";
import { l2normalize } from "./vec";
import { clipToImage, decodeYunet, letterbox, namedOutputs, nms, offsetDetection, tileRects, toYunetInput, type Detection, type Rect } from "./yunet";

export interface FoundFace {
  box: [number, number, number, number];
  score: number;
  quality: number;
  embedding: Float32Array;
  /** small WebP data URL for the People page */
  crop: string;
}

/** Biggest image we'll decode (2048×2048 is 4.2 MP); anything larger is not ours. */
const MAX_PIXELS = 3000 * 3000;
const MAX_FACES_PER_IMAGE = 40;

export async function analyzeImage(bytes: Buffer): Promise<FoundFace[]> {
  const { data: rgb, info } = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" })
    .rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  if (info.channels !== 3) throw new Error(`unexpected_channels_${info.channels}`);

  const dets = nms(await detectAll(rgb, W, H))
    .map((d) => clipToImage(d, W, H))
    .filter((d): d is Detection => !!d && Math.min(d.box[2], d.box[3]) >= FACES.minFacePx)
    .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])
    .slice(0, MAX_FACES_PER_IMAGE);

  const faces: FoundFace[] = [];
  for (const d of dets) {
    const aligned = alignFace(rgb, W, H, d.landmarks);
    const embedding = l2normalize(await runEmbedder(toSFaceInput(aligned)));
    const quality = faceQuality({ score: d.score, box: d.box, landmarks: d.landmarks, sharp: sharpness(aligned) });
    faces.push({ box: d.box, score: d.score, quality, embedding, crop: await cropDataUrl(rgb, W, H, d.box) });
  }
  return faces;
}

/**
 * YuNet on the whole image (big faces) and on overlapping tiles (small faces in group shots),
 * all in full-image coordinates, before NMS.
 */
async function detectAll(rgb: Buffer, W: number, H: number): Promise<Detection[]> {
  const all = await detectIn(rgb, W, H, { x: 0, y: 0, w: W, h: H });
  for (const t of tileRects(W, H, FACES.tiles, FACES.detectSize)) {
    for (const d of await detectIn(rgb, W, H, t)) {
      // a face cut by an inner tile edge is a partial box; the neighbouring tile (or the whole pass) has it whole
      const [x, y, w, h] = d.box;
      const cut = (t.x > 0 && x <= t.x + EDGE) || (t.y > 0 && y <= t.y + EDGE)
        || (t.x + t.w < W && x + w >= t.x + t.w - EDGE) || (t.y + t.h < H && y + h >= t.y + t.h - EDGE);
      if (!cut) all.push(d);
    }
  }
  return all;
}

const EDGE = 2;

async function detectIn(rgb: Buffer, W: number, H: number, r: Rect): Promise<Detection[]> {
  const lb = letterbox(r.w, r.h, FACES.detectSize);
  let img = sharp(rgb, { raw: { width: W, height: H, channels: 3 } });
  if (r.w !== W || r.h !== H) img = img.extract({ left: r.x, top: r.y, width: r.w, height: r.h });
  const small = await img.resize(lb.w, lb.h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
  const out = await runDetector(toYunetInput(small, lb), lb.size);
  const dets = decodeYunet(namedOutputs(out.names, out.data), lb, FACES.minScore);
  return r.x || r.y ? dets.map((d) => offsetDetection(d, r.x, r.y)) : dets;
}

/** Square crop around the face with some margin (hair, chin), as a small WebP data URL. */
async function cropDataUrl(rgb: Buffer, W: number, H: number, box: FoundFace["box"]): Promise<string> {
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  const side = Math.min(W, H, Math.round(Math.max(box[2], box[3]) * 1.6));
  const left = Math.round(Math.min(Math.max(0, cx - side / 2), W - side));
  const top = Math.round(Math.min(Math.max(0, cy - side / 2), H - side));
  const webp = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left, top, width: side, height: side })
    .resize(FACES.cropEdge, FACES.cropEdge).webp({ quality: 70 }).toBuffer();
  return `data:image/webp;base64,${webp.toString("base64")}`;
}
