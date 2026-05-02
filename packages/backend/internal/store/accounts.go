package store

import (
	"database/sql"
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
	KDFParamsJSON      string // raw JSON; opaque to the server
	CreatedAt          int64
}

type AccountStore struct{ db *sql.DB }

// Get returns the wrapper for the given user, or ErrNotFound.
func (s *AccountStore) Get(userID string) (*Account, error) {
	row := s.db.QueryRow(
		`SELECT salt, encrypted_master_key, master_key_nonce, kdf_params
		   FROM accounts WHERE user_id = ?`,
		userID,
	)
	a := Account{UserID: userID}
	if err := row.Scan(&a.Salt, &a.EncryptedMasterKey, &a.MasterKeyNonce, &a.KDFParamsJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &a, nil
}

// Exists is a cheaper check used by /auth/login to set has_account.
func (s *AccountStore) Exists(userID string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT 1 FROM accounts WHERE user_id = ?`, userID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// Create inserts a wrapper. Returns ErrConflict if one already exists
// (matches the TS behavior of refusing to overwrite - a re-init has
// to come through a separate flow).
func (s *AccountStore) Create(a *Account) error {
	_, err := s.db.Exec(
		`INSERT INTO accounts
		   (user_id, salt, encrypted_master_key, master_key_nonce, kdf_params, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		a.UserID, a.Salt, a.EncryptedMasterKey, a.MasterKeyNonce, a.KDFParamsJSON,
		time.Now().UnixMilli(),
	)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	}
	return nil
}
