package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Claims is the JWT payload. Field order + JSON names match the TS
// signJwt output so a token issued by either server verifies on both.
type Claims struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	IAT   int64  `json:"iat"`
	EXP   int64  `json:"exp"`
}

// JWTSigner signs and verifies tokens with HS256. The secret is held
// as a value field rather than read from env on every call — passes
// inversion-of-control: tests inject a known secret, prod injects the
// random one from config.
type JWTSigner struct {
	secret []byte
	ttl    time.Duration
}

// NewJWTSigner returns a signer that uses `secret` as the HMAC key
// and issues tokens valid for `ttl`. The TS server defaults to
// 30 days (60*60*24*30 seconds).
func NewJWTSigner(secret []byte, ttl time.Duration) *JWTSigner {
	return &JWTSigner{secret: secret, ttl: ttl}
}

// Sign returns a `header.payload.sig` token. Header is the constant
// `{"alg":"HS256","typ":"JWT"}` — kept inline rather than computed so
// the bytes are identical to what the TS server emits (different JSON
// encoders reorder keys differently, which would break the hash).
func (s *JWTSigner) Sign(sub, email string) (string, error) {
	headerB64 := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" // base64url('{"alg":"HS256","typ":"JWT"}')
	now := time.Now().Unix()
	claims := Claims{
		Sub:   sub,
		Email: email,
		IAT:   now,
		EXP:   now + int64(s.ttl/time.Second),
	}
	payloadJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	payloadB64 := b64urlEncode(payloadJSON)

	h := hmac.New(sha256.New, s.secret)
	h.Write([]byte(headerB64 + "." + payloadB64))
	sig := h.Sum(nil)
	sigB64 := b64urlEncode(sig)

	return headerB64 + "." + payloadB64 + "." + sigB64, nil
}

// Verify parses and validates the token. Returns ErrInvalidToken on
// any failure — handlers translate to 401.
func (s *JWTSigner) Verify(token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrInvalidToken
	}
	h := hmac.New(sha256.New, s.secret)
	h.Write([]byte(parts[0] + "." + parts[1]))
	expected := h.Sum(nil)
	provided, err := b64urlDecode(parts[2])
	if err != nil {
		return nil, ErrInvalidToken
	}
	if !hmac.Equal(expected, provided) {
		return nil, ErrInvalidToken
	}
	payload, err := b64urlDecode(parts[1])
	if err != nil {
		return nil, ErrInvalidToken
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, ErrInvalidToken
	}
	if c.EXP < time.Now().Unix() {
		return nil, ErrTokenExpired
	}
	return &c, nil
}

// Sentinel errors. Handlers can distinguish if they care; for now
// they all map to 401.
var (
	ErrInvalidToken = errors.New("invalid token")
	ErrTokenExpired = errors.New("token expired")
)

// b64url encoders matching the TS pair: standard base64 with '+/' →
// '-_' and trailing '=' stripped.
func b64urlEncode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}
func b64urlDecode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}
