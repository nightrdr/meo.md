// Command server is the meo.md backend HTTP daemon.
//
// Composition root — every dependency is constructed here and passed
// down by parameter, so a test can swap any piece for a fake.
//
//   Config → Store (Postgres pool + sub-stores)
//          → GoTrueClient (HTTP wrapper around Supabase Auth)
//          → JWTVerifier (HS256 verifier for Supabase access tokens)
//          ↘ api.NewServer → Routes → http.Server
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

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

	st, err := store.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	gt, err := auth.NewGoTrueClient(cfg.SupabaseURL, cfg.SupabaseAnonKey)
	if err != nil {
		log.Fatalf("gotrue: %v", err)
	}
	jv, err := auth.NewJWTVerifier(cfg.SupabaseJWTSecret)
	if err != nil {
		log.Fatalf("jwt: %v", err)
	}

	if err := os.MkdirAll(cfg.AttachmentDir, 0o700); err != nil {
		log.Fatalf("attachment dir: %v", err)
	}

	srv := api.NewServer(st, gt, jv, cfg.AttachmentDir)

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
	// closes the DB pool.
	go func() {
		log.Printf("meo.md backend listening on http://localhost:%d", cfg.Port)
		log.Printf("  → postgres: %s", cfg.DatabaseURL)
		log.Printf("  → gotrue:   %s", cfg.SupabaseURL)
		log.Printf("  → attach:   %s", cfg.AttachmentDir)
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
