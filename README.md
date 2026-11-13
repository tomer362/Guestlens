# GuestLens

A wedding photo/video PWA. Guests scan a QR code, see a short animated walkthrough (Hebrew by default, with an English toggle), then shoot and upload. Their phone compresses each file first, then sends it straight to Vercel Blob. Design doc: [ARCHITECTURE.md](ARCHITECTURE.md).

## What's in v1

| Area | Where |
|---|---|
| First-visit onboarding: welcome + optional name → shoot → auto-upload → gallery → install | `components/onboarding/*` |
| Hebrew/English with RTL/LTR, no flash (language cookie read on the server) | `lib/i18n/*`, `components/LangToggle.tsx` |
| Install with the fewest taps, per platform | `lib/pwa/platform.ts`, `components/onboarding/InstallGuide.tsx` |
| Per-event manifest (installed icon opens that event) | `app/e/[slug]/manifest.webmanifest/route.ts` |
| Photo → 2048 px WebP q75; video → H.264 ≤1080p 2.5 Mbps (Mediabunny, lazy-loaded) | `client/compress/*` |
| Persistent upload queue (IndexedDB, backoff + jitter, resumes after reload, one tab at a time via Web Locks) | `client/queue.ts` |
| reserve → client token → direct upload → complete (+ `onUploadCompleted` backup) | `app/api/media/*`, `app/api/blob/token` |
| Gallery: keyset pages + CDN-cached polling | `app/api/gallery`, `components/gallery/Gallery.tsx` |
| Phone-only first-time setup (tables + event) | `/setup` (needs `SETUP_KEY`) |
| Admin: usage meters, open/close uploads, private album, PIN, hide, URL export, printable QR | `/admin/<slug>` |
| Offline app shell | `public/sw.js` |

### How installing works on each platform
- **Android / Chromium**: we catch `beforeinstallprompt` in an inline `<head>` script, so it's never missed. The guest gets one **Install** button (one tap plus the system confirm).
- **iPhone/iPad Safari**: there's no install API. An animated phone mock walks through Share → Add to Home Screen → Add, with the steps highlighted in sync. iPad points to the top toolbar.
- **Chrome/Firefox on iOS**: the same flow, using the Share button in the address bar.
- **WhatsApp / Instagram / Facebook in-app browsers**: these can't install. Android gets an **Open in Chrome** button (an `intent://` URL); iOS gets "⋯ → Open in Safari" plus a copy-link button.
- **Already installed**: the step is skipped.
- Installing is optional, and the UI says so. The **Install** button in the header re-opens the guide at any time.
- The QR code should point to `/e/<slug>`. Phone cameras open it in Safari/Chrome (not a webview), which is the best install path.
- An installed iOS app doesn't share cookies with Safari. The app re-joins silently on start, and the saved name lives in the app's own storage.

## Scaling: Hobby now, more later
Budget numbers live only in `lib/config.ts` and come from env:

| `PLAN` | Storage cap | Upload ops cap |
|---|---|---|
| `hobby` (default) | 850 MB | 1,700 / month |
| `pro` | 100 GB | 50,000 / month |
| `custom` | `BUDGET_STORAGE_BYTES` | `BUDGET_PUTS` |

- Budget counters use single conditional UPSERTs, so concurrent uploads can't race past a cap.
- Upload tokens allow exactly the reserved byte count.
- Gallery polling responses are identical for every guest and cached at the CDN (`s-maxage=10`), so 400 phones polling every 15 s hit the origin about once every 10 s. Polling pauses when the tab is hidden and backs off when idle.
- Neon's HTTP driver means there's no connection pool to exhaust under serverless fan-out.
- Storage sits behind `StorageProvider` (`lib/storage/`). Another store means one new file plus `STORAGE_PROVIDER=…`. No external storage is wired in now.

## Setup (Vercel), phone only
1. On vercel.com: **Add New → Project →** import this repo (framework: Next.js).
2. Project **Storage** tab → **Create → Blob** (public). This adds `BLOB_READ_WRITE_TOKEN`.
3. **Storage → Marketplace → Neon** (free). This adds `DATABASE_URL`.
4. **Settings → Environment Variables**, add two long random strings (a password generator works):
   - `JWT_SECRET`
   - `SETUP_KEY` (12+ characters)
5. **Deployments → ⋯ → Redeploy**, so the new variables take effect.
6. Open `https://<app>.vercel.app/setup` and enter the setup key, event name, link name and optional PIN.
   This creates the tables and the event, then shows the guest link, the admin link and the **admin key (shown once, save it)**.
7. Open `/admin/<slug>`, sign in with the admin key, and download the QR code.

<details><summary>Same thing from a computer</summary>

```bash
npm i && vercel env pull .env.local
npm run db:migrate
APP_URL=https://<app>.vercel.app npm run seed -- <slug> "<event name>" [pin]
```
</details>

## Development
```bash
npm run dev          # without DATABASE_URL, /e/demo renders with a fake event (UI only)
npm test             # unit tests: budget, platform detection, he/en key parity
npm run build
npm run icons        # re-render public/icons from scripts/icon.svg
```
`GL_DEMO=1 npm start` serves the demo event from a production build.

## Known v1 limits
- Hidden items disappear from guests' galleries on their next full load, not instantly.
- Phones without WebCodecs upload the original MP4 as-is if it's ≤ 50 MB; anything else is refused.
- Without a database, `/e/demo` shows the UI only; uploads need Neon + Blob.
