# @meo/backend (Go)

The HTTP server for meo.md. Holds encrypted note rows + the
encryption-wrapper for each account; never sees plaintext.

Originally written in TypeScript on Hono. Rewritten in Go for the
single-binary deploy story (no Node runtime, no `npm install` on the
production host). Wire-compatible with the TS server — same routes,
same JSON shapes, same scrypt-format password hashes, same HS256
JWTs — so a `meo.sqlite` produced by either binary opens cleanly in
the other.

## Layout

```
packages/backend/
├── cmd/server/         # composition root — only place that wires deps
│   └── main.go
├── internal/
│   ├── config/         # env loader (PORT, MEO_DB_PATH, JWT_SECRET)
│   ├── store/          # SQLite layer
│   │   ├── store.go    # Store struct, opens DB + sub-stores
│   │   ├── schema.go   # CREATE TABLE migrations
│   │   ├── users.go    # UserStore
│   │   ├── accounts.go # AccountStore
│   │   └── notes.go    # NoteStore + SyncCursorStore (transactional Next())
│   ├── auth/
│   │   ├── hasher.go   # scrypt N=16384, r=8, p=1 — TS-compatible format
│   │   └── jwt.go      # HS256, base64url(no-pad), TS-compatible
│   └── api/
│       ├── server.go   # Server struct holds all deps; Routes() builds gin engine
│       ├── middleware.go
│       ├── dto.go      # request/response shapes
│       └── handlers_*.go
├── go.mod
├── Makefile
└── test-e2e.mjs        # the JS suite from the TS days; still runs against this server
```

## Run (local source)

```bash
# dev — runs from source, no autoreload
make dev

# production-style binary
make build
./bin/server

# end-to-end suite (signup → encrypt → sync → tombstone → cross-tenant isolation)
make e2e
```

## Run (Docker)

The Dockerfile is multi-stage with a distroless `static-debian12:nonroot`
final image. The whole thing comes out at **~5.6 MB** because the binary
is fully static (pure-Go SQLite via `modernc.org/sqlite`, no CGO).

```bash
# Build
make docker          # → image: meo-backend:latest
# or:
docker build -t meo-backend:latest -f Dockerfile .

# Run with persistent data volume + a real JWT secret
docker run -d \
  --name meo-backend \
  -p 8787:8787 \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -v meo-backend-data:/data \
  meo-backend:latest

# Or via compose (also brings up the volume)
docker compose up --build -d
docker compose logs -f
docker compose down            # keeps the volume
docker compose down -v         # wipes the volume too

# E2E against the dockerized server
docker run -d --name meo-smoke -p 8788:8787 \
  -e JWT_SECRET=dev-smoke meo-backend:latest
API=http://localhost:8788 node test-e2e.mjs
docker rm -f meo-smoke
```

### Image-size breakdown

```
distroless/static-debian12:nonroot   ~3 MB   (base layer)
+ /usr/local/bin/server              ~2.6 MB (stripped + trimmed Go binary)
= ~5.6 MB total
```

No shell, no package manager, no glibc — there's no `docker exec -it
… sh` to debug. That's the point. If you need to inspect a running
container, attach via `docker inspect` / `docker logs` / `docker stats`,
or temporarily run from `gcr.io/distroless/static-debian12:debug`
which is the same image but ships busybox.

### Container env (override per-deploy)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | HTTP listen port |
| `MEO_DB_PATH` | `/data/meo.sqlite` | SQLite file inside the volume |
| `MEO_MODEL_DIR` | `/data/models` | hosted model files (Agent 7's manifest) |
| `JWT_SECRET` | *(empty — REQUIRED in prod)* | utf-8 bytes; falls back to per-process random if missing, which invalidates issued JWTs on restart |
| `MEO_ADMIN_TOKEN` | *(empty)* | Bearer token for the `POST /models/:id/upload` endpoint. Empty = uploads disabled. |

The `/data` volume is owned by UID 65532 (distroless's `nonroot`). The
Dockerfile pre-seeds the directory with that ownership; if you bind-
mount a host path instead of a named volume, run
`sudo chown -R 65532:65532 /your/path` once before first start.

## Local-binary env (when running outside Docker)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | HTTP listen port |
| `MEO_DB_PATH` | `<binary-dir>/../meo.sqlite` | SQLite file |
| `MEO_MODEL_DIR` | `<binary-dir>/../models` | hosted model files |
| `JWT_SECRET` | random 32 bytes (per process) | utf-8 bytes; **set in prod** or every restart invalidates JWTs |
| `MEO_ADMIN_TOKEN` | *(empty)* | bearer token for model uploads |

## Why DI?

Every dependency flows in through a constructor parameter:

```go
// cmd/server/main.go
st, _    := store.Open(cfg.DBPath)
hasher   := auth.NewHasher()
signer   := auth.NewJWTSigner(cfg.JWTSecret, 30*24*time.Hour)
srv      := api.NewServer(st.Users, st.Accounts, st.Notes, st.SyncCursor, hasher, signer)
http.ListenAndServe(":8787", srv.Routes())
```

The handlers are methods on `*api.Server`, not free functions. The
DB handle lives in `*store.UserStore.db`, not a package var. A test
that wants to swap the JWT signer for a fake one builds a Server with
its own values — no monkey-patching, no init hooks, no `database.DB =
mockDB`.

This is intentionally the opposite of the gin-boilerplate
service-locator pattern (package-level `database.DB`, free-function
`repository.Get(model)`, controllers that are bare functions). The
overhead is one extra parameter per constructor; the payoff is every
seam is testable in isolation.

## API surface

All routes return JSON. Errors use `{ "error": "<message>" }` plus an
appropriate HTTP status.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET`    | `/healthz`         | — | liveness probe |
| `POST`   | `/auth/signup`     | — | `{email, password}` → `{user_id}` |
| `POST`   | `/auth/login`      | — | `{email, password}` → `{jwt, has_account, user_id}` |
| `GET`    | `/account`         | Bearer | wrapped master key for the user |
| `PUT`    | `/account`         | Bearer | upload wrapper (one-shot per user) |
| `GET`    | `/sync/notes?since=N` | Bearer | rows with `version > N`, ordered |
| `POST`   | `/notes`           | Bearer | upsert with HLC last-write-wins |
| `DELETE` | `/notes/:id`       | Bearer | tombstone (deleted_at + version bump) |
