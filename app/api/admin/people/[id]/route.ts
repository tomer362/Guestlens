import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { err, json, parse } from "@/lib/http";
import { renamePerson, setCover, setPersonHidden } from "@/lib/faces/store";

/** GET → this person's faces (for "not this person" and picking the cover). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const { id } = await ctx.params;
  const r = await db().execute(sql`
    select id, media_id, quality, locked from faces where person_id = ${id} and event_id = ${a.eid}
    order by quality desc limit 500`);
  return json({
    faces: (r.rows as { id: string; media_id: string; quality: number; locked: boolean }[]).map((f) => ({
      id: f.id, mediaId: f.media_id, q: Number(f.quality), locked: f.locked, crop: `/api/faces/${f.id}/crop?admin=1`,
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}

const Body = z.object({
  name: z.string().trim().max(60).nullable().optional(),
  hidden: z.boolean().optional(),
  coverFaceId: z.string().uuid().optional(),
});

/** PATCH { name?, hidden?, coverFaceId? }. Each locks the person's current faces. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const { id } = await ctx.params;
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  if (b.name !== undefined) await renamePerson(a.eid, id, b.name || null);
  if (b.hidden !== undefined) await setPersonHidden(a.eid, id, b.hidden);
  if (b.coverFaceId) await setCover(a.eid, id, b.coverFaceId);
  return json({ ok: true });
}
