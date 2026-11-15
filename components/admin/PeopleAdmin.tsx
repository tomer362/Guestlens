"use client";
/**
 * Admin → People (FACES.md): turn face grouping on/off, see the queue, and fix groups by hand
 * (rename, merge, hide, "not this person", pick the cover). Every fix locks those faces, so later
 * regroups keep it.
 */
import { useCallback, useEffect, useState } from "react";
import { Combine, Eye, EyeOff, Loader2, RefreshCw, ScanFace, Star, Trash2, X } from "lucide-react";
import { Avatar } from "@/components/people/People";

type P = { id: string; name: string | null; hidden: boolean; faces: number; n: number; cover: string | null };
type Status = {
  jobs: Record<string, number>; faces: number; assigned: number; lastError: string | null; minFaces: number;
  model: { ok: true; runtime: string } | { ok: false; error: string }; people: P[];
};
type Face = { id: string; mediaId: string; q: number; locked: boolean; crop: string };

const post = (url: string, body?: unknown, method = "POST") =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export function PeopleAdmin({ enabled, onToggle }: { enabled: boolean; onToggle: (on: boolean) => Promise<void> }) {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/faces").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (r) setS(r);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } finally { setBusy(null); load(); }
  };

  const pending = s?.jobs.pending ?? 0;
  return (
    <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex-1 font-semibold">People (face grouping)</h2>
        <button onClick={() => act("toggle", () => onToggle(!enabled))} className={`rounded-full px-4 py-2 font-medium text-white ${enabled ? "bg-emerald-600" : "bg-gray-500"}`}>
          {enabled ? "ON" : "OFF"}
        </button>
      </div>
      <p className="text-xs text-muted">
        Off by default. Turning it on scans every photo already in the album, then each new one about a second after it uploads.
        Face data is biometric: tell guests before you turn it on. It is deleted automatically some time after the event, or right away with “Delete all face data”.
      </p>

      {s && (
        <div className="space-y-2 text-sm">
          <p>
            Queue: <b>{pending}</b> waiting · <b>{s.jobs.done ?? 0}</b> done · <b>{s.jobs.failed ?? 0}</b> failed ·
            faces: <b>{s.faces}</b> (<b>{s.assigned}</b> in a person) · people: <b>{s.people.filter((p) => !p.hidden).length}</b>
          </p>
          {!s.model.ok && enabled && <p className="rounded-lg bg-amber-50 p-2 text-amber-800">Face models not available on the server: {s.model.error}</p>}
          {s.lastError && <p className="truncate text-xs text-muted" title={s.lastError}>Last error: {s.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => act("drain", () => post("/api/admin/faces", { action: "drain" }))} className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 ring-1 ring-black/10">
              {busy === "drain" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}Process now
            </button>
            <button disabled={!!busy} onClick={() => act("regroup", () => post("/api/admin/faces", { action: "regroup" }))} className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 ring-1 ring-black/10">
              {busy === "regroup" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Combine className="size-4" aria-hidden />}Regroup
            </button>
            <button disabled={!!busy} onClick={() => act("rescan", () => post("/api/admin/faces", { action: "rescan" }))} className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 ring-1 ring-black/10"
              title="Scan every photo again with the latest face detection. Names and fixes are kept.">
              {busy === "rescan" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ScanFace className="size-4" aria-hidden />}Rescan photos
            </button>
            <button disabled={!!busy} onClick={() => confirm("Delete every face and person for this event? Turn People OFF first if you don't want photos scanned again.") && act("purge", () => post("/api/admin/faces", { action: "purge" }))}
              className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-red-700 ring-1 ring-black/10">
              <Trash2 className="size-4" aria-hidden />Delete all face data
            </button>
            {sel.length >= 2 && (
              <button disabled={!!busy} onClick={() => {
                // keep the person with the most photos (and its name)
                const chosen = s.people.filter((p) => sel.includes(p.id)).sort((a, b) => b.n - a.n);
                act("merge", () => post("/api/admin/people/merge", { into: chosen[0].id, from: chosen.slice(1).map((p) => p.id) })).then(() => setSel([]));
              }} className="inline-flex items-center gap-1 rounded-full bg-rose-deep px-3 py-1.5 font-medium text-white">
                <Combine className="size-4" aria-hidden />Merge {sel.length} selected
              </button>
            )}
          </div>

          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {s.people.map((p) => (
              <li key={p.id} className={`relative rounded-xl p-2 ring-1 ${sel.includes(p.id) ? "ring-2 ring-rose-deep" : "ring-black/5"} ${p.hidden ? "opacity-50" : ""}`}>
                <input type="checkbox" aria-label="Select for merge" checked={sel.includes(p.id)} onChange={(e) => setSel((xs) => e.target.checked ? [...xs, p.id] : xs.filter((x) => x !== p.id))}
                  className="absolute start-2 top-2 z-10 size-4" />
                <button type="button" onClick={() => setOpen(open === p.id ? null : p.id)} className="block w-full"><Avatar src={p.cover} size="aspect-square w-full" /></button>
                <input defaultValue={p.name ?? ""} placeholder="Name" maxLength={60} key={`${p.id}:${p.name}`}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== (p.name ?? "")) act("rename", () => post(`/api/admin/people/${p.id}`, { name: v || null }, "PATCH")); }}
                  className="mt-1 w-full rounded-md bg-cream px-2 py-1 text-xs" />
                <div className="mt-1 flex items-center justify-between text-xs text-muted">
                  <span>{p.n} photos · {p.faces} faces{p.faces < s.minFaces && !p.name ? " (not shown)" : ""}</span>
                  <button onClick={() => act("hide", () => post(`/api/admin/people/${p.id}`, { hidden: !p.hidden }, "PATCH"))} aria-label={p.hidden ? "Show" : "Hide"}>
                    {p.hidden ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {open && <PersonFaces id={open} onChange={load} />}
        </div>
      )}
    </section>
  );
}

/** One person's faces: "not this person" and "use as cover". */
function PersonFaces({ id, onChange }: { id: string; onChange: () => void }) {
  const [faces, setFaces] = useState<Face[] | null>(null);
  const load = useCallback(() => {
    fetch(`/api/admin/people/${id}`).then((r) => r.json()).then((r) => setFaces(r.faces)).catch(() => setFaces([]));
  }, [id]);
  useEffect(() => { setFaces(null); load(); }, [load]);
  if (!faces) return <p className="text-muted">…</p>;
  return (
    <div className="rounded-xl bg-cream p-3">
      <p className="mb-2 text-xs text-muted">Faces in this person, best first. ✕ = not this person · ★ = use as the cover.</p>
      <div className="flex flex-wrap gap-2">
        {faces.map((f) => (
          <div key={f.id} className="relative">
            <img src={f.crop} alt="" loading="lazy" className="size-16 rounded-full object-cover" title={`quality ${f.q.toFixed(2)}${f.locked ? " · confirmed" : ""}`} />
            <button aria-label="Not this person" onClick={async () => { await post(`/api/admin/faces/${f.id}/reject`); load(); onChange(); }}
              className="absolute -end-1 -top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white"><X className="size-3.5" aria-hidden /></button>
            <button aria-label="Use as cover" onClick={async () => { await post(`/api/admin/people/${id}`, { coverFaceId: f.id }, "PATCH"); onChange(); }}
              className="absolute -bottom-1 -end-1 grid size-6 place-items-center rounded-full bg-white text-amber-500 shadow"><Star className="size-3.5" aria-hidden /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
