# syntax=docker/dockerfile:1
#
# Royalty — one process serving the API, the sockets and the built client.
# PLAN.md item 22. See docs/deploy.md.
#
# Two stages, because the build needs a C++ toolchain (better-sqlite3 is a
# native module) and the client's whole Vite toolchain, and neither should be on
# the machine serving the event. Both stages sit on the *same* base image on
# purpose: the compiled better-sqlite3 binding is copied forward, so the glibc
# and the Node ABI it was built against have to be the ones it runs on.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for common platforms and will use one
# if it fits; these are what it falls back to when it doesn't. Cheap insurance
# against a silent switch to source compilation failing months from now.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Manifests first, so a change to application code doesn't re-run the installs.
# The root `postinstall` installs the client, so client/package.json has to be
# in place before `npm ci` runs — not after it with the rest of the source.
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
RUN npm ci

COPY . .

# `tsc --noEmit && vite build`. NODE_ENV is deliberately *not* production here:
# vite and typescript are devDependencies, and the service-worker manifest is
# generated from the real bundle, so a client that does not build is a shell
# that cannot update itself.
RUN npm run build

# Drop the root devDependencies now the build is done. client/node_modules is
# simply not copied forward.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/client/dist ./client/dist

# Runs as root so it can write to the mounted volume, which Fly presents
# root-owned. The process is behind the platform proxy and holds no shell.

# ---------------------------------------------------------------------------
# Which release is this? — PLAN.md item 27.
#
# ⚠️ These arguments are the *only* way the running machine can name what it is
# running. `.git/` is in .dockerignore — deliberately, because an image gets
# pushed to a registry — so there is no repository in here to interrogate and no
# honest runtime fallback. A plain `fly deploy` produces a machine that answers
# "unknown", which is the correct answer and a useless one.
#
#   npm run freeze          prints the fly deploy line with these filled in
#   docs/freeze.md          why the freeze depends on it
#
# Last in the stage on purpose: they change on every build, and anything below
# an ENV that changes is rebuilt. Here they invalidate nothing.
# ---------------------------------------------------------------------------
ARG RELEASE=""
ARG RELEASE_COMMIT=""
ARG RELEASE_BUILT_AT=""
ARG RELEASE_DIRTY=""
ENV RELEASE=$RELEASE \
    RELEASE_COMMIT=$RELEASE_COMMIT \
    RELEASE_BUILT_AT=$RELEASE_BUILT_AT \
    RELEASE_DIRTY=$RELEASE_DIRTY

EXPOSE 8080

# No init shim: server/index.js installs its own SIGTERM handler, which is what
# makes `fly deploy` replace a machine in seconds instead of waiting out the
# kill timeout with the WAL unflushed. Don't wrap this in a shell — that would
# put /bin/sh at PID 1 and swallow the signal again.
CMD ["node", "server/index.js"]
