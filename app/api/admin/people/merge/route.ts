import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { err, json, parse } from "@/lib/http";
import { mergePeople } from "@/lib/faces/store";

const Body = z.object({ into: z.string().uuid(), from: z.array(z.string().uuid()).min(1).max(50) });

/** POST { into, from[] }: these are the same person. Regroups keep the result. */
export async function POST(req: Request) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  await mergePeople(a.eid, b.into, b.from);
  return json({ ok: true });
}
