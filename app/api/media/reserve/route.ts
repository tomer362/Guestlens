import { z } from "zod";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getGuest } from "@/lib/auth";
import { consume, releaseStorage } from "@/lib/budget";
import { LIMITS } from "@/lib/config";
import { err, eventBy, json, parse } from "@/lib/http";
import { storage } from "@/lib/storage";
import { LQIP_RE } from "@/lib/lqip";

const Body = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["photo", "video"]),
  contentType: z.string(),
  bytes: z.number().int().positive(),
  thumbType: z.enum(["image/webp", "image/jpeg"]),
  thumbBytes: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationS: z.number().nonnegative().optional(),
  lqip: z.string().max(200).regex(LQIP_RE).optional(),
});

/** Mark stale reservations failed and give their bytes back. Runs at most once a minute per instance. */
let lastSweep = 0;
async function sweepExpired() {
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  const cutoff = new Date(Date.now() - LIMITS.reservationTtlMs);
  const rows = await db().update(schema.media).set({ status: "failed" })
    .where(and(eq(schema.media.status, "reserved"), lt(schema.media.createdAt, cutoff)))
    .returning({ b: schema.media.bytes, t: schema.media.thumbBytes });
  await releaseStorage(rows.reduce((s, r) => s + r.b + r.t, 0));
}

export async function POST(req: Request) {
  const g = await getGuest();
  if (!g) return err(401, "no_guest");
  const b = await parse(req, Body);
  if (!b) { console.warn("[reserve] bad body"); return err(400, "bad_request"); }

  const event = await eventBy("id", g.eid);
  if (!event) return err(404, "not_found");
  if (!event.uploadOpen) return json({ rejected: "closed" }, { status: 403 });

  const lim = b.kind === "photo" ? LIMITS.photo : LIMITS.video;
  if (!(lim.types as readonly string[]).includes(b.contentType) || b.bytes > lim.maxBytes) {
    return json({ rejected: "type" }, { status: 422 });
  }
  if (b.thumbBytes > LIMITS.thumb.maxBytes) return json({ rejected: "type" }, { status: 422 });
  if (b.durationS && b.durationS > LIMITS.maxVideoSeconds + 1) return json({ rejected: "type" }, { status: 422 });

  const d = db();
  void sweepExpired().catch(() => {}); // off the critical path

  // One round trip for the independent reads: dedup row, per-guest rate counters, guest name.
  const hourAgo = new Date(Date.now() - 3600_000);
  const dayAgo = new Date(Date.now() - 86_400_000);
  const [dupRows, rateRows, guestRows] = await d.batch([
    d.select().from(schema.media)
      .where(and(eq(schema.media.eventId, event.id), eq(schema.media.sha256, b.sha256))).limit(1),
    d.select({
      hourCount: sql<number>`count(*) filter (where ${schema.media.createdAt} >= ${hourAgo})`.mapWith(Number),
      dayBytes: sql<number>`coalesce(sum(${schema.media.bytes} + ${schema.media.thumbBytes}), 0)`.mapWith(Number),
    }).from(schema.media).where(and(eq(schema.media.guestId, g.gid), gte(schema.media.createdAt, dayAgo))),
    d.select({ n: schema.guests.displayName }).from(schema.guests).where(eq(schema.guests.id, g.gid)),
  ]);
  const existing = dupRows[0];
  if (existing && existing.status !== "failed") {
    if (existing.status === "reserved" && existing.guestId === g.gid) {
      return json({ mediaId: existing.id, tickets: await tickets(event.id, existing.id, existing.contentType, b.thumbType) });
    }
    return json({ duplicate: true, mediaId: existing.id });
  }

  // Per-guest rate limits.
  const rate = rateRows[0] ?? { hourCount: 0, dayBytes: 0 };
  if (rate.hourCount >= LIMITS.perGuestItemsPerHour || rate.dayBytes + b.bytes > LIMITS.perGuestBytesPerDay) {
    return json({ rejected: "limit" }, { status: 429 });
  }

  // Global budget: 2 advanced ops (file + thumb) and the bytes they'll occupy.
  const total = b.bytes + b.thumbBytes;
  const verdict = await consume(total, 2);
  if (!verdict.ok) console.warn("[reserve] budget", verdict.reason);
  if (!verdict.ok) return json({ rejected: "budget", reason: verdict.reason }, { status: 507 });

  const guest = guestRows[0];
  const values = {
    eventId: event.id, guestId: g.gid, guestName: guest?.n ?? null, kind: b.kind, sha256: b.sha256,
    contentType: b.contentType, bytes: b.bytes, thumbBytes: b.thumbBytes,
    width: b.width, height: b.height, durationS: b.durationS, lqip: b.lqip ?? null,
    status: "reserved" as const, createdAt: new Date(), url: null, thumbUrl: null, readyAt: null,
  };

  let id: string | undefined;
  if (existing) {
    // A failed earlier attempt with the same hash: revive the row.
    const [r] = await d.update(schema.media).set(values)
      .where(and(eq(schema.media.id, existing.id), eq(schema.media.status, "failed"))).returning({ id: schema.media.id });
    id = r?.id;
  } else {
    const [r] = await d.insert(schema.media).values(values)
      .onConflictDoNothing({ target: [schema.media.eventId, schema.media.sha256] }).returning({ id: schema.media.id });
    id = r?.id;
  }
  if (!id) {
    await releaseStorage(total); // lost a race to an identical upload
    return json({ duplicate: true });
  }
  console.info("[reserve] ok", { mediaId: id, kind: b.kind, bytes: b.bytes, thumbBytes: b.thumbBytes });
  return json({ mediaId: id, tickets: await tickets(event.id, id, b.contentType, b.thumbType) });
}

async function tickets(eventId: string, mediaId: string, contentType: string, thumbType: string) {
  const s = storage();
  const [file, thumb] = await Promise.all([
    s.createUpload({ eventId, mediaId, part: "file", contentType, maxBytes: 0 }),
    s.createUpload({ eventId, mediaId, part: "thumb", contentType: thumbType, maxBytes: 0 }),
  ]);
  return { file, thumb };
}
