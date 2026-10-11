# ATLAS sandbox image (ADR-031): one immutable image for the analysis, acquisition and
# egress-broker sandboxes. Operators build it, then pin workers to its image ID
# (ATLAS_SANDBOX_IMAGE=sha256:...); sandboxes run it with --pull=never.
#
#   docker build -f deploy/sandbox.Dockerfile -t atlas-sandbox:dev .
#   docker image inspect atlas-sandbox:dev --format '{{.Id}}'

# node:24.15.0-trixie-slim (Debian 13), pinned by digest.
ARG NODE_IMAGE=node@sha256:291be77873bc04731968cacf82f0fcef17cee8cf200c6b6951e2bcab41560eb7

FROM ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /src
COPY . .
# Lifecycle scripts stay disabled (pnpm-workspace.yaml); only the worker and its dependencies compile.
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b apps/worker \
 && pnpm --filter @atlas/worker deploy --prod --legacy --config.strict-peer-dependencies=false /atlas

FROM ${NODE_IMAGE}
# Git 2.47 (trixie) provides GIT_NO_LAZY_FETCH; CA roots verify github.com through the broker tunnel.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git=1:2.47.3-0+deb13u1 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 atlas && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp atlas
COPY --from=build --chown=root:root /atlas /atlas
USER 10001:10001
WORKDIR /scratch
# No ENTRYPOINT: the coordinator always names a trusted entrypoint under /atlas/dist/sandbox.
