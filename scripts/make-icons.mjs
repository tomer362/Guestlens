// Renders scripts/icon.svg to the PNG icons the manifest needs (uses the pre-installed Playwright Chromium).
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { readFileSync } from "node:fs";
const svg = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");
const out = [
  ["public/icons/icon-192.png", 192, 0.22], ["public/icons/icon-512.png", 512, 0.22],
  ["public/icons/apple-touch-icon.png", 180, 0], ["public/icons/maskable-512.png", 512, 0],
];
const b = await chromium.launch();
const p = await b.newPage();
for (const [file, size, radius] of out) {
  await p.setViewportSize({ width: size, height: size });
  const inner = file.includes("maskable") ? svg.replace('transform="translate(256 262)"', 'transform="translate(256 262) scale(0.8)"') : svg;
  await p.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;border-radius:${radius * size}px;overflow:hidden">${inner.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div></body></html>`);
  await p.screenshot({ path: file, omitBackground: true });
}
await b.close();
console.log("icons written");
