import { LIMITS } from "@/lib/config";
import { encodeScaled, THUMB_EDGE, type Encoded } from "./photo";

export class VideoError extends Error {
  constructor(public code: "tooBig" | "tooLong" | "unsupported") { super(code); }
}

/** Grab a poster frame at ~1 s with a <video> element (works without WebCodecs). */
export async function posterFrame(file: Blob): Promise<{ thumb: Encoded; duration: number; width: number; height: number }> {
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
    const thumb = await encodeScaled(v, v.videoWidth, v.videoHeight, THUMB_EDGE, 0.7);
    return { thumb, duration, width: v.videoWidth, height: v.videoHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function canTranscode(): Promise<boolean> {
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") return false;
  const { canEncodeVideo } = await import("mediabunny");
  return canEncodeVideo("avc", { width: 1920, height: 1080, bitrate: 2_500_000 }).catch(() => false);
}

/**
 * Re-encode to MP4 / H.264 ≤1080p ~2.5 Mbps + AAC 96 kbps (~15 MB per 45 s), on the phone.
 * Mediabunny is loaded lazily, so photo-only guests never download it.
 */
/** Poster frame decoded by Mediabunny (reliable on iOS, unlike drawing a <video>). */
export async function posterFromMp4(blob: Blob): Promise<Encoded | null> {
  try {
    const mb = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const dur = await input.computeDuration();
    const landscape = track.displayWidth >= track.displayHeight;
    const sink = new mb.CanvasSink(track, landscape ? { width: THUMB_EDGE } : { height: THUMB_EDGE });
    const first = await track.getFirstTimestamp();
    const frame = await sink.getCanvas(first + Math.min(1, dur / 2));
    if (!frame) return null;
    const c = frame.canvas;
    return await encodeScaled(c, c.width, c.height, THUMB_EDGE, 0.7);
  } catch {
    return null;
  }
}

export async function compressVideo(file: Blob, onProgress?: (p: number) => void): Promise<{ blob: Blob; width?: number; height?: number; duration?: number }> {
  if (!(await canTranscode())) {
    if (file.type === "video/mp4" && file.size <= LIMITS.rawVideoMaxBytes) return { blob: file };
    throw new VideoError("tooBig");
  }
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const duration = await input.computeDuration();
  if (duration > LIMITS.maxVideoSeconds + 1) throw new VideoError("tooLong");
  const track = await input.getPrimaryVideoTrack();
  const landscape = track ? track.displayWidth >= track.displayHeight : true;

  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const conv = await mb.Conversion.init({
    input, output,
    video: {
      codec: "avc", bitrate: 2_500_000, keyFrameInterval: 2,
      // cap the short edge at 1080 (portrait phone videos stay portrait)
      ...(landscape ? { height: Math.min(1080, track?.displayHeight ?? 1080) } : { width: Math.min(1080, track?.displayWidth ?? 1080) }),
    },
    audio: { codec: "aac", bitrate: 96_000 },
  });
  if (!conv.isValid) {
    if (file.type === "video/mp4" && file.size <= LIMITS.rawVideoMaxBytes) return { blob: file };
    throw new VideoError("unsupported");
  }
  conv.onProgress = (p) => onProgress?.(p);
  await conv.execute();
  const buf = target.buffer;
  if (!buf) throw new VideoError("unsupported");
  const blob = new Blob([buf], { type: "video/mp4" });
  if (blob.size > LIMITS.video.maxBytes) throw new VideoError("tooBig");
  return { blob, width: track?.displayWidth, height: track?.displayHeight, duration };
}
