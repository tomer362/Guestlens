import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getGuest } from "@/lib/auth";
import { err, json, parse } from "@/lib/http";

const Body = z.object({ name: z.string().trim().max(60).nullable() });

export async function PATCH(req: Request) {
  const g = await getGuest();
  if (!g) return err(401, "no_guest");
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  await db().update(schema.guests).set({ displayName: b.name || null }).where(eq(schema.guests.id, g.gid));
  return json({ ok: true });
}
