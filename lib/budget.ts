import { sql } from "drizzle-orm";
import { getBudget, type Budget } from "./config";
import { db } from "./db/client";

export type BudgetVerdict = { ok: true } | { ok: false; reason: "storage" | "puts" };

/** Pure check, used by tests and the admin dashboard. */
export function evaluate(
  usage: { storageBytes: number; puts: number },
  add: { bytes: number; puts: number },
  budget: Budget = getBudget(),
): BudgetVerdict {
  if (usage.storageBytes + add.bytes > budget.storageBytes) return { ok: false, reason: "storage" };
  if (usage.puts + add.puts > budget.puts) return { ok: false, reason: "puts" };
  return { ok: true };
}

export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Atomically reserve storage bytes + put operations. Each counter is a single
 * conditional UPSERT, so concurrent reservations can't push it past the cap.
 * If the second step fails, the first is rolled back.
 */
export async function consume(bytes: number, puts: number): Promise<BudgetVerdict> {
  const b = getBudget();
  const d = db();
  const month = monthKey();

  const p = await d.execute(sql`
    insert into usage_month (month, blob_puts) values (${month}, ${puts})
    on conflict (month) do update set blob_puts = usage_month.blob_puts + excluded.blob_puts
    where usage_month.blob_puts + excluded.blob_puts <= ${b.puts}
    returning blob_puts`);
  if (p.rows.length === 0 || puts > b.puts) return { ok: false, reason: "puts" };

  const s = await d.execute(sql`
    insert into storage_usage (id, bytes) values (1, ${bytes})
    on conflict (id) do update set bytes = storage_usage.bytes + excluded.bytes
    where storage_usage.bytes + excluded.bytes <= ${b.storageBytes}
    returning bytes`);
  if (s.rows.length === 0 || bytes > b.storageBytes) {
    await d.execute(sql`update usage_month set blob_puts = greatest(0, blob_puts - ${puts}) where month = ${month}`);
    return { ok: false, reason: "storage" };
  }
  return { ok: true };
}

/** Give bytes back (expired reservation, deleted media). Puts already spent stay spent. */
export async function releaseStorage(bytes: number) {
  if (bytes <= 0) return;
  await db().execute(sql`update storage_usage set bytes = greatest(0, bytes - ${bytes}) where id = 1`);
}

export async function readUsage() {
  const d = db();
  const [m, s] = await Promise.all([
    d.execute(sql`select blob_puts from usage_month where month = ${monthKey()}`),
    d.execute(sql`select bytes from storage_usage where id = 1`),
  ]);
  return {
    puts: Number((m.rows[0] as { blob_puts?: number } | undefined)?.blob_puts ?? 0),
    storageBytes: Number((s.rows[0] as { bytes?: number } | undefined)?.bytes ?? 0),
    budget: getBudget(),
  };
}
