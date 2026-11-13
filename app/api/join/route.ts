import { z } from "zod";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getGuest, setGuestCookie } from "@/lib/auth";
import { err, eventBy, json, parse } from "@/lib/http";

const Body = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().trim().max(60).optional().nullable(),
  pin: z.string().max(20).optional().nullable(),
});

export async function POST(req: Request) {
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  const event = await eventBy("slug", b.slug);
  if (!event) return err(404, "not_found");

  const name = b.name?.trim() || null;
  const current = await getGuest();
  if (current?.eid === event.id) {
    // Already joined: just refresh the name if one was given.
    if (name) {
      await db().update(schema.guests).set({ displayName: name })
        .where(and(eq(schema.guests.id, current.gid), eq(schema.guests.eventId, event.id)));
    }
    return json({ guestId: current.gid, eventName: event.name, uploadOpen: event.uploadOpen });
  }

  if (event.pinHash && !(b.pin && (await bcrypt.compare(b.pin, event.pinHash)))) {
    return err(401, "pin");
  }

  const [g] = await db().insert(schema.guests)
    .values({ eventId: event.id, displayName: name })
    .returning({ id: schema.guests.id });
  await setGuestCookie({ gid: g.id, eid: event.id });
  return json({ guestId: g.id, eventName: event.name, uploadOpen: event.uploadOpen });
}
