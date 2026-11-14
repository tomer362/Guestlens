/**
 * Video preparation core. Runs inside a dedicated Web Worker (see video.worker.ts) so the
 * heavy decode/scale/encode loop never competes with the UI thread, and falls back to the
 * main thread where module workers are unavailable. No DOM APIs here.
 */
import { LIMITS } from "@/lib/config";

export class VideoError extends Error {
  constructor(public code: "tooBig" | "tooLong" | "unsupported") { super(code); }
}

export type VideoPath = "original" | "remux" | "transcode";
export interface VideoResult {
  blob: Blob; width?: number; height?: number; duration?: number; path: VideoPath; diag?: string;
}
export interface CoreHooks {
  /** skip conversion and upload the original when it is usable (after repeated stalls) */
  forceOriginal?: boolean;
  progress?: (p: number) => void;
  info?: (s: string) => void;
  report?: (s: string) => void;
}

/** H.264 at or below this bitrate is kept untouched. */
const KEEP_BITRATE = 5_000_000;
/** Short H.264 ≤1080p clips are kept untouched up to this size, whatever their bitrate. */
const KEEP_SMALL_BYTES = 25 * 1024 * 1024;
const TARGET_BITRATE = 2_500_000;
/** Bail out of a conversion that is projected to take longer than this (and upload the original if it fits). */
const SLOW_LIMIT_S = (durationS: number) => Math.max(45, durationS * 1.5);

export async function canTranscode(): Promise<boolean> {
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") return false;
  const { canEncodeVideo } = await import("mediabunny");
  return canEncodeVideo("avc", { width: 1920, height: 1080, bitrate: TARGET_BITRATE }).catch(() => false);
}

