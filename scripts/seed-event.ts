/**
 * Create an event and print its guest URL + admin key.
 *   npx tsx scripts/seed-event.ts <slug> "<name>" [pin]
 * Needs DATABASE_URL (e.g. `vercel env pull .env.local` then `node --env-file=.env.local`…).
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db, schema } from "../lib/db/client";

const [slug, name, pin] = process.argv.slice(2);
if (!slug || !name) {
  console.error('usage: tsx scripts/seed-event.ts <slug> "<event name>" [pin]');
  process.exit(1);
}
if (!/^[a-z0-9-]{3,40}$/.test(slug)) {
  console.error("slug: 3-40 chars of a-z, 0-9, -. Use something hard to guess, e.g. noa-itay-7f3k");
  process.exit(1);
}
const adminKey = randomBytes(18).toString("base64url");
await db().insert(schema.events).values({
  slug, name, adminKeyHash: await bcrypt.hash(adminKey, 10), pinHash: pin ? await bcrypt.hash(pin, 10) : null,
});
const base = process.env.APP_URL ?? "https://<your-app>.vercel.app";
console.log(`\nEvent created.\n  Guests: ${base}/e/${slug}\n  Admin:  ${base}/admin/${slug}\n  Admin key (save it, shown once): ${adminKey}\n`);
