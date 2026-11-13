"use client";
import { useCallback, useEffect, useState } from "react";
import { Download, Eye, EyeOff, Lock, Printer } from "lucide-react";
import QRCode from "qrcode";
import { useGallery } from "@/components/gallery/Gallery";
import { LangToggle } from "@/components/LangToggle";

type Usage = { plan: string; puts: number; storageBytes: number; budget: { puts: number; storageBytes: number }; counts: { status: string; kind: string; n: number; bytes: number }[]; guests: number };
type Ev = { name: string; uploadOpen: boolean; galleryPublic: boolean; hasPin: boolean };

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(0)} MB`;

function Meter({ label, value, max, fmt }: { label: string; value: number; max: number; fmt: (n: number) => string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <div className="flex justify-between text-sm"><span className="font-medium">{label}</span><span className="tabular-nums text-muted">{fmt(value)} / {fmt(max)}</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-blush"><div className={`h-full rounded-full ${pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Admin({ slug }: { slug: string }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [ev, setEv] = useState<Ev | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [qr, setQr] = useState<string>();

  const refresh = useCallback(async () => {
    const r = await fetch("/api/admin/event");
    if (!r.ok) return setAuthed(false);
    setAuthed(true);
    setEv(await r.json());
    setUsage(await fetch("/api/admin/usage").then((r) => r.json()));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    QRCode.toDataURL(`${location.origin}/e/${slug}`, { width: 600, margin: 2 }).then(setQr);
  }, [slug]);

  const patch = async (b: Partial<Ev> & { pin?: string | null }) => {
    await fetch("/api/admin/event", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    refresh();
  };

  if (authed === false) {
    return (
      <form className="mx-auto mt-24 flex max-w-xs flex-col gap-3 px-4" onSubmit={async (e) => {
        e.preventDefault();
        const r = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, key }) });
        if (r.ok) refresh(); else alert("Wrong key");
      }}>
        <Lock className="mx-auto size-10 text-rose-deep" aria-hidden />
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Admin key" className="rounded-xl bg-white px-4 py-3 ring-1 ring-black/10" />
        <button className="rounded-xl bg-rose-deep py-3 font-semibold text-white">Sign in</button>
      </form>
    );
  }
  if (!ev || !usage) return <p className="p-8 text-center text-muted">…</p>;

  const ready = usage.counts.filter((c) => c.status === "ready" || c.status === "hidden");
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4" dir="ltr">
      <header className="flex items-center justify-between">
        <h1 className="font-display text-2xl">{ev.name} · Admin</h1>
        <LangToggle />
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        <Meter label="Blob storage" value={usage.storageBytes} max={usage.budget.storageBytes} fmt={mb} />
        <Meter label="Upload ops this month" value={usage.puts} max={usage.budget.puts} fmt={(n) => n.toLocaleString()} />
        <div className="rounded-2xl bg-white p-4 text-sm shadow-sm ring-1 ring-black/5 sm:col-span-2">
          Plan profile: <b>{usage.plan}</b> · guests: <b>{usage.guests}</b> ·{" "}
          {ready.map((c) => <span key={c.status + c.kind} className="me-2">{c.kind}/{c.status}: <b>{c.n}</b> ({mb(c.bytes)})</span>)}
          <p className="mt-1 text-xs text-muted">Transfer and function usage: check the Vercel dashboard (Usage tab).</p>
        </div>
      </section>

      <section className="flex flex-wrap gap-3">
        <button onClick={() => patch({ uploadOpen: !ev.uploadOpen })} className={`rounded-full px-4 py-2 font-medium text-white ${ev.uploadOpen ? "bg-emerald-600" : "bg-gray-500"}`}>
          Uploads: {ev.uploadOpen ? "OPEN" : "CLOSED"}
        </button>
        <button onClick={() => patch({ galleryPublic: !ev.galleryPublic })} className="rounded-full bg-white px-4 py-2 font-medium ring-1 ring-black/10">
          Guests see album: {ev.galleryPublic ? "yes" : "no (couple only)"}
        </button>
        <button onClick={() => { const p = prompt("New PIN (empty = no PIN)"); if (p !== null) patch({ pin: p || null }); }} className="rounded-full bg-white px-4 py-2 font-medium ring-1 ring-black/10">
          PIN: {ev.hasPin ? "set" : "none"}
        </button>
        <a href="/api/admin/export" className="inline-flex items-center gap-1 rounded-full bg-white px-4 py-2 font-medium ring-1 ring-black/10"><Download className="size-4" aria-hidden />Export URLs</a>
      </section>

      {qr && (
        <section className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <img src={qr} alt="QR" className="size-32" />
          <div className="text-sm">
            <p className="font-medium">Guest QR code</p>
            <p className="break-all text-muted">{typeof location !== "undefined" && `${location.origin}/e/${slug}`}</p>
            <a href={qr} download={`${slug}-qr.png`} className="mt-2 inline-flex items-center gap-1 text-rose-deep"><Printer className="size-4" aria-hidden />Download for printing</a>
          </div>
        </section>
      )}

      <Moderation slug={slug} />
    </div>
  );
}

function Moderation({ slug }: { slug: string }) {
  const g = useGallery(slug, true);
  const toggle = async (id: string, hidden: boolean) => {
    await fetch(`/api/admin/media/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hidden }) });
    g.setItems((xs) => xs.map((x) => (x.id === id ? { ...x, hidden } : x)));
  };
  return (
    <section>
      <h2 className="mb-2 font-semibold">Moderation</h2>
      <div className="grid grid-cols-3 gap-1 sm:grid-cols-5">
        {g.items.map((it) => (
          <div key={it.id} className={`relative aspect-square overflow-hidden rounded-lg ${it.hidden ? "opacity-40" : ""}`}>
            <a href={it.url} target="_blank" rel="noreferrer"><img src={it.thumbUrl} alt="" loading="lazy" className="size-full object-cover" /></a>
            <button onClick={() => toggle(it.id, !it.hidden)} className="absolute end-1 top-1 grid size-8 place-items-center rounded-full bg-black/50 text-white" aria-label={it.hidden ? "Unhide" : "Hide"}>
              {it.hidden ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
            </button>
          </div>
        ))}
      </div>
      {g.hasMore && <button onClick={g.more} className="mt-3 w-full rounded-xl bg-white py-2 ring-1 ring-black/10">More</button>}
    </section>
  );
}
