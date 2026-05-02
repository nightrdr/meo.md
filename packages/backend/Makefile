.PHONY: dev build test e2e clean docker docker-run docker-e2e compose-up compose-down

# Default target — fast iteration during development. No autoreload
# binary; restart by hand on save (it's <1s on this hardware).
dev:
	go run ./cmd/server

# Build a release binary into bin/server. Used by the npm scripts in
# the root workspace.
build:
	mkdir -p bin
	go build -o bin/server ./cmd/server

test:
	go test ./...

# End-to-end smoke test — starts the server, runs the existing
# language-agnostic JS suite against it, then tears the server down.
# Requires `node` on PATH and `packages/shared/dist` already built.
e2e: build
	@echo "── starting server ──"
	@MEO_DB_PATH=$(PWD)/meo-e2e.sqlite ./bin/server & echo $$! > .e2e.pid; \
	sleep 1; \
	(cd ../.. && node packages/backend/test-e2e.mjs); \
	rc=$$?; \
	kill `cat .e2e.pid` 2>/dev/null; rm -f .e2e.pid meo-e2e.sqlite meo-e2e.sqlite-shm meo-e2e.sqlite-wal; \
	exit $$rc

# ─── Docker targets ──────────────────────────────────────────────────

# Multi-stage build → distroless/static-debian12:nonroot. ~5.6 MB image.
docker:
	docker build -t meo-backend:latest -f Dockerfile .

# Run the image with a per-process random JWT secret (dev only — for
# prod, supply your own via -e JWT_SECRET=…).
docker-run: docker
	docker run --rm -p 8787:8787 \
	  -e JWT_SECRET="$$(openssl rand -hex 32)" \
	  -v meo-backend-data:/data \
	  --name meo-backend \
	  meo-backend:latest

# E2E smoke against the dockerized server. Uses port 8788 to avoid
# colliding with anything the dev is running locally.
docker-e2e: docker
	@docker rm -f meo-smoke 2>/dev/null; true
	@docker run -d --name meo-smoke -p 8788:8787 \
	  -e JWT_SECRET=dev-smoke-secret meo-backend:latest >/dev/null
	@sleep 2
	@(cd ../.. && API=http://localhost:8788 node packages/backend/test-e2e.mjs); \
	  rc=$$?; \
	  docker rm -f meo-smoke >/dev/null; \
	  exit $$rc

compose-up:
	docker compose up --build -d

compose-down:
	docker compose down

clean:
	rm -rf bin meo-e2e.sqlite*
