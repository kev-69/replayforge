import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./db.js";

/**
 * A tiny migration runner. Tools like node-pg-migrate do the same thing with more features:
 *
 *   1. Keep a table of migrations that have already been applied.
 *   2. Find the .sql files, sorted by name (001_..., 002_...).
 *   3. Apply each missing one inside a transaction, and record it in the same
 *      transaction. A failure leaves nothing half-applied.
 *
 * An advisory lock (a named lock with no table behind it) makes concurrent
 * runners safe. If two API containers start at the same moment, the second
 * one waits, then sees the migration is already applied and skips it.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Arbitrary but fixed number that names our migration lock. */
const MIGRATION_LOCK_KEY = 7_420_000;

export async function migrate(
  db: Database,
  directory: string = MIGRATIONS_DIR,
): Promise<{ applied: string[] }> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const sql = await readFile(join(directory, file), "utf8");

    const didApply = await db.transaction(async (tx) => {
      // Held until COMMIT/ROLLBACK, then released automatically.
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const existing = await tx.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
        version,
      ]);
      if (existing.rows.length > 0) return false;
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      return true;
    });
    if (didApply) applied.push(version);
  }

  return { applied };
}
