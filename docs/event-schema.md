# Event schema (Stage 2)

ReplayForge has **two kinds of events**. They look similar (immutable facts with a schema
version) but they serve different purposes, so they're stored differently.

|           | Traffic events                                  | Lifecycle (domain) events                         |
| --------- | ----------------------------------------------- | ------------------------------------------------- |
| Example   | `CapturedExchange`: one request + response      | `RecordingStarted`, `RecordingSealed`             |
| About     | the **observed API**                            | **ReplayForge itself**                            |
| Volume    | huge (one per request, KBs each)                | tiny (a handful per recording)                    |
| Stored in | JSONL files: `recordings/<id>/events.jsonl`     | Postgres `events` table                           |
| Read by   | streaming readers (replay, Stage 4)             | aggregates and projections (queries, rules)       |
| Schema    | [exchange.ts](../packages/core/src/exchange.ts) | [recording.ts](../packages/core/src/recording.ts) |

**Why not put the exchanges in Postgres too?** It works for a few thousand rows. At 50,000 exchanges
per recording, each with full bodies, it fills the database with bulk data that nothing ever queries
with SQL. Files are cheap and fast to stream, and they can move to object storage later (Stage 9).
The database keeps the small facts that need rules, transactions and queries. The `location` field
in `RecordingStarted` connects the two.

---

## Anatomy of a lifecycle event

In code, a domain event is just `{ type, payload }`:

```ts
{ type: "RecordingLabelAdded", payload: { label: "baseline", at: "2026-11-12T10:05:00.000Z" } }
```

The event store wraps it in an **envelope** when it's stored (one row of the `events` table):

| Column            | Set by   | Meaning                                                      |
| ----------------- | -------- | ------------------------------------------------------------ |
| `event_id`        | store    | unique id (UUID) of this event                               |
| `stream_id`       | caller   | which aggregate it belongs to: `recording-<recordingId>`     |
| `stream_version`  | store    | 1, 2, 3… within the stream                                   |
| `global_position` | Postgres | order across all streams                                     |
| `type`            | domain   | `RecordingLabelAdded`                                        |
| `schema_version`  | domain   | version of the payload's shape (currently 1 for every type)  |
| `payload`         | domain   | the facts (JSONB)                                            |
| `metadata`        | caller   | context that isn't part of the fact (e.g. who ran a command) |
| `recorded_at`     | Postgres | when the row was written                                     |

There are two timestamps on purpose. `payload.at`/`startedAt` is when the fact **happened** (the
domain's clock). `recorded_at` is when it was **stored**. They usually match closely, but a manual
seal after a crash, or an import of old data, makes them different.

The store is **generic**. It knows nothing about recordings: it stores `type`, `schema_version` and
`payload` as given. Interpreting them is the domain's job (`parseRecordingEvent`). Later stages will
add more stream types (e.g. replay sessions in Stage 4) to the same table.

## The recording events

```
RecordingStarted ──▶ RecordingLabelAdded* ──▶ RecordingLabelRemoved* ──▶ RecordingSealed
                       (labels can be added/removed any time after the start, even after sealing)
```

| Event                   | Payload                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `RecordingStarted`      | `recordingId`, `service {name, version, hostname}`, `location`, `startedAt`, `settings`      |
| `RecordingLabelAdded`   | `label`, `at`                                                                                |
| `RecordingLabelRemoved` | `label`, `at`                                                                                |
| `RecordingSealed`       | `sealedAt`, `reason` (`shutdown`/`manual`), `exchangeCount`, `droppedCount` (null = unknown) |

Design choices worth noticing:

- **Names are past tense.** An event is something that _already happened_ and can't be refused.
  "Start recording" is a _command_ (a request, which can fail). "Recording started" is the event.
- **`settings` is copied into `RecordingStarted`.** Two months from now, someone looking at a
  recording needs to know it was sampled at 10% or had `password` redacted. Events should carry
  everything needed to understand them later, even if that duplicates config.
- **Removal is a new event, not a delete.** `RecordingLabelRemoved` _compensates_ for an earlier
  `RecordingLabelAdded`. Both stay in the history, so "who labeled this baseline, and when was that
  taken back?" always has an answer.
- **`null` means unknown, not zero.** A manual seal after a crash can't know how many exchanges were
  written. `exchangeCount: 0` would be a lie. `null` is honest.

---

## Versioning: how events change without breaking history

Events are stored forever, so their schema has to evolve without rewriting old data. The rules used
here, from cheapest to most expensive:

1. **Add an optional field: no new version.** Old events simply don't have it, and readers treat a
   missing field as "unknown". This covers most changes.
2. **Change a field's meaning or type, or rename one: bump `schemaVersion` and write an upcaster.**
   An _upcaster_ is a function that turns an old payload into the new shape **when it's read**:

   ```ts
   // in parseRecordingEvent, when RecordingSealed v2 exists:
   if (stored.type === "RecordingSealed" && stored.schemaVersion === 1) {
     const v1 = RecordingSealedV1.parse(stored.payload);
     return {
       type: "RecordingSealed",
       payload: { ...v1, exchanges: { written: v1.exchangeCount } },
     };
   }
   ```

   The stored row never changes, and the rest of the code only ever sees the current shape.
   (Migrating the stored data instead would break the "events never change" rule, and the database's
   append-only trigger forbids it anyway.)

3. **The concept itself changed: create a new event type** and stop emitting the old one.
   Readers still understand the old type, so history still works.

Readers **reject versions they don't know** instead of guessing (`parseExchange` and
`parseRecordingEvent` both throw). An old build reading newer data should fail loudly rather than
silently drop a field it doesn't understand.

The same rule applies to the JSONL traffic events: every `CapturedExchange` carries `schemaVersion`,
and readers go through [`parseExchange`](../packages/core/src/exchange.ts), which is where a v1→v2
upcaster would go.
