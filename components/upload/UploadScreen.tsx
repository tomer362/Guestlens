"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { liveQuery } from "dexie";
import { Camera, Check, CloudOff, ImagePlus, Lock, Pencil, RotateCw, Video, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { enqueue, ensureDb, getBlob, qdb, removeItem, retry, type QueueItem } from "@/client/queue";
import { savedName, updateName } from "@/client/session";

export interface UploadScreenHandle { openCamera(): void; }

function useQueue(slug: string) {
  const [items, setItems] = useState<QueueItem[]>([]);
  useEffect(() => {
    let sub: { unsubscribe(): void } | null = null, gone = false;
    // wait for the real (or in-memory fallback) database before subscribing
    ensureDb().then(() => {
      if (gone) return;
      sub = liveQuery(() => qdb().items.where("slug").equals(slug).reverse().sortBy("createdAt"))
        .subscribe({ next: setItems, error: () => {} });
    });
    return () => { gone = true; sub?.unsubscribe(); };
  }, [slug]);
  return items;
}

function Thumb({ item }: { item: QueueItem }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, made: string | null = null;
    if (item.id != null && item.thumbV) {
      getBlob(item.id, "thumb").then((b) => {
        if (!alive || !b) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      });
    }
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [item.id, item.thumbV]);
  return (
    <div className="relative size-14 shrink-0 overflow-hidden rounded-xl bg-blush">
      {url ? <img src={url} alt="" className="size-full object-cover" /> : (
        <m.div className="grid size-full place-items-center text-rose" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.4 }}>
          {item.kind === "video" ? <Video className="size-6" aria-hidden /> : <Camera className="size-6" aria-hidden />}
        </m.div>
      )}
      {item.kind === "video" && url && <Video className="absolute bottom-1 end-1 size-3.5 text-white drop-shadow" aria-hidden />}
    </div>
  );
}

