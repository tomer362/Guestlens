import { LIMITS } from "@/lib/config";
import { makeThumbs, THUMB_EDGE, type Encoded } from "./photo";

export class VideoError extends Error {
  constructor(public code: "tooBig" | "tooLong" | "unsupported") { super(code); }
}

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

export async function canTranscode(): Promise<boolean> {
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") return false;
  const { canEncodeVideo } = await import("mediabunny");
  return canEncodeVideo("avc", { width: 1920, height: 1080, bitrate: 2_500_000 }).catch(() => false);
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

/** Above this the clip is worth re-encoding; below it we keep the original stream untouched. */
const KEEP_BITRATE = 5_000_000;
const TARGET_BITRATE = 2_500_000;

export type VideoPath = "original" | "remux" | "transcode";

/**
 * Make the video upload-ready as cheaply as possible, without losing quality:
 *  1. "original"  H.264 MP4, ≤1080p, ≤5 Mbps: upload the file as-is (instant).
 *  2. "remux"     same stream in a .mov/other container: copy packets into MP4 (seconds, lossless).
 *  3. "transcode" HEVC / 4K / high bitrate: re-encode video to H.264 ≤1080p ~2.5 Mbps with
 *                 hardware acceleration. Audio is always copied, never re-encoded.
 * Mediabunny is loaded lazily, so photo-only guests never download it.
 */
export async function compressVideo(
  file: Blob, onProgress?: (p: number) => void,
): Promise<{ blob: Blob; width?: number; height?: number; duration?: number; path: VideoPath }> {
  if (!(await canTranscode())) {
    if (file.type === "video/mp4" && file.size <= LIMITS.rawVideoMaxBytes) return { blob: file, path: "original" };
    throw new VideoError("tooBig");
  }
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const duration = await input.computeDuration();
  if (duration > LIMITS.maxVideoSeconds + 1) throw new VideoError("tooLong");
  const track = await input.getPrimaryVideoTrack();
  const w = track?.displayWidth ?? 0, h = track?.displayHeight ?? 0;
  const shortEdge = Math.min(w, h) || 1080;
  const bitrate = duration > 0 ? (file.size * 8) / duration : Infinity;
  const fitsAsIs = track?.codec === "avc" && shortEdge <= 1080 && bitrate <= KEEP_BITRATE
    && file.size <= LIMITS.video.maxBytes;

  if (fitsAsIs && file.type === "video/mp4") {
    onProgress?.(1);
    return { blob: file, width: w, height: h, duration, path: "original" };
  }

  const landscape = w >= h;
  const t0 = performance.now();
  // Try the hardware encoder first (much faster on phones); some devices reject that
  // configuration, so fall back to the browser's default choice.
  let buf: ArrayBuffer | null = null;
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });
    const input2 = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const conv = await mb.Conversion.init({
      input: input2, output,
      // fitsAsIs → no video options → packets are copied (lossless, fast)
      video: fitsAsIs ? undefined : {
        codec: "avc", bitrate: TARGET_BITRATE, keyFrameInterval: 2, hardwareAcceleration,
        // cap the short edge at 1080 (portrait phone videos stay portrait)
        ...(shortEdge > 1080 ? (landscape ? { height: 1080 } : { width: 1080 }) : {}),
      },
      // no audio options → the phone's AAC track is copied as-is
    });
    if (!conv.isValid) {
      if (hardwareAcceleration === "prefer-hardware" && !fitsAsIs) continue;
      if (file.type === "video/mp4" && file.size <= LIMITS.rawVideoMaxBytes) return { blob: file, path: "original" };
      throw new VideoError("unsupported");
    }
    conv.onProgress = (p) => onProgress?.(p);
    try {
      await conv.execute();
      buf = target.buffer;
      break;
    } catch (e) {
      if (hardwareAcceleration === "prefer-hardware" && !fitsAsIs) { console.warn("[guestlens] HW encode failed, retrying", e); continue; }
      throw e;
    }
  }
  if (!buf) throw new VideoError("unsupported");
  const blob = new Blob([buf], { type: "video/mp4" });
  console.info("[guestlens] video", fitsAsIs ? "remux" : "transcode", {
    seconds: Math.round(duration), inMB: +(file.size / 1e6).toFixed(1), outMB: +(blob.size / 1e6).toFixed(1),
    tookS: +((performance.now() - t0) / 1000).toFixed(1), codec: track?.codec, w, h,
  });
  if (blob.size > LIMITS.video.maxBytes) throw new VideoError("tooBig");
  return { blob, width: w, height: h, duration, path: fitsAsIs ? "remux" : "transcode" };
}
