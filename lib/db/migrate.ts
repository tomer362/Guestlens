import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "./client";

/**
 * Apply drizzle/*.sql files that haven't run yet. Lets the app set up its own
 * database from the /setup page, with no terminal needed.
 */
export async function migrate(): Promise<string[]> {
  const d = db();
  await d.execute(sql`create table if not exists _gl_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set(((await d.execute(sql`select name from _gl_migrations`)).rows as { name: string }[]).map((r) => r.name));
  const dir = path.join(process.cwd(), "drizzle");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const stmts = readFileSync(path.join(dir, f), "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    for (const s of stmts) await d.execute(sql.raw(s));
    await d.execute(sql`insert into _gl_migrations (name) values (${f}) on conflict do nothing`);
    applied.push(f);
  }
  return applied;
}

let once: Promise<void> | null = null;
/**
 * Run pending migrations once per server instance (one cheap query when up to date).
 * New columns ship with a deploy; no manual step needed. Migrations must be idempotent
 * (IF NOT EXISTS), since two cold instances can race.
 */
export function ensureMigrated(): Promise<void> {
  once ??= migrate().then(
    (applied) => { if (applied.length) console.info("[migrate] applied", applied); },
    (e) => { once = null; console.error("[migrate] failed", e); },
  );
  return once;
}
