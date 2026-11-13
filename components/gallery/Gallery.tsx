"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { ChevronLeft, ChevronRight, Download, Play, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { GALLERY } from "@/lib/config";
import type { GalleryItem } from "@/app/api/gallery/route";
import { lqipToDataUrl } from "@/lib/lqip";

export function useGallery(slug: string, admin = false) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const [fresh, setFresh] = useState(0);
  const newest = useRef<string | null>(null);
  const qs = `slug=${encodeURIComponent(slug)}${admin ? "&admin=1" : ""}`;

  const load = useCallback(async () => {
    const r = await fetch(`/api/gallery?${qs}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (!r) return;
    setPrivate(!!r.private);
    setItems(r.items ?? []);
    setNextBefore(r.nextBefore ?? null);
    newest.current = r.items?.[0]?.at ?? null;
    setLoaded(true);
  }, [qs]);

  const more = useCallback(async () => {
    if (!nextBefore) return;
    const r = await fetch(`/api/gallery?${qs}&before=${encodeURIComponent(nextBefore)}`).then((r) => r.json()).catch(() => null);
    if (!r) return;
    setItems((prev) => [...prev, ...r.items.filter((x: GalleryItem) => !prev.some((p) => p.id === x.id))]);
    setNextBefore(r.nextBefore ?? null);
  }, [nextBefore, qs]);

  // Poll for new items only while the tab is visible; slow down when nothing changes.
  useEffect(() => {
    load();
    let delay: number = GALLERY.pollMs;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === "visible" && newest.current) {
        const r = await fetch(`/api/gallery?${qs}&since=${encodeURIComponent(newest.current)}`).then((r) => r.json()).catch(() => null);
        const add: GalleryItem[] = r?.items ?? [];
        if (add.length) {
          newest.current = add[add.length - 1].at;
          setItems((prev) => [...add.reverse().filter((x) => !prev.some((p) => p.id === x.id)), ...prev]);
          setFresh((n) => n + add.length);
          delay = GALLERY.pollMs;
        } else delay = Math.min(delay * 1.5, 60_000);
      } else if (document.visibilityState === "visible" && !newest.current) {
        await load();
      }
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    const vis = () => { if (document.visibilityState === "visible") { clearTimeout(timer); delay = GALLERY.pollMs; poll(); } };
    document.addEventListener("visibilitychange", vis);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", vis); };
  }, [load, qs]);

  return { items, setItems, loaded, isPrivate, more, hasMore: !!nextBefore, fresh, clearFresh: () => setFresh(0), reload: load };
}

export function Lightbox({ items, index, onClose, onIndex }: { items: GalleryItem[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const { t, f, lang } = useI18n();
  const it = items[index];
  const rtl = lang === "he";
  const step = (d: number) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") step(rtl ? -1 : 1);
      if (e.key === "ArrowLeft") step(rtl ? 1 : -1);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });
  // warm the cache for the next/previous full-size photos so swiping feels instant
  useEffect(() => {
    for (const n of [items[index + 1], items[index - 1]]) {
      if (n && n.kind === "photo") { const im = new Image(); im.decoding = "async"; im.src = n.url; }
    }
  }, [items, index]);
  if (!it) return null;
  return (
    <m.div className="fixed inset-0 z-50 flex flex-col bg-black" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="safe-top flex items-center justify-between px-4 pb-2 text-white">
        <button type="button" onClick={onClose} aria-label={t.common.close} className="grid size-10 place-items-center rounded-full bg-white/10"><X className="size-5" aria-hidden /></button>
        {it.by && <span className="truncate px-2 text-sm text-white/80">{f(t.gallery.by, { name: it.by })}</span>}
        <a href={it.url} download target="_blank" rel="noreferrer" aria-label={t.gallery.download} className="grid size-10 place-items-center rounded-full bg-white/10"><Download className="size-5" aria-hidden /></a>
      </div>
      <m.div key={it.id} className="relative flex flex-1 items-center justify-center overflow-hidden"
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.3}
        onDragEnd={(_, i) => { const dx = i.offset.x * (rtl ? -1 : 1); if (dx < -60) step(1); else if (dx > 60) step(-1); }}>
        {it.kind === "video" ? (
          <video src={it.url} poster={it.thumbUrl} controls playsInline autoPlay className="max-h-full max-w-full" />
        ) : (
          <img src={it.url} alt="" className="max-h-full max-w-full object-contain" draggable={false} decoding="async"
            width={it.w ?? undefined} height={it.h ?? undefined}
            style={it.p ? { backgroundImage: `url(${lqipToDataUrl(it.p)})`, backgroundSize: "100% 100%" } : undefined} />
        )}
      </m.div>
      <div className="safe-bottom flex justify-between px-4 pt-2 text-white">
        <button type="button" onClick={() => step(rtl ? 1 : -1)} className="grid size-11 place-items-center rounded-full bg-white/10" aria-label="prev"><ChevronLeft className="size-6" aria-hidden /></button>
        <span className="self-center text-sm text-white/60">{index + 1} / {items.length}</span>
        <button type="button" onClick={() => step(rtl ? -1 : 1)} className="grid size-11 place-items-center rounded-full bg-white/10" aria-label="next"><ChevronRight className="size-6" aria-hidden /></button>
      </div>
    </m.div>
  );
}

export function Tile({ it, onClick, i }: { it: GalleryItem; onClick: () => void; i: number }) {
  const [loaded, setLoaded] = useState(false);
  const ph = it.p ? lqipToDataUrl(it.p) : undefined;
  // first screenful loads eagerly at high priority; the rest lazily
  const eager = i < 15;
  return (
    <m.button type="button" onClick={onClick} className="relative aspect-square overflow-hidden rounded-lg bg-blush"
      initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: Math.min(i, 12) * 0.025 }}>
      {ph && (
        // 4×3 color grid from the gallery JSON, blurred: shows instantly, no request
        <img src={ph} alt="" aria-hidden className="absolute inset-0 size-full scale-125 object-cover blur-lg" />
      )}
      <img src={it.thumbUrl} alt="" loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : "low"} decoding="async"
        width={360} height={360} onLoad={() => setLoaded(true)} ref={(el) => { if (el?.complete && el.naturalWidth) setLoaded(true); }}
        className={`relative size-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`} />
      {it.kind === "video" && (
        <span className="absolute inset-0 grid place-items-center"><span className="grid size-9 place-items-center rounded-full bg-black/40"><Play className="size-4 fill-white text-white" aria-hidden /></span></span>
      )}
    </m.button>
  );
}

export function Gallery({ slug }: { slug: string }) {
  const { t, f } = useI18n();
  const g = useGallery(slug);
  const [open, setOpen] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    // fetch the next page well before the user reaches the end
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) g.more(); }, { rootMargin: "1500px" });
    io.observe(el);
    return () => io.disconnect();
  }, [g.more]);

  if (g.isPrivate) return <p className="py-24 text-center text-muted">{t.gallery.private}</p>;

  return (
    <div className="pt-2">
      <AnimatePresence>
        {g.fresh > 0 && (
          <m.button type="button" onClick={() => { g.clearFresh(); scrollTo({ top: 0, behavior: "smooth" }); }}
            initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -30, opacity: 0 }}
            className="sticky top-16 z-20 mx-auto mb-2 block rounded-full bg-rose-deep px-4 py-1.5 text-sm font-semibold text-white shadow-lg">
            {f(t.gallery.newItems, { n: g.fresh })} ✨
          </m.button>
        )}
      </AnimatePresence>
      {!g.loaded ? (
        <div className="grid grid-cols-3 gap-1">{[...Array(12)].map((_, i) => <div key={i} className="aspect-square animate-pulse rounded-lg bg-blush" />)}</div>
      ) : g.items.length === 0 ? (
        <p className="py-24 text-center text-muted">{t.gallery.empty}</p>
      ) : (
        <div className="grid grid-cols-3 gap-1">
          {g.items.map((it, i) => <Tile key={it.id} it={it} i={i} onClick={() => setOpen(i)} />)}
        </div>
      )}
      <div ref={sentinel} className="h-10" />
      <AnimatePresence>
        {open !== null && <Lightbox items={g.items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </div>
  );
}
