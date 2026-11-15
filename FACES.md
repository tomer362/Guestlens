# People: face detection and grouping

Status: Phase 1 working end to end and behind an admin switch (off by default) · 2026-11-15
Runtime (`onnxruntime-web`, `sharp`) and both models are in the repo, so a deploy can run it as is.
Part of [ARCHITECTURE.md](ARCHITECTURE.md).

The **People** page shows one circle per person at the event, using their face. Tapping it shows every photo and video they're in. It fills in during the night as uploads arrive.

## 1. The constraint that decides the design

A guest shoots, uploads and **puts the phone straight into a pocket**. iOS and Android then freeze the page, and **uploading stops with it**: the queue (`client/queue.ts`) is page JavaScript, with no service-worker or Background Fetch path.
- iOS suspends the page within seconds; Safari has no Background Fetch or Background Sync.
- Chrome on Android freezes a hidden page after about a minute.
- So an item that wasn't finished when the phone went away stays on the phone until the guest opens the app again. That is usually the next time they shoot.

Nothing can rely on the uploader's phone after it goes into a pocket, *including* any face work done there. The server learns about each item when its upload actually finishes, through `/api/media/complete`, or through Vercel Blob's `onUploadCompleted` webhook (`app/api/blob/token/route.ts` → `lib/media.ts markPart`). The webhook covers a phone that froze between the file upload and `/complete`. Face scanning starts from there, so faces trail the upload by seconds, however late the upload itself is.

Grouping needs every guest's faces in one place, so **clustering always runs on the server**. The only real choice is where faces are *detected and embedded* (turned into comparable vectors).

## 2. The options

| | A. Uploader's phone | **B. Our server (chosen)** | C. AWS Rekognition | D. External ML worker | E. Viewers' phones |
|---|---|---|---|---|---|
| Where detection and embedding run | Browser, after compressing (ONNX Runtime Web / MediaPipe) | Vercel function, after the response: `sharp` + ONNX | `IndexFaces` into a per-event collection | Python box (Modal / Fly / home PC) pulling jobs from Neon | Whoever has the album open processes unscanned items |
| Survives "upload then pocket" | ❌ only while the screen stays on, and it competes with the upload for those few seconds; adds a ~5–40 MB model download on wedding Wi-Fi | ✅ starts whenever the upload finishes (`/complete` **or** the Blob webhook), with nothing more needed from the phone | ✅ | ✅ | ⚠️ only while someone is browsing |
| Device coverage | uneven (old Android, in-app webviews, iOS WASM memory, flaky iOS WebGPU) | every item, one model | every item | every item | uneven |
| Accuracy | small models only | small/medium (YuNet + SFace) | high | highest (ArcFace, RetinaFace, HDBSCAN, video frames) | as A |
| Cost at ~3,700 items | $0 | $0: minutes of Hobby's 4 Active-CPU-hours | ~$4 to index + searches; AWS account | $0–10 + another platform | $0 |
| Privacy | best (only vectors leave the phone) | vectors and crops stay in our Neon DB | biometric data at AWS | third party or self-hosted | other guests' phones see faces |
| Trust | clients could send fake vectors | trusted | trusted | trusted | clients could send fake vectors |
| Catch | clustering must be on the server anyway | the server now decodes images; ~1 Blob read per photo | clustering isn't built in, we'd still write it | InsightFace `buffalo_l` weights are non-commercial research only | hard to make reliable |

**Why B:**
- A and E can never be the guaranteed path while phones are pocketed. They could only save server CPU, and B already fits inside Hobby's free allowance.
- C buys accuracy for money and a biometric vendor, and still leaves clustering to us.
- D is the upgrade path if real rehearsal photos show B isn't accurate enough. The model sits behind one seam (`lib/faces/model.ts` + `MODEL_ID`), so A or D can be added later without touching clustering or the UI.

## 3. How B works

```
upload → /api/media/complete ─┐
Blob onUploadCompleted webhook ┴─► item becomes ready → afterReady() (lib/media.ts)
                                    after the response: enqueueFaceJob → drainFaceJobs

drainFaceJobs (lib/faces/jobs.ts), budget ~45 s:
  claim ≤ 8 jobs: UPDATE … lease … WHERE … FOR UPDATE SKIP LOCKED   (parallel drains never collide)
  each job: fetch the 2048 px photo (or a video's poster) from Blob
            sharp decode → YuNet on a 640 px letterbox → NMS → drop faces < 36 px
            align on 5 landmarks (112×112 ArcFace template) → SFace → 128-d unit vector
            quality = confidence × size × frontal × sharpness;  96 px WebP crop as a data URL
            save faces; job done (3 attempts, then failed)
  then clusterEvent() for each event touched
```

