# ATLAS API image (P5.6): admission, job status/events and publication reads, plus the
# built viewer served same-origin. It holds no Docker access and never analyzes code.
#
#   docker build -f deploy/api.Dockerfile -t atlas-api:dev .

ARG NODE_IMAGE=node@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315

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
RUN groupadd --gid 10001 atlas && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp atlas
COPY --from=build --chown=root:root /atlas /atlas
USER 10001:10001
ENV NODE_ENV=production ATLAS_WEB_ROOT=/atlas/web ATLAS_LISTEN_HOST=0.0.0.0 ATLAS_PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "/atlas/dist/bin.js"]
CMD ["serve"]
