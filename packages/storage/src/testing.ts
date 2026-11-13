import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlClient } from "./db.js";
import { migrate } from "./migrate.js";

/**
 * An in-memory Postgres for tests: PGlite runs real Postgres compiled to
 * WebAssembly inside the Node process. Each call returns a fresh, empty,
 * migrated database. No Docker, no shared state between tests.
 *
 * PGlite has a single connection, so transactions run one after another.
 * That's fine for correctness tests; real concurrency needs a real server.
 */
export async function createTestDatabase(): Promise<Database> {
  const pglite = new PGlite();
  const wrap = (client: Pick<PGlite, "query" | "exec">): SqlClient => ({
    async query<R>(text: string, params?: unknown[]) {
      const result = await client.query<R>(text, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
  });

  const db: Database = {
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
  await migrate(db);
  return db;
}
