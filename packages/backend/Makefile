.PHONY: dev build test e2e clean

# Default target — fast iteration during development. No autoreload
# binary; restart by hand on save (it's <1s on this hardware).
dev:
	go run ./cmd/server

# Build a release binary into bin/server. Used by the npm scripts in
# the root workspace and by the Dockerfile (when one lands).
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

clean:
	rm -rf bin meo-e2e.sqlite*
