import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db, schema } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { databaseUrl } from "@/lib/db/url";
import { err, json, parse } from "@/lib/http";

const Body = z.object({
  setupKey: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  pin: z.string().max(20).optional().nullable(),
});

function keyOk(given: string) {
  const want = process.env.SETUP_KEY;
  if (!want || want.length < 12) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One-time setup from a phone: create tables, create the event, return the admin key. */
export async function POST(req: Request) {
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  if (!keyOk(b.setupKey)) return err(401, "bad_setup_key");
  if (!databaseUrl()) return err(500, "missing_env_DATABASE_URL");
  for (const v of ["BLOB_READ_WRITE_TOKEN", "JWT_SECRET"]) {
    if (!process.env[v]) return err(500, `missing_env_${v}`);
  }
  try {
    const applied = await migrate();
    const adminKey = randomBytes(18).toString("base64url");
    const [e] = await db().insert(schema.events).values({
      slug: b.slug, name: b.name, adminKeyHash: await bcrypt.hash(adminKey, 10),
      pinHash: b.pin ? await bcrypt.hash(b.pin, 10) : null,
    }).onConflictDoNothing({ target: schema.events.slug }).returning({ slug: schema.events.slug });
    if (!e) return err(409, "slug_taken");
    return json({ applied, slug: e.slug, adminKey });
  } catch (x) {
    return err(500, String((x as Error).message ?? x).slice(0, 200));
  }
}
