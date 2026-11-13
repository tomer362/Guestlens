/** Neon's Vercel integration names the variable after a chosen prefix; accept the common ones. */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL ?? process.env.STORAGE_URL ?? process.env.POSTGRES_URL;
}
