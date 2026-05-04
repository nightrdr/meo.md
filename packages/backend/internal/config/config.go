// Package config loads runtime configuration from the environment.
//
// Six knobs:
//   - PORT (default 8787) - HTTP listen port
//   - DATABASE_URL        - Postgres DSN (libpq URL)
//   - SUPABASE_URL        - Where to reach GoTrue (e.g. http://127.0.0.1:54321)
//   - SUPABASE_ANON_KEY   - apikey header value for GoTrue
//   - SUPABASE_JWT_SECRET - HS256 secret used to verify access tokens
//   - MEO_ATTACHMENT_DIR  - filesystem dir for encrypted attachment blobs
//
// Tests inject their own Config, so nothing in the rest of the app
// reads os.Getenv directly.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// Config is the resolved runtime configuration. Fields are immutable
// once Load() returns.
type Config struct {
	Port             int
	DatabaseURL      string
	SupabaseURL      string
	SupabaseAnonKey  string
	SupabaseJWTSecret []byte
	AttachmentDir    string
}

// Load reads the environment with sensible defaults aligned to the
// `supabase start` local stack. Production deployments should set
// every field explicitly via real env vars or a secrets manager.
func Load() (*Config, error) {
	port := 8787
	if v := os.Getenv("PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("PORT: %w", err)
		}
		port = n
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		// Default to the local supabase Postgres. Username/password
		// are the well-known supabase-CLI defaults.
		dsn = "postgres://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable"
	}

	supaURL := os.Getenv("SUPABASE_URL")
	if supaURL == "" {
		supaURL = "http://127.0.0.1:54321"
	}

	supaKey := os.Getenv("SUPABASE_ANON_KEY")
	if supaKey == "" {
		// The local supabase publishable key is also stable across
		// `supabase start` runs as long as the project's anon JWT
		// secret hasn't been rotated. We don't hardcode it because
		// tests use a different one — leave empty and refuse to start.
		return nil, errors.New("SUPABASE_ANON_KEY not set")
	}

	jwtSecret := os.Getenv("SUPABASE_JWT_SECRET")
	if jwtSecret == "" {
		// Default GoTrue local secret. In prod, set explicitly.
		jwtSecret = "super-secret-jwt-token-with-at-least-32-characters-long"
	}

	attDir := os.Getenv("MEO_ATTACHMENT_DIR")
	if attDir == "" {
		exe, err := os.Executable()
		if err == nil {
			attDir = filepath.Join(filepath.Dir(exe), "..", "attachments")
		} else {
			attDir = "attachments"
		}
	}

	return &Config{
		Port:              port,
		DatabaseURL:       dsn,
		SupabaseURL:       supaURL,
		SupabaseAnonKey:   supaKey,
		SupabaseJWTSecret: []byte(jwtSecret),
		AttachmentDir:     attDir,
	}, nil
}
