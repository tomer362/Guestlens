"use client";
/**
 * Fullscreen media viewer.
 *
 * - Opens/closes with a FLIP morph from/to the grid tile (the crop "unfolds" like a native photos app)
 * - Swipe left/right follows the finger (RTL-aware), springs to the next item
 * - Swipe down to dismiss (backdrop fades and the photo shrinks with your finger)
 * - Pinch and double-tap to zoom, drag to pan while zoomed
 * - Progressive: color placeholder → cached thumb → full image fades in once decoded
 * - Neighbours are mounted (±1) and preloaded (±2) so swiping never shows a blank frame
 * - Tap toggles the chrome; filmstrip at the bottom; Android back button / Esc close it
 * - Share sheet with the actual file (iOS "Save Image"), download fallback
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, animate, m, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { ChevronLeft, ChevronRight, Download, Loader2, Play, Share, VolumeX, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { lqipToDataUrl } from "@/lib/lqip";
import type { GalleryItem } from "@/app/api/gallery/route";

type Rect = { left: number; top: number; width: number; height: number };
// settle early (restDelta/restSpeed) so "finished" fires as soon as motion is imperceptible
const SPRING = { type: "spring", stiffness: 420, damping: 40, mass: 0.9, restDelta: 0.5, restSpeed: 20 } as const;
/** Paging: short and decisive, like a native photos app. */
const PAGE = { duration: 0.26, ease: [0.25, 0.9, 0.3, 1] } as const;
const MAX_ZOOM = 4;

function useViewport() {
  const [vp, setVp] = useState({ W: 390, H: 844 });
  useLayoutEffect(() => {
    const u = () => setVp({ W: window.innerWidth, H: window.innerHeight });
    u();
    addEventListener("resize", u);
    return () => removeEventListener("resize", u);
  }, []);
  return vp;
}

function fit(w: number, h: number, W: number, H: number): Rect {
  const s = Math.min(W / w, H / h);
  const width = w * s, height = h * s;
  return { left: (W - width) / 2, top: (H - height) / 2, width, height };
}

