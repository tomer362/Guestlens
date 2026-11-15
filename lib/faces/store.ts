/**
 * Database side of face grouping: saving faces, incremental assignment, full regroups, people
 * stats, and the admin/guest actions. Pure decisions live in cluster.ts.
 *
 * Concurrency: clustering for one event is single-flight via a lease column on events (one
 * conditional UPDATE, the same style as the budget counters; works on Neon's HTTP driver).
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { FACES } from "@/lib/config";
import { decideIncremental, matchRescan, regroup, NEW_PREFIX, type Neighbour, type RFace } from "./cluster";
import { MODEL_ID } from "./model";
import type { FoundFace } from "./pipeline";
import { fromPgVector, toPgVector } from "./vec";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres array literal for a uuid[] parameter (ids are validated, so no quoting needed). */
export function uuidArray(ids: string[]): string {
  for (const id of ids) if (!UUID.test(id)) throw new Error("bad_uuid");
  return `{${ids.join(",")}}`;
}
const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];

const cfg = { assignSim: FACES.assignSim, minFaces: FACES.minFaces, seedQuality: FACES.seedQuality, neighbours: FACES.neighbours };

export async function bumpPeopleVersion(eventId: string) {
  await db().execute(sql`update events set people_version = people_version + 1 where id = ${eventId}`);
}

/**
 * Replace a media item's faces (re-processing is idempotent). On a re-scan, a face found again in
 * the same place updates the old row, so its person, lock, rejections and cover survive; faces no
 * longer found are deleted, new ones inserted (and clustered as usual).
 */
export async function saveFaces(eventId: string, mediaId: string, found: FoundFace[]) {
  const old = rows<{ id: string; box: number[] }>(await db().execute(sql`select id, box from faces where media_id = ${mediaId}`));
  const match = matchRescan(old.map((o) => o.box.map(Number) as FoundFace["box"]), found.map((f) => f.box));
  const kept = new Set<string>();
  for (const [i, f] of found.entries()) {
    const box = `{${f.box.map((v) => v.toFixed(1)).join(",")}}`;
    const j = match.get(i);
    if (j !== undefined) {
      kept.add(old[j].id);
      await db().execute(sql`
        update faces set model = ${MODEL_ID}, embedding = ${toPgVector(f.embedding)}::vector, box = ${box}::real[],
          score = ${f.score}, quality = ${f.quality}, crop = ${f.crop}
        where id = ${old[j].id}`);
    } else {
      await db().execute(sql`
        insert into faces (event_id, media_id, model, embedding, box, score, quality, crop)
        values (${eventId}, ${mediaId}, ${MODEL_ID}, ${toPgVector(f.embedding)}::vector, ${box}::real[], ${f.score}, ${f.quality}, ${f.crop})`);
    }
  }
  const gone = old.filter((o) => !kept.has(o.id)).map((o) => o.id);
  if (gone.length) await db().execute(sql`delete from faces where id = any(${uuidArray(gone)}::uuid[])`);
}

// ---------- clustering ----------

async function acquire(eventId: string): Promise<{ rebuiltAt: number } | null> {
  const r = await db().execute(sql`
    update events set faces_lock_until = now() + make_interval(secs => ${FACES.clusterLeaseMs / 1000})
    where id = ${eventId} and faces_lock_until < now() returning faces_rebuilt_at_count`);
  const row = rows<{ faces_rebuilt_at_count: number }>(r)[0];
  return row ? { rebuiltAt: Number(row.faces_rebuilt_at_count) } : null;
}
const release = (eventId: string) => db().execute(sql`update events set faces_lock_until = 'epoch' where id = ${eventId}`);

/**
 * Assign new faces, regroup when due, refresh people. Returns false if another instance holds
 * the event (it will pick up whatever is left).
 */
