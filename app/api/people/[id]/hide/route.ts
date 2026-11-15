import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getGuest } from "@/lib/auth";
import { err, json } from "@/lib/http";
import { setPersonHidden } from "@/lib/faces/store";

/**
 * POST /api/people/:id/hide: a guest's "This is me, hide me". Hides the person from the
 * People page for everyone (the photos stay in the album); only the admin can undo it.
 * Hiding is the privacy-safe direction, so any guest of the event may do it.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await getGuest();
  if (!g) return err(401, "no_guest");
  const { id } = await ctx.params;
  const [p] = await db().select({ id: schema.people.id }).from(schema.people)
    .where(and(eq(schema.people.id, id), eq(schema.people.eventId, g.eid))).limit(1);
  if (!p) return err(404, "not_found");
  await setPersonHidden(g.eid, id, true);
  console.info("[faces] guest hid person", { person: id, guest: g.gid });
  return json({ ok: true });
}
