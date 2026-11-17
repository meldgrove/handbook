# One image for every process. The command selects the role:
#   all      web app and worker (default)
#   web      web app only (port 3000)
#   worker   search index upkeep, removes expired locks, tokens and unused uploads
#   migrate  apply database migrations, then exit

FROM node:26.13.0-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM base AS deps
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build
# Release builds upload the source maps of the server and the web app to
# Sentry, which finds them by the debug IDs the build wrote into the bundles
# (scripts/inject-debug-ids.mjs). Without the token, nothing is uploaded.
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      export SENTRY_CLI_NO_TELEMETRY=1 SENTRY_CLI_NO_UPDATE_CHECK=1 \
      && node_modules/.bin/sentry sourcemap upload apps/server/dist \
      && node_modules/.bin/sentry sourcemap upload apps/web/dist; \
    fi
# The web app's source maps would be public under /assets: they stay out of
# the image. The server's are never served.
RUN find apps/web/dist -name '*.map' -delete

FROM base AS prod-deps
# Optional packages here are build and test tools that libraries name as
# optional peers (vitest, drizzle-kit, esbuild): the server needs none of them.
RUN npm ci --omit=dev --omit=optional --workspace @knowledge/server --include-workspace-root=false --no-audit --no-fund

FROM node:26.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    FILES_DIR=/data/files \
    WORKER_HEARTBEAT_FILE=/tmp/worker-heartbeat
WORKDIR /app
# Uploaded files; mount a volume here (compose.yaml).
RUN mkdir -p /data/files && chown -R node:node /data
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The release workflow sets the version; images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["all"]
