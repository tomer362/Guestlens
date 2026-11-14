"use client";
import Dexie, { type Table } from "dexie";
import type { UploadTicket } from "@/lib/storage/provider";
import { compressPhoto, DecodeError } from "./compress/photo";
import { compressVideo, PausedError, posterFrame, posterFromVideo, VideoError } from "./compress/video";
import { sha256Hex } from "./hash";
import { uploadWithTicket } from "./upload";
import { ensureJoined } from "./session";
import { diag } from "./diag";

export type ItemStatus =
  | "queued" | "compressing" | "uploading" | "done" | "duplicate" | "waiting" | "failed" | "rejected";

export interface QueueItem {
  id?: number;
  slug: string;
  kind: "photo" | "video";
  status: ItemStatus;
  createdAt: number;
  /**
   * Files live in a separate "blobs" store + an in-memory cache (see putBlob/getBlob), never on
   * this record: Chrome on iOS (WKWebView) can't re-store Blobs in IndexedDB, and every status
   * update used to rewrite the whole record including the files.
   */
  name?: string;
  /** compression done; the "file" and "thumb" blobs exist */
  prepared?: boolean;
  fileType?: string;
  fileBytes?: number;
  thumbType?: "image/webp" | "image/jpeg";
  thumbBytes?: number;
  /** bumped whenever the thumb blob changes, so the list re-reads it */
  thumbV?: number;
  /** tiny blurred preview (data URL) */
  lqip?: string;
  sha256?: string;
  width?: number; height?: number; durationS?: number;
  mediaId?: string;
  tickets?: { file: UploadTicket; thumb: UploadTicket };
  fileUrl?: string;
  thumbUrl?: string;
  progress?: number;
  attempts: number;
  nextAt: number;
  error?: string;
  /** which step is running, for diagnostics */
  stage?: "reserve" | "thumb" | "file";
  /** what the phone did with this item and how long it took (shown in the list) */
  diag?: string;
  /**
   * Which tab is working on this item, until when. Leases replace a cross-tab lock: a lock held
   * by a frozen background tab (Chrome keeps one per opened link) blocked every other tab forever.
   */
  lease?: { owner: string; until: number };
}

type BlobPart = "original" | "file" | "thumb";
class QueueDB extends Dexie {
  items!: Table<QueueItem, number>;
  blobs!: Table<{ key: string; blob: Blob }, string>;
  constructor(deps?: ConstructorParameters<typeof Dexie>[1]) {
    super("guestlens", deps);
    this.version(1).stores({ items: "++id, slug, status, nextAt, createdAt" });
    // v2: files move out of the item records. Old in-record blobs are dropped (they were exactly
    // what broke on Chrome iOS); unfinished old items will ask to be picked again.
    this.version(2).stores({ items: "++id, slug, status, nextAt, createdAt", blobs: "key" }).upgrade(async (tx) => {
      await tx.table("items").toCollection().modify((i: Record<string, unknown>) => {
        const hadFile = !!i.file;
        delete i.original; delete i.file; delete i.thumb;
        if (!hadFile && ["queued", "compressing", "uploading", "waiting", "failed"].includes(i.status as string)) i.prepared = false;
      });
    });
  }
}
let _db: QueueDB | null = null;
export const qdb = () => (_db ??= new QueueDB());

/**
 * Open the queue database; where IndexedDB is unavailable (some private modes and embedded
 * webviews) swap in an in-memory implementation, so uploads still work during this visit.
 */
