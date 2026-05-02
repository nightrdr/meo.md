// Command server is the meo.md backend HTTP daemon.
//
// This file is the *only* place that knows how the pieces wire
// together — the composition root. Every dependency is constructed
// here and passed down by parameter:
//
//   Config → Store → (UserStore, AccountStore, NoteStore, SyncCursor)
//                  ↘ Hasher
//                  ↘ JWTSigner
//                              ↘ api.NewServer → Routes → http.Server
//
// No package globals, no init() side effects, no service locator.
// A test that wants to swap, say, the JWTSigner for a fake one
// constructs its own Server and skips this file.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"path/filepath"

	"meo.md/backend/internal/api"
	"meo.md/backend/internal/auth"
	"meo.md/backend/internal/config"
	"meo.md/backend/internal/models"
	"meo.md/backend/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	hasher := auth.NewHasher()
	signer := auth.NewJWTSigner(cfg.JWTSecret, 30*24*time.Hour)

	srv := api.NewServer(st.Users, st.Accounts, st.Notes, st.SyncCursor, hasher, signer)

	// ─── Model download subsystem ───────────────────────────────────
	// Catalogue is embedded in the binary; ops can override the file
	// via MEO_MODEL_MANIFEST. Files live in MEO_MODEL_DIR (default:
	// <binary-dir>/../models/). Admin upload gated by MEO_ADMIN_TOKEN.
	modelDir := os.Getenv("MEO_MODEL_DIR")
	if modelDir == "" {
		exe, err := os.Executable()
		if err == nil {
			modelDir = filepath.Join(filepath.Dir(exe), "..", "models")
		} else {
			modelDir = "models"
		}
	}
	cat, err := models.LoadCatalogue(os.Getenv("MEO_MODEL_MANIFEST"))
	if err != nil {
		log.Printf("model catalogue: %v (model endpoints disabled)", err)
	} else {
		mstore, err := models.NewStore(modelDir)
		if err != nil {
			log.Printf("model store: %v (model endpoints will 503)", err)
			mstore = nil
		}
		srv.WithModels(cat, mstore, os.Getenv("MEO_ADMIN_TOKEN"))
	}

	httpSrv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Graceful shutdown — SIGINT/SIGTERM stops accepting new
	// connections, lets in-flight requests finish for up to 10s, then
	// closes the DB.
	go func() {
		log.Printf("meo.md backend listening on http://localhost:%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Println("shutdown: draining…")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	log.Println("shutdown: bye")
}
