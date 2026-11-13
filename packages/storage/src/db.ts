import pg from "pg";

/**
 * The smallest database interface the rest of the code needs.
 *
 * Production uses node-postgres (`pg`) against a real Postgres server. Tests
 * use PGlite, which is real Postgres compiled to WebAssembly and running
 * in-process (see testing.ts). Both are hidden behind this interface, so the
 * SQL and the event-store code are identical in both cases.
 */
export interface SqlClient {
  /** One statement, with $1, $2... parameters. */
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Several statements with no parameters (e.g. a migration file). */
  exec(sql: string): Promise<void>;
}

export interface Database extends SqlClient {
  /**
   * Runs `fn` inside BEGIN ... COMMIT. If `fn` throws, the transaction is
   * rolled back and the error rethrown. Every query inside `fn` must use the
   * `tx` client it receives, not the outer Database.
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres error code for "unique constraint violated". */
export const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return e?.code === UNIQUE_VIOLATION && (constraint === undefined || e.constraint === constraint);
}

function wrapPgClient(client: pg.Pool | pg.PoolClient): SqlClient {
  return {
    async query<R>(text: string, params?: unknown[]) {
      const result = await client.query(text, params);
      return { rows: result.rows as R[] };
    },
    async exec(sql: string) {
      // Without parameters, pg uses Postgres' "simple query" protocol,
      // which accepts several statements separated by semicolons.
      await client.query(sql);
    },
  };
}

/** Connects to Postgres, e.g. postgres://replayforge:replayforge@localhost:5435/replayforge */
export function createPgDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 5 });
  // An idle client can lose its connection (e.g. Postgres restarts). Without a
  // listener the 'error' event would crash the process.
  pool.on("error", () => {});
  const base = wrapPgClient(pool);

  return {
    ...base,
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      // A transaction has to run on ONE connection, so take one out of the pool.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrapPgClient(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** pg returns BIGINT as a string (it can exceed Number.MAX_SAFE_INTEGER); PGlite may not. */
export function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** Timestamps come back as Date objects. We pass ISO strings around. */
export function toIso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}