let dbReady: Promise<void> | null = null;
export function ensureDb(): Promise<void> {
  return (dbReady ??= (async () => {
    try {
      if (typeof indexedDB === "undefined") throw new Error("no indexedDB");
      await qdb().open();
    } catch (e) {
      const fake = await import("fake-indexeddb");
      _db = new QueueDB({ indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange });
      await _db.open();
      diag(`indexedDB unavailable → in-memory queue: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  })());
}

// ---------- file storage: memory first, IndexedDB best-effort (to resume after a reload) ----------
const mem = new Map<string, Blob>();
let idbBlobs: boolean | null = null; // learned at first write
let idbWarned = false;
const bkey = (id: number, part: BlobPart) => `${id}:${part}`;

export async function putBlob(id: number, part: BlobPart, blob: Blob) {
  const key = bkey(id, part);
  mem.set(key, blob);
  if (idbBlobs === false) return;
  try {
    await qdb().blobs.put({ key, blob });
    idbBlobs = true;
  } catch (e) {
    if (!idbWarned) { idbWarned = true; diag(`idb can't store files → memory only: ${String((e as Error)?.message ?? e).slice(0, 140)}`); }
    idbBlobs = false;
  }
}

/** The blob, or undefined if it's gone or unreadable (e.g. a WebKit-persisted File after reload). */
export async function getBlob(id: number, part: BlobPart): Promise<Blob | undefined> {
  const key = bkey(id, part);
  const m = mem.get(key);
  if (m) return m;
  try {
    const r = await qdb().blobs.get(key);
    if (!r?.blob) return undefined;
    await r.blob.slice(0, 1).arrayBuffer(); // prove it's still readable
    mem.set(key, r.blob);
    return r.blob;
  } catch {
    return undefined;
  }
}

async function delBlobs(id: number, parts: BlobPart[] = ["original", "file", "thumb"]) {
  for (const p of parts) mem.delete(bkey(id, p));
  await qdb().blobs.bulkDelete(parts.map((p) => bkey(id, p))).catch(() => {});
}

const ACTIVE: ItemStatus[] = ["queued", "compressing", "uploading", "waiting"];
const CONCURRENCY = 2;
const LEASE_MS = 30_000;
const HEARTBEAT_MS = 8_000;
/**
 * This tab's identity for leases. Kept in sessionStorage so a reload of the same tab still owns
 * its leases (otherwise its own unfinished items would wait out a 30 s lease after every reload).
 */
const TAB = (() => {
  const fresh = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
  try {
    if (typeof sessionStorage === "undefined") return fresh();
    const v = sessionStorage.getItem("gl_tab") ?? fresh();
    sessionStorage.setItem("gl_tab", v);
    return v;
  } catch { return fresh(); }
})();

const leaseFree = (i: QueueItem, now = Date.now()) => !i.lease || i.lease.until < now || i.lease.owner === TAB;

/** Resolve within `ms` or reject with a labelled timeout (a hung await must never block a lane). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { diag(`timeout ${label} ${ms / 1000}s`); reject(new Error(`timeout_${label}`)); }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Tell the album (this tab and other tabs) that an upload just went live. */
function announceUploaded() {
  try { dispatchEvent(new Event("gl:uploaded")); } catch {}
  try { const bc = new BroadcastChannel("gl"); bc.postMessage("gl:uploaded"); bc.close(); } catch {}
}

/** Thrown when another tab took this item over (we were frozen past our lease). */
class LostLease extends Error { constructor() { super("lost_lease"); } }

export async function enqueue(slug: string, files: File[]) {
  const now = Date.now();
  // some browsers give HEIC/MOV files an empty MIME type: fall back to the extension
  const kindOf = (f: File): QueueItem["kind"] | null =>
    f.type.startsWith("video/") || /\.(mov|mp4|m4v|3gp|webm|mkv)$/i.test(f.name) ? "video"
    : f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|hei[cf]|avif|dng)$/i.test(f.name) ? "photo" : null;
  await ensureDb();
  const picked = files.filter((f) => kindOf(f));
  const items: QueueItem[] = picked.map((f, i) => ({
    slug, kind: kindOf(f)!, status: "queued",
    createdAt: now + i, name: f.name, attempts: 0, nextAt: 0,
  }));
  const ids = (await qdb().items.bulkAdd(items, { allKeys: true })) as number[];
  // memory copy is immediate; the IndexedDB copy (for resuming after reload) is best-effort
  await Promise.all(ids.map((id, i) => putBlob(id, "original", picked[i])));
  kick();
  return items.length;
}

export async function retry(id: number) {
  await qdb().items.update(id, { status: "queued", attempts: 0, nextAt: 0, error: undefined, lease: undefined });
  kick();
}
export async function removeItem(id: number) { await delBlobs(id); await qdb().items.delete(id); }

/** Drop finished items after a day so IndexedDB stays small. */
async function gc() {
  const cutoff = Date.now() - 86_400_000;
  const old = await qdb().items.where("createdAt").below(cutoff)
    .filter((i) => i.status === "done" || i.status === "duplicate").primaryKeys();
  for (const id of old) await delBlobs(id);
  await qdb().items.bulkDelete(old);
}

function backoff(attempts: number) {
  const base = Math.min(60_000, 1000 * 2 ** attempts);
  return base / 2 + Math.random() * base / 2; // jitter
}

class Rejected extends Error { constructor(public code: string) { super(code); } }

const looksHeicName = (it: QueueItem) => /\.hei[cf]$/i.test(it.name ?? "");

type Prepared = { file: Blob; thumb: Blob; meta: Partial<QueueItem> };
async function prepare(it: QueueItem, src: Blob): Promise<Prepared> {
  if (it.kind === "photo") {
    const t0 = performance.now();
    let r: Awaited<ReturnType<typeof compressPhoto>>;
    try {
      // 60 s: the first HEIC photo also downloads the WASM decoder
      r = await withTimeout(compressPhoto(src), looksHeicName(it) ? 60_000 : 30_000, "photo");
    } catch (e) {
      if (e instanceof DecodeError) throw new Rejected("unsupported"); // no point retrying 12 times
      throw e;
    }
    const { main, thumb, lqip } = r;
    return { file: main.blob, thumb: thumb.blob, meta: {
      fileType: main.type, thumbType: thumb.type, lqip,
      diag: `photo ${((performance.now() - t0) / 1000).toFixed(1)}s · ${(src.size / 1e6).toFixed(1)}MB → ${(main.blob.size / 1e3).toFixed(0)}KB ${main.encoder ?? ""}`.trim(),
      width: main.width, height: main.height, sha256: await sha256Hex(main.blob),
    } };
  }
  // Poster first, from the original: the list shows the real frame right away,
  // and it doesn't depend on the conversion succeeding.
  const early = await withTimeout(posterFromVideo(src), 20_000, "poster").catch(() => null)
    ?? await withTimeout(posterFrame(src), 15_000, "poster-el").catch(() => null);
  if (early) {
    await putBlob(it.id!, "thumb", early.thumb.blob);
    await qdb().items.update(it.id!, { thumbType: early.thumb.type, lqip: early.lqip, thumbV: Date.now() });
  }
  const t0 = performance.now();
  // iOS/Android take the hardware decoder away from background pages ("Decoder failure"):
  // stop cleanly when hidden and resume from the start when the guest comes back.
  const ctrl = new AbortController();
  const onVis = () => { if (document.visibilityState === "hidden") ctrl.abort(); };
  document.addEventListener("visibilitychange", onVis);
  let v: Awaited<ReturnType<typeof compressVideo>>;
  try {
    if (document.visibilityState === "hidden") throw new PausedError();
    // stalled twice already on this device → just upload the original if it's usable
    const forceOriginal = it.attempts >= 2 && /stalled_video/.test(it.error ?? "");
    v = await compressVideo(src, (p) => qdb().items.update(it.id!, { progress: p * 0.5 }),
      (info) => qdb().items.update(it.id!, { diag: info }), ctrl.signal, forceOriginal);
  } finally {
    document.removeEventListener("visibilitychange", onVis);
  }
  // if the early poster failed (e.g. undecodable original), try the converted MP4
  const late = early ? null
    : await withTimeout(posterFromVideo(v.blob), 20_000, "poster2").catch(() => null)
      ?? await withTimeout(posterFrame(v.blob), 15_000, "poster2-el").catch(() => null);
  const poster = early ?? late;
  if (!poster) throw new Error("poster_failed");
  const thumb = poster.thumb;
  const lqip = poster.lqip;
  const duration = v.duration ?? poster.duration ?? 0;
  if (duration > 181) throw new Rejected("tooLong");
  return { file: v.blob, thumb: thumb.blob, meta: {
    fileType: v.blob.type || "video/quicktime", thumbType: thumb.type, lqip,
    width: v.width ?? poster.width, height: v.height ?? poster.height,
    durationS: duration > 0 ? Math.round(duration * 10) / 10 : undefined,
    diag: `${v.diag ?? v.path} · total ${((performance.now() - t0) / 1000).toFixed(0)}s`,
    sha256: await sha256Hex(v.blob),
  } };
}

async function post(url: string, body: unknown) {
  // iOS can leave a request pending forever after the screen locks: always time out.
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout?.(20_000),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j };
}

/** Between stages: make sure this tab still owns the item. */
async function checkpoint(id: number) {
  const cur = await qdb().items.get(id);
  if (!cur || (cur.lease && cur.lease.owner !== TAB && cur.lease.until > Date.now())) throw new LostLease();
}

async function processOne(it: QueueItem) {
  const db = qdb();
  const id = it.id!;
  try {
    // 1. compress (once; the result is kept in memory + best-effort IndexedDB)
    let file = it.prepared ? await getBlob(id, "file") : undefined;
    let thumb = it.prepared ? await getBlob(id, "thumb") : undefined;
    if (!file || !thumb) {
      const original = await getBlob(id, "original");
      if (!original) {
        // the picked file is gone (reload on a browser that can't keep files): ask to pick it again
        diag(`item lost kind=${it.kind} (original unavailable, idbBlobs=${idbBlobs})`);
        await db.items.update(id, { status: "rejected", error: "lost" });
        return;
      }
      await db.items.update(id, { status: "compressing", progress: 0, error: undefined });
      const prepared = await prepare(it, original);
      file = prepared.file; thumb = prepared.thumb;
      await putBlob(id, "file", file);
      await putBlob(id, "thumb", thumb);
      const meta = { ...prepared.meta, prepared: true, fileBytes: file.size, thumbBytes: thumb.size, thumbV: Date.now() };
      await db.items.update(id, meta);
      await delBlobs(id, ["original"]); // free space; the prepared file is all we need now
      it = { ...it, ...meta };
    }

    // 2. reserve
    await checkpoint(id);
    const upStart = Date.now();
    await db.items.update(id, { status: "uploading" });
    if (!it.mediaId || !it.tickets) {
      await db.items.update(id, { stage: "reserve" });
      const body = {
        sha256: it.sha256, kind: it.kind, contentType: it.fileType, bytes: file.size,
        thumbType: it.thumbType, thumbBytes: thumb.size, width: it.width, height: it.height,
        durationS: it.durationS, lqip: it.lqip,
      };
      let r = await post("/api/media/reserve", body);
      if (r.status === 401) { await ensureJoined(it.slug, true); r = await post("/api/media/reserve", body); }
      if (r.j.duplicate) { await db.items.update(id, { status: "duplicate", progress: 1 }); await delBlobs(id, ["original", "file"]); return; }
      if (r.j.rejected) throw new Rejected(r.j.rejected);
      if (!r.ok) throw new Error(`reserve_${r.status}${r.j.error ? `:${r.j.error}` : ""}`);
      it.mediaId = r.j.mediaId; it.tickets = r.j.tickets;
      await db.items.update(id, { mediaId: it.mediaId, tickets: it.tickets });
    }

    // 3. upload directly to storage (thumb first: it's tiny and makes the gallery look alive)
    await checkpoint(id);
    if (!it.thumbUrl) {
      await db.items.update(id, { stage: "thumb" });
      it.thumbUrl = await uploadWithTicket(it.tickets!.thumb, thumb);
      await db.items.update(id, { thumbUrl: it.thumbUrl });
    }
    if (!it.fileUrl) {
      await db.items.update(id, { stage: "file" });
      const start = it.kind === "video" ? 0.5 : 0;
      let lastWrite = 0;
      it.fileUrl = await uploadWithTicket(it.tickets!.file, file, (f) => {
        // throttle IndexedDB writes (each one re-renders the list)
        const now = Date.now();
        if (now - lastWrite > 400 || f >= 1) { lastWrite = now; db.items.update(id, { progress: start + f * (1 - start) }); }
      });
      await db.items.update(id, { fileUrl: it.fileUrl });
    }

    // 4. complete
    await checkpoint(id);
    const c = await post("/api/media/complete", { mediaId: it.mediaId, url: it.fileUrl, thumbUrl: it.thumbUrl });
    if (c.status === 410) {
      // reservation expired (e.g. phone was offline > 1 h): start over from reserve
      await db.items.update(id, { mediaId: undefined, tickets: undefined, fileUrl: undefined, thumbUrl: undefined });
      throw new Error("expired");
    }
    if (!c.ok) throw new Error(`complete_${c.status}${c.j.error ? `:${c.j.error}` : ""}`);
    if (it.kind === "video") diag(`video uploaded ${((Date.now() - upStart) / 1000).toFixed(0)}s · ${it.diag ?? ""}`);
    announceUploaded();
    await delBlobs(id, ["original", "file"]); // keep the small thumb for the list
    await db.items.update(id, { status: "done", progress: 1, tickets: undefined,
      diag: `${it.diag ?? ""} · upload ${((Date.now() - upStart) / 1000).toFixed(0)}s` });
  } catch (e) {
    if (e instanceof LostLease) { diag(`lost lease ${id} (another tab took over)`); return; }
    if (e instanceof PausedError) {
      // not a failure: back in line, resumes when the app is visible again (startQueue wakes on visibility)
      await db.items.update(id, { status: "queued", progress: 0, error: "paused", nextAt: 0 });
      return;
    }
    if (e instanceof Rejected || e instanceof VideoError) {
      const code = e instanceof VideoError ? e.code : e.code;
      // budget/limit may clear later → retry slowly; others are final
      if (code === "limit" || code === "budget") {
        await db.items.update(id, { status: "waiting", error: code, attempts: it.attempts + 1, nextAt: Date.now() + 5 * 60_000 });
      } else {
        await db.items.update(id, { status: "rejected", error: code });
        await delBlobs(id, ["original", "file"]);
      }
      return;
    }
    const msg = String((e as Error)?.message ?? e);
    if (/client token|no_reservation|bad_path/i.test(msg)) {
      await db.items.update(id, { mediaId: undefined, tickets: undefined, thumbUrl: undefined, fileUrl: undefined });
    }
    diag(`item failed kind=${it.kind} stage=${(await db.items.get(id))?.stage ?? "prepare"} err=${String((e as Error)?.message ?? e).slice(0, 200)}`);
    const attempts = it.attempts + 1;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    await db.items.update(id, {
      status: attempts > 12 ? "failed" : "waiting",
      error: offline ? "offline" : `${(await db.items.get(id))?.stage ?? "prepare"}: ${String((e as Error).message ?? e)}`.slice(0, 160),
      attempts, nextAt: Date.now() + backoff(attempts),
    });
  } finally {
    await db.items.where("id").equals(id).modify((i) => { if (i.lease?.owner === TAB) delete i.lease; }).catch(() => {});
  }
}

/** Atomically take an item for this tab (two tabs can never work on the same item). */
async function claim(id: number): Promise<boolean> {
  const db = qdb();
  return db.transaction("rw", db.items, async () => {
    const cur = await db.items.get(id);
    const now = Date.now();
    if (!cur || !ACTIVE.includes(cur.status) || cur.nextAt > now) return false;
    if (!leaseFree(cur, now)) return false;
    if (cur.lease && cur.lease.owner !== TAB) diag(`takeover ${id} from ${cur.lease.owner} (expired ${((now - cur.lease.until) / 1000).toFixed(0)}s ago)`);
    // an expired lease means its tab died or froze mid-way: show it as queued again
    await db.items.update(id, {
      lease: { owner: TAB, until: now + LEASE_MS },
      ...(cur.status === "compressing" || cur.status === "uploading" ? { status: "queued" as const } : {}),
    });
    return true;
  });
}

let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const inFlight = new Map<number, { kind: QueueItem["kind"]; p: Promise<void> }>();

// keep our leases alive while we work
let heartbeat: ReturnType<typeof setInterval> | undefined;
function ensureHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (!inFlight.size) { clearInterval(heartbeat); heartbeat = undefined; return; }
    const ids = [...inFlight.keys()];
    const until = Date.now() + LEASE_MS;
    void qdb().items.where("id").anyOf(ids).modify((i) => { if (i.lease?.owner === TAB) i.lease.until = until; }).catch(() => {});
  }, HEARTBEAT_MS);
}

