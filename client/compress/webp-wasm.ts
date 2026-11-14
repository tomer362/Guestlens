"use client";
/**
 * WASM WebP for browsers whose canvas can't produce WebP (Safari / every iOS browser).
 * Benchmarked: same files as Chrome's native WebP, ~60% smaller than the canvas JPEG those
 * browsers fall back to; ~370 ms per 2048 px photo on a desktop core. A one-off micro-benchmark
 * per device keeps slow phones on the (fast, bigger) canvas JPEG.
 */
import type { WebpIn, WebpOut } from "./webp-wasm.worker";

const DECISION_KEY = "gl_photo_enc_v1";
/** 512×384 (0.2 MP) test encode; ×16 ≈ a 2048×1536 photo. Over this → too slow for this device. */
const MAX_SMALL_MS = 110;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (o: WebpOut) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./webp-wasm.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WebpOut>) => { pending.get(e.data.id)?.(e.data); pending.delete(e.data.id); };
    worker.onerror = () => { for (const r of pending.values()) r({ id: -1, error: "worker_error" }); pending.clear(); worker?.terminate(); worker = null; };
  }
  return worker;
}

export async function encodeWebpWasm(img: ImageData, quality = 75, timeoutMs = 20_000): Promise<{ blob: Blob; ms: number }> {
  const w = getWorker();
  const id = ++seq;
  const buf = img.data.buffer.slice(0) as ArrayBuffer;
  const out = await new Promise<WebpOut>((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ id, error: "timeout" }); }, timeoutMs);
    pending.set(id, (o) => { clearTimeout(t); resolve(o); });
    w.postMessage({ id, buf, w: img.width, h: img.height, quality } satisfies WebpIn, [buf]);
  });
  if (!out.buf) throw new Error(`webp_wasm_${out.error}`);
  return { blob: new Blob([out.buf], { type: "image/webp" }), ms: out.ms ?? 0 };
}

let decision: Promise<boolean> | null = null;
/** Should this device encode photos with WASM WebP? Measured once, remembered. */
export function shouldUseWasmWebp(): Promise<boolean> {
  return (decision ??= (async () => {
    try {
      const cached = localStorage.getItem(DECISION_KEY);
      if (cached === "1" || cached === "0") return cached === "1";
    } catch {}
    let ok = false;
    try {
      if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") throw new Error("no wasm/worker");
      const c = document.createElement("canvas"); c.width = 512; c.height = 384;
      const ctx = c.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, 512, 384); g.addColorStop(0, "#c97"); g.addColorStop(1, "#579");
      ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 384);
      for (let i = 0; i < 300; i++) { ctx.fillStyle = `hsl(${i * 37} 60% ${30 + (i % 50)}%)`; ctx.fillRect((i * 97) % 512, (i * 53) % 384, 18, 18); }
      const img = ctx.getImageData(0, 0, 512, 384);
      await encodeWebpWasm(img, 75, 8000);              // warm-up (module download + init)
      const { ms } = await encodeWebpWasm(img, 75, 8000);
      ok = ms <= MAX_SMALL_MS;
    } catch {
      ok = false;
    }
    try { localStorage.setItem(DECISION_KEY, ok ? "1" : "0"); } catch {}
    return ok;
  })());
}
