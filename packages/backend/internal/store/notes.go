package store

import (
	"database/sql"
	"errors"
	"time"
)

// Note is the on-the-wire encrypted note row. EncryptedContent and
// Nonce are opaque ciphertext bytes - the server never decrypts them.
type Note struct {
	ID               string
	UserID           string
	EncryptedContent []byte
	Nonce            []byte
	Version          int64
	HLCTimestamp     string // opaque, lexically comparable
	UpdatedAt        int64
	DeletedAt        *int64 // nullable tombstone
	SizeBytes        int64
}

// ErrStaleWrite is returned by Upsert when the incoming HLC is not
// strictly greater than the stored one. Handlers translate to 409.
var ErrStaleWrite = errors.New("stale write")

// ErrForbidden is returned when the requesting user doesn't own the
// note row being touched. Handlers translate to 403.
var ErrForbidden = errors.New("forbidden")

type NoteStore struct{ db *sql.DB }

// Get returns the row regardless of which user owns it. Caller is
// responsible for the ownership check (we expose this so the upsert
// path doesn't have to do two lookups).
func (s *NoteStore) Get(id string) (*Note, error) {
	row := s.db.QueryRow(
		`SELECT id, user_id, encrypted_content, nonce, version, hlc_timestamp,
		        updated_at, deleted_at, size_bytes
		   FROM notes WHERE id = ?`, id,
	)
	return scanNote(row)
}

// ListSince returns all rows for the user with version > since,
// ordered by version ASC. Used by the sync poll.
func (s *NoteStore) ListSince(userID string, since int64) ([]*Note, error) {
	rows, err := s.db.Query(
		`SELECT id, user_id, encrypted_content, nonce, version, hlc_timestamp,
		        updated_at, deleted_at, size_bytes
		   FROM notes
		  WHERE user_id = ? AND version > ?
		  ORDER BY version ASC`,
		userID, since,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*Note
	for rows.Next() {
		n, err := scanNote(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// UpsertInput is the subset of Note fields a client controls.
type UpsertInput struct {
	ID               string
	EncryptedContent []byte
	Nonce            []byte
	HLCTimestamp     string
}

// Upsert performs the create-or-update with HLC last-write-wins
// semantics. All inside one transaction so the version counter only
// advances on accepted writes (test #9 depends on this - a stale
// reject must not consume a version).
func (s *NoteStore) Upsert(userID string, sync *SyncCursorStore, in UpsertInput) (*Note, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// 1. Look up the existing row (ownership + HLC check).
	var existingUser, existingHLC sql.NullString
	err = tx.QueryRow(
		`SELECT user_id, hlc_timestamp FROM notes WHERE id = ?`, in.ID,
	).Scan(&existingUser, &existingHLC)
	exists := !errors.Is(err, sql.ErrNoRows)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if exists && existingUser.String != userID {
		return nil, ErrForbidden
	}
	if exists && in.HLCTimestamp <= existingHLC.String {
		return nil, ErrStaleWrite
	}

	// 2. Allocate the next version inside the same tx.
	version, err := sync.Next(tx, userID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	size := int64(len(in.EncryptedContent))

	if exists {
		_, err = tx.Exec(
			`UPDATE notes SET
			   encrypted_content = ?, nonce = ?, version = ?,
			   hlc_timestamp = ?, updated_at = ?, deleted_at = NULL,
			   size_bytes = ?
			 WHERE id = ?`,
			in.EncryptedContent, in.Nonce, version,
			in.HLCTimestamp, now, size, in.ID,
		)
	} else {
		_, err = tx.Exec(
			`INSERT INTO notes
			   (id, user_id, encrypted_content, nonce, version,
			    hlc_timestamp, updated_at, deleted_at, size_bytes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			in.ID, userID, in.EncryptedContent, in.Nonce, version,
			in.HLCTimestamp, now, size,
		)
	}
	if err != nil {
		return nil, err
	}

	// 3. Re-read so the response carries every field the client
	//    needs (matches rowToWire() in the TS server).
	saved, err := scanNote(tx.QueryRow(
		`SELECT id, user_id, encrypted_content, nonce, version, hlc_timestamp,
		        updated_at, deleted_at, size_bytes
		   FROM notes WHERE id = ?`, in.ID,
	))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return saved, nil
}

// Tombstone marks the note deleted. Bumps the per-user version so
// other devices learn about it via the sync poll.
func (s *NoteStore) Tombstone(userID, id string, sync *SyncCursorStore) (*Note, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var existingUser sql.NullString
	err = tx.QueryRow(`SELECT user_id FROM notes WHERE id = ?`, id).Scan(&existingUser)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if existingUser.String != userID {
		return nil, ErrForbidden
	}

	version, err := sync.Next(tx, userID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	if _, err := tx.Exec(
		`UPDATE notes SET deleted_at = ?, version = ?, updated_at = ? WHERE id = ?`,
		now, version, now, id,
	); err != nil {
		return nil, err
	}

	saved, err := scanNote(tx.QueryRow(
		`SELECT id, user_id, encrypted_content, nonce, version, hlc_timestamp,
		        updated_at, deleted_at, size_bytes
		   FROM notes WHERE id = ?`, id,
	))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return saved, nil
}

// scanner is the narrow interface implemented by both *sql.Row and
// *sql.Rows so scanNote can reuse the same column list for both.
type scanner interface {
	Scan(dest ...any) error
}

func scanNote(s scanner) (*Note, error) {
	var n Note
	var deletedAt sql.NullInt64
	if err := s.Scan(
		&n.ID, &n.UserID, &n.EncryptedContent, &n.Nonce, &n.Version,
		&n.HLCTimestamp, &n.UpdatedAt, &deletedAt, &n.SizeBytes,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if deletedAt.Valid {
		v := deletedAt.Int64
		n.DeletedAt = &v
	}
	return &n, nil
}

// ──────────────────────────────────────────────────────────────────────
// SyncCursor - per-user monotonic version counter.
// ──────────────────────────────────────────────────────────────────────

type SyncCursorStore struct{ db *sql.DB }

// Tx is the narrow interface satisfied by both *sql.DB and *sql.Tx.
// Lets Next() participate in an outer transaction (Upsert/Tombstone)
// or run standalone if needed.
type Tx interface {
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

// Next allocates the next version for userID and bumps the counter.
// First call for a user returns 1; subsequent calls return 2, 3, ….
//
// Note: only called inside the Note* mutators above, after every
// validation has passed - a stale reject does NOT consume a version.
func (s *SyncCursorStore) Next(tx Tx, userID string) (int64, error) {
	if tx == nil {
		tx = s.db
	}
	var v int64
	err := tx.QueryRow(
		`SELECT next_version FROM sync_cursor WHERE user_id = ?`, userID,
	).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		// First write: store next_version=2 and hand out 1.
		if _, err := tx.Exec(
			`INSERT INTO sync_cursor (user_id, next_version) VALUES (?, 2)`, userID,
		); err != nil {
			return 0, err
		}
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(
		`UPDATE sync_cursor SET next_version = ? WHERE user_id = ?`, v+1, userID,
	); err != nil {
		return 0, err
	}
	return v, nil
}
