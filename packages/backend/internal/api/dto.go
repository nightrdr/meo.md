// Package api defines HTTP handlers and the wire DTOs they exchange.
//
// Handlers are methods on a Server struct (see server.go) so all
// dependencies (stores, GoTrue client, JWT verifier, attachment dir)
// flow in via constructor — no package globals, no service locator.
package api

import (
	"encoding/base64"
	"time"

	"meo.md/backend/internal/store"
)

// ─── Auth (OTP + refresh) ────────────────────────────────────────────

type otpRequestRequest struct {
	Email string `json:"email"`
}
type otpRequestResponse struct {
	Sent bool `json:"sent"`
}

type otpVerifyRequest struct {
	Email string `json:"email"`
	Token string `json:"token"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// authLoginResponse mirrors the SupabaseApiClient's AuthLoginResponse
// shape exactly so the desktop's session.ts can stay agnostic about
// which backend issued it.
type authLoginResponse struct {
	JWT          string `json:"jwt"`
	UserID       string `json:"user_id"`
	HasAccount   bool   `json:"has_account"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

// passwordSignupRequest / loginRequest kept for the legacy e2e path.
// The desktop UI prefers the OTP flow above.
type passwordRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// ─── Account (encryption wrapper) ────────────────────────────────────

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

// rawJSONPayload is a tiny alias around []byte that (un)marshals as
// raw JSON, so kdf_params is round-tripped byte-for-byte through the
// server.
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

// ─── Notes ───────────────────────────────────────────────────────────

type noteWire struct {
	ID               string `json:"id"`
	EncryptedContent string `json:"encrypted_content"`
	Nonce            string `json:"nonce"`
	Version          int64  `json:"version"`
	HLCTimestamp     string `json:"hlc_timestamp"`
	UpdatedAt        int64  `json:"updated_at"`
	DeletedAt        *int64 `json:"deleted_at"`
	SizeBytes        int64  `json:"size_bytes"`
	IsVault          bool   `json:"is_vault"`
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
		IsVault:          n.IsVault,
	}
}

type upsertRequest struct {
	ID               string `json:"id"`
	EncryptedContent string `json:"encrypted_content"`
	Nonce            string `json:"nonce"`
	HLCTimestamp     string `json:"hlc_timestamp"`
	IsVault          bool   `json:"is_vault"`
}

type staleConflictResponse struct {
	Error   string   `json:"error"`
	Current noteWire `json:"current"`
}

type syncResponse struct {
	Notes  []noteWire `json:"notes"`
	Cursor int64      `json:"cursor"`
}

// ─── Devices ─────────────────────────────────────────────────────────

type deviceWire struct {
	DeviceID    string  `json:"device_id"`
	Name        string  `json:"name"`
	Platform    string  `json:"platform"`
	UA          *string `json:"ua"`
	IP          *string `json:"ip"`
	FirstSeenAt string  `json:"first_seen_at"`
	LastSeen    string  `json:"last_seen"`
}
type deviceRegisterRequest struct {
	DeviceID string  `json:"device_id"`
	Platform string  `json:"platform"`
	Name     string  `json:"name"`
	UA       *string `json:"ua"`
}

func deviceToWire(d *store.Device) deviceWire {
	return deviceWire{
		DeviceID:    d.DeviceID,
		Name:        d.Name,
		Platform:    d.Platform,
		UA:          d.UA,
		IP:          d.IP,
		FirstSeenAt: d.FirstSeenAt.UTC().Format(time.RFC3339),
		LastSeen:    d.LastSeen.UTC().Format(time.RFC3339),
	}
}

// ─── Subscriptions ───────────────────────────────────────────────────

type subscriptionWire struct {
	UserID             string  `json:"user_id"`
	Tier               string  `json:"tier"`
	Source             *string `json:"source"`
	ExternalID         *string `json:"external_id"`
	CurrentPeriodEnd   *string `json:"current_period_end"`
	CancelAtPeriodEnd  bool    `json:"cancel_at_period_end"`
	UpdatedAt          string  `json:"updated_at"`
}

