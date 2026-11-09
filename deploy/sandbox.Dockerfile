# ATLAS sandbox image (ADR-031): one immutable image for the analysis, acquisition and
# egress-broker sandboxes. Operators build it, then pin workers to its image ID
# (ATLAS_SANDBOX_IMAGE=sha256:...); sandboxes run it with --pull=never.
#
#   docker build -f deploy/sandbox.Dockerfile -t atlas-sandbox:dev .
#   docker image inspect atlas-sandbox:dev --format '{{.Id}}'

# node:24.22.2-trixie-slim (Debian 13), pinned by digest.
ARG NODE_IMAGE=node@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d

FROM ${NODE_IMAGE} AS patched
# DSA-6613-1. Apply the fixed package to build and runtime (ADR-093).
RUN apt-get update \
 && apt-get install --yes --no-install-recommends --only-upgrade zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/*

FROM patched AS build
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /src
COPY . .
# Lifecycle scripts stay disabled (pnpm-workspace.yaml); only the worker and its dependencies compile.
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b apps/worker \
 && pnpm --filter @atlas/worker deploy --prod --legacy --config.strict-peer-dependencies=false /atlas

FROM patched
# Git 2.47 (trixie) provides GIT_NO_LAZY_FETCH; CA roots verify github.com through the broker tunnel.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git=1:2.47.3-0+deb13u1 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --gid 10001 atlas && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp atlas
COPY --from=build --chown=root:root /atlas /atlas
USER 10001:10001
WORKDIR /scratch
# No ENTRYPOINT: the coordinator always names a trusted entrypoint under /atlas/dist/sandbox.
