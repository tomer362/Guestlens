import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { err, json, parse } from "@/lib/http";

const Body = z.object({ hidden: z.boolean() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const { id } = await ctx.params;
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  const r = await db().update(schema.media).set({ status: b.hidden ? "hidden" : "ready" })
    .where(and(eq(schema.media.id, id), eq(schema.media.eventId, a.eid), inArray(schema.media.status, ["ready", "hidden"])))
    .returning({ id: schema.media.id });
  return r.length ? json({ ok: true }) : err(404, "not_found");
}
