import { z } from "zod";
import bcrypt from "bcryptjs";
import { setAdminCookie } from "@/lib/auth";
import { err, eventBy, json, parse } from "@/lib/http";

const Body = z.object({ slug: z.string(), key: z.string().min(8) });

export async function POST(req: Request) {
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  const event = await eventBy("slug", b.slug);
  if (!event || !(await bcrypt.compare(b.key, event.adminKeyHash))) return err(401, "bad_key");
  await setAdminCookie({ eid: event.id });
  return json({ ok: true });
}
