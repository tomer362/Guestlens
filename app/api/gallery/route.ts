import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { GALLERY } from "@/lib/config";
import { err, eventBy, json } from "@/lib/http";

export type GalleryItem = {
  id: string; kind: "photo" | "video"; url: string; thumbUrl: string;
  w: number | null; h: number | null; d: number | null; by: string | null; at: string; hidden?: boolean;
  /** inline blur placeholder */ p?: string;
};

/**
 * GET /api/gallery?slug=…            newest page
 * GET /api/gallery?slug=…&since=ISO  items newer than ISO (polling)
 * GET /api/gallery?slug=…&before=ISO_id  next older page (keyset)
 * &admin=1 includes hidden items (admin cookie, never cached)
 *
 * Clients poll /api/gallery/version and refetch the first page with &v=<version> only when it
 * changes (see useGallery). Responses are identical for every guest, so they're CDN-shared.
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
    return json({ private: true, items: [] }, { headers: { "Cache-Control": `public, max-age=0, s-maxage=${GALLERY.versionMaxAge}` } });
  }

  const m = schema.media;
  const statuses = admin ? (["ready", "hidden"] as const) : (["ready"] as const);
  const base = and(eq(m.eventId, event.id), inArray(m.status, [...statuses]));

  // only what the response uses
  const cols = {
    id: m.id, kind: m.kind, url: m.url, thumbUrl: m.thumbUrl, width: m.width, height: m.height,
    durationS: m.durationS, guestName: m.guestName, readyAt: m.readyAt, status: m.status, lqip: m.lqip,
  };
  const since = q.get("since");
  const before = q.get("before");
  let rows;
  if (since) {
    rows = await db().select(cols).from(m).where(and(base, gt(m.readyAt, new Date(since))))
      .orderBy(asc(m.readyAt), asc(m.id)).limit(200);
  } else {
    let cond = base;
    if (before) {
      const [at, id] = before.split("_");
      const t = new Date(at);
      cond = and(base, or(lt(m.readyAt, t), and(eq(m.readyAt, t), sql`${m.id} < ${id}`)));
    }
    rows = await db().select(cols).from(m).where(cond).orderBy(desc(m.readyAt), desc(m.id)).limit(GALLERY.pageSize);
  }

  const items: GalleryItem[] = rows.map((r) => ({
    id: r.id, kind: r.kind, url: r.url!, thumbUrl: r.thumbUrl!, w: r.width, h: r.height, d: r.durationS,
    by: r.guestName, at: r.readyAt!.toISOString(), ...(r.lqip ? { p: r.lqip } : {}), ...(admin ? { hidden: r.status === "hidden" } : {}),
  }));
  const last = rows[rows.length - 1];
  const nextBefore = !since && rows.length === GALLERY.pageSize && last ? `${last.readyAt!.toISOString()}_${last.id}` : null;

  // Keyed by feed version (&v=…): a given version's page never changes, so it can sit in the CDN
  // and be shared by every guest; a new version is a new URL, so it is never stale.
  const cache = admin || q.has("fresh") ? "private, no-store"
    : q.has("v") ? `public, max-age=0, s-maxage=${GALLERY.pageMaxAge}`
    : `public, max-age=0, s-maxage=${GALLERY.versionMaxAge}`;
  return json({ items, nextBefore }, { headers: { "Cache-Control": cache } });
}
