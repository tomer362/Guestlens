"use client";
import Dexie, { type Table } from "dexie";
import type { UploadTicket } from "@/lib/storage/provider";
import { compressPhoto } from "./compress/photo";
import { compressVideo, posterFrame, posterFromMp4, VideoError } from "./compress/video";
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
  /** the original (dropped after compression to free IndexedDB space) */
  original?: Blob;
  file?: Blob;
  fileType?: string;
  thumb?: Blob;
  thumbType?: "image/webp" | "image/jpeg";
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
}

class QueueDB extends Dexie {
  items!: Table<QueueItem, number>;
  constructor() {
    super("guestlens");
    this.version(1).stores({ items: "++id, slug, status, nextAt, createdAt" });
  }
}
let _db: QueueDB | null = null;
export const qdb = () => (_db ??= new QueueDB());

const ACTIVE: ItemStatus[] = ["queued", "compressing", "uploading", "waiting"];
const CONCURRENCY = 2;

export async function enqueue(slug: string, files: File[]) {
  const now = Date.now();
  const items: QueueItem[] = files
    .filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"))
    .map((f, i) => ({
      slug, kind: f.type.startsWith("video/") ? "video" : "photo", status: "queued",
      createdAt: now + i, original: f, attempts: 0, nextAt: 0,
    }));
  await qdb().items.bulkAdd(items);
  kick();
  return items.length;
}

export async function retry(id: number) {
  await qdb().items.update(id, { status: "queued", attempts: 0, nextAt: 0, error: undefined });
  kick();
}
export async function removeItem(id: number) { await qdb().items.delete(id); }

/** Drop finished items after a day so IndexedDB stays small. */
async function gc() {
  const cutoff = Date.now() - 86_400_000;
  await qdb().items.where("createdAt").below(cutoff)
    .filter((i) => i.status === "done" || i.status === "duplicate").delete();
}

function backoff(attempts: number) {
  const base = Math.min(60_000, 1000 * 2 ** attempts);
  return base / 2 + Math.random() * base / 2; // jitter
}

class Rejected extends Error { constructor(public code: string) { super(code); } }

