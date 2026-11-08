# replayforge

A system that captures HTTP traffic, stores requests as replayable events, and reproduces those requests against another API environment to test behavior, compatibility, performance, and reliability.

This is a learning project, built one stage at a time.

| Stage | Topic                   | Status                                          |
| ----- | ----------------------- | ----------------------------------------------- |
| 1     | HTTP traffic capture    | ✅ [docs/architecture.md](docs/architecture.md) |
| 2–10  | Event model → analytics | not started                                     |

## Requirements

- Node.js 22.13+ and pnpm 10 (`corepack enable`)
- Docker (optional: only needed to run the k6 traffic generator)

## Quick start

```sh
pnpm install
pnpm check          # typecheck + lint + tests
```

### Record traffic locally

```sh
pnpm dev:capture    # demo API on http://localhost:3001, capture on
```

Use the API, for example in another terminal:

```sh
curl -X POST localhost:3001/api/auth/login -H "content-type: application/json" \
     -d '{"username":"user001","password":"password123"}'
```

Each server start creates a new recording in `recordings/<recordingId>/events.jsonl`, with one
captured request/response per line. Stop the server with Ctrl+C so the file is flushed cleanly.

### Record realistic traffic with k6 (Docker)

```sh
docker compose up -d --build api        # demo API with capture on, writing to ./recordings
docker compose run --rm k6              # 200 shopper journeys (login → browse → cart → order → pay)
docker compose stop api                 # flush and close the recording
```

## Repository layout

```
packages/capture   Fastify plugin that records traffic (+ event schema, sinks)
apps/demo-api      Small e-commerce API used as the system under test
apps/traffic       k6 script that generates shopper traffic
docs/              Design notes, one per stage
```

Demo API endpoints: `POST /api/auth/login`, `GET /api/products`, `GET /api/products/:id`,
`POST /api/cart/items`, `GET /api/cart`, `POST /api/orders`, `POST /api/payments`.
Seeded users are `user001` … `user100`, all with password `password123`. Prices are integer cents.
