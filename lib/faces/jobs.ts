/**
 * Face job queue on Postgres (FACES.md §1). An item is enqueued the moment it becomes `ready`,
 * whether that came from the phone's /complete or from Blob's upload webhook. So a phone that is
 * pocketed right after its upload still gets its faces found: nothing here needs the phone.
 *
 * Draining runs in `after()` (once the response has been sent) from upload completions, from the
 * album's version poll when a backlog exists, from the admin page and from a daily cron.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { FACES, LIMITS } from "@/lib/config";
import { ModelUnavailable } from "./model";
import { clusterEvent, saveFaces } from "./store";

const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];

/** Queue one ready item if its event has faces on and its guest didn't opt out. Idempotent. */
export async function enqueueFaceJob(mediaId: string): Promise<boolean> {
  const r = await db().execute(sql`
    insert into face_jobs (media_id, event_id)
    select m.id, m.event_id from media m
      join events e on e.id = m.event_id and e.faces_enabled
      join guests g on g.id = m.guest_id and not g.faces_opt_out
    where m.id = ${mediaId} and m.status = 'ready'
    on conflict do nothing returning media_id`);
  return r.rows.length > 0;
}

/** Queue everything already in the album (faces just turned on, or a guest opted back in). */
export async function backfill(eventId: string, guestId?: string): Promise<number> {
  const r = await db().execute(sql`
    insert into face_jobs (media_id, event_id)
    select m.id, m.event_id from media m join guests g on g.id = m.guest_id and not g.faces_opt_out
    where m.event_id = ${eventId} and m.status in ('ready', 'hidden') ${guestId ? sql`and m.guest_id = ${guestId}` : sql``}
    on conflict do nothing returning media_id`);
  return r.rows.length;
}

/** Cheap check for the version poll: is there work nobody is doing right now? */
export async function hasBacklog(eventId: string): Promise<boolean> {
  const r = await db().execute(sql`
    select exists (select 1 from face_jobs where event_id = ${eventId} and status = 'pending' and lease_until < now())
        or exists (select 1 from faces where event_id = ${eventId} and not clustered) as b`);
  return !!rows<{ b: boolean }>(r)[0]?.b;
}

interface Claimed { media_id: string; event_id: string; attempts: number; kind: "photo" | "video"; url: string | null; thumb_url: string | null; status: string }

/** Lease up to n jobs (any event, or one). SKIP LOCKED: parallel drains never take the same job. */
async function claim(n: number, eventId?: string): Promise<Claimed[]> {
  return rows<Claimed>(await db().execute(sql`
    with c as (
      select media_id from face_jobs
      where status = 'pending' and lease_until < now() ${eventId ? sql`and event_id = ${eventId}` : sql``}
      order by created_at limit ${n} for update skip locked
    ), u as (
      update face_jobs j set lease_until = now() + make_interval(secs => ${FACES.jobLeaseMs / 1000}), attempts = attempts + 1
      from c where j.media_id = c.media_id returning j.media_id, j.event_id, j.attempts
    )
    select u.*, m.kind, m.url, m.thumb_url, m.status from u join media m on m.id = u.media_id`));
}

async function fetchImage(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/^image\/(webp|jpeg)/.test(type)) throw new Error(`type_${type.slice(0, 30)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("too_big");
  return buf;
}

async function processJob(j: Claimed) {
  // photos: the 2048 px upload; videos: the poster frame the phone made from the original
  const src = j.kind === "photo" ? j.url : j.thumb_url;
  if (!src) throw new Error("no_url");
  const { analyzeImage } = await import("./pipeline"); // sharp + ONNX only load in functions that do face work
  const found = await analyzeImage(await fetchImage(src, j.kind === "photo" ? LIMITS.photo.maxBytes : LIMITS.thumb.maxBytes));
  await saveFaces(j.event_id, j.media_id, found);
  await db().execute(sql`update face_jobs set status = 'done', faces = ${found.length}, error = null where media_id = ${j.media_id}`);
  return found.length;
}

export interface DrainResult { jobs: number; faces: number; failed: number; unavailable?: string }

/**
 * Process queued jobs until the time budget runs out, then cluster the events touched.
 * Never throws: it runs after the response, where nobody would see the error.
 */
export async function drainFaceJobs(opts: { eventId?: string; budgetMs?: number } = {}): Promise<DrainResult> {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? FACES.drainBudgetMs;
  const res: DrainResult = { jobs: 0, faces: 0, failed: 0 };
  const events = new Set<string>(opts.eventId ? [opts.eventId] : []);
  try {
    while (Date.now() - t0 < budget * 0.75) {
      const batch = await claim(FACES.jobsPerDrain, opts.eventId);
      if (!batch.length) break;
      for (const j of batch) {
        events.add(j.event_id);
        if (j.status !== "ready" && j.status !== "hidden") {
          await db().execute(sql`update face_jobs set status = 'done', faces = 0 where media_id = ${j.media_id}`);
          continue;
        }
        try {
          res.faces += await processJob(j);
          res.jobs++;
        } catch (e) {
          if (e instanceof ModelUnavailable) {
            // not this job's fault: hand it back untouched and stop; retry in 10 minutes
            await db().execute(sql`
              update face_jobs set attempts = greatest(0, attempts - 1), lease_until = now() + interval '10 minutes', error = ${e.message.slice(0, 300)}
              where media_id = any(${`{${batch.map((b) => b.media_id).join(",")}}`}::uuid[]) and status = 'pending'`);
            res.unavailable = e.message;
            return res;
          }
          const msg = String((e as Error)?.message ?? e).slice(0, 300);
          const last = j.attempts >= FACES.maxAttempts;
          await db().execute(sql`
            update face_jobs set status = ${last ? "failed" : "pending"}, error = ${msg},
              lease_until = now() + make_interval(secs => ${30 * j.attempts})
            where media_id = ${j.media_id}`);
          res.failed++;
          console.warn("[faces] job failed", j.media_id, j.attempts, msg);
        }
        if (Date.now() - t0 > budget * 0.75) break;
      }
    }
    for (const e of events) await clusterEvent(e, { budgetMs: Math.max(5_000, budget - (Date.now() - t0)) });
  } catch (e) {
    console.error("[faces] drain error", e);
  }
  if (res.jobs || res.failed) console.info("[faces] drain", { ...res, ms: Date.now() - t0 });
  return res;
}