export async function clusterEvent(eventId: string, opts: { forceRebuild?: boolean; budgetMs?: number } = {}): Promise<boolean> {
  const lease = await acquire(eventId);
  if (!lease) return false;
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 40_000;
  let changed = false;
  try {
    for (;;) {
      const batch = rows<{ id: string; media_id: string; embedding: string; quality: number }>(await db().execute(sql`
        select id, media_id, embedding::text as embedding, quality from faces
        where event_id = ${eventId} and not clustered order by created_at limit 100`));
      if (!batch.length) break;
      for (const f of batch) {
        const n = rows<{ id: string; person_id: string | null; quality: number; sim: number }>(await db().execute(sql`
          select id, person_id, quality, 1 - (embedding <=> ${f.embedding}::vector) as sim
          from faces where event_id = ${eventId} and media_id <> ${f.media_id} and model = ${MODEL_ID}
          order by embedding <=> ${f.embedding}::vector limit ${FACES.neighbours}`));
        const neighbours: Neighbour[] = n.map((x) => ({ id: x.id, personId: x.person_id, quality: Number(x.quality), sim: Number(x.sim) }));
        const d = decideIncremental({ id: f.id, quality: Number(f.quality) }, neighbours, cfg);
        if (d.kind === "assign") {
          await db().execute(sql`update faces set person_id = ${d.personId}, clustered = true where id = ${f.id}`);
          changed = true;
        } else if (d.kind === "create") {
          await db().execute(sql`
            with p as (insert into people (event_id) values (${eventId}) returning id)
            update faces set person_id = (select id from p), clustered = true
            where id = any(${uuidArray(d.faceIds)}::uuid[]) and (person_id is null)`);
          changed = true;
        } else {
          await db().execute(sql`update faces set clustered = true where id = ${f.id}`);
        }
      }
      if (Date.now() - t0 > budget) break;
    }

    const total = Number(rows<{ n: number }>(await db().execute(sql`select count(*)::int as n from faces where event_id = ${eventId}`))[0].n);
    const due = total - lease.rebuiltAt >= Math.max(FACES.rebuildMin, lease.rebuiltAt * FACES.rebuildFrac);
    if (opts.forceRebuild || (due && total >= FACES.minFaces)) {
      await regroupEvent(eventId);
      await db().execute(sql`update events set faces_rebuilt_at_count = ${total} where id = ${eventId}`);
      changed = true;
    }
    if (changed) {
      await refreshPeople(eventId);
      await bumpPeopleVersion(eventId);
    }
  } finally {
    await release(eventId);
  }
  return true;
}

/** Full regroup (cluster.ts `regroup`), then write back only what changed. */
export async function regroupEvent(eventId: string) {
  const all = rows<{ id: string; media_id: string; embedding: string; quality: number; person_id: string | null; locked: boolean }>(await db().execute(sql`
    select id, media_id, embedding::text as embedding, quality, person_id, locked from faces
    where event_id = ${eventId} and model = ${MODEL_ID}`));
  if (!all.length) return;
  const faces: RFace[] = all.map((f) => ({ id: f.id, mediaId: f.media_id, vec: fromPgVector(f.embedding), quality: Number(f.quality), personId: f.person_id, locked: f.locked }));
  const rej = new Map<string, Set<string>>();
  for (const r of rows<{ face_id: string; person_id: string }>(await db().execute(sql`
    select r.face_id, r.person_id from face_rejections r join faces f on f.id = r.face_id where f.event_id = ${eventId}`))) {
    (rej.get(r.face_id) ?? rej.set(r.face_id, new Set()).get(r.face_id)!).add(r.person_id);
  }
  const t = Date.now();
  const target = regroup(faces, rej, cfg);

  // create people for new groups
  const newLabels = [...new Set([...target.values()].filter((v): v is string => !!v && v.startsWith(NEW_PREFIX)))];
  const created = new Map<string, string>();
  for (const l of newLabels) {
    const r = rows<{ id: string }>(await db().execute(sql`insert into people (event_id) values (${eventId}) returning id`));
    created.set(l, r[0].id);
  }
  const ids: string[] = [], pids: string[] = [];
  for (const f of faces) {
    let p = target.get(f.id) ?? null;
    if (p && created.has(p)) p = created.get(p)!;
    if (p !== f.personId) { ids.push(f.id); pids.push(p ?? ""); }
  }
  for (let i = 0; i < ids.length; i += 500) {
    const a = ids.slice(i, i + 500), b = pids.slice(i, i + 500);
    await db().execute(sql`
      update faces f set person_id = nullif(v.pid, '')::uuid, clustered = true
      from (select unnest(${uuidArray(a)}::uuid[]) as id, unnest(${`{${b.map((x) => x || '""').join(",")}}`}::text[]) as pid) v
      where f.id = v.id`);
  }
  console.info("[faces] regroup", { eventId, faces: faces.length, moved: ids.length, newPeople: created.size, ms: Date.now() - t });
}

