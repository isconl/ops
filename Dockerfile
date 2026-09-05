# ops engine -- same portable container shape as every other isconl engine.
# node:20-slim (Debian/glibc), not -alpine: @bitwarden/sdk-napi is a native
# N-API module: musl (alpine) breaks native bindings built against glibc.
#
# Needs the docker CLI installed (not just the socket mounted) so
# lib/ops-vm.js's `docker compose ...` calls actually resolve to a binary
# inside the container -- every other engine skips this, ops is the one
# exception because its whole job is driving the host's docker compose.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates docker.io docker-compose-plugin git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY src ./src

# Real fail-closed bind guard already in src/server.js: refuses to bind
# 0.0.0.0 without a configured token. Set OPS_TOKEN (or ISCONL_TOKEN) and
# OPS_BIND=0.0.0.0 at runtime -- not baked into the image. Deployed loopback-
# only in practice (hub reaches it over the docker network), same as
# vault/pulse/scope/circle/spark.
EXPOSE 8087
CMD ["node", "src/server.js"]
