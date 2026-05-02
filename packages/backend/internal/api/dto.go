// Package api defines HTTP handlers and the wire DTOs they exchange.
//
// Handlers are methods on a Server struct (see server.go) so all
// dependencies (stores, hasher, signer) flow in via constructor -
// no package globals, no service locator. Each route is a thin
// translation layer between HTTP and the typed store API.
package api

import (
	"encoding/base64"

	"meo.md/backend/internal/store"
)

// ──────────────────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────────────────

type signupRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}
type signupResponse struct {
	UserID string `json:"user_id"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}
type loginResponse struct {
	JWT        string `json:"jwt"`
	HasAccount bool   `json:"has_account"`
	UserID     string `json:"user_id"`
}

// ──────────────────────────────────────────────────────────────────────
// Account (encryption wrapper)
// ──────────────────────────────────────────────────────────────────────

// accountResponse mirrors the TS server: binary fields are base64
// strings, kdf_params is a parsed JSON object (passed through as
// json.RawMessage so we don't touch the bytes the client sent).
type accountResponse struct {
	Salt               string         `json:"salt"`
	EncryptedMasterKey string         `json:"encrypted_master_key"`
	MasterKeyNonce     string         `json:"master_key_nonce"`
	KDFParams          rawJSONPayload `json:"kdf_params"`
}

type accountRequest struct {
	Salt               string         `json:"salt"`
	EncryptedMasterKey string         `json:"encrypted_master_key"`
	MasterKeyNonce     string         `json:"master_key_nonce"`
	KDFParams          rawJSONPayload `json:"kdf_params"`
}

// rawJSONPayload is a tiny alias around []byte that
// (un)marshals as raw JSON, so kdf_params is round-tripped byte-for-
// byte through the server (matching the TS path of `JSON.parse` →
// store as string → `JSON.parse` again on read).
type rawJSONPayload []byte

func (r rawJSONPayload) MarshalJSON() ([]byte, error) {
	if len(r) == 0 {
		return []byte("null"), nil
	}
	return r, nil
}
func (r *rawJSONPayload) UnmarshalJSON(b []byte) error {
	*r = append((*r)[:0], b...)
	return nil
}

// ──────────────────────────────────────────────────────────────────────
// Notes
// ──────────────────────────────────────────────────────────────────────

// noteWire is the JSON shape returned by the sync + upsert endpoints.
// Snake_case names match the TS server.
type noteWire struct {
	ID               string `json:"id"`
	EncryptedContent string `json:"encrypted_content"`
	Nonce            string `json:"nonce"`
	Version          int64  `json:"version"`
	HLCTimestamp     string `json:"hlc_timestamp"`
	UpdatedAt        int64  `json:"updated_at"`
	DeletedAt        *int64 `json:"deleted_at"`
	SizeBytes        int64  `json:"size_bytes"`
}

func noteToWire(n *store.Note) noteWire {
	return noteWire{
		ID:               n.ID,
		EncryptedContent: base64.StdEncoding.EncodeToString(n.EncryptedContent),
		Nonce:            base64.StdEncoding.EncodeToString(n.Nonce),
		Version:          n.Version,
		HLCTimestamp:     n.HLCTimestamp,
		UpdatedAt:        n.UpdatedAt,
		DeletedAt:        n.DeletedAt,
		SizeBytes:        n.SizeBytes,
	}
}

type upsertRequest struct {
	ID               string `json:"id"`
	EncryptedContent string `json:"encrypted_content"`
	Nonce            string `json:"nonce"`
	HLCTimestamp     string `json:"hlc_timestamp"`
}

// staleConflictResponse is what we return on 409. The client uses
// `current` to refresh its local view in one round-trip.
type staleConflictResponse struct {
	Error   string   `json:"error"`
	Current noteWire `json:"current"`
}

type syncResponse struct {
	Notes  []noteWire `json:"notes"`
	Cursor int64      `json:"cursor"`
}
