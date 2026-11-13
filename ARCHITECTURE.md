# Wedding Media Upload: Architecture v1 (Vercel Hobby)

Status: draft v1 · 2026-11-12
Scope: first working version, running entirely on Vercel's free Hobby plan. Used for development and a small rehearsal (~30 guests). Not sized for the full 400-guest wedding (see §9).

---

## 1. Goals

| Goal | How v1 meets it |
|---|---|
| Zero-install for guests | PWA opened from a QR code; name + optional PIN, no account |
| Fast, reliable uploads on bad Wi-Fi | Compress on the phone, upload directly to Blob, persistent retry queue |
| Small files | Photos 2048 px WebP q75 (~600 KB); video 1080p H.264 ~2.5 Mbps (~15 MB per 45 s) |
| $0 cost | Vercel Hobby (personal, non-commercial use is allowed) + free-tier DB |
| Never get blocked mid-event | App enforces its own budget below every Hobby limit (§6) |
| Easy move to R2/Pro later | Storage behind a `StorageProvider` interface (§8) |

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| App | Next.js (App Router, TypeScript) on Vercel | One repo: PWA + API routes |
| File storage | Vercel Blob (public store, random-suffix paths) | Client uploads: bytes go phone → Blob, never through our functions |
| Metadata DB | Neon Postgres via Vercel Marketplace (free tier) | Source of truth for the gallery; we never call Blob `list()` |
| ORM | Drizzle | Small, SQL-first, works on serverless |
| Auth | Signed HTTP-only cookie (JWT via `jose`) | Guest token + separate admin token |
| Client compression | Canvas/`OffscreenCanvas` (photos), Mediabunny on WebCodecs (video) | All encoding happens on the phone |
| Client queue | IndexedDB (`idb-keyval` or Dexie) | Survives tab close / reload |
| Gallery refresh | Polling every 15 s with `?since=` cursor | No WebSockets/SSE needed |

## 3. High-level flow

```
Guest phone (PWA)
  │
  │ 1. POST /api/join {slug, name, pin?}  ──►  set guest cookie, insert guests row
  │
  │ 2. pick/shoot media
  │    └─ compress on device: photo→WebP 2048px q75 · video→1080p H.264 2.5 Mbps
  │    └─ make thumbnail (400 px WebP); for video, poster frame = thumbnail
  │    └─ SHA-256 of compressed file → enqueue in IndexedDB
  │
  │ 3. POST /api/media/reserve {sha256, kind, bytes, thumbBytes}
  │    ◄── {mediaId, paths} or {duplicate:true} or {rejected: "budget"|"limit"}
  │
  │ 4. @vercel/blob/client upload()  ──► POST /api/blob/token (handleUpload)
  │       onBeforeGenerateToken: check cookie, reservation, type, max size
  │    ──► PUT bytes directly to Vercel Blob (file, then thumb)
  │
  │ 5. POST /api/media/complete {mediaId, url, thumbUrl}
  │       idempotent; also triggered by onUploadCompleted webhook
  │
  │ 6. GET /api/gallery?since=…  (poll every 15 s)  ──► thumbs from Blob CDN
```

## 4. Upload pipeline (client)

1. **Select**: `<input type="file" accept="image/*,video/*" multiple>` (plus the camera via `capture`).
2. **Compress photo**: decode with `createImageBitmap` (handles EXIF orientation), resize to 2048 px on the long edge, encode WebP q0.75 (JPEG fallback on older Safari). Re-encoding drops EXIF/GPS automatically. Measured on real 16 MP phone photos: 6.5 MB → 578–643 KB.
3. **Compress video**: Mediabunny `Conversion` to MP4, H.264, max 1080p, ~2.5 Mbps video + 96 kbps AAC. Measured on real 1080p clips: ~15 MB per 45 s. Cap clip length at 3 min.
   - No WebCodecs → reject videos over 50 MB with a friendly message (v1 has no server encoder and only 1 GB of storage).
4. **Thumbnail**: 400 px WebP (~25–35 KB); for video, grab a frame at ~1 s via `<video>` + canvas.
5. **Hash**: SHA-256 of the compressed file (dedup).
6. **Queue**: store the blobs + metadata in IndexedDB; a worker loop uploads one item at a time (concurrency 1–2) with exponential backoff and jitter.
7. **UI**: per-item progress, "3 of 12 uploaded", retry button, and a banner when something is waiting.