function tileRect(id: string, scroll = false): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tile="${CSS.escape(id)}"]`);
  if (!el) return null;
  if (scroll) el.scrollIntoView({ block: "nearest" });
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.width === 0) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Minimal video player: tap toggles play, thin progress bar, unmute if autoplay with sound was blocked. */
function VideoPlayer({ it, onDims, onReady, toggleRef }: {
  it: GalleryItem; onDims: (id: string, w: number, h: number) => void; onReady: () => void;
  toggleRef: React.MutableRefObject<(() => void) | null>;
}) {
  const v = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [prog, setProg] = useState(0);
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    el.play().catch(() => { el.muted = true; setMuted(true); el.play().catch(() => {}); });
    toggleRef.current = () => { if (el.paused) el.play().catch(() => {}); else el.pause(); };
    return () => { toggleRef.current = null; el.pause(); };
  }, [toggleRef]);
  return (
    <>
      <video ref={v} src={it.url} poster={it.thumbUrl} playsInline loop preload="auto"
        className="absolute inset-0 size-full bg-black object-contain"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setProg(e.currentTarget.currentTime / (e.currentTarget.duration || 1))}
        onLoadedMetadata={(e) => { onReady(); onDims(it.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight); }} />
      <AnimatePresence>
        {!playing && (
          <m.span key="pp" className="pointer-events-none absolute inset-0 grid place-items-center" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.2 }}>
            <span className="grid size-16 place-items-center rounded-full bg-black/45 backdrop-blur"><Play className="size-7 fill-white text-white" aria-hidden /></span>
          </m.span>
        )}
      </AnimatePresence>
      {muted && (
        <button type="button" onClick={() => { const el = v.current; if (el) { el.muted = false; setMuted(false); } }}
          className="absolute bottom-4 start-3 grid size-10 place-items-center rounded-full bg-black/50 text-white backdrop-blur" aria-label="unmute">
          <VolumeX className="size-5" aria-hidden />
        </button>
      )}
      <span className="absolute inset-x-0 bottom-0 h-1 bg-white/20"><span className="block h-full bg-white" style={{ width: `${prog * 100}%` }} /></span>
    </>
  );
}

/** One slide: placeholder → thumb → full image (or video when active). */
function Slide({ it, active, rect, dims, onDims, zoom, toggleRef }: {
  toggleRef: React.MutableRefObject<(() => void) | null>;
  it: GalleryItem; active: boolean; rect: Rect | { left: MotionValue<number>; top: MotionValue<number>; width: MotionValue<number>; height: MotionValue<number> };
  dims: { w: number; h: number } | undefined; onDims: (id: string, w: number, h: number) => void;
  zoom?: { z: MotionValue<number>; px: MotionValue<number>; py: MotionValue<number> };
}) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const ph = it.p ? lqipToDataUrl(it.p) : undefined;
  useEffect(() => {
    if (loaded) return;
    const t = setTimeout(() => setSlow(true), 450);
    return () => clearTimeout(t);
  }, [loaded]);

  return (
    <m.div className="absolute overflow-hidden" style={{ ...rect, borderRadius: 4 }}>
      <m.div className="size-full" style={zoom ? { scale: zoom.z, x: zoom.px, y: zoom.py } : undefined}>
        {ph && <img src={ph} alt="" aria-hidden className="absolute inset-0 size-full object-cover blur-xl" />}
        <img src={it.thumbUrl} alt="" aria-hidden draggable={false} className="absolute inset-0 size-full object-cover" />
        {it.kind === "video" ? (
          active ? (
            <VideoPlayer it={it} onDims={onDims} onReady={() => setLoaded(true)} toggleRef={toggleRef} />
          ) : (
            <span className="absolute inset-0 grid place-items-center">
              <span className="grid size-16 place-items-center rounded-full bg-black/45 backdrop-blur"><Play className="size-7 fill-white text-white" aria-hidden /></span>
            </span>
          )
        ) : (
          <img src={it.url} alt="" draggable={false} decoding="async"
            className={`absolute inset-0 size-full object-contain transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
            ref={(el) => { if (el?.complete && el.naturalWidth && !loaded) { setLoaded(true); if (!dims) onDims(it.id, el.naturalWidth, el.naturalHeight); } }}
            onLoad={(e) => {
              const el = e.currentTarget;
              // decode off the main thread before revealing, so the fade never stutters
              (el.decode?.() ?? Promise.resolve()).catch(() => {}).finally(() => {
                setLoaded(true);
                onDims(it.id, el.naturalWidth, el.naturalHeight);
              });
            }} />
        )}
      </m.div>
      <AnimatePresence>
        {active && slow && !loaded && it.kind === "photo" && (
          <m.span key="sp" className="absolute bottom-3 end-3 text-white/80" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Loader2 className="size-5 animate-spin" aria-hidden />
          </m.span>
        )}
      </AnimatePresence>
    </m.div>
  );
}

