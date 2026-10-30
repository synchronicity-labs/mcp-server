FROM node:22-trixie-slim AS build
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*
# Corepack provides the pnpm version pinned in package.json.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# The deploy job writes the commit it builds to .revision; other builds record unknown.
RUN [ -s .revision ] || echo unknown > .revision
RUN pnpm run build
RUN pnpm run package:chatgpt

# Production dependencies only, installed apart from the build's dev tooling.
FROM node:22-trixie-slim AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-trixie-slim
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app
# Apply Debian security updates on top of the base image (notably openssl
# 3.5.6-1~deb13u2) so Inspector doesn't flag the base's stale system libs.
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/scripts/check-mcp.mjs ./scripts/check-mcp.mjs
COPY --from=build /app/dist ./dist
COPY --from=build /app/.revision ./.revision
COPY --from=build /app/chatgpt-dist ./chatgpt-dist
COPY --from=build /app/deploy/generation-status ./deploy/generation-status

# Strip tooling the runtime never uses but that AWS Inspector flags via the
# base image. The server starts with `node dist/cli.js`, and production
# dependencies come from the build stage, so no package manager is needed:
#  - the bundled npm CLI and Corepack, whose vendored picomatch /
#    brace-expansion / ip-address carry CVEs independent of our app dependencies.
#  - Node's C headers, present only to build native addons; their vendored
#    OpenSSL version (opensslv.h) is what Inspector reads the openssl CVEs from
#    (the Debian system openssl is already patched by the apt upgrade above).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
  /usr/local/include/node

# Select the approved UI with the image, independent of stale legacy directory settings.
ENV SYNC_CHATGPT_APP_RELEASES=/app/chatgpt-dist/releases.json

EXPOSE 3002
CMD ["node", "--expose-gc", "dist/cli.js", "--transport", "http", "--port", "3002"]
