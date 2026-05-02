// Package config loads runtime configuration from the environment.
//
// Kept tiny on purpose: only three knobs (port, DB path, JWT secret).
// Tests inject their own Config, so nothing in the rest of the app
// reads os.Getenv directly.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// Config is the resolved runtime configuration. Fields are immutable
// once Load() returns.
type Config struct {
	Port      int    // HTTP listen port
	DBPath    string // SQLite file path
	JWTSecret []byte // HMAC key for signing JWTs
}

// Load reads the environment with sensible defaults. JWT_SECRET, if
// unset, is replaced with 32 random bytes — matches the TS server's
// behavior of generating a per-process secret. Useful in dev; fatal in
// prod (issued JWTs invalidate on restart).
func Load() (*Config, error) {
	port := 8787
	if v := os.Getenv("PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("PORT: %w", err)
		}
		port = n
	}

	dbPath := os.Getenv("MEO_DB_PATH")
	if dbPath == "" {
		// Mirror the TS default: <package-root>/meo.sqlite. The Go
		// binary lives at <package-root>/bin/server, so go up one.
		exe, err := os.Executable()
		if err == nil {
			dbPath = filepath.Join(filepath.Dir(exe), "..", "meo.sqlite")
		} else {
			dbPath = "meo.sqlite"
		}
	}

	var secret []byte
	if v := os.Getenv("JWT_SECRET"); v != "" {
		// Match the TS path: env value is treated as the raw secret
		// (utf-8 bytes), not hex-decoded. Keeps tokens portable.
		secret = []byte(v)
	} else {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return nil, fmt.Errorf("rand: %w", err)
		}
		// Hex-stringify just for the log line below — not used as the
		// actual secret, which stays raw.
		_ = hex.EncodeToString
	}

	return &Config{Port: port, DBPath: dbPath, JWTSecret: secret}, nil
}
