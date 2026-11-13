import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { databaseUrl } from "./url";

// Neon's HTTP driver: one HTTPS round-trip per query, no TCP pool to exhaust
// when hundreds of serverless invocations fan out at once.
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function db() {
  if (!_db) {
    const url = databaseUrl();
    if (!url) throw new Error("DATABASE_URL (or STORAGE_URL) is not set");
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}
export { schema };
