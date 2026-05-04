package store

import (
	"database/sql"
	"errors"
	"time"
)

// TFASecret holds the TOTP shared secret encrypted client-side. The
// server never sees the plaintext secret — verification happens on the
// client and the server stores the encrypted bytes purely so multi-
// device users can re-derive their TOTP after pairing.
type TFASecret struct {
	UserID      string
	SecretEnc   []byte
	SecretNonce []byte
	Enabled     bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type TFAStore struct{ db *sql.DB }

// Status returns true if the user has 2FA enabled. Cheap check used by
// every protected route via the cold-start gate.
func (s *TFAStore) Status(userID string) (bool, error) {
	var enabled sql.NullBool
	err := s.db.QueryRow(
		`SELECT enabled FROM meo.tfa_secrets WHERE user_id = $1::uuid`,
		userID,
	).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return enabled.Bool, nil
}

// Enroll upserts the encrypted TOTP secret. enabled defaults to true
// because the desktop only persists secrets after the user has
// successfully verified the QR code on enrollment.
func (s *TFAStore) Enroll(userID string, secretEnc, secretNonce []byte) error {
	_, err := s.db.Exec(
		`INSERT INTO meo.tfa_secrets (user_id, secret_enc, secret_nonce, enabled, created_at, updated_at)
		 VALUES ($1::uuid, $2, $3, true, now(), now())
		 ON CONFLICT (user_id) DO UPDATE
		   SET secret_enc = EXCLUDED.secret_enc,
		       secret_nonce = EXCLUDED.secret_nonce,
		       enabled = true,
		       updated_at = now()`,
		userID, secretEnc, secretNonce,
	)
	return translatePgError(err)
}

// GetSecret returns the encrypted secret + nonce. Used by the desktop
// after pairing to a new device so the user doesn't have to re-enroll.
// ErrNotFound when 2FA isn't set up.
func (s *TFAStore) GetSecret(userID string) (*TFASecret, error) {
	row := s.db.QueryRow(
		`SELECT user_id::text, secret_enc, secret_nonce, enabled, created_at, updated_at
		   FROM meo.tfa_secrets WHERE user_id = $1::uuid`,
		userID,
	)
	var t TFASecret
	if err := row.Scan(&t.UserID, &t.SecretEnc, &t.SecretNonce, &t.Enabled, &t.CreatedAt, &t.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &t, nil
}

// Disable flips enabled=false but keeps the row so a future re-enable
// doesn't have to re-prompt for the QR. Wipe the secret when the user
// explicitly chooses "remove 2FA" via Delete.
func (s *TFAStore) Disable(userID string) error {
	res, err := s.db.Exec(
		`UPDATE meo.tfa_secrets SET enabled = false, updated_at = now()
		  WHERE user_id = $1::uuid`,
		userID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Delete removes the row entirely. Used by Settings → "remove 2FA".
func (s *TFAStore) Delete(userID string) error {
	_, err := s.db.Exec(`DELETE FROM meo.tfa_secrets WHERE user_id = $1::uuid`, userID)
	return err
}
