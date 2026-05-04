package store

import (
	"database/sql"
	"errors"
	"time"
)

// Note is the on-the-wire encrypted note row. EncryptedContent and
// Nonce are opaque ciphertext bytes — the server never decrypts them.
type Note struct {
	ID               string
	UserID           string
	EncryptedContent []byte
	Nonce            []byte
	Version          int64
	HLCTimestamp     string // opaque, lexically comparable
	UpdatedAt        int64  // unix millis
	DeletedAt        *int64 // nullable tombstone, unix millis
	SizeBytes        int64
	IsVault          bool
}

type NoteStore struct{ db *sql.DB }

// Get returns the row regardless of which user owns it. Caller is
// responsible for the ownership check (we expose this so the upsert
// path doesn't have to do two lookups).
func (s *NoteStore) Get(id string) (*Note, error) {
	row := s.db.QueryRow(
		`SELECT id, user_id::text, encrypted_content, nonce, version, hlc_timestamp,
		        updated_at, deleted_at, size_bytes, is_vault
		   FROM meo.notes WHERE id = $1`, id,
	)
	return scanNote(row)
}

// ListSince returns all rows for the user with version > since,
// ordered by version ASC. Used by the sync poll.
func (s *NoteStore) ListSince(userID string, since int64) ([]*Note, error) {
	rows, err := s.db.Query(
		`SELECT id, user_id::text, encrypted_content, nonce, version, hlc_timestamp,
		        updated_at, deleted_at, size_bytes, is_vault
		   FROM meo.notes
		  WHERE user_id = $1::uuid AND version > $2
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
	IsVault          bool
}

// Upsert performs the create-or-update with HLC last-write-wins
// semantics. All inside one transaction so the version counter only
// advances on accepted writes (a stale reject must not consume a
// version).
func (s *NoteStore) Upsert(userID string, sync *SyncCursorStore, in UpsertInput) (*Note, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// 1. Look up the existing row (ownership + HLC check).
	var existingUser, existingHLC sql.NullString
	err = tx.QueryRow(
		`SELECT user_id::text, hlc_timestamp FROM meo.notes WHERE id = $1`, in.ID,
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
	now := time.Now()
	size := int64(len(in.EncryptedContent))

	if exists {
		_, err = tx.Exec(
			`UPDATE meo.notes SET
			   encrypted_content = $1, nonce = $2, version = $3,
			   hlc_timestamp = $4, updated_at = $5, deleted_at = NULL,
			   size_bytes = $6, is_vault = $7
			 WHERE id = $8`,
			in.EncryptedContent, in.Nonce, version,
			in.HLCTimestamp, now, size, in.IsVault, in.ID,
		)
	} else {
		_, err = tx.Exec(
			`INSERT INTO meo.notes
			   (id, user_id, encrypted_content, nonce, version,
			    hlc_timestamp, updated_at, deleted_at, size_bytes, is_vault)
			 VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, NULL, $8, $9)`,
			in.ID, userID, in.EncryptedContent, in.Nonce, version,
			in.HLCTimestamp, now, size, in.IsVault,
		)
	}
	if err != nil {
		return nil, translatePgError(err)
	}

	// 3. Re-read so the response carries every field.
	saved, err := scanNote(tx.QueryRow(
		`SELECT id, user_id::text, encrypted_content, nonce, version, hlc_timestamp,
		        updated_at, deleted_at, size_bytes, is_vault
		   FROM meo.notes WHERE id = $1`, in.ID,
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
	err = tx.QueryRow(`SELECT user_id::text FROM meo.notes WHERE id = $1`, id).Scan(&existingUser)
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
	now := time.Now()
	if _, err := tx.Exec(
		`UPDATE meo.notes SET deleted_at = $1, version = $2, updated_at = $3 WHERE id = $4`,
		now, version, now, id,
	); err != nil {
		return nil, err
	}

	saved, err := scanNote(tx.QueryRow(
		`SELECT id, user_id::text, encrypted_content, nonce, version, hlc_timestamp,
		        updated_at, deleted_at, size_bytes, is_vault
		   FROM meo.notes WHERE id = $1`, id,
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
	var updatedAt time.Time
	var deletedAt sql.NullTime
	if err := s.Scan(
		&n.ID, &n.UserID, &n.EncryptedContent, &n.Nonce, &n.Version,
		&n.HLCTimestamp, &updatedAt, &deletedAt, &n.SizeBytes, &n.IsVault,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	n.UpdatedAt = updatedAt.UnixMilli()
	if deletedAt.Valid {
		v := deletedAt.Time.UnixMilli()
		n.DeletedAt = &v
	}
	return &n, nil
}

// ─── SyncCursor — per-user monotonic version counter ──────────────────

type SyncCursorStore struct{ db *sql.DB }

// Next allocates the next version for userID and bumps the counter.
// First call for a user returns 1; subsequent calls return 2, 3, …
//
// Only called inside the Note* mutators after every validation has
// passed — a stale reject does NOT consume a version.
func (s *SyncCursorStore) Next(tx Tx, userID string) (int64, error) {
	if tx == nil {
		tx = s.db
	}
	// Atomic upsert + increment in one round-trip. Returns the value
	// that was just *allocated* to the caller (i.e. the value before
	// the bump).
	var v int64
	err := tx.QueryRow(
		`INSERT INTO meo.sync_cursor (user_id, next_version)
		 VALUES ($1::uuid, 2)
		 ON CONFLICT (user_id) DO UPDATE
		   SET next_version = meo.sync_cursor.next_version + 1
		 RETURNING (CASE WHEN xmax = 0 THEN 1 ELSE next_version - 1 END)`,
		userID,
	).Scan(&v)
	if err != nil {
		return 0, err
	}
	return v, nil
}
