FROM node:22-trixie-slim AS build
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-trixie-slim
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app
# Apply Debian security updates on top of the base image (notably openssl
# 3.5.6-1~deb13u2) so Inspector doesn't flag the base's stale system libs.
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Strip tooling the runtime never uses but that AWS Inspector flags via the
# base image. The server starts with `node dist/cli.js`, so neither is needed
# once prod deps are installed:
#  - the bundled npm CLI, whose vendored picomatch / brace-expansion /
#    ip-address carry CVEs independent of our app dependencies.
#  - Node's C headers, present only to build native addons; their vendored
#    OpenSSL version (opensslv.h) is what Inspector reads the openssl CVEs from
#    (the Debian system openssl is already patched by the apt upgrade above).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/include/node

EXPOSE 3002
CMD ["node", "dist/cli.js", "--transport", "http", "--port", "3002"]
