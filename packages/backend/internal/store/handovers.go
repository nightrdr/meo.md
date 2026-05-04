package store

import (
	"database/sql"
	"errors"
	"time"
)

// Handover is one row in meo.handovers — the QR-driven device pairing
// blob. The handover_id IS the secret (16 bytes of CSPRNG, base64).
// Anyone holding the id can read/write the row, which is exactly the
// semantics we want: device A scans the QR and learns the id; device
// B reads the QR (so also learns the id); the server never sees who
// owns what until the handover_id is consumed.
type Handover struct {
	ID           string
	EkAPub       []byte
	EkBPub       []byte // null until B replies
	PayloadForB  []byte // null until A finalizes
	PayloadNonce []byte
	ExpiresAt    time.Time
}

type HandoverStore struct{ db *sql.DB }

const handoverTTL = 10 * time.Minute

// Create inserts the initial row with A's ephemeral public key. id is
// a 16-byte secret the caller already generated.
func (s *HandoverStore) Create(id string, ekAPub []byte) error {
	_, err := s.db.Exec(
		`INSERT INTO meo.handovers (id, ek_a_pub, expires_at)
		 VALUES ($1::uuid, $2, now() + $3::interval)`,
		id, ekAPub, handoverTTL.String(),
	)
	return translatePgError(err)
}

// PutB attaches B's ephemeral key. Idempotent on the (id, key) pair —
// a retry by B with the same key is harmless. Different keys would
// indicate someone else stole the QR; we reject the second.
func (s *HandoverStore) PutB(id string, ekBPub []byte) error {
	res, err := s.db.Exec(
		`UPDATE meo.handovers SET ek_b_pub = $1
		  WHERE id = $2::uuid AND expires_at > now()
		    AND (ek_b_pub IS NULL OR ek_b_pub = $1)`,
		ekBPub, id,
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

// PutPayload attaches the encrypted payload from A. Same idempotency
// rule as PutB.
func (s *HandoverStore) PutPayload(id string, payload, nonce []byte) error {
	res, err := s.db.Exec(
		`UPDATE meo.handovers SET payload_for_b = $1, payload_nonce = $2
		  WHERE id = $3::uuid AND expires_at > now()`,
		payload, nonce, id,
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

// Get returns the row. Caller checks expires_at; the SQL filters to
// non-expired rows so an attacker can't poll an expired secret.
func (s *HandoverStore) Get(id string) (*Handover, error) {
	row := s.db.QueryRow(
		`SELECT id::text, ek_a_pub, ek_b_pub, payload_for_b, payload_nonce, expires_at
		   FROM meo.handovers WHERE id = $1::uuid AND expires_at > now()`,
		id,
	)
	var h Handover
	var ekB, payload, nonce []byte
	if err := row.Scan(&h.ID, &h.EkAPub, &ekB, &payload, &nonce, &h.ExpiresAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if len(ekB) > 0 {
		h.EkBPub = ekB
	}
	if len(payload) > 0 {
		h.PayloadForB = payload
	}
	if len(nonce) > 0 {
		h.PayloadNonce = nonce
	}
	return &h, nil
}

// Clear deletes the row. B calls this after successfully unwrapping
// the payload so the secret can't be replayed.
func (s *HandoverStore) Clear(id string) error {
	_, err := s.db.Exec(`DELETE FROM meo.handovers WHERE id = $1::uuid`, id)
	return err
}
