import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * GET /api/faces/:id/crop → the 96 px WebP face crop (People page circles).
 * A face's crop never changes, so it's cached hard at the CDN; the id is unguessable.
 * Faces of hidden people are 404 for guests; `?admin=1` (admin cookie) sees them, uncached.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return new Response(null, { status: 400 });
  const admin = new URL(req.url).searchParams.has("admin") ? await getAdmin() : null;
  const r = await db().execute(sql`
    select f.crop, f.event_id, coalesce(p.hidden, false) as hidden, e.faces_enabled
    from faces f join events e on e.id = f.event_id left join people p on p.id = f.person_id
    where f.id = ${id}`);
  const row = r.rows[0] as { crop: string; event_id: string; hidden: boolean; faces_enabled: boolean } | undefined;
  const isAdmin = !!row && admin?.eid === row.event_id;
  const visible = !!row && (isAdmin || (row.faces_enabled && !row.hidden));
  const m = visible ? row!.crop.match(/^data:(image\/(?:webp|jpeg));base64,(.+)$/) : null;
  if (!m) return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  return new Response(Buffer.from(m[2], "base64"), {
    headers: { "Content-Type": m[1], "Cache-Control": isAdmin ? "private, no-store" : "public, max-age=86400, s-maxage=31536000, immutable" },
  });
}
