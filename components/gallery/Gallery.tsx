"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { Play } from "lucide-react";
import { Viewer } from "./Viewer";
import { useI18n } from "@/lib/i18n/client";
import { GALLERY } from "@/lib/config";
import type { GalleryItem } from "@/app/api/gallery/route";
import { lqipToDataUrl } from "@/lib/lqip";
import { mergeFirstPage } from "@/lib/feed";

/** Fired by the upload queue when one of this guest's uploads is live (same tab + other tabs). */
export const UPLOADED_EVENT = "gl:uploaded";

export function useGallery(slug: string, admin = false) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const [fresh, setFresh] = useState(0);
  const itemsRef = useRef<GalleryItem[]>([]);
  const version = useRef<number | null>(null);
  const busy = useRef(false);
  const qs = `slug=${encodeURIComponent(slug)}${admin ? "&admin=1" : ""}`;

  /**
   * Poll the tiny version number; only when it changed, fetch the first page keyed by that
   * version (CDN-shared by every guest, never stale) and merge it in.
   */
  const sync = useCallback(async (bypassCdn = false) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const f = bypassCdn ? `&fresh=${Date.now()}` : "";
      const vr = await fetch(`/api/gallery/version?${qs}${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!vr) return;
      if (vr.private) { setPrivate(true); setLoaded(true); return; }
      if (version.current === vr.v && !admin) return;
      const page = await fetch(`/api/gallery?${qs}&v=${vr.v}${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!page) return;
      setPrivate(!!page.private);
      const firstLoad = version.current === null;
      version.current = vr.v;
      const pageItems: GalleryItem[] = page.items ?? [];
      const r = mergeFirstPage(itemsRef.current, pageItems, pageItems.length >= GALLERY.pageSize);
      itemsRef.current = r.items;
      setItems(r.items);
      if (r.reset) setNextBefore(page.nextBefore ?? null);
      if (!firstLoad && r.added) setFresh((n) => n + r.added);
      setLoaded(true);
    } finally {
      busy.current = false;
    }
  }, [qs, admin]);

  const more = useCallback(async () => {
    if (!nextBefore) return;
    const v = version.current ?? 0;
    const r = await fetch(`/api/gallery?${qs}&before=${encodeURIComponent(nextBefore)}&v=${v}`).then((r) => r.json()).catch(() => null);
    if (!r) return;
    const prev = itemsRef.current;
    const next = [...prev, ...r.items.filter((x: GalleryItem) => !prev.some((p) => p.id === x.id))];
    itemsRef.current = next;
    setItems(next);
    setNextBefore(r.nextBefore ?? null);
  }, [nextBefore, qs]);

  const setItemsSynced = useCallback((fn: (x: GalleryItem[]) => GalleryItem[]) => {
    const next = fn(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") await sync();
      if (!stopped) timer = setTimeout(tick, GALLERY.versionPollMs);
    };
    void tick();
    // back to the app → check right away instead of waiting for the next tick
    const vis = () => { if (document.visibilityState === "visible") void tick(); };
    // this guest just uploaded (this tab or another) → show it immediately, bypassing the CDN
    const mine = () => { clearTimeout(timer); void sync(true).finally(() => { if (!stopped) timer = setTimeout(tick, GALLERY.versionPollMs); }); };
    document.addEventListener("visibilitychange", vis);
    addEventListener(UPLOADED_EVENT, mine);
    let bc: BroadcastChannel | null = null;
    try { bc = new BroadcastChannel("gl"); bc.onmessage = (e) => { if (e.data === UPLOADED_EVENT) mine(); }; } catch {}
    return () => {
      stopped = true; clearTimeout(timer);
      document.removeEventListener("visibilitychange", vis);
      removeEventListener(UPLOADED_EVENT, mine);
      bc?.close();
    };
  }, [sync]);

  return { items, setItems: setItemsSynced, loaded, isPrivate, more, hasMore: !!nextBefore, fresh, clearFresh: () => setFresh(0), reload: () => sync(true) };
}

export function Tile({ it, onClick, i, hidden }: { it: GalleryItem; onClick: () => void; i: number; hidden?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const ph = it.p ? lqipToDataUrl(it.p) : undefined;
  // first screenful loads eagerly at high priority; the rest lazily
  const eager = i < 15;
  return (
    // plain element + CSS entrance (no per-tile animation runtime); content-visibility lets the
    // browser skip off-screen tiles entirely, so a 3,000-photo album scrolls like a 30-photo one
    <button type="button" onClick={onClick} data-tile={it.id}
      style={{ visibility: hidden ? "hidden" : undefined, animationDelay: `${Math.min(i, 12) * 25}ms` }}
      className="tile-in relative aspect-square overflow-hidden rounded-lg bg-blush active:brightness-90 [contain-intrinsic-size:auto_120px] [content-visibility:auto]">
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
    </button>
  );
}

export function Gallery({ slug }: { slug: string }) {
  const { t, f } = useI18n();
  const g = useGallery(slug);
  // track the open item by id: polling prepends new items, which would shift a numeric index
  const [openId, setOpenId] = useState<string | null>(null);
  const openIdx = openId ? g.items.findIndex((x) => x.id === openId) : -1;
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
          {g.items.map((it, i) => <Tile key={it.id} it={it} i={i} hidden={openIdx === i} onClick={() => setOpenId(it.id)} />)}
        </div>
      )}
      <div ref={sentinel} className="h-10" />
      <AnimatePresence>
        {openIdx >= 0 && (
          <Viewer key="viewer" items={g.items} index={openIdx} onIndex={(i) => setOpenId(g.items[i]?.id ?? null)}
            onClose={() => setOpenId(null)} onMore={g.more} />
        )}
      </AnimatePresence>
    </div>
  );
}
