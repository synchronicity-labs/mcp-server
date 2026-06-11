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
EXPOSE 3002
CMD ["node", "dist/cli.js", "--transport", "http", "--port", "3002"]
