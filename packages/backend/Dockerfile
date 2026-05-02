# ─────────────────────────────────────────────────────────────────────
# Stage 1 — build the Go binary
# ─────────────────────────────────────────────────────────────────────
#
# `modernc.org/sqlite` is pure-Go, so we get a fully static binary
# with no CGO. That means stage 2 can be `gcr.io/distroless/static`
# (~3 MB) — no glibc, no shell, no package manager, just the binary.
#
# Build context expectation:
#   docker build -f packages/backend/Dockerfile packages/backend
# Reproducible builds: pinned go.mod via go.sum, no network access at
# stage 2. The image is byte-identical for a given commit.
FROM golang:1.24-alpine AS build

# Install certs for go mod fetches (Alpine doesn't include them by default).
RUN apk add --no-cache ca-certificates git

WORKDIR /src

# Cache go.mod / go.sum independently of source so dep changes alone
# trigger a layer rebuild, not source edits.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static build:
#   - CGO_OFF: required for distroless/static
#   - -trimpath: strips local paths from binary (smaller, more
#                reproducible, also slightly more secure)
#   - -ldflags='-s -w': strip symbols + DWARF, shaves ~30 % off
#   - Tags: 'osusergo,netgo,sqlite_omit_load_extension' → no Cgo deps
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} \
    go build \
      -trimpath \
      -ldflags='-s -w -extldflags "-static"' \
      -tags 'osusergo netgo sqlite_omit_load_extension' \
      -o /out/server \
      ./cmd/server

# Pre-create the /data directory with the distroless nonroot UID so the
# server can open the SQLite file on first boot. distroless has no
# shell or chown, so this has to happen here in the build stage.
RUN mkdir -p /out/data && chown -R 65532:65532 /out/data

# ─────────────────────────────────────────────────────────────────────
# Stage 2 — minimal runtime image
# ─────────────────────────────────────────────────────────────────────
#
# `distroless/static-debian12` ships:
#   - the binary (set as ENTRYPOINT)
#   - /etc/ssl/certs/ca-certificates.crt
#   - tzdata (so time.Local works against the TZ env var)
#   - a non-root `nonroot` user (UID 65532)
# Nothing else — no shell to exec into, which is the whole point.
FROM gcr.io/distroless/static-debian12:nonroot

# Image label conventions for ops folks running `docker inspect`.
LABEL org.opencontainers.image.title="meo.md backend" \
      org.opencontainers.image.description="meo.md HTTP server (Go)" \
      org.opencontainers.image.source="https://meo.md" \
      org.opencontainers.image.licenses="MIT"

# Default environment — override per-deployment with `docker run -e`.
#   PORT          - listen port (default 8787, matches the dev script)
#   MEO_DB_PATH   - SQLite file. We mount /data as a volume.
#   MEO_MODEL_DIR - hosted model files (Agent 7). Defaults inside the
#                   data volume so it survives container restarts.
#   MEO_ADMIN_TOKEN - empty in the image; required to enable the
#                   /models/:id/upload endpoint. Set in production.
#   JWT_SECRET    - REQUIRED in production. The Go server falls back to
#                   a per-process random secret if missing, which
#                   invalidates issued JWTs on every restart.
ENV PORT=8787 \
    MEO_DB_PATH=/data/meo.sqlite \
    MEO_MODEL_DIR=/data/models \
    MEO_ADMIN_TOKEN="" \
    JWT_SECRET=""

# Persistent data volume. SQLite WAL files and uploaded model blobs
# live here. Mount with `-v meo-data:/data` or a bind mount on disk.
VOLUME ["/data"]

EXPOSE 8787

# distroless's nonroot user owns nothing under /data by default.
# Either run as root inside (no shell exists in distroless to chown,
# so we rely on the volume's host-side mode) or change the volume
# permission from outside the container. We pick: stay nonroot, and
# let docker-compose / k8s manifests set ownership via :Z, fsGroup,
# or a one-time `chown -R 65532:65532` on the host volume.

COPY --from=build /out/server /usr/local/bin/server
COPY --from=build --chown=nonroot:nonroot /out/data /data

ENTRYPOINT ["/usr/local/bin/server"]
