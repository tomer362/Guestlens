import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { FACES, GALLERY } from "@/lib/config";
import { err, eventBy, json } from "@/lib/http";

export type PersonTile = { id: string; name: string | null; n: number; cover: string | null; hidden?: boolean };

/**
 * GET /api/people?slug=…&v=<people_version>  →  { enabled, people: PersonTile[] }
 * Same caching as /api/gallery: identical for every guest and keyed by version, so a given
 * version's list sits in the CDN and a new version is a new URL. Covers are separate, immutable
 * image URLs (/api/faces/:id/crop), so the list stays small and the circles load lazily.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const slug = q.get("slug");
  if (!slug) return err(400, "bad_request");
  const event = await eventBy("slug", slug);
  if (!event) return err(404, "not_found");
  const cache = { "Cache-Control": q.has("v") ? `public, max-age=0, s-maxage=${GALLERY.pageMaxAge}` : `public, max-age=0, s-maxage=${GALLERY.versionMaxAge}` };
  if (!event.facesEnabled) return json({ enabled: false, people: [] }, { headers: cache });
  if (!event.galleryPublic && (await getAdmin())?.eid !== event.id) return json({ private: true, enabled: true, people: [] }, { headers: cache });

  const r = await db().execute(sql`
    select id, name, media_count, cover_face_id from people
    where event_id = ${event.id} and not hidden and media_count > 0 and (face_count >= ${FACES.minFaces} or name is not null)
    order by media_count desc, created_at limit 500`);
  const people: PersonTile[] = (r.rows as { id: string; name: string | null; media_count: number; cover_face_id: string | null }[]).map((p) => ({
    id: p.id, name: p.name, n: Number(p.media_count), cover: p.cover_face_id ? `/api/faces/${p.cover_face_id}/crop` : null,
  }));
  return json({ enabled: true, people }, { headers: cache });
}
