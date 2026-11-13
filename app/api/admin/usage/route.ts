import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { readUsage } from "@/lib/budget";
import { getPlan } from "@/lib/config";
import { err, json } from "@/lib/http";

export async function GET() {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const m = schema.media;
  const [usage, counts, guests] = await Promise.all([
    readUsage(),
    db().select({
      status: m.status, kind: m.kind, n: sql<number>`count(*)`.mapWith(Number),
      bytes: sql<number>`coalesce(sum(${m.bytes} + ${m.thumbBytes}),0)`.mapWith(Number),
    }).from(m).where(eq(m.eventId, a.eid)).groupBy(m.status, m.kind),
    db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.guests).where(and(eq(schema.guests.eventId, a.eid))),
  ]);
  return json({ plan: getPlan(), ...usage, counts, guests: guests[0]?.n ?? 0 }, { headers: { "Cache-Control": "no-store" } });
}
