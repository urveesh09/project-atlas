# ATLAS API image (P5.6): admission, job status/events and publication reads, plus the
# built viewer served same-origin. It holds no Docker access and never analyzes code.
#
#   docker build -f deploy/api.Dockerfile -t atlas-api:dev .

# node:24.22.3-trixie-slim (Debian 13), pinned by digest (ADR-105).
ARG NODE_IMAGE=node@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

FROM ${NODE_IMAGE} AS patched
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
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b apps/api \
 && pnpm --filter @atlas/web build \
 && pnpm --filter @atlas/api deploy --prod --legacy --config.strict-peer-dependencies=false /atlas \
 && cp -r apps/web/dist /atlas/web

FROM patched
# Runtime needs Node, not package managers (including their unrelated dependencies).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --gid 10001 atlas && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp atlas
COPY --from=build --chown=root:root /atlas /atlas
USER 10001:10001
ENV NODE_ENV=production ATLAS_WEB_ROOT=/atlas/web ATLAS_LISTEN_HOST=0.0.0.0 ATLAS_PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "/atlas/dist/bin.js"]
CMD ["serve"]