/** Recount faces/photos per person (visible media only), pick covers, drop empty unnamed people. */
export async function refreshPeople(eventId: string) {
  await db().execute(sql`
    with s as (
      select f.person_id, count(*)::int as fc, count(distinct f.media_id)::int as mc,
             (array_agg(f.id order by f.quality desc))[1] as best
      from faces f join media m on m.id = f.media_id and m.status = 'ready'
      where f.event_id = ${eventId} and f.person_id is not null group by f.person_id
    )
    update people p set face_count = coalesce(s.fc, 0), media_count = coalesce(s.mc, 0),
      cover_face_id = case when p.cover_pinned and exists (select 1 from faces x where x.id = p.cover_face_id and x.person_id = p.id)
                           then p.cover_face_id else s.best end
    from people p2 left join s on s.person_id = p2.id
    where p.id = p2.id and p.event_id = ${eventId}`);
  await db().execute(sql`
    delete from people where event_id = ${eventId} and media_count = 0 and name is null and not hidden
      and not exists (select 1 from faces f where f.person_id = people.id)`);
}

// ---------- human corrections (all lock the faces involved, so regroups keep them) ----------

export async function renamePerson(eventId: string, personId: string, name: string | null) {
  await db().execute(sql`update people set name = ${name} where id = ${personId} and event_id = ${eventId}`);
  await db().execute(sql`update faces set locked = true where person_id = ${personId} and event_id = ${eventId}`);
  await bumpPeopleVersion(eventId);
}

export async function setPersonHidden(eventId: string, personId: string, hidden: boolean) {
  const r = await db().execute(sql`update people set hidden = ${hidden} where id = ${personId} and event_id = ${eventId} returning id`);
  if (!r.rows.length) return false;
  await db().execute(sql`update faces set locked = true where person_id = ${personId} and event_id = ${eventId}`);
  await bumpPeopleVersion(eventId);
  return true;
}

export async function setCover(eventId: string, personId: string, faceId: string) {
  await db().execute(sql`
    update people set cover_face_id = ${faceId}, cover_pinned = true
    where id = ${personId} and event_id = ${eventId}
      and exists (select 1 from faces where id = ${faceId} and person_id = ${personId})`);
  await bumpPeopleVersion(eventId);
}

/** Move every face of `from` into `into`; `into` keeps (or inherits) a name and hidden flag. */
export async function mergePeople(eventId: string, into: string, from: string[]) {
  const src = from.filter((x) => x !== into);
  if (!src.length) return;
  const arr = uuidArray(src);
  await db().execute(sql`
    update people set
      name = coalesce(people.name, (select name from people s where s.id = any(${arr}::uuid[]) and s.name is not null limit 1)),
      hidden = people.hidden or exists (select 1 from people s where s.id = any(${arr}::uuid[]) and s.hidden)
    where id = ${into} and event_id = ${eventId}`);
  await db().execute(sql`
    update faces set person_id = ${into}, locked = true
    where event_id = ${eventId} and (person_id = any(${arr}::uuid[]) or person_id = ${into})`);
  await db().execute(sql`delete from face_rejections where person_id = ${into} and face_id in (select id from faces where person_id = ${into})`);
  await db().execute(sql`delete from people where id = any(${arr}::uuid[]) and event_id = ${eventId}`);
  await refreshPeople(eventId);
  await bumpPeopleVersion(eventId);
}

/** "Not this person": detach the face and never put it back there. */
export async function rejectFace(eventId: string, faceId: string) {
  const r = rows<{ person_id: string | null }>(await db().execute(sql`select person_id from faces where id = ${faceId} and event_id = ${eventId}`));
  const p = r[0]?.person_id;
  if (!p) return false;
  await db().execute(sql`insert into face_rejections (face_id, person_id) values (${faceId}, ${p}) on conflict do nothing`);
  await db().execute(sql`update faces set person_id = null, locked = false, clustered = true where id = ${faceId}`);
  await refreshPeople(eventId);
  await bumpPeopleVersion(eventId);
  return true;
}

/** Delete every face, person and job of an event (admin "delete all face data", retention purge). */
export async function purgeEvent(eventId: string) {
  await db().execute(sql`delete from faces where event_id = ${eventId}`);
  await db().execute(sql`delete from people where event_id = ${eventId}`);
  await db().execute(sql`delete from face_jobs where event_id = ${eventId}`);
  await db().execute(sql`update events set faces_rebuilt_at_count = 0 where id = ${eventId}`);
  await bumpPeopleVersion(eventId);
}

/** A guest's "don't include my uploads in People". */
export async function setGuestOptOut(guestId: string, eventId: string, optOut: boolean) {
  await db().execute(sql`update guests set faces_opt_out = ${optOut} where id = ${guestId}`);
  if (optOut) {
    await db().execute(sql`delete from faces where media_id in (select id from media where guest_id = ${guestId})`);
    await db().execute(sql`delete from face_jobs where media_id in (select id from media where guest_id = ${guestId})`);
    await refreshPeople(eventId);
    await bumpPeopleVersion(eventId);
  }
}
