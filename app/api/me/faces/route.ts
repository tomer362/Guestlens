import { after } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getGuest } from "@/lib/auth";
import { err, json, parse } from "@/lib/http";
import { setGuestOptOut } from "@/lib/faces/store";
import { backfill, drainFaceJobs } from "@/lib/faces/jobs";

const Body = z.object({ optOut: z.boolean() });

/** GET → { optOut }: whether this guest's uploads are kept out of People. */
export async function GET() {
  const g = await getGuest();
  if (!g) return err(401, "no_guest");
  const [r] = await db().select({ optOut: schema.guests.facesOptOut }).from(schema.guests).where(eq(schema.guests.id, g.gid)).limit(1);
  return json({ optOut: !!r?.optOut }, { headers: { "Cache-Control": "private, no-store" } });
}

/** POST { optOut }: opting out deletes the faces found in this guest's uploads right away. */
export async function POST(req: Request) {
  const g = await getGuest();
  if (!g) return err(401, "no_guest");
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  await setGuestOptOut(g.gid, g.eid, b.optOut);
  if (!b.optOut && (await backfill(g.eid, g.gid)) > 0) after(() => drainFaceJobs({ eventId: g.eid }).then(() => undefined));
  return json({ ok: true });
}
