# Build context is the repo root (see docker-compose.yml).
FROM node:22.23.4-alpine

WORKDIR /app
RUN corepack enable

# 1) Download dependencies using only the lockfile. This layer is cached until
#    pnpm-lock.yaml changes, so editing source code doesn't re-download packages.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch

# 2) Copy the workspace and link packages from the store (no network needed).
COPY . .
RUN pnpm install --offline --frozen-lockfile

ENV HOST=0.0.0.0
# Run node directly (not via pnpm) so SIGTERM from `docker compose stop`
# reaches the app's shutdown handler.
CMD ["node", "--import", "tsx", "apps/demo-api/src/server.ts"]
