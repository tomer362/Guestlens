import { after } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { ensureMigrated } from "@/lib/db/migrate";
import { GALLERY } from "@/lib/config";
import { DEMO_EVENT, demoMode, err, json } from "@/lib/http";

// the poll can restart a stalled face backlog in the background (lib/faces/jobs.ts)
export const maxDuration = 60;

/**
 * GET /api/gallery/version?slug=…  →  { v, pv, faces }  (or { private: true })
 * The cheapest possible poll: one primary-key read, CDN-cached for a couple of seconds.
 * `v` is the album version, `pv` the People version (FACES.md), `faces` whether People is on.
 * `&fresh=…` (sent right after this guest's own upload) bypasses the CDN.
 *
 * While faces are on, the same read checks for face work nobody is doing (a function that died,
 * a burst) and drains it after replying. With the CDN in front, that's at most one check per
 * couple of seconds per region, only while someone has the app open.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const slug = q.get("slug");
  if (!slug) return err(400, "bad_request");
  const headers = { "Cache-Control": q.has("fresh") ? "private, no-store" : `public, max-age=0, s-maxage=${GALLERY.versionMaxAge}` };
  if (demoMode()) {
    return slug === DEMO_EVENT.slug ? json({ v: 0, pv: 0, faces: false }, { headers }) : err(404, "not_found");
  }
  await ensureMigrated();
  const r = await db().execute(sql`
    select e.id, e.media_version, e.people_version, e.gallery_public, e.faces_enabled,
      e.faces_enabled and e.faces_lock_until < now() and (
        exists (select 1 from face_jobs j where j.event_id = e.id and j.status = 'pending' and j.lease_until < now())
        or exists (select 1 from faces f where f.event_id = e.id and not f.clustered)) as backlog
    from events e where e.slug = ${slug}`);
  const row = r.rows[0] as { id: string; media_version: string | number; people_version: string | number; gallery_public: boolean; faces_enabled: boolean; backlog: boolean } | undefined;
  if (!row) return err(404, "not_found");
  if (row.backlog) {
    after(() => import("@/lib/faces/jobs").then((j) => j.drainFaceJobs({ eventId: row.id })).catch((e) => console.error("[faces] kick", e)));
  }
  if (!row.gallery_public && !q.has("admin")) return json({ private: true }, { headers });
  return json({ v: Number(row.media_version), pv: Number(row.people_version), faces: row.faces_enabled }, { headers });
}
