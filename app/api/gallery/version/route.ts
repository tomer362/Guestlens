import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { ensureMigrated } from "@/lib/db/migrate";
import { GALLERY } from "@/lib/config";
import { DEMO_EVENT, demoMode, err, json } from "@/lib/http";

/**
 * GET /api/gallery/version?slug=…  →  { v }  (or { private: true })
 * The cheapest possible poll: one primary-key read, CDN-cached for a couple of seconds.
 * `&fresh=…` (sent right after this guest's own upload) bypasses the CDN.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const slug = q.get("slug");
  if (!slug) return err(400, "bad_request");
  const headers = { "Cache-Control": q.has("fresh") ? "private, no-store" : `public, max-age=0, s-maxage=${GALLERY.versionMaxAge}` };
  if (demoMode()) {
    return slug === DEMO_EVENT.slug ? json({ v: 0 }, { headers }) : err(404, "not_found");
  }
  await ensureMigrated();
  const r = await db().execute(sql`select media_version, gallery_public from events where slug = ${slug}`);
  const row = r.rows[0] as { media_version: string | number; gallery_public: boolean } | undefined;
  if (!row) return err(404, "not_found");
  if (!row.gallery_public && !q.has("admin")) return json({ private: true }, { headers });
  return json({ v: Number(row.media_version) }, { headers });
}
