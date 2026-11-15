/**
 * Every plan-dependent number lives here. Moving from Hobby to Pro (or to a
 * different StorageProvider) means changing env vars, not code.
 */
const MB = 1024 * 1024;
const GB = 1024 * MB;

export type PlanName = "hobby" | "pro" | "custom";

export interface Budget {
  /** stop accepting new uploads once stored bytes would pass this */
  storageBytes: number;
  /** stop once advanced Blob ops (puts) would pass this */
  puts: number;
}

const PROFILES: Record<Exclude<PlanName, "custom">, Budget> = {
  // Hobby: 1 GB storage, 2,000 advanced ops, 10 GB transfer. Keep ~15% headroom.
  hobby: { storageBytes: 850 * MB, puts: 1_700 },
  // Pro: overage is billed instead of blocked, so caps are a cost guard-rail.
  pro: { storageBytes: 100 * GB, puts: 50_000 },
};

function num(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function getPlan(): PlanName {
  const p = (process.env.PLAN ?? "hobby").toLowerCase();
  return p === "pro" || p === "custom" ? p : "hobby";
}

export function getBudget(): Budget {
  const plan = getPlan();
  const base = plan === "custom" ? PROFILES.pro : PROFILES[plan];
  return {
    storageBytes: num("BUDGET_STORAGE_BYTES") ?? base.storageBytes,
    puts: num("BUDGET_PUTS") ?? base.puts,
  };
}

/** Per-upload limits, also enforced in the Blob client token. */
export const LIMITS = {
  photo: { types: ["image/webp", "image/jpeg"], maxBytes: 2 * MB },
  // video/quicktime: iPhone originals uploaded as-is when on-device conversion isn't possible
  // video/webm: realtime MediaRecorder output (Firefox Android & other browsers without WebCodecs)
  // NEXT_PUBLIC_VIDEO_MAX_MB raises the cap on Pro (client + server read the same value)
  video: { types: ["video/mp4", "video/quicktime", "video/webm"], maxBytes: (Number(process.env.NEXT_PUBLIC_VIDEO_MAX_MB) || 60) * MB },
  thumb: { types: ["image/webp", "image/jpeg"], maxBytes: 100 * 1024 },
  maxVideoSeconds: 180,
  /** without WebCodecs we upload the original, so cap it */
  rawVideoMaxBytes: 50 * MB,
  reservationTtlMs: 60 * 60 * 1000,
  perGuestItemsPerHour: 200,
  perGuestBytesPerDay: 300 * MB,
} as const;

export const GALLERY = {
  pageSize: 60,
  /**
   * Clients poll a tiny version number this often (while visible) and only fetch items when it
   * changes. The version reply is CDN-cached for `versionMaxAge` s, so 400 phones ≈ 1 origin
   * read per 2 s; item pages are keyed by version, so they can be cached long and never be stale.
   */
  versionPollMs: 4_000,
  versionMaxAge: 2,
  pageMaxAge: 300,
} as const;

/**
 * Face grouping (FACES.md). Similarities are cosine on L2-normalised SFace vectors.
 * Tune `assignSim` / `minFaces` on rehearsal photos with scripts/faces-eval.ts.
 */
export const FACES = {
  /** detector input: the image is letterboxed into this square (YuNet 2023mar is fixed at 640) */
  detectSize: 640,
  /**
   * Besides the whole image, YuNet also runs on a tiles×tiles grid of overlapping crops, so faces
   * in group shots (≈20 px after shrinking 2048 → 640) are seen ~2× bigger. 1 = whole image only.
   */
  tiles: Number(process.env.FACES_TILES) || 2,
  /**
   * detector cut-off. 0.7 let ceilings, grilles and signs through (and with 5 passes per photo
   * they get 5 chances); real faces below 0.8 are mostly too dark or blurry to group anyway.
   */
  minScore: Number(process.env.FACES_MIN_SCORE) || 0.8,
  /** smallest face side in source pixels worth embedding */
  minFacePx: 36,
  /** faces below this quality may join a person but never start one */
  seedQuality: 0.45,
  /**
   * every new person needs at least one face the detector is this sure of (and of seedQuality):
   * stray false detections (ceilings, grilles, pets) score below it, real faces above
   */
  anchorScore: Number(process.env.FACES_ANCHOR_SCORE) || 0.9,
  /** neighbours this similar count as "the same person" (SFace's own match threshold is 0.363) */
  assignSim: Number(process.env.FACES_ASSIGN_SIM) || 0.4,
  neighbours: 10,
  /**
   * a new person needs this many mutually similar faces (DBSCAN core point, Immich-style).
   * 1 = anyone seen once in a good-quality face gets a circle (sorted by photo count, so one-offs
   * sit at the end); raise to 2–3 to hide background faces.
   */
  minFaces: Number(process.env.FACES_MIN_FACES) || 1,
  /** full regroup once the face count grew by max(rebuildMin, rebuildFrac × last count) */
  rebuildMin: 200,
  rebuildFrac: 0.25,
  /** jobs per background drain, and its time budget (the function's duration also covers the response) */
  jobsPerDrain: 8,
  drainBudgetMs: 45_000,
  jobLeaseMs: 90_000,
  maxAttempts: 3,
  clusterLeaseMs: 60_000,
  cropEdge: 96,
  /** purge faces/people this many days after an event's last upload (daily cron) */
  retentionDays: Number(process.env.FACES_RETENTION_DAYS) || 60,
} as const;

export const MB_ = MB;
export const GB_ = GB;