async function prepare(it: QueueItem): Promise<Partial<QueueItem>> {
  const src = it.original!;
  if (it.kind === "photo") {
    const t0 = performance.now();
    const { main, thumb, lqip } = await compressPhoto(src);
    return {
      file: main.blob, fileType: main.type, thumb: thumb.blob, thumbType: thumb.type, lqip,
      diag: `photo ${((performance.now() - t0) / 1000).toFixed(1)}s · ${(src.size / 1e6).toFixed(1)}MB → ${(main.blob.size / 1e3).toFixed(0)}KB`,
      width: main.width, height: main.height, sha256: await sha256Hex(main.blob),
    };
  }
  const t0 = performance.now();
  const v = await compressVideo(src, (p) => qdb().items.update(it.id!, { progress: p * 0.5 }),
    (info) => qdb().items.update(it.id!, { diag: info }));
  // Prefer a frame decoded from the compressed MP4; fall back to a <video> grab.
  const fromMp4 = await posterFromMp4(v.blob);
  const poster = fromMp4 ? null : await posterFrame(v.blob).catch(() => posterFrame(src));
  const thumb = fromMp4?.thumb ?? poster!.thumb;
  const lqip = fromMp4 ? fromMp4.lqip : poster?.lqip;
  const duration = v.duration ?? poster?.duration ?? 0;
  if (duration > 181) throw new Rejected("tooLong");
  return {
    file: v.blob, fileType: "video/mp4", thumb: thumb.blob, thumbType: thumb.type, lqip,
    width: v.width ?? poster?.width, height: v.height ?? poster?.height,
    durationS: duration > 0 ? Math.round(duration * 10) / 10 : undefined,
    diag: `${v.diag ?? v.path} · total ${((performance.now() - t0) / 1000).toFixed(0)}s`,
    sha256: await sha256Hex(v.blob),
  };
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

async function processOne(it: QueueItem) {
  const db = qdb();
  const id = it.id!;
  try {
    // 1. compress (once; the result is persisted)
    if (!it.file) {
      await db.items.update(id, { status: "compressing", progress: 0 });
      const prepared = await prepare(it);
      await db.items.update(id, { ...prepared, original: undefined });
      it.diag = prepared.diag;
      it = { ...it, ...prepared, original: undefined };
    }

    // 2. reserve
    const upStart = Date.now();
    await db.items.update(id, { status: "uploading" });
    if (!it.mediaId || !it.tickets) {
      await db.items.update(id, { stage: "reserve" });
      const body = {
        sha256: it.sha256, kind: it.kind, contentType: it.fileType, bytes: it.file!.size,
        thumbType: it.thumbType, thumbBytes: it.thumb!.size, width: it.width, height: it.height,
        durationS: it.durationS, lqip: it.lqip,
      };
      let r = await post("/api/media/reserve", body);
      if (r.status === 401) { await ensureJoined(it.slug, true); r = await post("/api/media/reserve", body); }
      if (r.j.duplicate) { await db.items.update(id, { status: "duplicate", file: undefined, progress: 1 }); return; }
      if (r.j.rejected) throw new Rejected(r.j.rejected);
      if (!r.ok) throw new Error(`reserve_${r.status}${r.j.error ? `:${r.j.error}` : ""}`);
      it.mediaId = r.j.mediaId; it.tickets = r.j.tickets;
      await db.items.update(id, { mediaId: it.mediaId, tickets: it.tickets });
    }

    // 3. upload directly to storage (thumb first: it's tiny and makes the gallery look alive)
    if (!it.thumbUrl) {
      await db.items.update(id, { stage: "thumb" });
      it.thumbUrl = await uploadWithTicket(it.tickets!.thumb, it.thumb!);
      await db.items.update(id, { thumbUrl: it.thumbUrl });
    }
    if (!it.fileUrl) {
      await db.items.update(id, { stage: "file" });
      const start = it.kind === "video" ? 0.5 : 0;
      let lastWrite = 0;
      it.fileUrl = await uploadWithTicket(it.tickets!.file, it.file!, (f) => {
        // throttle IndexedDB writes (each one re-renders the list)
        const now = Date.now();
        if (now - lastWrite > 400 || f >= 1) { lastWrite = now; db.items.update(id, { progress: start + f * (1 - start) }); }
      });
      await db.items.update(id, { fileUrl: it.fileUrl });
    }

    // 4. complete
    const c = await post("/api/media/complete", { mediaId: it.mediaId, url: it.fileUrl, thumbUrl: it.thumbUrl });
    if (c.status === 410) {
      // reservation expired (e.g. phone was offline > 1 h): start over from reserve
      await db.items.update(id, { mediaId: undefined, tickets: undefined, fileUrl: undefined, thumbUrl: undefined });
      throw new Error("expired");
    }
    if (!c.ok) throw new Error(`complete_${c.status}${c.j.error ? `:${c.j.error}` : ""}`);
    if (it.kind === "video") diag(`video uploaded ${((Date.now() - upStart) / 1000).toFixed(0)}s · ${it.diag ?? ""}`);
    await db.items.update(id, { status: "done", progress: 1, file: undefined, tickets: undefined,
      diag: `${it.diag ?? ""} · upload ${((Date.now() - upStart) / 1000).toFixed(0)}s` });
  } catch (e) {
    if (e instanceof Rejected || e instanceof VideoError) {
      const code = e instanceof VideoError ? e.code : e.code;
      // budget/limit may clear later → retry slowly; others are final
      if (code === "limit" || code === "budget") {
        await db.items.update(id, { status: "waiting", error: code, attempts: it.attempts + 1, nextAt: Date.now() + 5 * 60_000 });
      } else {
        await db.items.update(id, { status: "rejected", error: code, original: undefined });
      }
      return;
    }
    diag(`item failed kind=${it.kind} stage=${(await db.items.get(id))?.stage ?? "prepare"} err=${String((e as Error)?.message ?? e).slice(0, 200)}`);
    const attempts = it.attempts + 1;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    await db.items.update(id, {
      status: attempts > 12 ? "failed" : "waiting",
      error: offline ? "offline" : `${(await db.items.get(id))?.stage ?? "prepare"}: ${String((e as Error).message ?? e)}`.slice(0, 160),
      attempts, nextAt: Date.now() + backoff(attempts),
    });
  }
}

let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;

async function loop() {
  if (running) return;
  running = true;
  try {
    const db = qdb();
    // items left "in progress" by a closed tab are resumed
    await db.items.where("status").anyOf("compressing", "uploading").modify({ status: "queued" });
    // Two lanes: one video at a time (heavy) next to up to CONCURRENCY photos,
    // so photos never wait behind a long video conversion.
    const inFlight = new Map<number, { kind: QueueItem["kind"]; p: Promise<void> }>();
    for (;;) {
      const now = Date.now();
      const ready = (await db.items.where("status").anyOf(ACTIVE).filter((i) => i.nextAt <= now).sortBy("createdAt"))
        .filter((i) => !inFlight.has(i.id!));
      const busy = [...inFlight.values()];
      const freeVideo = busy.some((x) => x.kind === "video") ? 0 : 1;
      const freePhotos = CONCURRENCY - busy.filter((x) => x.kind === "photo").length;
      const start = [
        ...ready.filter((i) => i.kind === "video").slice(0, freeVideo),
        ...ready.filter((i) => i.kind === "photo").slice(0, Math.max(0, freePhotos)),
      ];
      for (const it of start) {
        const p = processOne(it).finally(() => inFlight.delete(it.id!));
        inFlight.set(it.id!, { kind: it.kind, p });
      }
      if (!inFlight.size) break;
      await Promise.race([...inFlight.values()].map((x) => x.p));
    }
    await gc();
    const next = await db.items.where("status").anyOf(ACTIVE).toArray();
    if (next.length) {
      const wait = Math.max(1000, Math.min(...next.map((i) => i.nextAt)) - Date.now());
      clearTimeout(timer);
      timer = setTimeout(kick, wait);
    }
  } finally {
    running = false;
  }
}

/** Start or wake the worker. Only one tab works the queue at a time (Web Locks). */
export function kick() {
  if (typeof window === "undefined") return;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks) locks.request("gl-queue", { ifAvailable: true }, async (lock) => { if (lock) await loop(); });
  else loop();
}

let wired = false;
export function startQueue() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  const wake = async () => {
    // network came back: retry waiting items now instead of after their backoff
    await qdb().items.where("status").equals("waiting").filter((i) => i.error !== "budget" && i.error !== "limit").modify({ nextAt: 0 });
    kick();
  };
  addEventListener("online", wake);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  kick();
}
