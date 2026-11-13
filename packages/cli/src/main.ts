import { parseArgs } from "node:util";
import { createPgDatabase } from "@replayforge/storage";
import { run } from "./run.js";

/** The Postgres from docker-compose.yml. Override with --database-url or $DATABASE_URL. */
const LOCAL_DATABASE_URL = "postgres://replayforge:replayforge@localhost:5435/replayforge";

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv,
  allowPositionals: true,
  strict: false,
  options: { "database-url": { type: "string" } },
});

const databaseUrl =
  (values["database-url"] as string | undefined) ?? process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

const db = createPgDatabase(databaseUrl);
try {
  process.exitCode = await run(argv, { db, out: (line) => console.log(line) });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  if ((error as { code?: string }).code === "ECONNREFUSED") {
    console.error(
      `could not reach Postgres at ${databaseUrl}. Is it running? (docker compose up -d postgres)`,
    );
  }
  process.exitCode = 1;
} finally {
  await db.close();
}
