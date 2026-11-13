import { parseArgs } from "node:util";
import { RecordingError } from "@replayforge/core";
import { migrate, Recordings, type Database, type RecordingSummary } from "@replayforge/storage";

export const USAGE = `usage: replayforge <command>

  db migrate                          apply pending database migrations
  recordings list                     list recordings (from the projection)
  recordings show <id>                one recording, plus its full event history
  recordings label <id> <label>       add a label
  recordings unlabel <id> <label>     remove a label (appends a RecordingLabelRemoved event)
  recordings seal <id>                seal a recording by hand (e.g. after a crash)
  projections rebuild                 rebuild every read model from the event log

options:
  --database-url <url>   default: $DATABASE_URL, else the docker-compose Postgres on localhost`;

export interface RunContext {
  db: Database;
  out: (line: string) => void;
}

/** A CLI usage error: print the message and the usage text, exit 2. */
class UsageError extends Error {}

/**
 * Runs one CLI command and returns the process exit code.
 * Kept separate from main.ts (which owns process.argv and the DB connection)
 * so tests can call it directly.
 */
export async function run(argv: string[], ctx: RunContext): Promise<number> {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "database-url": { type: "string" } },
  });
  const [group, command, ...rest] = positionals;
  const recordings = new Recordings(ctx.db);
  const { out } = ctx;

  const need = (n: number, what: string): string[] => {
    if (rest.length !== n) throw new UsageError(`expected ${what}`);
    return rest;
  };

  try {
    switch (`${group ?? ""} ${command ?? ""}`) {
      case "db migrate": {
        const { applied } = await migrate(ctx.db);
        out(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
        return 0;
      }

      case "recordings list": {
        await recordings.catchUp();
        const rows = await recordings.list();
        if (rows.length === 0) out("no recordings yet");
        else out(table(rows));
        return 0;
      }

      case "recordings show": {
        const [id] = need(1, "<id>");
        await recordings.catchUp();
        const summary = await recordings.get(id!);
        if (!summary) return notFound(out, id!);
        out(describe(summary));
        out("");
        out("events:");
        for (const { stored, event } of await recordings.history(id!)) {
          out(
            `  #${stored.streamVersion}  ${stored.recordedAt}  ${event.type}  ${JSON.stringify(event.payload)}`,
          );
        }
        return 0;
      }

      case "recordings label":
      case "recordings unlabel": {
        const [id, label] = need(2, "<id> <label>");
        const result =
          command === "label"
            ? await recordings.addLabel(id!, label!)
            : await recordings.removeLabel(id!, label!);
        await recordings.catchUp();
        out(result.appended.length ? `ok (${result.appended[0]!.type})` : "nothing to change");
        return 0;
      }

      case "recordings seal": {
        const [id] = need(1, "<id>");
        const result = await recordings.seal(id!, { reason: "manual" });
        await recordings.catchUp();
        out(result.appended.length ? "sealed" : "already sealed");
        return 0;
      }

      case "projections rebuild": {
        const count = await recordings.rebuild();
        out(`rebuilt "recordings" from ${count} events`);
        return 0;
      }

      default:
        throw new UsageError(group ? `unknown command: ${positionals.join(" ")}` : "");
    }
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message) out(`error: ${error.message}\n`);
      out(USAGE);
      return 2;
    }
    if (error instanceof RecordingError) {
      if (error.code === "not_found") return notFound(out, rest[0] ?? "");
      out(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function notFound(out: RunContext["out"], id: string): number {
  out(`error: recording ${id} not found`);
  return 1;
}

function describe(r: RecordingSummary): string {
  const lines = [
    `recording   ${r.recordingId}`,
    `status      ${r.status}${r.sealReason ? ` (${r.sealReason})` : ""}`,
    `service     ${r.service} ${r.serviceVersion} on ${r.hostname}`,
    `location    ${r.location}`,
    `sampling    ${r.sampleRate * 100}%`,
    `started     ${r.startedAt}`,
    `sealed      ${r.sealedAt ?? "-"}`,
    `exchanges   ${r.exchangeCount ?? "-"} written, ${r.droppedCount ?? "-"} dropped`,
    `labels      ${r.labels.join(", ") || "-"}`,
  ];
  return lines.join("\n");
}

function table(rows: RecordingSummary[]): string {
  const data = [
    ["RECORDING", "STATUS", "SERVICE", "STARTED", "EXCHANGES", "LABELS"],
    ...rows.map((r) => [
      r.recordingId,
      r.status,
      `${r.service}@${r.serviceVersion}`,
      r.startedAt.replace("T", " ").slice(0, 19),
      r.exchangeCount === null ? "-" : String(r.exchangeCount),
      r.labels.join(",") || "-",
    ]),
  ];
  const widths = data[0]!.map((_, col) => Math.max(...data.map((row) => row[col]!.length)));
  return data
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
