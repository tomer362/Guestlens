import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { err } from "@/lib/http";

/** Plain list of full-size URLs (one per line). Download everything with: xargs -n1 curl -O < urls.txt */
export async function GET() {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const m = schema.media;
  const rows = await db().select({ url: m.url }).from(m)
    .where(and(eq(m.eventId, a.eid), inArray(m.status, ["ready", "hidden"]))).orderBy(asc(m.readyAt));
  return new Response(rows.map((r) => r.url).join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="urls.txt"' },
  });
}
