import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { UploadPart } from "./storage/provider";

/** Record one uploaded part; flip to ready once both parts exist. Idempotent. */
export async function markPart(mediaId: string, part: UploadPart, url: string) {
  const d = db();
  const set = part === "file" ? { url } : { thumbUrl: url };
  await d.update(schema.media).set(set)
    .where(and(eq(schema.media.id, mediaId), sql`${schema.media.status} in ('reserved','ready')`));
  return markReadyIfComplete(mediaId);
}

export async function markReadyIfComplete(mediaId: string) {
  const r = await db().update(schema.media).set({ status: "ready", readyAt: new Date() })
    .where(and(
      eq(schema.media.id, mediaId), eq(schema.media.status, "reserved"),
      isNotNull(schema.media.url), isNotNull(schema.media.thumbUrl),
    )).returning({ id: schema.media.id });
  return r.length > 0;
}
