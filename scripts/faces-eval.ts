/**
 * Tune face grouping on real photos, offline (no database, no Blob):
 *
 *   npm run faces:eval -- <folder of .jpg/.webp> [assignSim=0.4] [minFaces=1]
 *
 * Runs the same pipeline as the server (lib/faces/pipeline.ts) on every image, groups the faces
 * with the same regroup() the server uses, and writes faces-eval.html: one row of face crops per
 * person, then the unassigned faces. Needs the models (npm run faces:models) and an ONNX runtime.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { analyzeImage, type FoundFace } from "@/lib/faces/pipeline";
import { regroup, type RFace } from "@/lib/faces/cluster";
import { FACES } from "@/lib/config";

// tsx runs .ts files as CommonJS here, which has no top-level await
async function main() {
  const [dir, simArg, minArg] = process.argv.slice(2);
  if (!dir) { console.error("usage: npm run faces:eval -- <folder> [assignSim] [minFaces]"); process.exit(1); }
  const assignSim = Number(simArg) || FACES.assignSim;
  const minFaces = Number(minArg) || FACES.minFaces;

  const files = (await readdir(dir)).filter((f) => /\.(jpe?g|webp|png)$/i.test(f)).sort();
  const all: (FoundFace & { id: string; file: string })[] = [];
  const t0 = Date.now();
  for (const f of files) {
    // like the phone: 2048 px on the long edge, WebP
    const img = await sharp(await readFile(path.join(dir, f))).rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    const t = Date.now();
    const faces = await analyzeImage(img);
    console.log(`${f}: ${faces.length} faces, ${Date.now() - t} ms`);
    faces.forEach((x, i) => all.push({ ...x, id: `${f}#${i}`, file: f }));
  }
  console.log(`${files.length} images, ${all.length} faces, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const rfaces: RFace[] = all.map((x) => ({ id: x.id, vec: x.embedding, quality: x.quality, personId: null, locked: false, mediaId: x.file }));
  const out = regroup(rfaces, new Map(), { assignSim, minFaces, seedQuality: FACES.seedQuality, neighbours: FACES.neighbours });
  const groups = new Map<string, typeof all>();
  for (const x of all) {
    const g = out.get(x.id) ?? "unassigned";
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(x);
  }
  const sorted = [...groups].sort((a, b) => (a[0] === "unassigned" ? 1 : b[0] === "unassigned" ? -1 : b[1].length - a[1].length));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>faces-eval</title>
  <style>body{font:14px system-ui;margin:16px}h2{font-size:15px;margin:18px 0 6px}img{width:72px;height:72px;border-radius:50%;margin:2px;object-fit:cover}img.low{opacity:.45}</style>
  <p>${files.length} images · ${all.length} faces · assignSim ${assignSim} · minFaces ${minFaces} · ${groups.size - (groups.has("unassigned") ? 1 : 0)} people</p>
  ${sorted.map(([g, xs]) => `<h2>${g === "unassigned" ? "Unassigned" : "Person"} · ${xs.length}</h2>${xs.map((x) =>
    `<img src="${x.crop}" class="${x.quality < FACES.seedQuality ? "low" : ""}" title="${esc(x.file)} q=${x.quality.toFixed(2)} s=${x.score.toFixed(2)}">`).join("")}`).join("\n")}`;
  await writeFile("faces-eval.html", html);
  console.log("wrote faces-eval.html");
}
main().catch((e) => { console.error(e); process.exit(1); });
