# Functional backup/drill tooling, never installed in API or analysis containers.
FROM node@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS patched
# DSA-6613-1 (zlib, ADR-093) and Debian 13.7's glibc fixes for CVE-2026-5435 and
# CVE-2026-19499 (ADR-108). Apply the fixed packages to build and runtime.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends --only-upgrade zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
    libc6=2.41-12+deb13u5 libc-bin=2.41-12+deb13u5 \
 && rm -rf /var/lib/apt/lists/*

FROM patched AS build
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec tsc -b apps/worker \
 && pnpm --filter @atlas/worker deploy --prod --legacy --config.strict-peer-dependencies=false /atlas

FROM patched
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client-17=17.12-0+deb13u1 openssl=3.5.7-1~deb13u3 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10002 atlas-backup && useradd --uid 10002 --gid 10002 --no-create-home atlas-backup
COPY --from=build --chown=root:root /atlas /atlas
COPY deploy/production/backup.mjs deploy/production/restore-drill.mjs /operator/
ENV ATLAS_WORKER_RUNTIME=/atlas ATLAS_PG_BIN=/usr/lib/postgresql/17/bin
USER 10002:10002