## 5. Server

### 5.1 API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/join` | POST | Validate slug (+PIN), create guest, set cookie |
| `/api/media/reserve` | POST | Dedup by hash, check budgets (§6), insert row `status=reserved`, return paths |
| `/api/blob/token` | POST | `handleUpload`: `onBeforeGenerateToken` checks cookie + reservation, sets `allowedContentTypes`, `maximumSizeInBytes`, `addRandomSuffix`, long `cacheControlMaxAge` |
| `/api/media/complete` | POST | Mark `ready`, store URLs, add bytes to usage counters (idempotent) |
| `/api/gallery` | GET | Keyset-paginated list of `ready` media (`?since=` / `?before=`) |
| `/api/admin/media/:id` | PATCH | Hide/unhide (admin cookie) |
| `/api/admin/event` | PATCH | Toggle `upload_open`, change PIN |
| `/api/admin/usage` | GET | Budget dashboard (§6) |

Upload limits enforced in the token:
- photo: `image/webp`, `image/jpeg`; ≤ 2 MB
- video: `video/mp4`; ≤ 60 MB
- thumb: `image/webp`; ≤ 100 KB

### 5.2 Data model (Postgres)

```sql
create table events (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  pin_hash text,
  admin_key_hash text not null,
  upload_open boolean not null default true,
  created_at timestamptz not null default now()
);

create table guests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  display_name text not null,
  created_at timestamptz not null default now()
);

create table media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  guest_id uuid not null references guests(id),
  kind text not null check (kind in ('photo','video')),
  sha256 text not null,
  bytes bigint not null,
  thumb_bytes int not null,
  width int, height int, duration_s real,
  url text, thumb_url text,
  status text not null default 'reserved'
    check (status in ('reserved','ready','hidden','failed')),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  unique (event_id, sha256)
);
create index media_gallery on media (event_id, status, ready_at desc);

create table usage_month (          -- our own meter, mirrors Vercel's
  month date primary key,
  blob_bytes bigint not null default 0,
  blob_puts int not null default 0,
  est_transfer_bytes bigint not null default 0
);
```

Reservations not completed within 1 hour are marked `failed` and their budget is released (lazy cleanup on the next reserve).

## 6. Hobby plan limits and how v1 stays under them

Hobby never bills overage; it **blocks Blob access for up to 30 days** once a limit is hit. So the app tracks its own usage and refuses new uploads before Vercel does.

| Limit (Hobby, monthly) | Allowance | v1 cost per item | App-enforced cap |
|---|---|---|---|
| Blob storage | 1 GB | photo ~0.63 MB, video ~15 MB + thumb | stop new uploads at **850 MB** |
| Blob advanced ops (`put`, `copy`, `list`) | 2,000 | 2 puts (file + thumb) | stop at **1,700 puts** (~850 items) |
| Blob simple ops (reads on cache miss) | 10,000 | ~1–2 per item viewed | long cache headers; no `head()` calls |
| Blob data transfer | 10 GB | thumbs ~30 KB, full on tap | gallery shows thumbs only; warn at 8 GB |
| Blob ops rate | 15 advanced ops/s | | client concurrency 1–2 + backoff on 429 |
| Function invocations | 1,000,000 | ~5 per item + polling | poll every 15 s, only while the tab is visible |
| Fast Data Transfer | 100 GB | app shell only | static assets cached |

Rules that save operations:
- Never call `list()`; the DB is the index.
- Never `copy()`; write final paths once.
- Dedup by hash before uploading.
- Delete rehearsal data at month end (deletes are not advanced ops), or use a fresh Blob store per test.

**Practical v1 capacity:** ~850 items or ~850 MB per month, whichever comes first. Examples: ~1,300 photos, or ~550 photos + 20 short videos. That's enough for development and a rehearsal with a few dozen guests.

