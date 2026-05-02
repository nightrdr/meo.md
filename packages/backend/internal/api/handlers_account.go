package api

import (
	"encoding/base64"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/store"
)

// getAccount returns the encrypted-master-key wrapper for the
// authenticated user. Pure pass-through: server never decrypts.
func (s *Server) getAccount(c *gin.Context) {
	a, err := s.accounts.Get(claimsFor(c).Sub)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "no account"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lookup failed"})
		return
	}
	c.JSON(http.StatusOK, accountResponse{
		Salt:               base64.StdEncoding.EncodeToString(a.Salt),
		EncryptedMasterKey: base64.StdEncoding.EncodeToString(a.EncryptedMasterKey),
		MasterKeyNonce:     base64.StdEncoding.EncodeToString(a.MasterKeyNonce),
		KDFParams:          rawJSONPayload(a.KDFParamsJSON),
	})
}

// putAccount stores the wrapper. One-shot per user — re-init has to
// go through a separate (un)wrap-and-rewrap flow.
func (s *Server) putAccount(c *gin.Context) {
	var req accountRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if req.Salt == "" || req.EncryptedMasterKey == "" || req.MasterKeyNonce == "" || len(req.KDFParams) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing fields"})
		return
	}
	salt, err1 := base64.StdEncoding.DecodeString(req.Salt)
	emk, err2 := base64.StdEncoding.DecodeString(req.EncryptedMasterKey)
	mkn, err3 := base64.StdEncoding.DecodeString(req.MasterKeyNonce)
	if err1 != nil || err2 != nil || err3 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid base64"})
		return
	}

	err := s.accounts.Create(&store.Account{
		UserID:             claimsFor(c).Sub,
		Salt:               salt,
		EncryptedMasterKey: emk,
		MasterKeyNonce:     mkn,
		KDFParamsJSON:      string(req.KDFParams),
	})
	if errors.Is(err, store.ErrConflict) {
		c.JSON(http.StatusConflict, gin.H{"error": "account already initialized"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "insert failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
