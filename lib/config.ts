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
  video: { types: ["video/mp4", "video/quicktime"], maxBytes: 60 * MB },
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
  pollMs: 15_000,
  /** CDN cache for the polling endpoint; 400 phones polling ≈ 1 origin hit / 10 s */
  sMaxAge: 10,
} as const;

export const MB_ = MB;
export const GB_ = GB;
