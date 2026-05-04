// Package store is the Postgres data layer.
//
// We connect to the same database the Supabase stack uses (locally:
// supabase_db_meo.md → postgresql://postgres:postgres@127.0.0.1:54322/postgres,
// in prod: whatever DATABASE_URL points at). All schemas are owned by
// the Supabase migrations under /supabase/migrations — this Go layer
// reads/writes the existing meo.* tables and never runs DDL.
//
// Auth boundary: we connect as the postgres superuser (or a dedicated
// role with full grants on meo.*) so RLS does NOT apply. Every store
// method takes an explicit userID and adds it to WHERE/INSERT, so
// cross-tenant isolation is enforced at the Go boundary by these
// per-method WHERE clauses, plus the JWT-validation in api/middleware.go
// that ensures the userID actually came from a signed Supabase token.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver "pgx"
)

// Common errors. Handlers map these to HTTP statuses.
var (
	ErrNotFound          = errors.New("not found")
	ErrForbidden         = errors.New("forbidden")
	ErrStaleWrite        = errors.New("stale write")
	ErrConflict          = errors.New("conflict")
	ErrTooLarge          = errors.New("attachment too large")
	ErrQuotaExceeded     = errors.New("storage cap exceeded")
	ErrDeviceCapExceeded = errors.New("device cap exceeded")
)

// Store is the connection holder + per-table sub-stores. Composed in
// main.go and passed by reference. Concurrency-safe (database/sql
// pools internally).
type Store struct {
	DB            *sql.DB
	Notes         *NoteStore
	Accounts      *AccountStore
	SyncCursor    *SyncCursorStore
	Devices       *DeviceStore
	Subscriptions *SubscriptionStore
	Attachments   *AttachmentStore
	TFA           *TFAStore
	Handovers     *HandoverStore
}

// Open establishes the pool, pings, and returns the composed Store.
// dsn is a libpq-style URL: postgres://user:pass@host:port/db?sslmode=…
func Open(dsn string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{
		DB:            db,
		Notes:         &NoteStore{db: db},
		Accounts:      &AccountStore{db: db},
		SyncCursor:    &SyncCursorStore{db: db},
		Devices:       &DeviceStore{db: db},
		Subscriptions: &SubscriptionStore{db: db},
		Attachments:   &AttachmentStore{db: db},
		TFA:           &TFAStore{db: db},
		Handovers:     &HandoverStore{db: db},
	}, nil
}

// Close releases the pool. Safe to call multiple times.
func (s *Store) Close() error {
	if s.DB == nil {
		return nil
	}
	return s.DB.Close()
}

// Tx is the narrow interface satisfied by both *sql.DB and *sql.Tx.
// Lets the SyncCursor's Next() participate in an outer transaction
// (Upsert/Tombstone) or run standalone.
type Tx interface {
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

// translatePgError maps known SQLSTATE codes from pgx into our
// sentinels so handlers don't grep error strings. Callers wrap any
// error with errors.Is(err, store.ErrXxx).
func translatePgError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	type sqlState interface{ SQLState() string }
	var s sqlState
	if errors.As(err, &s) {
		switch s.SQLState() {
		case "23505": // unique_violation
			return ErrConflict
		case "23503": // foreign_key_violation
			return ErrNotFound
		}
	}
	return err
}