export function Viewer({ items, index, onIndex, onClose, onMore }: {
  items: GalleryItem[]; index: number; onIndex: (i: number) => void; onClose: () => void; onMore?: () => void;
}) {
  const { t, f, lang } = useI18n();
  const dir = lang === "he" ? -1 : 1; // which way "next" lies on screen
  const { W, H } = useViewport();
  const it = items[index];

  // natural sizes: from the API (w/h) or learned when the full image loads
  const [dimsMap, setDimsMap] = useState<Record<string, { w: number; h: number }>>({});
  const dimsOf = useCallback((g: GalleryItem) => dimsMap[g.id] ?? (g.w && g.h ? { w: g.w, h: g.h } : undefined), [dimsMap]);
  const onDims = useCallback((id: string, w: number, h: number) => {
    if (!w || !h) return;
    setDimsMap((d) => (d[id]?.w === w && d[id]?.h === h ? d : { ...d, [id]: { w, h } }));
  }, []);
  const rectFor = useCallback((g: GalleryItem): Rect => {
    const d = dimsOf(g);
    return d ? fit(d.w, d.h, W, H) : fit(1, 1, W, H);
  }, [dimsOf, W, H]);

  // active box geometry (animated for open/close morph)
  const L = useMotionValue(0), T = useMotionValue(0), BW = useMotionValue(W), BH = useMotionValue(H);
  const x = useMotionValue(0), y = useMotionValue(0);
  const z = useMotionValue(1), px = useMotionValue(0), py = useMotionValue(0);
  const shown = useMotionValue(0); // 0 → 1 open progress (backdrop)
  const backdrop = useTransform<number, number>([shown, y], ([s, yy]) => s * (1 - Math.min(Math.abs(yy) / 450, 0.75)));
  const dragScale = useTransform(y, (v) => 1 - Math.min(Math.abs(v) / 1400, 0.3));
  const [phase, setPhase] = useState<"opening" | "open" | "closing">("opening");
  const [chrome, setChrome] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const busy = useRef(false);
  const videoToggle = useRef<(() => void) | null>(null);

  // --- open: morph from the tile -------------------------------------------------------------
  useLayoutEffect(() => {
    const target = rectFor(it);
    const from = tileRect(it.id) ?? { ...target, left: target.left + target.width * 0.1, top: target.top + target.height * 0.1, width: target.width * 0.8, height: target.height * 0.8 };
    L.set(from.left); T.set(from.top); BW.set(from.width); BH.set(from.height);
    const anims = [
      animate(L, target.left, SPRING), animate(T, target.top, SPRING),
      animate(BW, target.width, SPRING), animate(BH, target.height, SPRING),
      animate(shown, 1, { duration: 0.25 }),
    ];
    Promise.all(anims.map((a) => a.finished)).then(() => setPhase((p) => (p === "opening" ? "open" : p)));
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; anims.forEach((a) => a.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the active box fitted: jump instantly to a new item, animate when its size becomes known
  const prevId = useRef(it.id);
  useLayoutEffect(() => {
    if (phase !== "open") return;
    const r = rectFor(it);
    if (prevId.current !== it.id) {
      prevId.current = it.id;
      L.set(r.left); T.set(r.top); BW.set(r.width); BH.set(r.height);
    } else {
      animate(L, r.left, SPRING); animate(T, r.top, SPRING); animate(BW, r.width, SPRING); animate(BH, r.height, SPRING);
    }
  }, [phase, it, rectFor, L, T, BW, BH]);

  // --- close: morph back into the tile (Back button, Esc, X, swipe down) -------------------
  const doClose = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setPhase("closing");
    setChrome(false);
    // bake the current drag offset into the box, then fly home
    const curScale = dragScale.get() * z.get();
    const cw = BW.get() * curScale, ch = BH.get() * curScale;
    const cl = L.get() + (BW.get() - cw) / 2 + x.get() + px.get(), ct = T.get() + (BH.get() - ch) / 2 + y.get() + py.get();
    x.set(0); y.set(0); z.set(1); px.set(0); py.set(0);
    L.set(cl); T.set(ct); BW.set(cw); BH.set(ch);
    const home = tileRect(it.id, true);
    const done = () => onClose();
    if (home) {
      Promise.all([
        animate(L, home.left, SPRING).finished, animate(T, home.top, SPRING).finished,
        animate(BW, home.width, SPRING).finished, animate(BH, home.height, SPRING).finished,
        animate(shown, 0, { duration: 0.22 }).finished,
      ]).then(done);
    } else {
      Promise.all([
        animate(BW, cw * 0.85, { duration: 0.2 }).finished, animate(BH, ch * 0.85, { duration: 0.2 }).finished,
        animate(L, cl + cw * 0.075, { duration: 0.2 }).finished, animate(T, ct + ch * 0.075, { duration: 0.2 }).finished,
        animate(shown, 0, { duration: 0.2 }).finished,
      ]).then(done);
    }
  }, [BW, BH, L, T, x, y, z, px, py, shown, dragScale, it.id, onClose]);

  // Android back button / browser back closes the viewer instead of leaving the page
  const closedByPop = useRef(false);
  useEffect(() => {
    history.pushState({ glViewer: true }, "");
    const pop = () => { closedByPop.current = true; doClose(); };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, [doClose]);
  const requestClose = useCallback(() => {
    if (!closedByPop.current && history.state?.glViewer) history.back(); // → popstate → doClose
    else doClose();
  }, [doClose]);

  // --- paging -------------------------------------------------------------------------------
  const resetZoom = useCallback(() => {
    animate(z, 1, SPRING); animate(px, 0, SPRING); animate(py, 0, SPRING); setZoomed(false);
  }, [z, px, py]);
  const go = useCallback((d: number) => {
    const n = index + d;
    if (busy.current || n < 0 || n >= items.length) { animate(x, 0, SPRING); return; }
    busy.current = true;
    resetZoom();
    animate(x, -d * dir * W, PAGE).finished.then(() => {
      onIndex(n);
      x.set(0);
      busy.current = false;
      if (n >= items.length - 6) onMore?.();
    });
  }, [index, items.length, dir, W, x, onIndex, onMore, resetZoom]);

  // preload ±2 full images
  useEffect(() => {
    for (const k of [1, -1, 2, -2]) {
      const n = items[index + k];
      if (n?.kind === "photo") { const im = new Image(); im.decoding = "async"; im.src = n.url; }
    }
  }, [items, index]);

  // keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
      if (e.key === "ArrowRight") go(dir);
      if (e.key === "ArrowLeft") go(-dir);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [go, dir, requestClose]);

  // --- gestures: swipe, dismiss, pinch, pan, tap / double-tap --------------------------------
  const g = useRef({
    pts: new Map<number, { x: number; y: number }>(),
    mode: "none" as "none" | "swipe-x" | "swipe-y" | "pan" | "pinch" | "pending",
    sx: 0, sy: 0, st: 0, lx: 0, ly: 0, lt: 0, vx: 0, vy: 0,
    pinchD: 0, pinchZ: 1, pinchMid: { x: 0, y: 0 }, pinchP: { x: 0, y: 0 },
    lastTap: 0, tapTimer: 0 as ReturnType<typeof setTimeout> | 0,
  });
  const panBounds = () => {
    const s = z.get();
    return { mx: Math.max(0, (BW.get() * s - W) / 2), my: Math.max(0, (BH.get() * s - H) / 2) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (phase !== "open" || busy.current) return;
    if ((e.target as HTMLElement).closest("button, a")) return;
    const s = g.current;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    s.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.pts.size === 2) {
      const [a, b] = [...s.pts.values()];
      s.mode = "pinch";
      s.pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      s.pinchZ = z.get();
      s.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      s.pinchP = { x: px.get(), y: py.get() };
      animate(x, 0, SPRING); animate(y, 0, SPRING);
      return;
    }
    s.mode = zoomed ? "pan" : "pending";
    s.sx = s.lx = e.clientX; s.sy = s.ly = e.clientY; s.st = s.lt = performance.now(); s.vx = s.vy = 0;
  };
  const onMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s.pts.has(e.pointerId)) return;
    s.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now(), dt = Math.max(1, now - s.lt);
    if (s.mode === "pinch" && s.pts.size >= 2) {
      const [a, b] = [...s.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const nz = clamp(s.pinchZ * (d / s.pinchD), 0.85, MAX_ZOOM + 0.5);
      // keep the point under the fingers steady
      const cx = s.pinchMid.x - W / 2, cy = s.pinchMid.y - H / 2;
      const k = nz / s.pinchZ;
      z.set(nz);
      px.set(cx - (cx - s.pinchP.x) * k + ((a.x + b.x) / 2 - s.pinchMid.x));
      py.set(cy - (cy - s.pinchP.y) * k + ((a.y + b.y) / 2 - s.pinchMid.y));
      return;
    }
    const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
    s.vx = (e.clientX - s.lx) / dt * 1000; s.vy = (e.clientY - s.ly) / dt * 1000;
    s.lx = e.clientX; s.ly = e.clientY; s.lt = now;
    if (s.mode === "pan") {
      const { mx, my } = panBounds();
      px.set(clamp(px.get() + (e.movementX || 0), -mx - 40, mx + 40));
      py.set(clamp(py.get() + (e.movementY || 0), -my - 40, my + 40));
      return;
    }
    if (s.mode === "pending" && Math.hypot(dx, dy) > 8) s.mode = Math.abs(dx) > Math.abs(dy) ? "swipe-x" : "swipe-y";
    if (s.mode === "swipe-x") {
      const hasTarget = items[index + (dx * dir < 0 ? 1 : -1)];
      x.set(hasTarget ? dx : dx * 0.3); // rubber band at the ends
    } else if (s.mode === "swipe-y") {
      y.set(dy); x.set(dx * 0.4);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s.pts.has(e.pointerId)) return;
    s.pts.delete(e.pointerId);
    if (s.mode === "pinch") {
      if (s.pts.size > 0) return; // wait for the last finger
      s.mode = "none";
      if (z.get() < 1.08) resetZoom();
      else {
        const nz = Math.min(z.get(), MAX_ZOOM);
        animate(z, nz, SPRING);
        setZoomed(true);
        requestAnimationFrame(() => { const { mx, my } = panBounds(); animate(px, clamp(px.get(), -mx, mx), SPRING); animate(py, clamp(py.get(), -my, my), SPRING); });
      }
      return;
    }
    const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
    const dur = performance.now() - s.st;
    if (s.mode === "pan") {
      const { mx, my } = panBounds();
      animate(px, clamp(px.get() + s.vx * 0.12, -mx, mx), SPRING);
      animate(py, clamp(py.get() + s.vy * 0.12, -my, my), SPRING);
      if (Math.hypot(dx, dy) < 8 && dur < 300) handleTap(e.clientX, e.clientY);
    } else if (s.mode === "swipe-x") {
      const fwd = -dx * dir, vfwd = -s.vx * dir;
      if (fwd > W * 0.22 || vfwd > 550) go(1);
      else if (fwd < -W * 0.22 || vfwd < -550) go(-1);
      else animate(x, 0, SPRING);
    } else if (s.mode === "swipe-y") {
      if (Math.abs(dy) > 110 || Math.abs(s.vy) > 700) requestClose();
      else { animate(y, 0, SPRING); animate(x, 0, SPRING); }
    } else if (s.mode === "pending" && dur < 300) {
      handleTap(e.clientX, e.clientY);
    }
    s.mode = "none";
  };
  const handleTap = (cx: number, cy: number) => {
    const s = g.current;
    const now = performance.now();
    if (now - s.lastTap < 280) {
      // double tap → zoom into that point / back out
      if (s.tapTimer) clearTimeout(s.tapTimer);
      s.lastTap = 0;
      if (it.kind !== "photo") return;
      if (zoomed) resetZoom();
      else {
        const nz = 2.5;
        animate(z, nz, SPRING);
        animate(px, (W / 2 - cx) * (nz - 1), SPRING);
        animate(py, (H / 2 - cy) * (nz - 1), SPRING);
        setZoomed(true);
      }
      return;
    }
    s.lastTap = now;
    s.tapTimer = setTimeout(() => {
      if (it.kind === "video" && videoToggle.current) videoToggle.current();
      else setChrome((c) => !c);
    }, it.kind === "video" ? 0 : 280);
  };

  // --- share / download -----------------------------------------------------------------------
  const [sharing, setSharing] = useState(false);
  const share = async () => {
    setSharing(true);
    try {
      const res = await fetch(it.url);
      const blob = await res.blob();
      const name = `${it.id.slice(0, 8)}.${blob.type.split("/")[1] ?? "jpg"}`;
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") window.open(it.url, "_blank");
    } finally {
      setSharing(false);
    }
  };
  const canShareFiles = useMemo(() => typeof navigator !== "undefined" && !!navigator.canShare, []);

  // --- filmstrip --------------------------------------------------------------------------------
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-strip="${index}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [index, chrome]);

  const showChrome = chrome && phase !== "closing";
  const slides = [-1, 0, 1].map((k) => ({ k, g: items[index + k] })).filter((s) => s.g);
  const Prev = dir === 1 ? ChevronLeft : ChevronRight;
  const Next = dir === 1 ? ChevronRight : ChevronLeft;

  return (
    <div className="fixed inset-0 z-50 select-none" role="dialog" aria-modal="true" aria-label={t.gallery.title}>
      <m.div className="absolute inset-0 bg-black" style={{ opacity: backdrop }} />

      {/* stage */}
      <div className="absolute inset-0 touch-none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <m.div className="absolute inset-0" style={{ x }}>
          {slides.map(({ k, g: s }) => (
            <m.div key={s.id} className="absolute inset-0" style={k === 0 ? { y, scale: dragScale } : { left: k * dir * W }}>
              <Slide it={s} active={k === 0 && phase !== "opening"} dims={dimsOf(s)} onDims={onDims} toggleRef={videoToggle}
                rect={k === 0 ? { left: L, top: T, width: BW, height: BH } : rectFor(s)}
                zoom={k === 0 ? { z, px, py } : undefined} />
            </m.div>
          ))}
        </m.div>
      </div>

      {/* top bar */}
      <AnimatePresence>
        {showChrome && (
          <m.div key="top" className="safe-top absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/60 to-transparent px-3 pb-6 text-white"
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.18 }}>
            <button type="button" onClick={requestClose} aria-label={t.common.close} className="grid size-10 place-items-center rounded-full bg-white/15 backdrop-blur active:scale-90">
              <X className="size-5" aria-hidden />
            </button>
            <div className="min-w-0 flex-1 text-center leading-tight">
              <p className="text-sm font-semibold tabular-nums" dir="ltr">{index + 1} / {items.length}</p>
              {it.by && <p className="truncate text-xs text-white/70">{f(t.gallery.by, { name: it.by })}</p>}
            </div>
            <button type="button" onClick={share} disabled={sharing} aria-label={t.gallery.download}
              className="grid size-10 place-items-center rounded-full bg-white/15 backdrop-blur active:scale-90">
              {sharing ? <Loader2 className="size-5 animate-spin" aria-hidden /> : canShareFiles ? <Share className="size-5" aria-hidden /> : <Download className="size-5" aria-hidden />}
            </button>
          </m.div>
        )}
      </AnimatePresence>

      {/* desktop arrows */}
      {showChrome && (
        <>
          {index > 0 && (
            <button type="button" onClick={() => go(-1)} aria-label={t.common.back}
              className="absolute top-1/2 hidden size-11 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white backdrop-blur sm:grid"
              style={{ [dir === 1 ? "left" : "right"]: 12 }}>
              <Prev className="size-6" aria-hidden />
            </button>
          )}
          {index < items.length - 1 && (
            <button type="button" onClick={() => go(1)} aria-label={t.common.next}
              className="absolute top-1/2 hidden size-11 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white backdrop-blur sm:grid"
              style={{ [dir === 1 ? "right" : "left"]: 12 }}>
              <Next className="size-6" aria-hidden />
            </button>
          )}
        </>
      )}

      {/* filmstrip */}
      <AnimatePresence>
        {showChrome && items.length > 1 && (
          <m.div key="strip" className="safe-bottom absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent pt-6"
            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} transition={{ duration: 0.18 }}>
            <div ref={strip} className="flex gap-1.5 overflow-x-auto px-[45%] pb-1 [scrollbar-width:none]">
              {items.map((s, i) => (
                <button key={s.id} type="button" data-strip={i} onClick={() => i !== index && onIndex(i)}
                  className={`relative size-11 shrink-0 overflow-hidden rounded-md transition-all duration-200 ${i === index ? "scale-110 ring-2 ring-white" : "opacity-60"}`}>
                  {Math.abs(i - index) < 40 && <img src={s.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />}
                  {s.kind === "video" && <Play className="absolute inset-0 m-auto size-3.5 fill-white text-white" aria-hidden />}
                </button>
              ))}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
