"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, EyeOff, UserRound } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { GALLERY } from "@/lib/config";
import type { PersonTile } from "@/app/api/people/route";
import { Gallery, UPLOADED_EVENT } from "@/components/gallery/Gallery";
import { ensureJoined } from "@/client/session";

/**
 * People list: polls the same tiny version endpoint as the album and refetches the (CDN-shared,
 * version-keyed) list only when the People version changes.
 */
function usePeople(slug: string) {
  const [people, setPeople] = useState<PersonTile[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "disabled" | "private">("loading");
  const version = useRef<number | null>(null);
  const busy = useRef(false);
  const qs = `slug=${encodeURIComponent(slug)}`;

  const sync = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const vr = await fetch(`/api/gallery/version?${qs}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!vr) return;
      if (vr.private) return setState("private");
      if (!vr.faces) return setState("disabled");
      if (version.current === vr.pv) return;
      const r = await fetch(`/api/people?${qs}&v=${vr.pv}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!r) return;
      version.current = vr.pv;
      setPeople(r.people ?? []);
      setState(r.private ? "private" : r.enabled ? "ready" : "disabled");
    } finally {
      busy.current = false;
    }
  }, [qs]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    // faces show up a little after uploads, so a slower poll than the album is plenty
    const tick = async () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") await sync();
      if (!stopped) timer = setTimeout(tick, GALLERY.versionPollMs * 2);
    };
    void tick();
    const vis = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", vis);
    addEventListener(UPLOADED_EVENT, vis);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", vis); removeEventListener(UPLOADED_EVENT, vis); };
  }, [sync]);

  return { people, state };
}

/** "Include faces from my uploads": the guest's own opt-out (deletes their faces at once). */
function MyFacesToggle({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [optOut, setOptOut] = useState<boolean | null>(null);
  useEffect(() => {
    ensureJoined(slug).then(() => fetch("/api/me/faces")).then((r) => (r.ok ? r.json() : null))
      .then((r) => setOptOut(r ? !!r.optOut : null)).catch(() => {});
  }, [slug]);
  if (optOut === null) return null;
  const toggle = async () => {
    const next = !optOut;
    setOptOut(next);
    const ok = await fetch("/api/me/faces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optOut: next }) }).then((r) => r.ok).catch(() => false);
    if (!ok) setOptOut(!next);
  };
  return (
    <label className="mt-2 flex items-center justify-between gap-3 text-sm font-medium">
      {t.people.includeMine}
      <button type="button" role="switch" aria-checked={!optOut} onClick={toggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${optOut ? "bg-gray-300" : "bg-rose-deep"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${optOut ? "start-0.5" : "start-[1.375rem]"}`} />
      </button>
    </label>
  );
}

export function Avatar({ src, size = "size-full" }: { src: string | null; size?: string }) {
  const [ok, setOk] = useState(true);
  return src && ok
    ? <img src={src} alt="" loading="lazy" decoding="async" width={96} height={96} onError={() => setOk(false)} className={`${size} rounded-full bg-blush object-cover`} />
    : <span className={`${size} grid place-items-center rounded-full bg-blush text-rose-deep`}><UserRound className="size-1/2" aria-hidden /></span>;
}

export function People({ slug }: { slug: string }) {
  const { t, f } = useI18n();
  const { people, state } = usePeople(slug);

  if (state === "private") return <p className="py-24 text-center text-muted">{t.gallery.private}</p>;
  if (state === "disabled") return <p className="py-24 text-center text-muted">{t.people.disabled}</p>;

  return (
    <div className="pt-2">
      <section className="mb-4 rounded-2xl bg-white p-4 text-sm text-muted shadow-sm ring-1 ring-black/5">
        <p>{t.people.notice}</p>
        <MyFacesToggle slug={slug} />
      </section>
      {state === "loading" ? (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4">{[...Array(9)].map((_, i) => <div key={i} className="aspect-square animate-pulse rounded-full bg-blush" />)}</div>
      ) : people.length === 0 ? (
        <p className="py-16 text-center text-muted">{t.people.empty}</p>
      ) : (
        <ul className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4">
          {people.map((p, i) => (
            <li key={p.id} className="tile-in" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
              <Link href={`/e/${slug}/people/${p.id}`} className="flex flex-col items-center gap-1 active:opacity-80">
                <span className="aspect-square w-full p-1"><Avatar src={p.cover} /></span>
                {p.name && <span className="max-w-full truncate text-sm font-medium">{p.name}</span>}
                <span className="text-xs text-muted">{f(t.people.count, { n: p.n })}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One person's photos: the album grid + viewer, filtered, with a back link and "hide me". */
export function Person({ slug, personId }: { slug: string; personId: string }) {
  const { t, f, lang } = useI18n();
  const [hidden, setHidden] = useState(false);
  const Back = lang === "he" ? ChevronRight : ChevronLeft; // "back" points to the reading start
  const hide = async () => {
    if (!confirm(t.people.hideConfirm)) return;
    await ensureJoined(slug);
    const ok = await fetch(`/api/people/${personId}/hide`, { method: "POST" }).then((r) => r.ok).catch(() => false);
    if (ok) setHidden(true);
  };
  if (hidden) {
    return (
      <div className="py-24 text-center">
        <p className="text-muted">{t.people.hidden}</p>
        <Link href={`/e/${slug}/people`} className="mt-4 inline-block font-semibold text-rose-deep">{t.people.back}</Link>
      </div>
    );
  }
  return (
    <Gallery slug={slug} personId={personId} header={(g) => (
      <div className="mb-3 flex items-center gap-3">
        <Link href={`/e/${slug}/people`} aria-label={t.people.back} className="grid size-9 shrink-0 place-items-center rounded-full bg-white shadow-sm ring-1 ring-black/5">
          <Back className="size-5" aria-hidden />
        </Link>
        <div className="min-w-0 flex-1">
          {g.person?.name && <p className="truncate font-semibold">{g.person.name}</p>}
          {g.loaded && <p className="text-sm text-muted">{f(t.people.count, { n: g.items.length + (g.hasMore ? "+" : "") })}</p>}
        </div>
        <button type="button" onClick={hide} className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-muted shadow-sm ring-1 ring-black/5">
          <EyeOff className="size-4" aria-hidden />{t.people.hideMe}
        </button>
      </div>
    )} />
  );
}
