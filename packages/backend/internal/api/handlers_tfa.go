package api

import (
	"encoding/base64"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/store"
)

// tfaStatus reports whether the user has 2FA enabled.
func (s *Server) tfaStatus(c *gin.Context) {
	on, err := s.store.TFA.Status(claimsFor(c).Sub)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lookup failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"enabled": on})
}

// tfaEnroll persists the user's encrypted TOTP secret. The desktop
// generates the secret + QR client-side; the server only stores
// ciphertext so multi-device users can re-derive after pairing.
func (s *Server) tfaEnroll(c *gin.Context) {
	var req tfaEnrollRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.SecretEnc == "" || req.SecretNonce == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "secret_enc and secret_nonce required"})
		return
	}
	enc, e1 := base64.StdEncoding.DecodeString(req.SecretEnc)
	nonce, e2 := base64.StdEncoding.DecodeString(req.SecretNonce)
	if e1 != nil || e2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid base64"})
		return
	}
	if err := s.store.TFA.Enroll(claimsFor(c).Sub, enc, nonce); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "enroll failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// tfaGetSecret returns the stored encrypted secret so a paired device
// can re-derive the TOTP locally without re-enrolling.
func (s *Server) tfaGetSecret(c *gin.Context) {
	t, err := s.store.TFA.GetSecret(claimsFor(c).Sub)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "no 2fa enrolled"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lookup failed"})
		return
	}
	c.JSON(http.StatusOK, tfaSecretResponse{
		SecretEnc:   base64.StdEncoding.EncodeToString(t.SecretEnc),
		SecretNonce: base64.StdEncoding.EncodeToString(t.SecretNonce),
		Enabled:     t.Enabled,
	})
}

// tfaDisable flips the enabled flag without wiping the secret. Future
// re-enable is then a one-flip toggle; "remove 2FA" goes through delete.
func (s *Server) tfaDisable(c *gin.Context) {
	if err := s.store.TFA.Disable(claimsFor(c).Sub); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no 2fa enrolled"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "disable failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// tfaDelete wipes the secret entirely. The user goes back to no-2FA.
func (s *Server) tfaDelete(c *gin.Context) {
	if err := s.store.TFA.Delete(claimsFor(c).Sub); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
