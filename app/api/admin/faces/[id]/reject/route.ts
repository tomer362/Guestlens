import { getAdmin } from "@/lib/auth";
import { err, json } from "@/lib/http";
import { rejectFace } from "@/lib/faces/store";

/** POST: "not this person". The face leaves its person and never goes back there. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const { id } = await ctx.params;
  return (await rejectFace(a.eid, id)) ? json({ ok: true }) : err(404, "not_found");
}