**Jobs that get left behind** (a function killed mid-run, a burst of uploads):
- every drain also takes jobs whose lease ran out;
- `/api/gallery/version`, which the open album polls, checks for a stalled backlog in the same query and drains it after replying;
- the admin page has "Process now";
- a daily cron (`/api/cron/faces`, the Hobby limit) sweeps whatever is left.

**When the model is missing:** if the ONNX runtime or the models aren't installed, jobs are handed back untouched and retried 10 minutes later. Nothing is lost.

### Clustering (`lib/faces/cluster.ts`, `lib/faces/store.ts`)
- **Incremental, per new face.** Find the 10 nearest faces in the event with pgvector cosine (`<=>`), skipping faces from the same photo.
  - If close neighbours (similarity ≥ `assignSim`, default 0.40) belong to people, join the one with the most weight.
  - Otherwise, if this face and at least `minFaces − 1` close unassigned faces are *good quality*, create a person. This is a DBSCAN core point, the approach Immich uses.
  - Blurry, tiny or side-on faces can join a person but never start one.
- **Full regroup, now and then.** Runs whenever the face count has grown by max(200, 25 %), or when the admin presses "Regroup".
  - Build a symmetric kNN graph (no edges between faces of the same photo), then run Chinese Whispers (dlib's face-clustering algorithm).
  - Each face starts labelled with its current person, so person IDs, names and fixes survive.
  - *Locked* faces never move. *Rejected* (face, person) pairs never join.
  - New groups become people only with ≥ `minFaces` faces, mostly good ones.
  - Measured: 10k faces regroup in ~9 s of CPU (brute-force kNN). Spread over a whole wedding that's under a minute.
- **Single-flight per event:** a lease column on `events`, taken with one conditional UPDATE (no session locks, works on Neon's HTTP driver).
- **Counts and covers:** recomputed over *visible* media only; the cover is the best-quality face unless the admin pins one. Every change bumps `events.people_version`.

### Data (`drizzle/0004_faces.sql`)
| Table / column | Purpose |
|---|---|
| `events.faces_enabled` | admin switch (default off) |
| `events.people_version` | what the People page polls (like `media_version`) |
| `events.faces_lock_until`, `faces_rebuilt_at_count` | clustering lease, regroup schedule |
| `guests.faces_opt_out` | "don't include my uploads" |
| `face_jobs` | the queue: status, attempts, lease, error |
| `faces` | `vector(128)`, box, score, quality, crop, person, `clustered`, `locked`, `model` |
| `people` | name, cover, counts, hidden |
| `face_rejections` | "not this person" |

There's no HNSW index on purpose. Queries are always per event (~10k rows at most), where an exact scan is fast. A filtered HNSW scan could also return fewer than *k* neighbours.

### API and UI
| Route | |
|---|---|
| `GET /api/gallery/version` | now `{ v, pv, faces }`; also restarts a stalled backlog |
| `GET /api/people?slug&v=pv` | people list, CDN-shared and keyed by version (like `/api/gallery`) |
| `GET /api/people/:id/media?slug&v=pv&before` | that person's items, same tile shape and paging as the album |
| `GET /api/faces/:id/crop` | the face crop as an image, cached immutable |
| `POST /api/people/:id/hide` | guest: "This is me, hide me" |
| `GET/POST /api/me/faces` | guest opt-out (deletes their faces at once) |
| `GET/POST /api/admin/faces` | status; `drain` / `regroup` / `purge` |
| `PATCH /api/admin/people/:id`, `POST /api/admin/people/merge`, `POST /api/admin/faces/:id/reject` | rename, hide, cover, merge, not-this-person (each locks the faces) |
| `GET /api/cron/faces` | daily: drain, cluster, purge after `FACES_RETENTION_DAYS` (60) |

- **Pages:** `/e/<slug>/people` is a grid of face circles with counts, plus a privacy notice and the guest's own switch. `/e/<slug>/people/<id>` reuses the album grid and viewer, filtered to that person. The bottom bar gains a **People** tab when faces are on.
- **Admin:** the People section has the on/off switch, the queue and model status, Process now, Regroup, Delete all face data, and a grid of people with rename, hide and merge. Tap a face circle to open that person's faces, with ✕ (not this person) and ★ (cover).

### Videos
- **Phase 1:** the poster frame the phone already uploads (400 px), so close-up faces are found.
- **Later, if the rehearsal shows many videos without faces:** sample 3–5 frames server-side with ffmpeg (HTTP range reads of the MP4).

## 4. Privacy (biometric data)
Face vectors are biometric data. They are "especially sensitive information" under Israel's Privacy Protection Law (Amendment 13, in force Aug 2025) and special-category data under GDPR. So:
- **Off by default.** The organiser turns it on per event; tell guests first, e.g. on the QR sign.
- The People page always shows a notice and the guest's **"Include faces from my uploads"** switch. Turning it off deletes their faces immediately.
- **"This is me, hide me"** on any person page. The admin can also hide, rename and merge people.
- **Delete all face data** (admin), plus an automatic purge `FACES_RETENTION_DAYS` after the last upload (daily cron).
- Crops are served by unguessable ID, like Blob URLs. Hidden people's crops return 404 to guests.
- This changes ARCHITECTURE.md §7: the server now decodes images, but only WebP/JPEG, ≤ 9 MP (`limitInputPixels`), and only with libvips via `sharp`.

## 5. Budgets (Hobby)
- **Per photo:** one Blob read (~0.6 MB), so ~3,700 reads and ~2.2 GB of transfer for the wedding. That's within 10k simple ops / 10 GB, but counts against them; on R2 it costs nothing.
- **CPU:** detection plus embedding is roughly 0.1–0.3 s per photo. That's an estimate until measured on Vercel; the WASM runtime is slower than native.
- **Neon:** ~3–4 KB per face (vector + crop), so ~40 MB for 10k faces.

## 6. Setup (turning it on)
`onnxruntime-web` (WASM, no native binaries) and `sharp` are dependencies, and both models are committed in `lib/faces/models/`. Nothing to install. On a non-Vercel host, `npm i onnxruntime-node` is faster; the code uses whichever is installed.
1. Optional: set `CRON_SECRET` in Vercel so only Vercel can call the daily cron.
2. Deploy. The migration runs by itself (pgvector is available on every Neon plan).
3. Admin → **People → ON**. The admin page shows whether the server could load the models. Photos already in the album are queued at once.
4. Tune on real photos before the event: `npm run faces:eval -- ~/rehearsal-photos 0.4 3` writes `faces-eval.html`, one row of faces per person. Set `FACES_ASSIGN_SIM` / `FACES_MIN_FACES` in Vercel if the defaults merge or split too much.

### Verified
- **End-to-end test** (`npm run test:faces`, `tests/faces-e2e.test.ts`): real Postgres + pgvector, the migrations, photos served over HTTP like Blob, `enqueueFaceJob` → `drainFaceJobs` → clustering → a forced regroup → `GET /api/people`, a person's media and a cover crop. It needs `FACES_TEST_DB` (a Postgres it may create a database on) and `FACES_TEST_IMAGES` (photos named `<person>_*.jpg`, ≥ 3 per person, strangers start with `x`); otherwise it skips.
- **Measured on sample photos** (WASM, 1 thread): ~150–280 ms per photo after an ~0.8 s cold model load. Same person (different photos): similarity 0.74–0.95. Different people: ≤ 0.11. Threshold: 0.40.
- **Vercel bundle:** the face routes trace to ~96 MB (models, the ORT wasm, sharp/libvips), under the 250 MB limit. The models load from only the traced files.

## 7. Not in Phase 1
- Video frame sampling (§3, Videos).
- **"Find me" selfie search:** post a selfie, embed it in memory, never store it, jump to the closest person.
- Client-assisted embedding (option A) to save server CPU.
- A stronger embedder (option D). Changing `MODEL_ID` means rescanning.

## Sources
- Vercel function limits (Hobby: 300 s, 2 GB, 4 Active-CPU-h): https://vercel.com/docs/functions/limitations · https://vercel.com/docs/plans/hobby
- Background work with `after()` / `waitUntil`: https://vercel.com/kb/guide/how-to-run-background-jobs-in-nextjs-on-vercel
- Hobby cron, once a day: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Rekognition pricing (face APIs in Group 1; $0.00001 per stored face per month): https://aws.amazon.com/rekognition/pricing/
- OpenCV Zoo YuNet (MIT) and SFace (Apache-2.0): https://github.com/opencv/opencv_zoo · https://huggingface.co/opencv/face_recognition_sface
- InsightFace model licence (non-commercial research only): https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md
- Immich's incremental DBSCAN-style clustering: https://docs.immich.app/features/facial-recognition
- Neon pgvector: https://neon.com/docs/extensions/pgvector
- Israel PPL Amendment 13: https://iapp.org/news/a/israel-marks-a-new-era-in-privacy-law-amendment-13-ushers-in-sweeping-reform
- ONNX Runtime Web / WebGPU on iOS (limited): https://www.mintlify.com/microsoft/onnxruntime/execution-providers/webgpu · https://bugs.webkit.org/show_bug.cgi?id=311598
