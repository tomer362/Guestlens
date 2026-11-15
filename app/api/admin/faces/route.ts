import { after } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getAdmin } from "@/lib/auth";
import { FACES } from "@/lib/config";
import { err, json, parse } from "@/lib/http";
import { drainFaceJobs, rescanEvent } from "@/lib/faces/jobs";
import { modelStatus } from "@/lib/faces/model";
import { clusterEvent, purgeEvent } from "@/lib/faces/store";

export const maxDuration = 300;

/** GET → queue status, model status and every person (hidden ones too) for the admin page. */
export async function GET() {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const [jobs, counts, people, lastError, model] = await Promise.all([
    db().execute(sql`select status, count(*)::int as n from face_jobs where event_id = ${a.eid} group by status`),
    db().execute(sql`select count(*)::int as faces, count(person_id)::int as assigned from faces where event_id = ${a.eid}`),
    db().execute(sql`
      select id, name, hidden, face_count, media_count, cover_face_id from people
      where event_id = ${a.eid} and (face_count > 0 or name is not null or hidden)
      order by media_count desc, created_at limit 1000`),
    db().execute(sql`select error from face_jobs where event_id = ${a.eid} and error is not null order by created_at desc limit 1`),
    modelStatus(),
  ]);
  return json({
    jobs: Object.fromEntries((jobs.rows as { status: string; n: number }[]).map((r) => [r.status, Number(r.n)])),
    ...(counts.rows[0] as object),
    lastError: (lastError.rows[0] as { error?: string } | undefined)?.error ?? null,
    model,
    minFaces: FACES.minFaces,
    people: (people.rows as { id: string; name: string | null; hidden: boolean; face_count: number; media_count: number; cover_face_id: string | null }[]).map((p) => ({
      id: p.id, name: p.name, hidden: p.hidden, faces: Number(p.face_count), n: Number(p.media_count),
      cover: p.cover_face_id ? `/api/faces/${p.cover_face_id}/crop?admin=1` : null,
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}

const Body = z.object({ action: z.enum(["drain", "regroup", "rescan", "purge"]) });

/**
 * POST { action }:
 * - drain:   process queued jobs now (in the background) and cluster
 * - regroup: full regroup now (keeps names, merges and hidden people)
 * - rescan:  scan every photo again (keeps names and fixes), starting now in the background
 * - purge:   delete every face, person and job of this event (turn faces off first to stop new ones)
 */
export async function POST(req: Request) {
  const a = await getAdmin();
  if (!a) return err(401, "admin");
  const b = await parse(req, Body);
  if (!b) return err(400, "bad_request");
  if (b.action === "drain") {
    after(() => drainFaceJobs({ eventId: a.eid, budgetMs: 240_000 }).then(() => undefined));
    return json({ ok: true, started: true });
  }
  if (b.action === "regroup") {
    const ran = await clusterEvent(a.eid, { forceRebuild: true, budgetMs: 200_000 });
    return ran ? json({ ok: true }) : err(409, "busy");
  }
  if (b.action === "rescan") {
    const queued = await rescanEvent(a.eid);
    after(() => drainFaceJobs({ eventId: a.eid, budgetMs: 240_000 }).then(() => undefined));
    return json({ ok: true, queued });
  }
  await purgeEvent(a.eid);
  return json({ ok: true });
}
