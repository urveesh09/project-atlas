# ATLAS API image (P5.6): admission, job status/events and publication reads, plus the
# built viewer served same-origin. It holds no Docker access and never analyzes code.
#
#   docker build -f deploy/api.Dockerfile -t atlas-api:dev .

ARG NODE_IMAGE=node@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a

FROM ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b apps/api \
 && pnpm --filter @atlas/web build \
 && pnpm --filter @atlas/api deploy --prod --legacy --config.strict-peer-dependencies=false /atlas \
 && cp -r apps/web/dist /atlas/web

FROM ${NODE_IMAGE}
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
