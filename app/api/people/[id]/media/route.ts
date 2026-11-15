import { and, desc, eq, exists, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { GALLERY } from "@/lib/config";
import { err, eventBy, json } from "@/lib/http";
import { cursorOf, galleryCols, toGalleryItem } from "@/lib/gallery";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * GET /api/people/:id/media?slug=…&v=<people_version>[&before=ISO_id]
 * → { person: { id, name }, items: GalleryItem[], nextBefore }. Photos/videos this person is in,
 * newest first, same tile shape and keyset paging as /api/gallery.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const slug = q.get("slug");
  if (!slug || !UUID.test(id)) return err(400, "bad_request");
  const event = await eventBy("slug", slug);
  if (!event) return err(404, "not_found");
  const admin = (await getAdmin())?.eid === event.id;
  if (!event.facesEnabled && !admin) return err(404, "not_found");
  if (!event.galleryPublic && !admin) return json({ private: true, items: [] });

  const [person] = await db().select({ id: schema.people.id, name: schema.people.name, hidden: schema.people.hidden })
    .from(schema.people).where(and(eq(schema.people.id, id), eq(schema.people.eventId, event.id))).limit(1);
  if (!person || (person.hidden && !admin)) return err(404, "not_found");

  const m = schema.media, f = schema.faces;
  let cond = and(eq(m.eventId, event.id), eq(m.status, "ready"),
    exists(db().select({ x: sql`1` }).from(f).where(and(eq(f.mediaId, m.id), eq(f.personId, id)))));
  const before = q.get("before");
  if (before) {
    const [at, bid] = before.split("_");
    const t = new Date(at);
    cond = and(cond, or(lt(m.readyAt, t), and(eq(m.readyAt, t), sql`${m.id} < ${bid}`)));
  }
  const rows = await db().select(galleryCols).from(m).where(cond).orderBy(desc(m.readyAt), desc(m.id)).limit(GALLERY.pageSize);
  const last = rows[rows.length - 1];
  return json({
    person: { id: person.id, name: person.name },
    items: rows.map((r) => toGalleryItem(r)),
    nextBefore: rows.length === GALLERY.pageSize && last ? cursorOf(last) : null,
  }, { headers: { "Cache-Control": admin ? "private, no-store" : q.has("v") ? `public, max-age=0, s-maxage=${GALLERY.pageMaxAge}` : `public, max-age=0, s-maxage=${GALLERY.versionMaxAge}` } });
}
