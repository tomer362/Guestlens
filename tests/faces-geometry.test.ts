import { describe, expect, it } from "vitest";
import { applySimilarity, ARCFACE_112, estimateSimilarity, invertSimilarity, toSFaceInput, warpRGB } from "@/lib/faces/align";
import { clipToImage, decodeYunet, iou, letterbox, namedOutputs, nms, toYunetInput, type Detection } from "@/lib/faces/yunet";
import { faceQuality, frontalness, sharpness } from "@/lib/faces/quality";

describe("similarity transform", () => {
  it("recovers a known rotation + scale + translation", () => {
    const truth = { a: 1.5 * Math.cos(0.3), b: 1.5 * Math.sin(0.3), tx: 12, ty: -7 };
    const dst = ARCFACE_112.map(([x, y]) => applySimilarity(truth, x, y));
    const m = estimateSimilarity(ARCFACE_112, dst);
    expect(m.a).toBeCloseTo(truth.a, 6);
    expect(m.b).toBeCloseTo(truth.b, 6);
    expect(m.tx).toBeCloseTo(truth.tx, 6);
    expect(m.ty).toBeCloseTo(truth.ty, 6);
  });
  it("inverts", () => {
    const m = { a: 0.8, b: 0.4, tx: 3, ty: 9 };
    const [x, y] = applySimilarity(invertSimilarity(m), ...applySimilarity(m, 17, -4));
    expect(x).toBeCloseTo(17, 9);
    expect(y).toBeCloseTo(-4, 9);
  });
  it("identity warp copies pixels", () => {
    const w = 120, h = 120;
    const src = new Uint8Array(w * h * 3).map((_, i) => (i * 7) % 251);
    const out = warpRGB(src, w, h, { a: 1, b: 0, tx: 0, ty: 0 });
    expect(out[(50 * 112 + 60) * 3 + 1]).toBe(src[(50 * w + 60) * 3 + 1]);
  });
  it("SFace input is planar RGB", () => {
    const rgb = new Uint8Array(112 * 112 * 3);
    rgb[0] = 10; rgb[1] = 20; rgb[2] = 30;
    const t = toSFaceInput(rgb);
    expect([t[0], t[112 * 112], t[2 * 112 * 112]]).toEqual([10, 20, 30]);
  });
});

describe("yunet", () => {
  it("letterboxes to fit", () => {
    expect(letterbox(2048, 1536, 640)).toEqual({ size: 640, scale: 0.3125, w: 640, h: 480 });
  });
  it("packs BGR planes with zero padding", () => {
    const lb = { size: 4, scale: 1, w: 2, h: 1 };
    const t = toYunetInput(Uint8Array.from([1, 2, 3, 4, 5, 6]), lb);
    expect([t[0], t[1], t[16], t[32], t[33], t[2]]).toEqual([3, 6, 2, 1, 4, 0]);
  });
  it("decodes one anchor into source coordinates", () => {
    const size = 64, lb = { size, scale: 0.5, w: 64, h: 64 };
    const out: Record<string, Float32Array> = {};
    for (const s of [8, 16, 32]) {
      const n = (size / s) ** 2;
      out[`cls_${s}`] = new Float32Array(n); out[`obj_${s}`] = new Float32Array(n);
      out[`bbox_${s}`] = new Float32Array(n * 4); out[`kps_${s}`] = new Float32Array(n * 10);
    }
    // stride 16, row 1, col 2 → idx 1*4+2 = 6
    out.cls_16[6] = 0.81; out.obj_16[6] = 1;
    out.bbox_16.set([0.5, 0.5, Math.log(2), Math.log(2)], 24);
    out.kps_16.set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], 60);
    const d = decodeYunet(out, lb, 0.5);
    expect(d).toHaveLength(1);
    expect(d[0].score).toBeCloseTo(0.9, 6);
    // centre (2.5*16, 1.5*16) = (40, 24), size 32 → box (24, 8, 32, 32) at detector scale → ×2
    expect(d[0].box.map((v) => Math.round(v))).toEqual([48, 16, 64, 64]);
    expect(d[0].landmarks[1].map((v) => Math.round(v))).toEqual([(2 + 1) * 16 * 2, (1 + 0) * 16 * 2]);
  });
  it("maps outputs by name, or by OpenCV's order", () => {
    const names = ["cls_8", "cls_16", "cls_32", "obj_8", "obj_16", "obj_32", "bbox_8", "bbox_16", "bbox_32", "kps_8", "kps_16", "kps_32"];
    const data = names.map((_, i) => Float32Array.of(i));
    expect(namedOutputs([...names].reverse(), [...data].reverse()).kps_32[0]).toBe(11);
    expect(namedOutputs(names.map((_, i) => `out${i}`), data).obj_8[0]).toBe(3);
  });
  it("NMS keeps the best of overlapping boxes", () => {
    const mk = (x: number, s: number): Detection => ({ box: [x, 0, 10, 10], score: s, landmarks: [] });
    const kept = nms([mk(0, 0.8), mk(1, 0.9), mk(50, 0.7)]);
    expect(kept.map((d) => d.score)).toEqual([0.9, 0.7]);
    expect(iou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(1 / 3, 6);
  });
  it("clips to the image", () => {
    expect(clipToImage({ box: [-5, -5, 20, 20], score: 1, landmarks: [] }, 10, 10)?.box).toEqual([0, 0, 10, 10]);
    expect(clipToImage({ box: [20, 20, 5, 5], score: 1, landmarks: [] }, 10, 10)).toBeNull();
  });
});

describe("quality", () => {
  const frontal: [number, number][] = [[38, 52], [74, 52], [56, 72], [42, 92], [70, 92]];
  it("frontal faces score 1, turned faces less", () => {
    expect(frontalness(frontal)).toBeCloseTo(1, 1);
    const turned = frontal.map(([x, y], i) => (i === 2 ? [x + 14, y] : [x, y])) as [number, number][];
    expect(frontalness(turned)).toBeLessThan(0.1);
  });
  it("sharp crops have more Laplacian variance than flat ones", () => {
    const flat = new Uint8Array(112 * 112 * 3).fill(128);
    const checker = new Uint8Array(112 * 112 * 3).map((_, i) => ((Math.floor(i / 3) % 2) ^ (Math.floor(i / 336) % 2) ? 255 : 0));
    expect(sharpness(flat)).toBe(0);
    expect(sharpness(checker)).toBeGreaterThan(1000);
  });
  it("combines into 0..1", () => {
    const q = faceQuality({ score: 0.95, box: [0, 0, 150, 150], landmarks: frontal, sharp: 500 });
    expect(q).toBeGreaterThan(0.9);
    expect(faceQuality({ score: 0.95, box: [0, 0, 20, 20], landmarks: frontal, sharp: 5 })).toBeLessThan(0.45);
  });
});
