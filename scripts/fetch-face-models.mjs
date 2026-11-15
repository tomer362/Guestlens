#!/usr/bin/env node
/**
 * Download the two face models into lib/faces/models/ (FACES.md §2). Commit them afterwards so
 * every deploy has them. Prints each file's SHA-256 so you can record it.
 *
 *   npm run faces:models
 *
 * YuNet (MIT) and SFace (Apache-2.0) from the OpenCV Zoo. Tries Hugging Face, then GitHub (LFS).
 */
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), "lib", "faces", "models");
const MODELS = [
  {
    file: "face_detection_yunet_2023mar.onnx",
    urls: [
      "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
      "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    ],
    minBytes: 100_000,
  },
  {
    file: "face_recognition_sface_2021dec.onnx",
    urls: [
      "https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx",
      "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    ],
    minBytes: 10_000_000,
  },
];

await mkdir(DIR, { recursive: true });
for (const m of MODELS) {
  const dest = path.join(DIR, m.file);
  const have = await stat(dest).catch(() => null);
  if (have && have.size >= m.minBytes) { console.log(`✓ ${m.file} already present (${have.size} bytes)`); continue; }
  let ok = false;
  for (const url of m.urls) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // a Git LFS pointer is a tiny text file: reject it
      if (buf.length < m.minBytes) throw new Error(`only ${buf.length} bytes (LFS pointer?)`);
      await writeFile(dest, buf);
      console.log(`✓ ${m.file} ${buf.length} bytes sha256=${createHash("sha256").update(buf).digest("hex")}\n  from ${url}`);
      ok = true;
      break;
    } catch (e) {
      console.warn(`  ${url}: ${e.message}`);
    }
  }
  if (!ok) { console.error(`✗ could not download ${m.file}`); process.exitCode = 1; }
}
