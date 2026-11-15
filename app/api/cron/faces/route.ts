import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { FACES } from "@/lib/config";
import { err, json } from "@/lib/http";
import { drainFaceJobs } from "@/lib/faces/jobs";
import { clusterEvent, purgeEvent } from "@/lib/faces/store";

export const maxDuration = 300;

/**
 * Daily safety net (vercel.json; Hobby crons run once a day): finish any face jobs nobody
 * drained, catch up clustering, and purge face data of events past their retention period.
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return err(401, "cron");

  const drained = await drainFaceJobs({ budgetMs: 200_000 });

  const stale = (await db().execute(sql`
    select e.id from events e
    where exists (select 1 from faces f where f.event_id = e.id)
      and coalesce((select max(ready_at) from media m where m.event_id = e.id), e.created_at)
          < now() - make_interval(days => ${FACES.retentionDays})`)).rows as { id: string }[];
  for (const e of stale) await purgeEvent(e.id);

  const pending = (await db().execute(sql`select distinct event_id from faces where not clustered`)).rows as { event_id: string }[];
  for (const e of pending) await clusterEvent(e.event_id, { budgetMs: 30_000 });

  return json({ drained, purged: stale.length, clustered: pending.length });
}
