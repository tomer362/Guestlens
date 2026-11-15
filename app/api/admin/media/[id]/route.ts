import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { err, json, parse } from "@/lib/http";
import { after } from "next/server";
import { bumpVersion } from "@/lib/media";
import { refreshPeople } from "@/lib/faces/store";
import { releaseStorage } from "@/lib/budget";
import { storage } from "@/lib/storage";

const Body = z.object({ hidden: z.boolean() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const { id } = await ctx.params;
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  const r = await db().update(schema.media).set({ status: b.hidden ? "hidden" : "ready" })
    .where(and(eq(schema.media.id, id), eq(schema.media.eventId, a.eid), inArray(schema.media.status, ["ready", "hidden"])))
    .returning({ id: schema.media.id });
  if (!r.length) return err(404, "not_found");
  await bumpVersion(a.eid); // guests' feeds drop/restore it within one poll
  after(() => refreshPeople(a.eid).catch((e) => console.error("[faces] refresh", e))); // people counts skip hidden items
  return json({ ok: true });
}

/**
 * DELETE → remove an item for good: its row (faces and face job cascade), then its files in the
 * store, and give its bytes back to the storage budget. Hiding (PATCH) is the reversible option.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return err(404, "not_found");
  const r = await db().delete(schema.media)
    .where(and(eq(schema.media.id, id), eq(schema.media.eventId, a.eid)))
    .returning({ url: schema.media.url, thumbUrl: schema.media.thumbUrl, bytes: schema.media.bytes, thumbBytes: schema.media.thumbBytes, status: schema.media.status });
  const m = r[0];
  if (!m) return err(404, "not_found");
  await bumpVersion(a.eid);
  after(async () => {
    const s = storage();
    const urls = [m.url, m.thumbUrl].filter((u): u is string => !!u && s.ownsUrl(u, a.eid, id));
    try { await s.delete(urls); } catch (e) { console.error("[admin] blob delete failed", id, e); }
    // a reservation that never completed was already given back by the reservation sweep
    if (m.status !== "reserved") await releaseStorage(Number(m.bytes) + Number(m.thumbBytes)).catch((e) => console.error("[admin] release", e));
    await refreshPeople(a.eid).catch((e) => console.error("[faces] refresh", e));
  });
  return json({ ok: true });
}