async function loop() {
  if (running) { again = true; return; }
  running = true;
  try {
    await ensureDb();
    const db = qdb();
    // Two lanes: one video at a time per device (heavy) next to up to CONCURRENCY photos,
    // so photos never wait behind a long video conversion.
    do {
      again = false;
      for (;;) {
        const now = Date.now();
        const hidden = document.visibilityState === "hidden";
        const active = await db.items.where("status").anyOf(ACTIVE).sortBy("createdAt");
        const ready = active.filter((i) => i.nextAt <= now && !(hidden && i.error === "paused")
          && !inFlight.has(i.id!) && leaseFree(i, now));
        // another live tab converting a video? leave the video lane to it
        const otherVideo = active.some((i) => i.kind === "video" && i.lease && i.lease.owner !== TAB && i.lease.until > now);
        const busy = [...inFlight.values()];
        const freeVideo = busy.some((x) => x.kind === "video") || otherVideo ? 0 : 1;
        const freePhotos = CONCURRENCY - busy.filter((x) => x.kind === "photo").length;
        const candidates = [
          ...ready.filter((i) => i.kind === "video").slice(0, freeVideo),
          ...ready.filter((i) => i.kind === "photo").slice(0, Math.max(0, freePhotos)),
        ];
        for (const it of candidates) {
          if (!(await claim(it.id!))) continue;
          const fresh = (await db.items.get(it.id!))!;
          const p = processOne(fresh).finally(() => { inFlight.delete(it.id!); });
          inFlight.set(it.id!, { kind: it.kind, p });
          ensureHeartbeat();
        }
        if (!inFlight.size) break;
        await Promise.race([...inFlight.values()].map((x) => x.p));
      }
    } while (again); // a kick() arrived while we were finishing: scan once more (no lost wake-ups)
    await gc();
    const next = await db.items.where("status").anyOf(ACTIVE).toArray();
    if (next.length) {
      const now = Date.now();
      // wake when the earliest backoff ends or a foreign lease expires
      const times = next.map((i) => Math.max(i.nextAt, i.lease && i.lease.owner !== TAB ? i.lease.until + 50 : 0));
      const wait = Math.max(1000, Math.min(...times) - now);
      clearTimeout(timer);
      timer = setTimeout(kick, wait);
    }
  } catch (e) {
    diag(`queue loop error ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    clearTimeout(timer);
    timer = setTimeout(kick, 3000);
  } finally {
    running = false;
  }
}

/** Start or wake the worker. Never dropped: a kick during a run triggers another scan. */
export function kick() {
  if (typeof window === "undefined") return;
  void loop();
}

let wired = false;
export async function startQueue() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  await ensureDb();
  diag(`queue start tab=${TAB} ua=${navigator.userAgent.slice(0, 120)}`);
  // which compression path this device can use (once per session, off the critical path)
  setTimeout(() => { import("./compress/capabilities").then((m) => m.reportCapabilities()).catch(() => {}); }, 3000);
  // evidence for the old bug: was a (frozen) tab still holding the previous cross-tab lock?
  (navigator as Navigator & { locks?: LockManager }).locks?.query?.().then((q) => {
    const held = q.held?.filter((l) => l.name === "gl-queue").length ?? 0;
    const pending = q.pending?.filter((l) => l.name === "gl-queue").length ?? 0;
    if (held || pending) diag(`old gl-queue lock held=${held} pending=${pending}`);
  }).catch(() => {});
  const wake = async () => {
    // network came back: retry waiting items now instead of after their backoff
    await qdb().items.where("status").equals("waiting").filter((i) => i.error !== "budget" && i.error !== "limit").modify({ nextAt: 0 });
    kick();
  };
  addEventListener("online", wake);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  kick();
}
