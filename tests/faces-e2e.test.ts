/**
 * End-to-end check of People (FACES.md §3) on real photos and a real Postgres + pgvector:
 * migrate → event/guest/media rows → enqueueFaceJob → drainFaceJobs (fetch over HTTP like Blob,
 * sharp, YuNet, SFace, save) → clustering → GET /api/people and the crop route.
 *
 * Skipped unless both are set (plus the models from `npm run faces:models`):
 *   FACES_TEST_DB      postgres://… of a server where this test may create and drop a database
 *   FACES_TEST_IMAGES  folder with photos, named <person>_<anything>.jpg|png|webp, ≥ 3 per person;
 *                      a name starting with "x" is a stranger (one-off, must not become a person)
 *
 *   FACES_TEST_DB=postgres://postgres:pg@localhost/postgres FACES_TEST_IMAGES=~/faces npx vitest run tests/faces-e2e.test.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ADMIN_URL = process.env.FACES_TEST_DB;
const IMAGES = process.env.FACES_TEST_IMAGES;
const MODELS = path.join(__dirname, "..", "lib", "faces", "models", "face_recognition_sface_2021dec.onnx");
const enabled = !!ADMIN_URL && !!IMAGES && existsSync(MODELS);

// this test checks that one-off strangers stay hidden, so it pins the stricter setting
// (config is only imported dynamically below, after this runs)
process.env.FACES_MIN_FACES = "3";

const dbName = `gl_faces_e2e_${process.pid}`;
const state: { pool?: import("pg").Pool; eventId?: string; after: Promise<unknown>[] } = { after: [] };

vi.mock("@/lib/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@/lib/db/schema");
  let d: ReturnType<typeof drizzle<typeof schema>> | undefined;
  return { schema, db: () => (d ??= drizzle(state.pool!, { schema })) };
});
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<object>()), getAdmin: async () => ({ eid: state.eventId }) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: (fn: () => unknown) => { state.after.push(Promise.resolve().then(fn)); } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

describe.skipIf(!enabled)("faces end to end", () => {
  let server: Server;
  let base = "";
  let eventId = "";
  const media: { id: string; file: string; person: string }[] = [];

  beforeAll(async () => {
    const pg = await import("pg");
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName}`);
    await admin.query(`create database ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    state.pool = new pg.Pool({ connectionString: url.toString() });
    process.env.DATABASE_URL = url.toString(); // not demo mode (lib/http.ts); queries still go through the mock

    const { migrate } = await import("@/lib/db/migrate");
    await migrate();

    // the photos as the phone would upload them: ≤ 2048 px WebP, served with image/webp like Blob
    const sharp = (await import("sharp")).default;
    const files = readdirSync(IMAGES!).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
    const webp = new Map<string, Buffer>();
    for (const f of files) {
      webp.set(f, await sharp(readFileSync(path.join(IMAGES!, f))).rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toBuffer());
    }
    server = createServer((req, res) => {
      const b = webp.get(decodeURIComponent(req.url!.slice(1)));
      if (!b) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "image/webp", "content-length": b.length }).end(b);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const q = (s: string, p: unknown[] = []) => state.pool!.query(s, p);
    eventId = (await q(`insert into events (slug, name, admin_key_hash, faces_enabled) values ('e2e', 'E2E', 'x', true) returning id`)).rows[0].id;
    state.eventId = eventId;
    const guest = (await q(`insert into guests (event_id) values ($1) returning id`, [eventId])).rows[0].id;
    for (const f of files) {
      const r = await q(`insert into media (event_id, guest_id, kind, sha256, content_type, bytes, thumb_bytes, url, thumb_url, status, ready_at)
        values ($1, $2, 'photo', $3, 'image/webp', $4, 1, $5, $5, 'ready', now()) returning id`,
        [eventId, guest, f, webp.get(f)!.length, `${base}/${encodeURIComponent(f)}`]);
      media.push({ id: r.rows[0].id, file: f, person: f.split("_")[0].toLowerCase() });
    }
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await state.pool?.end();
    if (ADMIN_URL) {
      const pg = await import("pg");
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    }
  });

  it("queues, detects, embeds, groups and serves people", async () => {
    const { enqueueFaceJob, drainFaceJobs } = await import("@/lib/faces/jobs");
    for (const m of media) expect(await enqueueFaceJob(m.id)).toBe(true);
    expect(await enqueueFaceJob(media[0].id)).toBe(false); // idempotent

    const res = await drainFaceJobs({ eventId, budgetMs: 120_000 });
    expect(res.unavailable).toBeUndefined();
    expect(res.failed).toBe(0);
    expect(res.jobs).toBe(media.length);
    expect(res.faces).toBeGreaterThanOrEqual(media.length - 2);

    const q = (s: string, p: unknown[] = []) => state.pool!.query(s, p);
    const jobs = (await q(`select status, count(*)::int n from face_jobs group by status`)).rows;
    expect(jobs).toEqual([{ status: "done", n: media.length }]);
    expect((await q(`select count(*)::int n from faces where not clustered`)).rows[0].n).toBe(0);

    // force a full regroup too (the admin "Regroup" button), it must agree with the incremental pass
    const { clusterEvent } = await import("@/lib/faces/store");
    expect(await clusterEvent(eventId, { forceRebuild: true })).toBe(true);

    // which file names ended up in which person
    const rows = (await q(`select f.person_id, m.id media_id from faces f join media m on m.id = f.media_id where f.person_id is not null`)).rows as { person_id: string; media_id: string }[];
    const byPerson = new Map<string, Set<string>>();
    for (const r of rows) {
      const who = media.find((m) => m.id === r.media_id)!.person;
      (byPerson.get(r.person_id) ?? byPerson.set(r.person_id, new Set()).get(r.person_id)!).add(who);
    }
    const expected = [...new Set(media.map((m) => m.person))].filter((p) => !p.startsWith("x") && media.filter((m) => m.person === p).length >= 3);
    console.info("[e2e] people", [...byPerson.values()].map((s) => [...s]));
    expect(byPerson.size).toBe(expected.length);
    // every person found is mostly one real identity, and every expected identity was found
    // (a group photo carries one file name for several identities, so judge each person by solo photos)
    const found = new Set<string>();
    const perMedia = new Map(((await q(`select media_id, count(*)::int n from faces group by media_id`)).rows as { media_id: string; n: number }[]).map((r) => [r.media_id, r.n]));
    for (const [pid] of byPerson) {
      const who = rows.filter((r) => r.person_id === pid).map((r) => media.find((m) => m.id === r.media_id)!);
      const solo = who.filter((m) => perMedia.get(m.id) === 1);
      const counts = new Map<string, number>();
      for (const m of solo) counts.set(m.person, (counts.get(m.person) ?? 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1])[0];
      expect(top, `person ${pid}`).toBeTruthy();
      found.add(top[0]);
    }
    for (const p of expected) expect(found.has(p), `found ${p}`).toBe(true);

    // the guest-facing list and a cover crop
    const { GET: people } = await import("@/app/api/people/route");
    const list = await (await people(new Request("http://x/api/people?slug=e2e&v=1"))).json();
    expect(list.enabled).toBe(true);
    expect(list.people.length).toBe(expected.length);
    for (const p of list.people) expect(p.n).toBeGreaterThanOrEqual(2);

    const { GET: crop } = await import("@/app/api/faces/[id]/crop/route");
    const coverId = list.people[0].cover.split("/")[3];
    const img = await crop(new Request(`http://x${list.people[0].cover}`), { params: Promise.resolve({ id: coverId }) });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/webp");
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(500);

    const { GET: personMedia } = await import("@/app/api/people/[id]/media/route");
    const pm = await (await personMedia(new Request(`http://x/api/people/${list.people[0].id}/media?slug=e2e`), { params: Promise.resolve({ id: list.people[0].id }) })).json();
    expect(pm.items.length).toBe(list.people[0].n);
  }, 300_000);

  it("rescan keeps names and fixes; admin delete removes an item and its faces", async () => {
    const { drainFaceJobs, enqueueFaceJob } = await import("@/lib/faces/jobs");
    const q = (s: string, p: unknown[] = []) => state.pool!.query(s, p);
    for (const m of media) await enqueueFaceJob(m.id);
    await drainFaceJobs({ eventId, budgetMs: 120_000 });

    const person = (await q(`select id from people where event_id = $1 order by media_count desc limit 1`, [eventId])).rows[0]?.id as string;
    expect(person).toBeTruthy();
    const { PATCH: renamePerson } = await import("@/app/api/admin/people/[id]/route");
    const rn = await renamePerson(new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "Dana" }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: person }) });
    expect(rn.status).toBe(200);
    const before = (await q(`select id from faces where person_id = $1 order by id`, [person])).rows.map((r) => r.id);
    expect(before.length).toBeGreaterThan(0);

    const { POST } = await import("@/app/api/admin/faces/route");
    const rs = await (await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "rescan" }), headers: { "content-type": "application/json" } }))).json();
    expect(rs.queued).toBe(media.length);
    await Promise.all(state.after.splice(0));
    expect((await q(`select count(*)::int n from face_jobs where status <> 'done'`)).rows[0].n).toBe(0);
    // same faces (same rows), still in the named person
    const after = (await q(`select id from faces where person_id = $1 order by id`, [person])).rows.map((r) => r.id);
    expect(after).toEqual(before);
    expect((await q(`select name from people where id = $1`, [person])).rows[0].name).toBe("Dana");

    const victim = media[0];
    const { DELETE } = await import("@/app/api/admin/media/[id]/route");
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: victim.id }) })).status).toBe(200);
    await Promise.all(state.after.splice(0));
    expect((await q(`select count(*)::int n from media where id = $1`, [victim.id])).rows[0].n).toBe(0);
    expect((await q(`select count(*)::int n from faces where media_id = $1`, [victim.id])).rows[0].n).toBe(0);
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: victim.id }) })).status).toBe(404);
  }, 300_000);
});
