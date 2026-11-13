import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { GALLERY } from "@/lib/config";
import { err, eventBy, json } from "@/lib/http";

export type GalleryItem = {
  id: string; kind: "photo" | "video"; url: string; thumbUrl: string;
  w: number | null; h: number | null; d: number | null; by: string | null; at: string; hidden?: boolean;
};

/**
 * GET /api/gallery?slug=…            newest page
 * GET /api/gallery?slug=…&since=ISO  items newer than ISO (polling)
 * GET /api/gallery?slug=…&before=ISO_id  next older page (keyset)
 * &admin=1 includes hidden items (admin cookie, never cached)
 *
 * Guest responses are identical for every viewer, so they're CDN-cacheable:
 * hundreds of phones polling every 15 s collapse into ~1 origin hit per s-maxage.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const slug = q.get("slug");
  if (!slug) return err(400, "bad_request");
  const event = await eventBy("slug", slug);
  if (!event) return err(404, "not_found");

  const wantAdmin = q.get("admin") === "1";
  const admin = wantAdmin ? await getAdmin() : null;
  if (wantAdmin && admin?.eid !== event.id) return err(401, "admin");
  if (!admin && !event.galleryPublic) {
    return json({ private: true, items: [] }, { headers: { "Cache-Control": `public, s-maxage=${GALLERY.sMaxAge}` } });
  }

  const m = schema.media;
  const statuses = admin ? (["ready", "hidden"] as const) : (["ready"] as const);
  const base = and(eq(m.eventId, event.id), inArray(m.status, [...statuses]));

  const since = q.get("since");
  const before = q.get("before");
  let rows;
  if (since) {
    rows = await db().select().from(m).where(and(base, gt(m.readyAt, new Date(since))))
      .orderBy(asc(m.readyAt), asc(m.id)).limit(200);
  } else {
    let cond = base;
    if (before) {
      const [at, id] = before.split("_");
      const t = new Date(at);
      cond = and(base, or(lt(m.readyAt, t), and(eq(m.readyAt, t), sql`${m.id} < ${id}`)));
    }
    rows = await db().select().from(m).where(cond).orderBy(desc(m.readyAt), desc(m.id)).limit(GALLERY.pageSize);
  }

  const items: GalleryItem[] = rows.map((r) => ({
    id: r.id, kind: r.kind, url: r.url!, thumbUrl: r.thumbUrl!, w: r.width, h: r.height, d: r.durationS,
    by: r.guestName, at: r.readyAt!.toISOString(), ...(admin ? { hidden: r.status === "hidden" } : {}),
  }));
  const last = rows[rows.length - 1];
  const nextBefore = !since && rows.length === GALLERY.pageSize && last ? `${last.readyAt!.toISOString()}_${last.id}` : null;

  return json({ items, nextBefore }, {
    headers: {
      "Cache-Control": admin ? "private, no-store" : `public, max-age=0, s-maxage=${GALLERY.sMaxAge}, stale-while-revalidate=30`,
    },
  });
}