export function UploadScreen({ slug, uploadOpen, onHandle }: { slug: string; uploadOpen: boolean; onHandle?: (h: UploadScreenHandle) => void }) {
  const { t, f } = useI18n();
  const photoIn = useRef<HTMLInputElement>(null);
  const videoIn = useRef<HTMLInputElement>(null);
  const pickIn = useRef<HTMLInputElement>(null);
  const items = useQueue(slug);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [online, setOnline] = useState(true);
  // re-render every few seconds so "stuck in line" items get a retry button
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);

  useEffect(() => { onHandle?.({ openCamera: () => photoIn.current?.click() }); }, [onHandle]);
  useEffect(() => {
    setName(savedName());
    const n = () => setName(savedName());
    const u = () => setOnline(navigator.onLine);
    u(); addEventListener("online", u); addEventListener("offline", u); addEventListener("gl:name", n);
    return () => { removeEventListener("online", u); removeEventListener("offline", u); removeEventListener("gl:name", n); };
  }, []);

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length) {
      await enqueue(slug, files);
      // ask the browser not to evict our queue under storage pressure
      navigator.storage?.persist?.().catch(() => {});
    }
  };

  const today = items.filter((i) => Date.now() - i.createdAt < 86_400_000);
  const finished = today.filter((i) => i.status === "done" || i.status === "duplicate").length;
  const pending = today.filter((i) => ["queued", "compressing", "uploading", "waiting"].includes(i.status)).length;
  const statusText = (i: QueueItem) => {
    switch (i.status) {
      case "queued": return i.error === "paused" ? t.upload.paused : t.upload.queued;
      case "compressing": return i.kind === "video" && i.progress ? `${t.upload.compressing} ${Math.round(i.progress * 200)}%` : t.upload.compressing;
      case "uploading": return t.upload.uploading;
      case "done": return t.upload.done;
      case "duplicate": return t.upload.duplicate;
      case "waiting": return i.error === "budget" ? t.upload.rejectedBudget : i.error === "limit" ? t.upload.rejectedLimit : t.upload.waiting;
      case "rejected": return ({ closed: t.upload.rejectedClosed, tooBig: t.upload.tooBig, tooLong: t.upload.tooLong, lost: t.upload.lost } as Record<string, string>)[i.error ?? ""] ?? t.upload.unsupported;
      case "failed": return t.upload.failed;
    }
  };

  if (!uploadOpen) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center text-muted">
        <Lock className="size-10" aria-hidden /><p>{t.upload.rejectedClosed}</p>
      </div>
    );
  }

  return (
    <div className="pt-2">
      {/* name chip (optional) */}
      <div className="mb-4 flex justify-center">
        {editing ? (
          <form className="flex w-full max-w-xs gap-2" onSubmit={(e) => { e.preventDefault(); updateName(name.trim()); setEditing(false); }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t.onboarding.namePlaceholder}
              className="min-w-0 flex-1 rounded-full bg-white px-4 py-2 shadow-sm ring-1 ring-black/10 outline-none focus:ring-2 focus:ring-rose" />
            <button className="grid size-10 place-items-center rounded-full bg-rose-deep text-white" aria-label={t.common.done}><Check className="size-5" aria-hidden /></button>
          </form>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1 text-sm text-muted ring-1 ring-black/5">
            <Pencil className="size-3.5" aria-hidden />{name || t.upload.anonymous}
          </button>
        )}
      </div>

      {/* capture controls: same layout as the onboarding illustration (gallery · shutter · video) */}
      <div className="flex items-end justify-center gap-6 py-6">
        {([
          [pickIn, ImagePlus, t.upload.pick, false],
          [photoIn, Camera, t.upload.shoot, true],
          [videoIn, Video, t.upload.video, false],
        ] as const).map(([r, Icon, label, big]) => (
          <div key={label} className="flex flex-col items-center gap-2">
            <m.button type="button" whileTap={{ scale: 0.9 }} onClick={() => r.current?.click()} aria-label={label}
              className={big
                ? "relative grid size-32 place-items-center rounded-full bg-gradient-to-br from-rose to-rose-deep text-white shadow-2xl shadow-rose/40"
                : "grid size-16 place-items-center rounded-full bg-white text-ink shadow-md ring-1 ring-black/5"}>
              {big && <m.span className="absolute inset-0 rounded-full ring-4 ring-rose/40" animate={{ scale: [1, 1.18], opacity: [0.9, 0] }} transition={{ repeat: Infinity, duration: 1.8 }} />}
              <Icon className={big ? "size-14" : "size-7"} aria-hidden />
            </m.button>
            <span className={`text-sm ${big ? "font-semibold" : "text-muted"}`}>{label}</span>
          </div>
        ))}
      </div>

      <input ref={photoIn} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
      <input ref={videoIn} type="file" accept="video/*" capture="environment" className="hidden" onChange={onFiles} />
      <input ref={pickIn} type="file" accept="image/*,video/*" multiple className="hidden" onChange={onFiles} />

      {/* status */}
      <AnimatePresence>
        {(pending > 0 || !online) && (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="mt-6 flex items-start gap-2 overflow-hidden rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
            {!online ? <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden /> : <RotateCw className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />}
            <span>{!online ? t.upload.waiting : pending === 1 ? t.upload.pendingBannerOne : f(t.upload.pendingBanner, { n: pending })}</span>
          </m.div>
        )}
      </AnimatePresence>

      {today.length > 0 && (
        <p className="mt-6 text-center text-sm font-semibold">{f(t.upload.progress, { done: finished, total: today.length })}</p>
      )}

      <ul className="mt-3 space-y-2">
        <AnimatePresence initial={false}>
          {items.slice(0, 50).map((it) => (
            <m.li key={it.id} layout initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }}
              className="flex items-center gap-3 rounded-2xl bg-white p-2 pe-3 shadow-sm ring-1 ring-black/5">
              <Thumb item={it} />
              <div className="min-w-0 flex-1">
                <p className={`truncate text-sm ${it.status === "rejected" || it.status === "failed" ? "text-rose-deep" : ""}`}>{statusText(it)}</p>
                {it.error && it.error !== "paused" && it.status !== "done" && it.status !== "rejected" && (
                  <p className="truncate text-[11px] text-muted" dir="ltr" title={it.error}>#{it.attempts} · {it.error}</p>
                )}
                {it.diag && (
                  // diagnostics: what the phone did and how long each step took
                  <p className="text-[10px] leading-tight text-muted/80 break-all" dir="ltr">{it.diag}</p>
                )}
                {(it.status === "uploading" || it.status === "compressing") && (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-blush">
                    <m.div className="h-full rounded-full bg-rose" animate={{ width: `${Math.round((it.progress ?? 0.05) * 100)}%` }} />
                  </div>
                )}
              </div>
              {it.status === "done" || it.status === "duplicate" ? (
                <Check className="size-5 text-emerald-600" aria-hidden />
              ) : it.status === "failed" || (it.status === "waiting" && it.error !== "budget")
                || (it.status === "queued" && it.error !== "paused" && now - it.createdAt > 20_000 && (!it.lease || it.lease.until < now)) ? (
                <button type="button" onClick={() => retry(it.id!)} aria-label={t.common.retry} className="grid size-8 place-items-center rounded-full bg-blush"><RotateCw className="size-4" aria-hidden /></button>
              ) : it.status === "rejected" ? (
                <button type="button" onClick={() => removeItem(it.id!)} aria-label={t.common.close} className="grid size-8 place-items-center rounded-full bg-blush"><X className="size-4" aria-hidden /></button>
              ) : null}
            </m.li>
          ))}
        </AnimatePresence>
      </ul>
      {items.length === 0 && <p className="mt-10 text-center text-muted">{t.upload.queueEmpty}</p>}
    </div>
  );
}