**Watch:** confirm in the rehearsal how client multipart uploads are counted. If each part counts as an op, keep videos as single-part uploads (they're ≤ 60 MB).

## 7. Security

- Bytes never touch our functions; the server only signs scoped upload tokens.
- Token constraints: content type allow-list, max size, random-suffix path under `events/{eventId}/{mediaId}/`.
- Blob store is public but paths are unguessable. Acceptable for a private event; move to a private store or R2 with signed URLs for the wedding.
- Guest cookie: HTTP-only, `SameSite=Lax`, 30-day expiry, signed with `JWT_SECRET`. Admin uses a separate cookie and key.
- Rate limits per guest: e.g. 200 items/hour, 300 MB/day, enforced in `reserve`.
- No server-side decoding of media, so no image/video parser attack surface on our side. Client-made thumbs are trusted for display only; admins can hide anything.
- PIN and admin key stored as hashes (argon2/bcrypt).
- `upload_open=false` closes the event instantly.

## 8. Portability: swap to R2 or Vercel Pro later

```ts
interface StorageProvider {
  // returns what the client needs to upload one object directly
  createUpload(input: {
    path: string; contentType: string; maxBytes: number;
  }): Promise<UploadTicket>;          // Vercel: client token · R2: presigned PUT URL
  publicUrl(path: string): string;    // or a signed GET URL for private stores
  delete(paths: string[]): Promise<void>;
}
```

- `VercelBlobProvider`: v1.
- `R2Provider`: presigned PUT via `@aws-sdk/s3-request-presigner`, 10 GB free storage, free egress.
- The client upload step calls one function, `uploadWithTicket(ticket, file)`, with a small adapter per provider.
- Budget caps (§6) live in config per provider, so moving to R2 or Pro just raises the numbers.

## 9. Path to the wedding (400 guests)

Expected load: ~3,700 items, ~9 GB (up to ~75–85 GB worst case), ~8,000 puts.
Hobby Blob would block after roughly the first 850 items. Pick one before the event:

| Option | Change | Cost |
|---|---|---|
| A. Vercel Hobby + Cloudflare R2 | Swap `StorageProvider`; app stays on Hobby | ~$0–1/month |
| B. Vercel Pro for the event month | Raise caps; Blob Pro includes 5 GB, 10k advanced ops, 100 GB transfer, then pay-as-you-go | $20 + small overage |

## 10. Repo layout

```
/app
  /(guest)/[slug]/page.tsx        join + camera/upload screen
  /(guest)/[slug]/gallery/page.tsx
  /admin/[slug]/page.tsx          moderation + usage dashboard
  /api/join/route.ts
  /api/media/reserve/route.ts
  /api/media/complete/route.ts
  /api/blob/token/route.ts        handleUpload
  /api/gallery/route.ts
  /api/admin/...
/lib
  /storage/provider.ts            StorageProvider interface
  /storage/vercel-blob.ts
  /db/schema.ts                   Drizzle schema (§5.2)
  /budget.ts                      usage caps (§6)
  /auth.ts                        cookies/JWT
/client
  /compress/photo.ts              canvas → WebP
  /compress/video.ts              Mediabunny → H.264 1080p
  /queue.ts                       IndexedDB upload queue
  /upload.ts                      provider adapters
/public/manifest.webmanifest      PWA
```

Env vars: `BLOB_READ_WRITE_TOKEN`, `DATABASE_URL`, `JWT_SECRET`, `ADMIN_KEY_HASH`.

## 11. Milestones

1. Next.js skeleton on Vercel, Neon connected, `join` + cookie.
2. Photo path end to end: compress → reserve → Blob client upload → complete → gallery.
3. IndexedDB queue with retry; offline/flaky-network test (Chrome throttling).
4. Video: Mediabunny compression + poster; 50 MB fallback rule.
5. Budget enforcement + admin usage page.
6. Admin: hide, close uploads, export (download list of URLs → `zip` locally).
7. Rehearsal with friends/family; compare our usage meter with Vercel's dashboard.
8. Decide on option A or B (§9) and switch the provider.

## 12. Open questions

- Is it OK that the full-quality originals aren't kept?
- Photo quality: keep q75 / 2048 px (~600 KB) or go to ~400 KB?
- Video bitrate: 2.5 Mbps (measured near-identical for talking/dancing, softer on fast detailed motion) or 3.5 Mbps?
- Should guests see each other's uploads live, or only the couple?
