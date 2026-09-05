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
    ca-certificates docker.io git curl \
    && rm -rf /var/lib/apt/lists/*

# docker-compose-plugin isn't in Debian's own apt repo (only docker.io's CLI
# is) -- pulled directly from the compose project's own GitHub releases
# instead of adding Docker's apt repo just for this one binary, same
# "fewer moving parts outside this repo's own control" reasoning the fleet's
# CI workflows already use for gitleaks. Pinned version + arch-detected
# (this fleet's VM is arm64/Ampere; local dev boxes may be amd64).
RUN mkdir -p /usr/libexec/docker/cli-plugins \
    && ARCH=$(uname -m) \
    && curl -sSfL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-${ARCH}" \
       -o /usr/libexec/docker/cli-plugins/docker-compose \
    && chmod +x /usr/libexec/docker/cli-plugins/docker-compose

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
