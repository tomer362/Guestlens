import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getGuest } from "@/lib/auth";
import { markReadyIfComplete } from "@/lib/media";
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

  const [m] = await db().select({ status: schema.media.status }).from(schema.media)
    .where(and(eq(schema.media.id, b.mediaId), eq(schema.media.guestId, g.gid))).limit(1);
  if (!m) return err(404, "not_found");
  if (m.status === "ready" || m.status === "hidden") return json({ ok: true });
  if (m.status === "failed") return err(410, "expired"); // client re-reserves

  await db().update(schema.media).set({ url: b.url, thumbUrl: b.thumbUrl })
    .where(eq(schema.media.id, b.mediaId));
  const ready = await markReadyIfComplete(b.mediaId);
  console.info("[complete]", { mediaId: b.mediaId, ready });
  return json({ ok: true });
}
