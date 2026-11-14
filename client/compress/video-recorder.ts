"use client";
/**
 * Realtime re-encode with the browser's own (hardware) recorder, for browsers WITHOUT WebCodecs
 * (Firefox Android, old Chromium) when the original is too big to upload as-is.
 *
 *   hidden <video> (muted) ──draw ≤1080p──▶ canvas.captureStream(30)  ┐
 *   video.captureStream() audio track (not affected by `muted`) ─────┴▶ MediaRecorder ~2.5 Mbps
 *
 * Takes 1× the clip length, needs no download (vs. ~25 MB / 10–30× slower for ffmpeg.wasm), and
 * the result is repackaged by Mediabunny (packet copy, no WebCodecs) so it has a proper duration
 * and seek index. Safari has no captureStream on media elements; it only reaches this tier below
 * iOS 16.4, where `recorderSupported()` is false and the original-upload rule applies instead.
 */
export interface RecorderResult { blob: Blob; width: number; height: number; duration: number; mime: string }

type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

// Ordered by how widely the RESULT plays for other guests: H.264 MP4 everywhere; VP8 WebM next
// (Chrome/Firefox/Edge, Safari 14.1+). Never a bare "video/mp4": Chromium may fill it with VP9,
// which iPhones don't play reliably.
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2", // Chrome 126+ with H.264, Safari
  "video/mp4;codecs=avc1.42E01F,opus",
  "video/webm;codecs=vp8,opus",              // Firefox, Chromium without H.264
  "video/webm;codecs=vp9,opus",
  "video/webm",
];

export function recorderMime(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export function recorderSupported(): boolean {
  if (typeof document === "undefined" || !recorderMime()) return false;
  const v = document.createElement("video") as CapturableVideo;
  const c = document.createElement("canvas") as HTMLCanvasElement & { captureStream?: unknown };
  return typeof c.captureStream === "function" && (typeof v.captureStream === "function" || typeof v.mozCaptureStream === "function");
}

export class RecorderAborted extends Error { constructor() { super("recorder_aborted"); } }

export async function recordTranscode(
  file: Blob,
  opts: { maxShortEdge?: number; videoBps?: number; onProgress?: (p: number) => void; signal?: AbortSignal; stallMs?: number } = {},
): Promise<RecorderResult> {
  const { maxShortEdge = 1080, onProgress, signal, stallMs = 30_000 } = opts;
  let videoBps = opts.videoBps ?? 2_500_000;
  const mime = recorderMime();
  if (!mime) throw new Error("recorder_unsupported");

  const url = URL.createObjectURL(file);
  const v = document.createElement("video") as CapturableVideo;
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  // keep it in the DOM but invisible: some engines throttle detached media
  v.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-10px;top:-10px";
  document.body.appendChild(v);

  let recorder: MediaRecorder | null = null;
  let raf = 0;
  const cleanup = () => {
    cancelAnimationFrame(raf);
    try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch {}
    v.pause(); v.removeAttribute("src"); v.load(); v.remove();
    URL.revokeObjectURL(url);
  };

  try {
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error("recorder_cannot_play_source"));
    });
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("recorder_bad_duration");
    // never spend more bits than the source had: re-encoding must not make the file bigger
    const srcBps = (file.size * 8) / duration;
    videoBps = Math.max(400_000, Math.min(videoBps, srcBps * 0.75 - 128_000));
    const sw = v.videoWidth, sh = v.videoHeight;
    const s = Math.min(1, maxShortEdge / Math.min(sw, sh));
    const w = Math.round((sw * s) / 2) * 2, h = Math.round((sh * s) / 2) * 2;

    const canvas = document.createElement("canvas") as HTMLCanvasElement & { captureStream(fps?: number): MediaStream };
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";

    // the element's stream carries the audio regardless of `muted` (Chrome / Firefox)
    const es = (v.captureStream ?? v.mozCaptureStream)!.call(v);
    // audio tracks only exist once playback has produced data: play a moment, rewind, then record
    await v.play();
    await new Promise((r) => setTimeout(r, 120));
    v.pause();
    v.currentTime = 0;
    await new Promise<void>((r) => { v.onseeked = () => r(); setTimeout(r, 1500); });

    const out = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...es.getAudioTracks()]);
    recorder = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: videoBps, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise<void>((r) => { recorder!.onstop = () => r(); });

    const draw = () => { ctx.drawImage(v, 0, 0, w, h); raf = requestAnimationFrame(draw); };
    let lastTick = Date.now();
    v.ontimeupdate = () => { lastTick = Date.now(); onProgress?.(Math.min(0.99, v.currentTime / duration)); };

    const finished = new Promise<void>((res, rej) => {
      v.onended = () => res();
      v.onerror = () => rej(new Error("recorder_playback_error"));
      signal?.addEventListener("abort", () => rej(new RecorderAborted()), { once: true });
      const watchdog = setInterval(() => {
        if (Date.now() - lastTick > stallMs) { clearInterval(watchdog); rej(new Error("stalled_video")); }
      }, 2000);
      v.addEventListener("ended", () => clearInterval(watchdog), { once: true });
    });

    recorder.start(1000);
    draw();
    await v.play();
    await finished;
    ctx.drawImage(v, 0, 0, w, h);
    recorder.stop();
    await stopped;
    cancelAnimationFrame(raf);

    const baseType = mime.startsWith("video/mp4") ? "video/mp4" : "video/webm";
    const raw = new Blob(chunks, { type: baseType });
    onProgress?.(1);
    return { blob: await finalize(raw, baseType), width: w, height: h, duration, mime: baseType };
  } finally {
    cleanup();
  }
}

/**
 * MediaRecorder output (esp. Chrome WebM) has no duration/seek index, so players can't seek it.
 * Repackage once with Mediabunny: a packet copy, pure JS, works without WebCodecs.
 */
async function finalize(raw: Blob, type: "video/mp4" | "video/webm"): Promise<Blob> {
  try {
    const mb = await import("mediabunny");
    const target = new mb.BufferTarget();
    const output = new mb.Output({
      format: type === "video/mp4" ? new mb.Mp4OutputFormat({ fastStart: "in-memory" }) : new mb.WebMOutputFormat(),
      target,
    });
    const conv = await mb.Conversion.init({ input: new mb.Input({ source: new mb.BlobSource(raw), formats: mb.ALL_FORMATS }), output });
    if (!conv.isValid || conv.discardedTracks.length) return raw;
    await conv.execute();
    return target.buffer ? new Blob([target.buffer], { type }) : raw;
  } catch {
    return raw;
  }
}
