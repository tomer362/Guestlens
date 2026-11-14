import { makeThumbs, THUMB_EDGE, type Encoded } from "./photo";
import { diag as report } from "@/client/diag";
import { prepareVideo, VideoError, type VideoResult } from "./video-core";
import type { WorkerOut } from "./video.worker";

export { VideoError, canTranscode } from "./video-core";
export type { VideoPath } from "./video-core";

/** Grab a poster frame at ~1 s with a <video> element (works without WebCodecs). */
export async function posterFrame(file: Blob): Promise<{ thumb: Encoded; lqip?: string; duration: number; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new VideoError("unsupported"));
    });
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    // iOS paints nothing until the video has actually played: play muted briefly, then seek.
    await v.play().catch(() => {});
    v.pause();
    const seekTo = async (t: number) => {
      v.currentTime = t;
      await new Promise<void>((res) => {
        const done = () => res();
        const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void }).requestVideoFrameCallback;
        if (rvfc) rvfc.call(v, done); else v.onseeked = done;
        setTimeout(done, 2000);
      });
    };
    let chosen = false;
    for (const t of POSTER_TRIES.filter((x) => x < Math.max(0.05, duration - 0.05))) {
      await seekTo(t);
      if (frameScore(v, v.videoWidth, v.videoHeight).ok) { chosen = true; break; }
    }
    if (!chosen) await seekTo(Math.min(1, duration / 2));
    const { thumb, lqip } = await makeThumbs(v, v.videoWidth, v.videoHeight);
    return { thumb, lqip, duration, width: v.videoWidth, height: v.videoHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Is this frame worth showing? Rejects black/fade-in frames, blown-out white frames and flat
 * (motion-blurred / out-of-focus) frames by sampling luma on a 24×24 downscale.
 */
function frameScore(src: CanvasImageSource, w: number, h: number): { ok: boolean; score: number } {
  const c = document.createElement("canvas"); c.width = c.height = 24;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h, 0, 0, 24, 24);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  let sum = 0, sq = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    sum += y; sq += y * y;
  }
  const mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
  return { ok: mean > 28 && mean < 235 && std > 14, score: std - Math.abs(mean - 128) * 0.15 };
}

/** Timestamps (s from the first frame) we try, in order, for the poster. */
const POSTER_TRIES = [0, 0.3, 0.7, 1.2, 2, 3.5];

/**
 * Poster frame decoded with Mediabunny (reliable on iOS, unlike drawing a <video>):
 * the first "legit" frame among a few early timestamps, or the best-scoring one.
 */
export async function posterFromVideo(blob: Blob): Promise<{ thumb: Encoded; lqip?: string; duration: number; width: number; height: number } | null> {
  try {
    const mb = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const dur = await input.computeDuration();
    const dw = track.displayWidth, dh = track.displayHeight;
    // decode straight at thumbnail size: short edge = THUMB_EDGE (only ONE dimension, so the aspect is kept)
    const sink = new mb.CanvasSink(track, dw >= dh
      ? { height: Math.min(dh, THUMB_EDGE) }
      : { width: Math.min(dw, THUMB_EDGE) });
    const first = await track.getFirstTimestamp();
    const times = POSTER_TRIES.filter((t) => t < Math.max(0.05, dur - 0.05)).map((t) => first + t);
    let best: { c: HTMLCanvasElement | OffscreenCanvas; score: number } | null = null;
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (!frame) continue;
      const c = frame.canvas;
      const { ok, score } = frameScore(c, c.width, c.height);
      if (ok) { best = { c, score }; break; }
      if (!best || score > best.score) {
        // keep a copy: the sink may reuse its canvases
        const copy = document.createElement("canvas"); copy.width = c.width; copy.height = c.height;
        copy.getContext("2d")!.drawImage(c, 0, 0);
        best = { c: copy, score };
      }
    }
    if (!best) return null;
    const { thumb, lqip } = await makeThumbs(best.c, best.c.width, best.c.height);
    return { thumb, lqip, duration: dur, width: dw, height: dh };
  } catch (e) {
    report(`poster mediabunny failed: ${String(e).slice(0, 160)}`);
    return null;
  }
}

/** @deprecated kept for callers; use posterFromVideo */
export async function posterFromMp4(blob: Blob) {
  const r = await posterFromVideo(blob);
  return r ? { thumb: r.thumb, lqip: r.lqip } : null;
}

/**
 * Prepare a video for upload in a dedicated Web Worker (falls back to the main thread).
 * See video-core.ts for the original / remux / transcode decision.
 */
/** Thrown when preparation was stopped because the app went to the background; the item simply resumes later. */
export class PausedError extends Error { constructor() { super("paused"); } }

/** No message at all from the conversion worker for this long → it's stuck (or was killed). */
const STALL_MS = 90_000;

export function compressVideo(
  file: Blob, onProgress?: (p: number) => void, onInfo?: (s: string) => void, signal?: AbortSignal,
  forceOriginal = false,
): Promise<VideoResult> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./video.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (!worker) return prepareVideo(file, { progress: onProgress, info: onInfo, report, forceOriginal });
  const w = worker;
  return new Promise<VideoResult>((resolve, reject) => {
    let last = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - last < STALL_MS) return;
      clearInterval(watchdog);
      w.terminate();
      report(`video stalled: no worker message for ${STALL_MS / 1000}s`);
      reject(new Error("stalled_video"));
    }, 5_000);
    const settle = <T,>(fn: (v: T) => void) => (v: T) => { clearInterval(watchdog); fn(v); };
    resolve = settle(resolve); reject = settle(reject);
    const abort = () => { w.terminate(); report("video paused (app in background)"); reject(new PausedError()); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      last = Date.now();
      const m = e.data;
      if (m.type === "progress") onProgress?.(m.p);
      else if (m.type === "info") onInfo?.(m.s);
      else if (m.type === "report") report(m.s);
      else if (m.type === "done") { w.terminate(); resolve(m.result); }
      else { w.terminate(); reject(m.code ? new VideoError(m.code as VideoError["code"]) : new Error(m.message)); }
    };
    w.onerror = (ev) => {
      // worker failed to load (old browser / CSP): run on the main thread instead
      w.terminate();
      report(`video worker error ${ev.message ?? ""} → main thread`);
      const alive = () => { last = Date.now(); };
      prepareVideo(file, {
        progress: (p) => { alive(); onProgress?.(p); }, info: (s) => { alive(); onInfo?.(s); },
        report: (s) => { alive(); report(s); }, forceOriginal,
      }).then(resolve, reject);
    };
    w.postMessage({ file, forceOriginal });
  });
}
