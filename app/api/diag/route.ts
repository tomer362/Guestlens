import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getGuest } from "@/lib/auth";
import { err, eventBy, json } from "@/lib/http";

/**
 * Technical upload diagnostics (codec, resolution, sizes, timings, user agent): no media,
 * no names. Lets us see why a phone is slow without the guest relaying console output.
 */
export async function POST(req: Request) {
  const g = await getGuest();
  if (!g) return err(401, "no_guest");
  const body = (await req.json().catch(() => null)) as { msg?: unknown } | null;
  const msg = typeof body?.msg === "string" ? body.msg.slice(0, 600) : "";
  if (!msg) return err(400, "bad_request");
  await db().execute(sql`insert into diag_log (event_id, guest_id, msg) values (${g.eid}, ${g.gid}, ${msg})`);
  // keep the table tiny
  await db().execute(sql`delete from diag_log where event_id = ${g.eid} and id < (select coalesce(max(id),0) - 500 from diag_log where event_id = ${g.eid})`);
  return json({ ok: true });
}

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug");
  const e = slug ? await eventBy("slug", slug) : null;
  if (!e) return err(404, "not_found");
  const r = await db().execute(sql`select created_at, left(guest_id::text, 8) as g, msg from diag_log where event_id = ${e.id} order by id desc limit 80`);
  return json(r.rows, { headers: { "Cache-Control": "no-store" } });
}
