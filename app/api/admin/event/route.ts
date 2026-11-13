import { z } from "zod";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { err, eventBy, invalidateEvent, json, parse } from "@/lib/http";

const Body = z.object({
  uploadOpen: z.boolean().optional(),
  galleryPublic: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  pin: z.string().max(20).nullable().optional(), // null removes the PIN
});

export async function GET() {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const e = await eventBy("id", a.eid);
  if (!e) return err(404, "not_found");
  return json({ id: e.id, slug: e.slug, name: e.name, uploadOpen: e.uploadOpen, galleryPublic: e.galleryPublic, hasPin: !!e.pinHash });
}

export async function PATCH(req: Request) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  const set: Partial<typeof schema.events.$inferInsert> = {};
  if (b.uploadOpen !== undefined) set.uploadOpen = b.uploadOpen;
  if (b.galleryPublic !== undefined) set.galleryPublic = b.galleryPublic;
  if (b.name) set.name = b.name;
  if (b.pin !== undefined) set.pinHash = b.pin ? await bcrypt.hash(b.pin, 10) : null;
  const [row] = await db().update(schema.events).set(set).where(eq(schema.events.id, a.eid)).returning();
  invalidateEvent(row);
  return json({ ok: true });
}
