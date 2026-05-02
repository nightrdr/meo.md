// Package store wraps the SQLite handle and exposes typed sub-stores
// (UserStore, AccountStore, NoteStore) that each receive *sql.DB via
// constructor injection.
//
// Why a struct holding *sql.DB and not a package-level var:
//   - Lets us run two independent DBs in tests (e.g. parallel suites)
//   - Lets handlers depend on a narrow interface, not the whole DB
//   - Makes the DB lifecycle explicit (Open / Close), no init() magic
package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver, no CGO
)

// Store is the root handle. Sub-stores hang off it as fields so the
// composition root constructs them once and passes the typed values
// down - no service locator.
type Store struct {
	DB             *sql.DB
	Users          *UserStore
	Accounts       *AccountStore
	Notes          *NoteStore
	SyncCursor     *SyncCursorStore
}

// Open creates a Store at the given SQLite path, applies pragmas
// (WAL + foreign keys), and runs schema migrations.
func Open(path string) (*Store, error) {
	// modernc.org/sqlite registers the driver as "sqlite". The DSN
	// supports `?_pragma=foo(bar)` to apply pragmas at connection
	// time - but we'd rather do it explicitly here so the test reads
	// the same as the runtime path.
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("sql.Open: %w", err)
	}

	// SQLite is single-writer. Cap the pool at 1 to avoid SQLITE_BUSY
	// races; readers piggyback on WAL.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(time.Hour)

	for _, pragma := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	s := &Store{DB: db}
	s.Users = &UserStore{db: db}
	s.Accounts = &AccountStore{db: db}
	s.Notes = &NoteStore{db: db}
	s.SyncCursor = &SyncCursorStore{db: db}
	return s, nil
}

// Close releases the underlying connection pool.
func (s *Store) Close() error { return s.DB.Close() }
