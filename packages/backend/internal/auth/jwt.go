// Package auth verifies Supabase-issued JWTs and brokers calls to
// GoTrue (Supabase Auth). The Go backend doesn't issue its own tokens
// — every protected route trusts a JWT minted by the local GoTrue
// instance.
//
// Algorithm support: GoTrue moved to asymmetric ES256 keys in newer
// builds (the project's `auth.signing_keys_path` writes a P-256 EC
// keypair on first run). Older deployments still use HS256 with the
// shared `GOTRUE_JWT_SECRET`. We support both: ES256 verification
// uses the JWKS at `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`,
// HS256 falls back to the supplied symmetric secret.
package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims is a narrow view of the Supabase JWT payload. We pin only
// the fields handlers actually use; everything else is ignored.
type Claims struct {
	Sub         string `json:"sub"`           // user UUID
	Email       string `json:"email"`         // user email
	Role        string `json:"role"`          // 'authenticated' | 'anon'
	AAL         string `json:"aal,omitempty"` // assurance level
	IsAnonymous bool   `json:"is_anonymous"`
	jwt.RegisteredClaims
}

// JWTVerifier holds the symmetric secret + a JWKS cache for asymmetric
// keys. Concurrency-safe: the JWKS map is only written under jwksMu.
type JWTVerifier struct {
	hmacSecret []byte
	jwksURL    string

	jwksMu      sync.RWMutex
	jwksKeys    map[string]any // kid → *ecdsa.PublicKey or []byte (HMAC)
	jwksFetched time.Time
}

// NewJWTVerifier prepares a verifier. Pass the HMAC secret (for HS256
// tokens) and the supabase URL (used to derive the JWKS endpoint for
// asymmetric tokens). Either may be empty — but at least one must be
// usable, else every Verify() call will fail.
func NewJWTVerifier(hmacSecret []byte, supabaseURL string) (*JWTVerifier, error) {
	if len(hmacSecret) == 0 && supabaseURL == "" {
		return nil, errors.New("auth: need either HMAC secret or Supabase URL")
	}
	v := &JWTVerifier{
		hmacSecret: hmacSecret,
		jwksKeys:   map[string]any{},
	}
	if supabaseURL != "" {
		v.jwksURL = strings.TrimRight(supabaseURL, "/") + "/auth/v1/.well-known/jwks.json"
		// Try once at startup so a misconfiguration fails loudly. A
		// failure here isn't fatal (HMAC may still work) but we log so
		// ops can see it.
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = v.refreshJWKS(ctx)
	}
	return v, nil
}

// Verify parses and validates a token. Returns Claims on success or
// an error wrapping the reason. Refuses tokens with role !=
// 'authenticated' so anon-key callers can't slip past requireAuth.
func (v *JWTVerifier) Verify(raw string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(raw, &Claims{}, v.keyFunc, jwt.WithLeeway(30*time.Second))
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

// keyFunc resolves the verification key for a token, choosing between
// HMAC and JWKS-lookup based on the token's `alg` header.
func (v *JWTVerifier) keyFunc(t *jwt.Token) (any, error) {
	switch t.Method.(type) {
	case *jwt.SigningMethodHMAC:
		if len(v.hmacSecret) == 0 {
			return nil, errors.New("HS256 token but no HMAC secret configured")
		}
		return v.hmacSecret, nil
	case *jwt.SigningMethodECDSA:
		kid, _ := t.Header["kid"].(string)
		key, err := v.lookupJWK(kid)
		if err != nil {
			return nil, err
		}
		return key, nil
	default:
		return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
	}
}

// lookupJWK returns the cached EC public key for kid, refreshing the
// JWKS once if the kid is missing (handles key rotation without a
// restart).
func (v *JWTVerifier) lookupJWK(kid string) (*ecdsa.PublicKey, error) {
	v.jwksMu.RLock()
	if k, ok := v.jwksKeys[kid].(*ecdsa.PublicKey); ok {
		v.jwksMu.RUnlock()
		return k, nil
	}
	v.jwksMu.RUnlock()

	// Cache miss — refresh from the JWKS endpoint and try once more.
	// Rate-limit refreshes to one per 30 seconds so a malformed kid
	// doesn't DoS the auth server.
	v.jwksMu.Lock()
	if time.Since(v.jwksFetched) < 30*time.Second {
		v.jwksMu.Unlock()
		return nil, fmt.Errorf("unknown kid %q (refresh throttled)", kid)
	}
	v.jwksMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := v.refreshJWKS(ctx); err != nil {
		return nil, fmt.Errorf("jwks refresh: %w", err)
	}
	v.jwksMu.RLock()
	defer v.jwksMu.RUnlock()
	k, ok := v.jwksKeys[kid].(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("unknown kid %q after refresh", kid)
	}
	return k, nil
}

// jwksDoc is the on-the-wire JWKS shape — we only care about EC P-256.
type jwksDoc struct {
	Keys []struct {
		Kty string `json:"kty"`
		Kid string `json:"kid"`
		Crv string `json:"crv"`
		X   string `json:"x"`
		Y   string `json:"y"`
		Alg string `json:"alg"`
		Use string `json:"use"`
	} `json:"keys"`
}

func (v *JWTVerifier) refreshJWKS(ctx context.Context) error {
	if v.jwksURL == "" {
		return errors.New("no JWKS URL configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("jwks fetch %d: %s", resp.StatusCode, string(body))
	}
	var doc jwksDoc
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return fmt.Errorf("decode jwks: %w", err)
	}

	keys := map[string]any{}
	for _, k := range doc.Keys {
		if k.Kty != "EC" || k.Crv != "P-256" {
			continue // We only support ES256 / P-256 here.
		}
		x, errX := base64.RawURLEncoding.DecodeString(k.X)
		y, errY := base64.RawURLEncoding.DecodeString(k.Y)
		if errX != nil || errY != nil {
			continue
		}
		pub := &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(x),
			Y:     new(big.Int).SetBytes(y),
		}
		keys[k.Kid] = pub
	}
	v.jwksMu.Lock()
	v.jwksKeys = keys
	v.jwksFetched = time.Now()
	v.jwksMu.Unlock()
	return nil
}