export async function prepareVideo(file: Blob, hooks: CoreHooks = {}): Promise<VideoResult> {
  const { report = () => {} } = hooks;
  const tStart = performance.now();
  const el = () => `${((performance.now() - tStart) / 1000).toFixed(1)}s`;
  report(`video start type=${file.type || "?"} size=${(file.size / 1e6).toFixed(1)}MB ctx=${(globalThis as { constructor?: { name?: string } }).constructor?.name ?? "?"} ua=${navigator.userAgent.slice(0, 160)}`);

  if (!(await canTranscode())) {
    report(`video no-webcodecs-avc @${el()}`);
    const t = file.type || "video/quicktime";
    if ((LIMITS.video.types as readonly string[]).includes(t) && file.size <= LIMITS.video.maxBytes) {
      return { blob: file.type ? file : new Blob([file], { type: t }), path: "original" };
    }
    throw new VideoError("tooBig");
  }

  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const duration = await input.computeDuration();
  if (duration > LIMITS.maxVideoSeconds + 1) throw new VideoError("tooLong");
  const track = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  const w = track?.displayWidth ?? 0, h = track?.displayHeight ?? 0;
  const shortEdge = Math.min(w, h) || 1080;
  const bitrate = duration > 0 ? (file.size * 8) / duration : Infinity;
  const fps = track ? (await track.computePacketStats(120).catch(() => null))?.averagePacketRate ?? 0 : 0;
  const isAvc = track?.codec === "avc";
  const fitsAsIs = isAvc && shortEdge <= 1080 && file.size <= LIMITS.video.maxBytes
    && (bitrate <= KEEP_BITRATE || file.size <= KEEP_SMALL_BYTES);
  // The original can be uploaded untouched (iPhone .mov included) when it's H.264/HEVC in a
  // container we accept and within the size limit: used when remux/transcode fails or is too slow.
  const origType = file.type || "video/quicktime";
  const containerOk = (LIMITS.video.types as readonly string[]).includes(origType);
  const canFallBackToOriginal = (isAvc || track?.codec === "hevc") && containerOk && file.size <= LIMITS.video.maxBytes;
  const original = () => (file.type ? file : new Blob([file], { type: origType }));

  const src = `${track?.codec ?? "?"} ${w}x${h} ${Math.round(fps)}fps ${(bitrate / 1e6).toFixed(1)}Mbps ${Math.round(duration)}s ${(file.size / 1e6).toFixed(0)}MB audio=${audio?.codec ?? "none"}`;
  report(`video probed @${el()} ${src} fitsAsIs=${fitsAsIs}`);
  hooks.info?.(src);

  if (hooks.forceOriginal && canFallBackToOriginal) {
    report(`video forceOriginal (${origType}) after repeated stalls`);
    hooks.progress?.(1);
    return { blob: original(), width: w, height: h, duration, path: "original", diag: `original (forced) · ${src}` };
  }
  if (fitsAsIs && file.type === "video/mp4") {
    hooks.progress?.(1);
    return { blob: file, width: w, height: h, duration, path: "original", diag: `original · ${src}` };
  }


  // Remux (fitsAsIs, .mov) or transcode. Called again with transcode=false for the slow-path fallback.
  let aacRegistered = false;
  const run = async (transcode: boolean, allowBail: boolean): Promise<Blob | "bail"> => {
    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });
    const inp = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    // Keep ONE audio track, chosen by us: iPhone 16+ add a spatial-audio (APAC) track that no
    // browser decodes, and Mediabunny's "primary" pick isn't necessarily the normal AAC one.
    const audios = await inp.getAudioTracks();
    const rank = (c: string | null) => (c === "aac" ? 0 : c === "opus" ? 1 : c === "mp3" ? 2 : 5);
    let keepAudio: (typeof audios)[number] | null = null;
    for (const a of [...audios].sort((x, y) => rank(x.codec) - rank(y.codec))) {
      if (a.codec && (rank(a.codec) < 5 || (await a.canDecode().catch(() => false)))) { keepAudio = a; break; }
    }
    // audio exists but none is usable → don't make a silent copy; the caller uploads the original
    if (audios.length && !keepAudio) throw new VideoError("unsupported");
    const init = () => mb.Conversion.init({
      input: inp, output,
      tracks: "all",
      audio: (t) => (t === keepAudio ? {} : { discard: true }),
      // no video options → packets are copied (lossless, fast)
      video: transcode ? {
        codec: "avc", bitrate: TARGET_BITRATE, keyFrameInterval: 2,
        // let the browser pick the hardware encoder when it has one; forcing it also forces
        // the hardware *decoder* and fails outright on some devices
        hardwareAcceleration: "no-preference",
        ...(fps > 31 ? { frameRate: 30 } : {}),
        ...(shortEdge > 1080 ? (w >= h ? { height: 1080 } : { width: 1080 }) : {}),
      } : undefined,
    });
    let conv = await init();
    // Never silently drop audio: if it must be re-encoded and this browser has no AAC encoder
    // (e.g. desktop Chrome on Linux), load Mediabunny's WASM AAC encoder (only then) and retry.
    if (!aacRegistered && conv.discardedTracks.some((d) => d.track.type === "audio" && d.reason === "no_encodable_target_codec")) {
      const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
      registerAacEncoder();
      aacRegistered = true;
      report(`video registered wasm aac @${el()}`);
      conv = await init();
    }
    const pv = await inp.getPrimaryVideoTrack(), pa = keepAudio;
    const dropped = conv.discardedTracks.map((d) => `${d.track.type}/${(d.track as { codec?: string | null }).codec ?? "?"}:${d.reason}`);
    report(`video convert start transcode=${transcode} valid=${conv.isValid} dropped=${dropped.join(",") || "-"} @${el()}`);
    // fail only if the PRIMARY video or audio would be lost (never produce a silent/blank file)
    if (!conv.isValid || conv.discardedTracks.some((d) => d.track === pv || d.track === pa)) {
      throw new VideoError("unsupported");
    }
    let bailed = false;
    let lastPost = 0, lastLog = -1;
    const t0 = performance.now();
    conv.onProgress = (p) => {
      const now = performance.now();
      // throttle: progress fires once per frame
      if (now - lastPost > 400 || p >= 1) { lastPost = now; hooks.progress?.(p); }
      const step = Math.floor(p * 10);
      if (step > lastLog) { lastLog = step; report(`video ${Math.round(p * 100)}% @${el()}`); }
      // adaptive bail-out: projected time way over budget → stop and upload the original instead
      const spent = (now - t0) / 1000;
      if (allowBail && !bailed && p >= 0.12 && spent > 6 && spent / p > SLOW_LIMIT_S(duration)) {
        bailed = true;
        report(`video too slow (projected ${(spent / p).toFixed(0)}s) → original @${el()}`);
        void conv.cancel();
      }
    };
    try {
      await conv.execute();
    } catch (e) {
      if (bailed) return "bail";
      report(`video convert error @${el()}: ${String(e).slice(0, 200)}`);
      throw e;
    }
    if (bailed) return "bail";
    if (!target.buffer) throw new VideoError("unsupported");
    return new Blob([target.buffer], { type: "video/mp4" });
  };

  const t0 = performance.now();
  let path: VideoPath = fitsAsIs ? "remux" : "transcode";
  let blob: Blob;
  try {
    const r = await run(!fitsAsIs, !fitsAsIs && canFallBackToOriginal);
    if (r === "bail") { path = "original"; blob = original(); }
    else blob = r;
  } catch (e) {
    if (canFallBackToOriginal) {
      report(`video fallback → original (${origType}) after: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      path = "original"; blob = original();
    }
    // a decoder/encoder hiccup (e.g. iOS reclaiming the decoder) is retryable, not a verdict on the file
    else throw e;
  }
  const took = (performance.now() - t0) / 1000;
  report(`video done path=${path} @${el()} out=${(blob.size / 1e6).toFixed(1)}MB`);
  if (blob.size > LIMITS.video.maxBytes) throw new VideoError("tooBig");
  return { blob, width: w, height: h, duration, path, diag: `${path} ${took.toFixed(0)}s → ${(blob.size / 1e6).toFixed(0)}MB · ${src}` };
}
