import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getGuest } from "@/lib/auth";
import { storage } from "@/lib/storage";
import { err, json, parse } from "@/lib/http";

const Body = z.object({ mediaId: z.string().uuid(), url: z.string().url(), thumbUrl: z.string().url() });

export async function POST(req: Request) {
  const g = await getGuest();
  if (!g) return err(401, "no_guest");
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");

  const s = storage();
  if (!s.ownsUrl(b.url, g.eid, b.mediaId) || !s.ownsUrl(b.thumbUrl, g.eid, b.mediaId)) {
    console.warn("[complete] bad_url", b.url, b.thumbUrl);
    return err(400, "bad_url");
  }

  // One round trip: store URLs, flip to ready, bump the event's feed version.
  const r = await db().execute(sql`
    with u as (
      update media set url = ${b.url}, thumb_url = ${b.thumbUrl}, status = 'ready', ready_at = now()
      where id = ${b.mediaId} and guest_id = ${g.gid} and status = 'reserved'
      returning event_id
    ), v as (
      update events set media_version = media_version + 1 where id in (select event_id from u) returning 1
    )
    select count(*)::int as n from u`);
  if (Number((r.rows[0] as { n: number }).n) > 0) return json({ ok: true });

  // Not updated: find out why (rare path)
  const [m] = await db().select({ status: schema.media.status }).from(schema.media)
    .where(and(eq(schema.media.id, b.mediaId), eq(schema.media.guestId, g.gid))).limit(1);
  if (!m) return err(404, "not_found");
  if (m.status === "ready" || m.status === "hidden") return json({ ok: true }); // idempotent
  return err(410, "expired"); // reservation expired → client re-reserves
}
