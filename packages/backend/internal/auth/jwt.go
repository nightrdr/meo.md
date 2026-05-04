// Package auth verifies Supabase-issued JWTs and brokers calls to
// GoTrue (Supabase Auth). The Go backend doesn't issue its own tokens
// — every protected route trusts a JWT minted by the local GoTrue
// instance, verified against the shared GOTRUE_JWT_SECRET (HS256).
package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims is a narrow view of the Supabase JWT payload. We pin only
// the fields handlers actually use; everything else is ignored. Field
// tags must match GoTrue's wire names exactly.
type Claims struct {
	Sub         string `json:"sub"`              // user UUID
	Email       string `json:"email"`            // user email (may be empty for anon)
	Role        string `json:"role"`             // 'authenticated' | 'anon'
	AAL         string `json:"aal,omitempty"`    // assurance level: 'aal1' | 'aal2'
	IsAnonymous bool   `json:"is_anonymous"`     // true for anon-key tokens
	jwt.RegisteredClaims
}

// JWTVerifier wraps the shared HS256 secret used by GoTrue. Stateless
// after construction — safe to share across goroutines.
type JWTVerifier struct {
	secret []byte
}

// NewJWTVerifier holds the secret bytes. Caller is responsible for
// reading SUPABASE_JWT_SECRET from env (or wherever) and passing it
// in. Empty secret is rejected — refusing to verify is safer than
// silently accepting any signature.
func NewJWTVerifier(secret []byte) (*JWTVerifier, error) {
	if len(secret) == 0 {
		return nil, errors.New("auth: empty JWT secret")
	}
	return &JWTVerifier{secret: secret}, nil
}

// Verify parses and validates a token. Returns Claims on success or
// an error wrapping the reason (expired, malformed, bad signature).
// Refuses tokens with role != 'authenticated' so anon-key callers
// can't drift past the protected boundary.
func (v *JWTVerifier) Verify(raw string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(raw, &Claims{}, func(t *jwt.Token) (any, error) {
		// Refuse anything that isn't HMAC-SHA256. Defence-in-depth
		// against the alg=none / RSA-vs-HMAC confusion attacks.
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return v.secret, nil
	}, jwt.WithLeeway(30*time.Second))
	if err != nil {
		return nil, err
	}
	c, ok := tok.Claims.(*Claims)
	if !ok || !tok.Valid {
		return nil, errors.New("invalid token")
	}
	if c.Sub == "" {
		return nil, errors.New("token missing sub")
	}
	if c.Role != "authenticated" {
		return nil, fmt.Errorf("role %q not authorized", c.Role)
	}
	return c, nil
}
