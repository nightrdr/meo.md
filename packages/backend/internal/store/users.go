package store

import (
	"database/sql"
	"errors"
	"time"
)

// ErrNotFound is returned by all sub-stores when a lookup misses.
// Handlers translate this to 404 (or whatever status fits the route).
var ErrNotFound = errors.New("not found")

// ErrConflict is returned when a uniqueness constraint would be
// violated (duplicate email, duplicate account init, etc).
var ErrConflict = errors.New("conflict")

type User struct {
	ID           string
	Email        string
	PasswordHash string
	CreatedAt    int64
}

type UserStore struct{ db *sql.DB }

// Create inserts a new user. Returns ErrConflict on duplicate email.
func (s *UserStore) Create(id, email, passwordHash string) error {
	_, err := s.db.Exec(
		`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		id, email, passwordHash, time.Now().UnixMilli(),
	)
	if err != nil {
		// modernc.org/sqlite returns errors with "UNIQUE constraint
		// failed" in the message. We convert to a sentinel so handlers
		// don't have to grep error strings.
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	}
	return nil
}

// FindByEmail returns the user with the given email, or ErrNotFound.
func (s *UserStore) FindByEmail(email string) (*User, error) {
	row := s.db.QueryRow(
		`SELECT id, email, password_hash, created_at FROM users WHERE email = ?`,
		email,
	)
	var u User
	if err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &u, nil
}

// EmailExists is a cheaper check than FindByEmail when you only need
// to know whether the address is taken.
func (s *UserStore) EmailExists(email string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT 1 FROM users WHERE email = ?`, email).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// isUniqueViolation matches modernc.org/sqlite's error text. Kept in
// one place so the leak doesn't spread.
func isUniqueViolation(err error) bool {
	return err != nil && containsAny(err.Error(),
		"UNIQUE constraint failed",
		"constraint failed: UNIQUE",
	)
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if indexOf(s, sub) >= 0 {
			return true
		}
	}
	return false
}

// Tiny strings.Contains shim so this file doesn't pull in another
// import for one call.
func indexOf(s, sub string) int {
	if len(sub) == 0 {
		return 0
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
