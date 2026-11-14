"use client";
/**
 * One-line summary of what this device can do for media, logged once per session so real-world
 * coverage is visible in /api/diag?all=1 (e.g. "caps wc-avc=1 rec=webm canvas-webp=0 wasm-webp=1").
 */
import { diag } from "@/client/diag";

export async function reportCapabilities() {
  try {
    if (sessionStorage.getItem("gl_caps")) return;
    sessionStorage.setItem("gl_caps", "1");
  } catch {}
  const [{ canTranscode }, { recorderMime }] = await Promise.all([import("./video-core"), import("./video-recorder")]);
  const wcAvc = await canTranscode().catch(() => false);
  const canvasWebp = await new Promise<boolean>((r) => {
    try { const c = document.createElement("canvas"); c.width = c.height = 2; c.toBlob((b) => r(b?.type === "image/webp"), "image/webp", 0.5); }
    catch { r(false); }
  });
  let wasmWebp = "-";
  if (!canvasWebp) {
    const { shouldUseWasmWebp } = await import("./webp-wasm");
    wasmWebp = (await shouldUseWasmWebp().catch(() => false)) ? "1" : "0";
  }
  const n = navigator as Navigator & { deviceMemory?: number };
  diag(`caps wc-avc=${wcAvc ? 1 : 0} rec=${recorderMime()?.split(";")[0].split("/")[1] ?? "none"} canvas-webp=${canvasWebp ? 1 : 0} wasm-webp=${wasmWebp} `
    + `wasm=${typeof WebAssembly !== "undefined" ? 1 : 0} cores=${n.hardwareConcurrency ?? "?"} mem=${n.deviceMemory ?? "?"} ua=${navigator.userAgent.slice(0, 110)}`);
}
