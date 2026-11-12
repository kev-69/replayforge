# replayforge

A system that captures HTTP traffic, stores requests as replayable events, and reproduces those requests against another API environment to test behavior, compatibility, performance, and reliability.

This is a learning project, built one stage at a time.

| Stage | Topic                       | Status                                                                                                  |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1     | HTTP traffic capture        | ✅ [docs/architecture.md](docs/architecture.md) (Part I)                                                |
| 2     | Event model, event sourcing | ✅ [docs/architecture.md](docs/architecture.md) (Part II), [docs/event-schema.md](docs/event-schema.md) |
| 3–10  | Integrity → analytics       | not started                                                                                             |

## Requirements

- Node.js 22.13+ and pnpm 10 (`corepack enable`)
- Docker, for Postgres and the k6 traffic generator. `pnpm test` doesn't need it: tests use an
  in-process Postgres (PGlite).

## Quick start

```sh
pnpm install
pnpm check          # typecheck + lint + tests
```

### Record traffic locally

```sh
docker compose up -d postgres     # Postgres on localhost:5435
pnpm replayforge db migrate       # create the tables
pnpm dev:capture                  # demo API on http://localhost:3001, capture on
```

Use the API, for example in another terminal:

```sh
curl -X POST localhost:3001/api/auth/login -H "content-type: application/json" \
     -d '{"username":"user001","password":"password123"}'
```

Each server start creates a new recording:

- the exchanges (one request/response per line) go to `recordings/<recordingId>/events.jsonl`;
- `RecordingStarted` / `RecordingSealed` events go to Postgres.

Stop the server with Ctrl+C so the file is flushed and the recording sealed. Postgres is optional:
without it, capture still writes the file and logs a warning.

### Inspect recordings

```sh
pnpm replayforge recordings list
pnpm replayforge recordings show <id>             # details + full event history
pnpm replayforge recordings label <id> baseline
pnpm replayforge recordings seal <id>             # for a recording whose process crashed
pnpm replayforge projections rebuild              # recompute read models from the event log
```

The CLI connects to `localhost:5435` by default. Override with `--database-url` or `DATABASE_URL`.

### Record realistic traffic with k6 (all in Docker)

```sh
docker compose up -d --build api   # postgres → migrate (one-shot) → api with capture on
docker compose run --rm k6         # 200 shopper journeys (login → browse → cart → order → pay)
docker compose stop api            # flush the file and seal the recording
pnpm replayforge recordings list
```

## Repository layout

```
packages/core      Event schemas and business rules (pure, no I/O)
packages/capture   Fastify plugin that records traffic, and its sinks
packages/storage   Postgres event store, migrations, projections
packages/cli       The `replayforge` command-line tool
apps/demo-api      Small e-commerce API used as the system under test
apps/traffic       k6 script that generates shopper traffic
docs/              Design notes
```

Demo API endpoints: `POST /api/auth/login`, `GET /api/products`, `GET /api/products/:id`,
`POST /api/cart/items`, `GET /api/cart`, `POST /api/orders`, `POST /api/payments`.
Seeded users are `user001` … `user100`, all with password `password123`. Prices are integer cents.
