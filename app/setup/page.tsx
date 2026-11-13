"use client";
import { useState } from "react";

const suggest = () => `wedding-${Math.random().toString(36).slice(2, 7)}`;

export default function Setup() {
  const [form, setForm] = useState({ setupKey: "", name: "", slug: suggest(), pin: "" });
  const [res, setRes] = useState<{ slug: string; adminKey: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  if (res) {
    const origin = location.origin;
    return (
      <main className="mx-auto max-w-md space-y-4 p-6" dir="ltr">
        <h1 className="font-display text-2xl">✅ Event created</h1>
        <p>Guest link:<br /><a className="break-all text-rose-deep underline" href={`/e/${res.slug}`}>{origin}/e/{res.slug}</a></p>
        <p>Admin link:<br /><a className="break-all text-rose-deep underline" href={`/admin/${res.slug}`}>{origin}/admin/{res.slug}</a></p>
        <div className="rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
          <p className="font-semibold">Admin key: save it now. It is shown only once.</p>
          <p className="mt-2 select-all break-all font-mono text-lg">{res.adminKey}</p>
          <button className="mt-2 rounded-full bg-white px-3 py-1 text-sm ring-1 ring-black/10" onClick={() => navigator.clipboard.writeText(res.adminKey)}>Copy</button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-6" dir="ltr">
      <h1 className="font-display text-2xl">GuestLens setup</h1>
      <p className="mt-1 text-sm text-muted">Creates the database tables (first time only) and your event.</p>
      <form className="mt-6 space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError("");
        const r = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, pin: form.pin || null }) });
        const j = await r.json().catch(() => ({}));
        setBusy(false);
        if (r.ok) setRes(j); else setError(j.error ?? `Error ${r.status}`);
      }}>
        {([
          ["setupKey", "Setup key (the SETUP_KEY you set in Vercel)", "password"],
          ["name", "Event name (shown to guests)", "text"],
          ["slug", "Link name (a-z, 0-9, -)", "text"],
          ["pin", "Guest PIN (optional)", "text"],
        ] as const).map(([k, label, type]) => (
          <label key={k} className="block">
            <span className="mb-1 block text-sm font-medium">{label}</span>
            <input type={type} value={form[k]} onChange={set(k)} required={k !== "pin"} autoCapitalize="none" autoCorrect="off"
              className="w-full rounded-xl bg-white px-4 py-3 ring-1 ring-black/10 outline-none focus:ring-2 focus:ring-rose" />
          </label>
        ))}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full rounded-full bg-rose-deep py-3 font-semibold text-white disabled:opacity-60">{busy ? "Working…" : "Create event"}</button>
      </form>
    </main>
  );
}
