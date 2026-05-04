package store

import (
	"database/sql"
	"errors"
	"time"
)

// Attachment is one row in meo.attachments. The encrypted blob lives
// outside the DB (filesystem under MEO_ATTACHMENT_DIR/<storage_key>);
// the row holds metadata + the storage_key pointer.
type Attachment struct {
	ID                string
	NoteID            string
	UserID            string
	StorageKey        string // filesystem path key, e.g. "<user_id>/<id>.bin"
	StorageBackend    string // always "local" for this backend
	EncryptedSize     int64  // ciphertext bytes on disk
	Nonce             []byte
	EncryptedMetadata []byte
	MetadataNonce     []byte
	CreatedAt         time.Time
}

type AttachmentStore struct{ db *sql.DB }

// CreateInput is what handlers pass to record a freshly-uploaded blob.
type CreateInput struct {
	ID                string
	NoteID            string
	UserID            string
	StorageKey        string
	EncryptedSize     int64
	Nonce             []byte
	EncryptedMetadata []byte
	MetadataNonce     []byte
}

// Create records the attachment row. Caller has already written the
// ciphertext to disk and verified note ownership + tier quotas.
func (s *AttachmentStore) Create(in CreateInput) (*Attachment, error) {
	row := s.db.QueryRow(
		`INSERT INTO meo.attachments
		   (id, note_id, user_id, storage_key, storage_backend,
		    encrypted_size, nonce, encrypted_metadata, metadata_nonce)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'local', $5, $6, $7, $8)
		 RETURNING id, note_id::text, user_id::text, storage_key, storage_backend,
		           encrypted_size, nonce, encrypted_metadata, metadata_nonce, created_at`,
		in.ID, in.NoteID, in.UserID, in.StorageKey,
		in.EncryptedSize, in.Nonce, in.EncryptedMetadata, in.MetadataNonce,
	)
	return scanAttachment(row)
}

// Get returns the row, scoped to the requesting user. ErrNotFound if
// the row doesn't exist or is owned by someone else (we don't leak
// existence information across tenants).
func (s *AttachmentStore) Get(userID, id string) (*Attachment, error) {
	row := s.db.QueryRow(
		`SELECT id::text, note_id::text, user_id::text, storage_key, storage_backend,
		        encrypted_size, nonce, encrypted_metadata, metadata_nonce, created_at
		   FROM meo.attachments
		  WHERE id = $1::uuid AND user_id = $2::uuid`,
		id, userID,
	)
	a, err := scanAttachment(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return a, nil
}

// ListByNote returns all attachment rows for a note belonging to the user.
func (s *AttachmentStore) ListByNote(userID, noteID string) ([]*Attachment, error) {
	rows, err := s.db.Query(
		`SELECT id::text, note_id::text, user_id::text, storage_key, storage_backend,
		        encrypted_size, nonce, encrypted_metadata, metadata_nonce, created_at
		   FROM meo.attachments
		  WHERE note_id = $1::uuid AND user_id = $2::uuid
		  ORDER BY created_at ASC`,
		noteID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Attachment
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Delete removes the row, scoped to the user. Returns the storage_key
// so the caller can also unlink the on-disk blob.
func (s *AttachmentStore) Delete(userID, id string) (string, error) {
	var key string
	err := s.db.QueryRow(
		`DELETE FROM meo.attachments
		  WHERE id = $1::uuid AND user_id = $2::uuid
		  RETURNING storage_key`,
		id, userID,
	).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return key, err
}

// TotalBytes returns the sum of encrypted_size across the user's
// attachments. Used by the per-tier quota check before accepting a
// new upload.
func (s *AttachmentStore) TotalBytes(userID string) (int64, error) {
	var n sql.NullInt64
	err := s.db.QueryRow(
		`SELECT COALESCE(SUM(encrypted_size), 0)
		   FROM meo.attachments WHERE user_id = $1::uuid`,
		userID,
	).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n.Int64, nil
}

// NoteSizeBytes returns the sum of encrypted_size on meo.notes for the
// user. Combined with TotalBytes this gives the workspace total used
// in the storage_usage handler.
func (s *AttachmentStore) NoteSizeBytes(userID string) (int64, error) {
	var n sql.NullInt64
	err := s.db.QueryRow(
		`SELECT COALESCE(SUM(size_bytes), 0)
		   FROM meo.notes WHERE user_id = $1::uuid AND deleted_at IS NULL`,
		userID,
	).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n.Int64, nil
}

// VerifyNoteOwnership returns true if the note exists and belongs to
// the user. Called before accepting an attachment upload so we don't
// stash bytes for a note the user can't access.
func (s *AttachmentStore) VerifyNoteOwnership(userID, noteID string) (bool, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT 1 FROM meo.notes WHERE id = $1::uuid AND user_id = $2::uuid`,
		noteID, userID,
	).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func scanAttachment(s scanner) (*Attachment, error) {
	var a Attachment
	if err := s.Scan(
		&a.ID, &a.NoteID, &a.UserID, &a.StorageKey, &a.StorageBackend,
		&a.EncryptedSize, &a.Nonce, &a.EncryptedMetadata, &a.MetadataNonce, &a.CreatedAt,
	); err != nil {
		return nil, err
	}
	return &a, nil
}
