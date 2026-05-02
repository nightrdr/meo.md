package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/auth"
	"meo.md/backend/internal/store"
)

// signup creates a new user. Mirrors the TS path:
//   - body must have email + password (≥ 8 chars)
//   - 409 on duplicate email
func (s *Server) signup(c *gin.Context) {
	var req signupRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Email == "" || req.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and password required"})
		return
	}
	if len(req.Password) < 8 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password too short"})
		return
	}
	hash, err := s.hasher.Hash(req.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "hash failed"})
		return
	}
	id, err := newUUID()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "uuid failed"})
		return
	}
	if err := s.users.Create(id, req.Email, hash); err != nil {
		if errors.Is(err, store.ErrConflict) {
			c.JSON(http.StatusConflict, gin.H{"error": "email already registered"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "create user failed"})
		return
	}
	c.JSON(http.StatusOK, signupResponse{UserID: id})
}

// login verifies credentials and returns a JWT + has_account flag.
// Note: returns 401 on both unknown email and bad password — never
// distinguish, to avoid email enumeration.
func (s *Server) login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Email == "" || req.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and password required"})
		return
	}
	u, err := s.users.FindByEmail(req.Email)
	if err != nil || !s.hasher.Verify(req.Password, u.PasswordHash) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	hasAccount, err := s.accounts.Exists(u.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lookup failed"})
		return
	}
	token, err := s.signer.Sign(u.ID, u.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "sign failed"})
		return
	}
	c.JSON(http.StatusOK, loginResponse{JWT: token, HasAccount: hasAccount, UserID: u.ID})
}

// claimsFor pulls the verified JWT claims out of the context. Called
// from every authed handler. Asserts because requireAuth would have
// short-circuited if the value were missing.
func claimsFor(c *gin.Context) *auth.Claims {
	return c.MustGet(claimsKey).(*auth.Claims)
}

// newUUID returns a v4-style UUID string. Avoids a dependency on
// google/uuid for one call site — generates 16 random bytes and
// formats them with the version + variant bits set.
func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	hexStr := hex.EncodeToString(b)
	return hexStr[0:8] + "-" + hexStr[8:12] + "-" + hexStr[12:16] + "-" + hexStr[16:20] + "-" + hexStr[20:32], nil
}