func subscriptionToWire(s *store.Subscription) subscriptionWire {
	var cpe *string
	if s.CurrentPeriodEnd != nil {
		v := s.CurrentPeriodEnd.UTC().Format(time.RFC3339)
		cpe = &v
	}
	return subscriptionWire{
		UserID:             s.UserID,
		Tier:               s.Tier,
		Source:             s.Source,
		ExternalID:         s.ExternalID,
		CurrentPeriodEnd:   cpe,
		CancelAtPeriodEnd:  s.CancelAtPeriodEnd,
		UpdatedAt:          s.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

// ─── Attachments ─────────────────────────────────────────────────────

type attachmentWire struct {
	ID                string `json:"id"`
	NoteID            string `json:"note_id"`
	StorageKey        string `json:"storage_key"`
	StorageBackend    string `json:"storage_backend"`
	EncryptedSize     int64  `json:"encrypted_size"`
	Nonce             string `json:"nonce"`              // base64
	EncryptedMetadata string `json:"encrypted_metadata"` // base64
	MetadataNonce     string `json:"metadata_nonce"`     // base64
	CreatedAt         string `json:"created_at"`
}

func attachmentToWire(a *store.Attachment) attachmentWire {
	return attachmentWire{
		ID:                a.ID,
		NoteID:            a.NoteID,
		StorageKey:        a.StorageKey,
		StorageBackend:    a.StorageBackend,
		EncryptedSize:     a.EncryptedSize,
		Nonce:             base64.StdEncoding.EncodeToString(a.Nonce),
		EncryptedMetadata: base64.StdEncoding.EncodeToString(a.EncryptedMetadata),
		MetadataNonce:     base64.StdEncoding.EncodeToString(a.MetadataNonce),
		CreatedAt:         a.CreatedAt.UTC().Format(time.RFC3339),
	}
}

type attachmentCreateRequest struct {
	ID                string `json:"id"`                 // client-supplied UUID
	NoteID            string `json:"note_id"`
	Nonce             string `json:"nonce"`              // base64 (12 bytes)
	EncryptedMetadata string `json:"encrypted_metadata"` // base64
	MetadataNonce     string `json:"metadata_nonce"`     // base64
	// Encrypted bytes themselves arrive in a separate multipart field
	// or follow-up PUT depending on the route — see handlers_attachments.go.
}

type storageUsageResponse struct {
	AttachmentBytes    int64 `json:"attachment_bytes"`
	NoteBytes          int64 `json:"note_bytes"`
	TotalBytes         int64 `json:"total_bytes"`
	CapBytes           int64 `json:"cap_bytes"`
	MaxAttachmentBytes int64 `json:"max_attachment_bytes"`
}

// ─── 2FA ─────────────────────────────────────────────────────────────

type tfaEnrollRequest struct {
	SecretEnc   string `json:"secret_enc"`   // base64 ciphertext of the TOTP secret
	SecretNonce string `json:"secret_nonce"` // base64 12-byte nonce
}
type tfaSecretResponse struct {
	SecretEnc   string `json:"secret_enc"`
	SecretNonce string `json:"secret_nonce"`
	Enabled     bool   `json:"enabled"`
}

// ─── Handovers ───────────────────────────────────────────────────────

type handoverCreateRequest struct {
	ID     string `json:"id"`
	EkAPub string `json:"ek_a_pub"` // hex
}
type handoverPutBRequest struct {
	EkBPub string `json:"ek_b_pub"` // hex
}
type handoverPutPayloadRequest struct {
	Payload string `json:"payload"`       // hex
	Nonce   string `json:"payload_nonce"` // hex
}
type handoverWire struct {
	EkAPub       *string `json:"ek_a_pub"`
	EkBPub       *string `json:"ek_b_pub"`
	PayloadForB  *string `json:"payload_for_b"`
	PayloadNonce *string `json:"payload_nonce"`
	ExpiresAt    string  `json:"expires_at"`
}
