/// <reference lib="webworker" />
// WebP encoding in WASM (Squoosh's libwebp via jSquash) for browsers whose canvas can't encode
// WebP (Safari/iOS). Runs off the main thread; the module (~300 KB) loads on first use only.
import encode from "@jsquash/webp/encode";

export type WebpIn = { id: number; buf: ArrayBuffer; w: number; h: number; quality: number };
export type WebpOut = { id: number; buf?: ArrayBuffer; ms?: number; error?: string };

self.onmessage = async (e: MessageEvent<WebpIn>) => {
  const { id, buf, w, h, quality } = e.data;
  try {
    const t0 = performance.now();
    const out = await encode(new ImageData(new Uint8ClampedArray(buf), w, h), { quality, method: 4 });
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, buf: out, ms: performance.now() - t0 } satisfies WebpOut, [out]);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: String((err as Error)?.message ?? err) } satisfies WebpOut);
  }
};
