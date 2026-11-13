import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import type { ZodSchema } from "zod";
import { db, schema } from "./db/client";
import type { EventRow } from "./db/schema";
import { databaseUrl } from "./db/url";
import { ensureMigrated } from "./db/migrate";

export const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, init);
export const err = (status: number, code: string) => NextResponse.json({ error: code }, { status });

export async function parse<T>(req: Request, s: ZodSchema<T>): Promise<T | null> {
  try {
    const r = s.safeParse(await req.json());
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

// Tiny per-instance cache: an event row is read on nearly every request.
const cache = new Map<string, { at: number; row: EventRow | null }>();
const TTL = 15_000;

/** Local UI development without a database: /e/demo renders with a fake event. */
export const DEMO_EVENT: EventRow = {
  id: "00000000-0000-0000-0000-000000000000", slug: "demo", name: "החתונה של נועה ואיתי", pinHash: null,
  adminKeyHash: "", uploadOpen: true, galleryPublic: true, createdAt: new Date(0),
};
const demoMode = () => process.env.GL_DEMO === "1" || (!databaseUrl() && process.env.NODE_ENV !== "production");

export async function eventBy(field: "slug" | "id", value: string): Promise<EventRow | null> {
  if (demoMode()) return value === DEMO_EVENT[field] ? DEMO_EVENT : null;
  const k = `${field}:${value}`;
  await ensureMigrated();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.row;
  const col = field === "slug" ? schema.events.slug : schema.events.id;
  const [row] = await db().select().from(schema.events).where(eq(col, value)).limit(1);
  cache.set(k, { at: Date.now(), row: row ?? null });
  return row ?? null;
}
export function invalidateEvent(row: Pick<EventRow, "id" | "slug">) {
  cache.delete(`id:${row.id}`);
  cache.delete(`slug:${row.slug}`);
}
