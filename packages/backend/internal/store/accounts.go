package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Account is the encrypted-master-key wrapper that the client uploads
// during initial setup. The server only ever sees opaque bytes; the
// actual master key never leaves the client.
type Account struct {
	UserID             string
	Salt               []byte
	EncryptedMasterKey []byte
	MasterKeyNonce     []byte
	KDFParamsJSON      json.RawMessage // stored as jsonb
	CreatedAt          int64           // unix millis
}

type AccountStore struct{ db *sql.DB }

// Get returns the wrapper for the given user, or ErrNotFound.
func (s *AccountStore) Get(userID string) (*Account, error) {
	row := s.db.QueryRow(
		`SELECT salt, encrypted_master_key, master_key_nonce, kdf_params, created_at
		   FROM meo.accounts WHERE user_id = $1::uuid`,
		userID,
	)
	a := Account{UserID: userID}
	var createdAt time.Time
	if err := row.Scan(&a.Salt, &a.EncryptedMasterKey, &a.MasterKeyNonce, &a.KDFParamsJSON, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	a.CreatedAt = createdAt.UnixMilli()
	return &a, nil
}

// Exists is a cheaper check used on the auth path.
func (s *AccountStore) Exists(userID string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT 1 FROM meo.accounts WHERE user_id = $1::uuid`, userID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// Create inserts a wrapper. Returns ErrConflict if one already exists.
func (s *AccountStore) Create(a *Account) error {
	if len(a.KDFParamsJSON) == 0 {
		a.KDFParamsJSON = json.RawMessage(`{}`)
	}
	_, err := s.db.Exec(
		`INSERT INTO meo.accounts
		   (user_id, salt, encrypted_master_key, master_key_nonce, kdf_params)
		 VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
		a.UserID, a.Salt, a.EncryptedMasterKey, a.MasterKeyNonce, string(a.KDFParamsJSON),
	)
	return translatePgError(err)
}
