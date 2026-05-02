// Package auth handles password hashing and JWT signing.
//
// Two structs, two responsibilities, both injected as interfaces into
// the API layer:
//
//   - Hasher    — scrypt-based password hash, format-compatible with
//                 the TypeScript node:crypto/scrypt output so existing
//                 password_hash rows decode.
//   - JWTSigner — HS256 JWT, base64url(no-pad) parts, identical wire
//                 format to the TS server.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"
)

// scrypt parameters — must match the TS server (src/auth.ts).
// Changing them invalidates every existing password hash unless we
// store the params alongside (which the format string already does
// for the active value, so a future bump is a non-event).
const (
	scryptN = 16384
	scryptR = 8
	scryptP = 1
	keyLen  = 32
)

// Hasher hashes and verifies passwords. Stateless — kept as a struct
// purely so the API layer takes a value, not a free function. Makes
// testing with a fake hasher trivial.
type Hasher struct{}

// NewHasher returns a Hasher with the production parameters.
func NewHasher() *Hasher { return &Hasher{} }

// Hash returns a self-describing scrypt hash of `password` in the
// format `scrypt$N$r$p$saltb64$keyb64`. The format is byte-identical
// to what the TS server produces, so a hash from one is verifiable by
// the other.
func (h *Hasher) Hash(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, keyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("scrypt$%d$%d$%d$%s$%s",
		scryptN, scryptR, scryptP,
		base64.StdEncoding.EncodeToString(salt),
		base64.StdEncoding.EncodeToString(key),
	), nil
}

// Verify constant-time-compares `password` against `stored`. Reads
// the params out of the stored hash so a future bump (e.g. N=32768)
// still verifies the old rows.
func (h *Hasher) Verify(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return false
	}
	N, err1 := strconv.Atoi(parts[1])
	r, err2 := strconv.Atoi(parts[2])
	p, err3 := strconv.Atoi(parts[3])
	if err1 != nil || err2 != nil || err3 != nil {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	expected, err := base64.StdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	actual, err := scrypt.Key([]byte(password), salt, N, r, p, len(expected))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(expected, actual) == 1
}

// ErrBadHash is reserved for future use (e.g. distinguishing parse
// failure from mismatch in callers that care). Verify currently only
// returns bool — keeping an error surface here so the interface stays
// extensible without breaking callers.
var ErrBadHash = errors.New("bad password hash format")
