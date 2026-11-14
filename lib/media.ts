import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { UploadPart } from "./storage/provider";

/** Record one uploaded part; flip to ready once both parts exist. Idempotent. */
export async function markPart(mediaId: string, part: UploadPart, url: string) {
  const set = part === "file" ? { url } : { thumbUrl: url };
  await db().update(schema.media).set(set)
    .where(and(eq(schema.media.id, mediaId), sql`${schema.media.status} in ('reserved','ready')`));
  return markReadyIfComplete(mediaId);
}

/**
 * reserved → ready once both URLs are known, and bump the event's media_version in the SAME
 * statement, so a client that sees the new version is guaranteed to see the item.
 */
export async function markReadyIfComplete(mediaId: string) {
  const r = await db().execute(sql`
    with u as (
      update media set status = 'ready', ready_at = now()
      where id = ${mediaId} and status = 'reserved' and url is not null and thumb_url is not null
      returning event_id
    )
    update events set media_version = media_version + 1
    where id in (select event_id from u)
    returning media_version`);
  return r.rows.length > 0;
}

/** Bump the visible-set version (hide/unhide, deletes). */
export async function bumpVersion(eventId: string) {
  await db().execute(sql`update events set media_version = media_version + 1 where id = ${eventId}`);
}
