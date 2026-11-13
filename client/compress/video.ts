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
    v.currentTime = Math.min(1, (duration || 2) / 2);
    await new Promise<void>((res) => {
      const done = () => res();
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void }).requestVideoFrameCallback;
      if (rvfc) rvfc.call(v, done); else v.onseeked = done;
      setTimeout(done, 3000);
    });
    const { thumb, lqip } = await makeThumbs(v, v.videoWidth, v.videoHeight);
    return { thumb, lqip, duration, width: v.videoWidth, height: v.videoHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Poster frame decoded by Mediabunny (reliable on iOS, unlike drawing a <video>). */
export async function posterFromMp4(blob: Blob): Promise<{ thumb: Encoded; lqip?: string } | null> {
  try {
    const mb = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const dur = await input.computeDuration();
    const landscape = track.displayWidth >= track.displayHeight;
    const scale = THUMB_EDGE / Math.min(track.displayWidth, track.displayHeight);
    const sink = new mb.CanvasSink(track, landscape
      ? { height: Math.min(track.displayHeight, THUMB_EDGE), width: Math.round(track.displayWidth * Math.min(1, scale)) }
      : { width: Math.min(track.displayWidth, THUMB_EDGE), height: Math.round(track.displayHeight * Math.min(1, scale)) });
    const first = await track.getFirstTimestamp();
    const frame = await sink.getCanvas(first + Math.min(1, dur / 2));
    if (!frame) return null;
    const c = frame.canvas;
    return await makeThumbs(c, c.width, c.height);
  } catch {
    return null;
  }
}

/**
 * Prepare a video for upload in a dedicated Web Worker (falls back to the main thread).
 * See video-core.ts for the original / remux / transcode decision.
 */
/** Thrown when preparation was stopped because the app went to the background; the item simply resumes later. */
export class PausedError extends Error { constructor() { super("paused"); } }

export function compressVideo(
  file: Blob, onProgress?: (p: number) => void, onInfo?: (s: string) => void, signal?: AbortSignal,
): Promise<VideoResult> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./video.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (!worker) return prepareVideo(file, { progress: onProgress, info: onInfo, report });
  const w = worker;
  return new Promise<VideoResult>((resolve, reject) => {
    const abort = () => { w.terminate(); report("video paused (app in background)"); reject(new PausedError()); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
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
      prepareVideo(file, { progress: onProgress, info: onInfo, report }).then(resolve, reject);
    };
    w.postMessage({ file });
  });
}
