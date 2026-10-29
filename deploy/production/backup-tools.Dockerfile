# Functional backup/drill tooling, never installed in API or analysis containers.
FROM node@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a AS build
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec tsc -b apps/worker \
 && pnpm --filter @atlas/worker deploy --prod --legacy --config.strict-peer-dependencies=false /atlas

FROM node@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client-17=17.11-0+deb13u1 openssl=3.5.7-1~deb13u3 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10002 atlas-backup && useradd --uid 10002 --gid 10002 --no-create-home atlas-backup
COPY --from=build --chown=root:root /atlas /atlas
COPY deploy/production/backup.mjs deploy/production/restore-drill.mjs /operator/
ENV ATLAS_WORKER_RUNTIME=/atlas ATLAS_PG_BIN=/usr/lib/postgresql/17/bin
USER 10002:10002
