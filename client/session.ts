"use client";
const NAME_KEY = "gl_name";

export function savedName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
}
export function saveName(n: string) {
  try { localStorage.setItem(NAME_KEY, n); } catch {}
  dispatchEvent(new CustomEvent("gl:name", { detail: n }));
}

let joining: Promise<boolean> | null = null;
let currentSlug = "";

/**
 * Join silently (anonymous unless a name is saved). An installed iOS PWA has its
 * own cookie jar, separate from Safari, so this runs on every app start.
 */
export function ensureJoined(slug: string, force = false): Promise<boolean> {
  if (joining && !force && currentSlug === slug) return joining;
  currentSlug = slug;
  joining = fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, name: savedName() || null }),
  }).then((r) => r.ok).catch(() => false);
  joining.then((ok) => { if (!ok) joining = null; });
  return joining;
}

export async function updateName(name: string) {
  saveName(name);
  await fetch("/api/me", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name || null }),
  }).catch(() => {});
}
