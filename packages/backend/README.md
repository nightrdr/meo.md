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

## Run

```bash
# dev — runs from source, no autoreload
make dev

# production-style binary
make build
./bin/server

# end-to-end suite (signup → encrypt → sync → tombstone → cross-tenant isolation)
make e2e
```

Configuration via env:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | HTTP listen port |
| `MEO_DB_PATH` | `<binary-dir>/../meo.sqlite` | SQLite file |
| `JWT_SECRET` | random 32 bytes (per process) | utf-8 bytes; **set this in prod** or every restart invalidates issued tokens |

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
