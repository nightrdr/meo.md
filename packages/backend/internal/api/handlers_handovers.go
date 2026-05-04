package api

import (
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/store"
)

// Handover endpoints implement the QR-driven device pairing flow.
// The handover_id IS the secret (16-byte CSPRNG, generated client-
// side). Anyone holding the id can read/write the row, which is
// exactly the bearer-token semantics the protocol requires — the
// server never knows whose pairing it is until B finalizes by writing
// to meo.devices via /devices.
//
// Routes are NOT behind requireAuth. The id is the auth.

func (s *Server) handoverCreate(c *gin.Context) {
	var req handoverCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.ID == "" || req.EkAPub == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id and ek_a_pub required"})
		return
	}
	pub, err := hex.DecodeString(req.EkAPub)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid hex"})
		return
	}
	if err := s.store.Handovers.Create(req.ID, pub); err != nil {
		if errors.Is(err, store.ErrConflict) {
			c.JSON(http.StatusConflict, gin.H{"error": "id already used"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "create failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handoverPutB(c *gin.Context) {
	id := c.Param("id")
	var req handoverPutBRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.EkBPub == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ek_b_pub required"})
		return
	}
	pub, err := hex.DecodeString(req.EkBPub)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid hex"})
		return
	}
	if err := s.store.Handovers.PutB(id, pub); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "expired or not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "put_b failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handoverPutPayload(c *gin.Context) {
	id := c.Param("id")
	var req handoverPutPayloadRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Payload == "" || req.Nonce == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload and payload_nonce required"})
		return
	}
	payload, e1 := hex.DecodeString(req.Payload)
	nonce, e2 := hex.DecodeString(req.Nonce)
	if e1 != nil || e2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid hex"})
		return
	}
	if err := s.store.Handovers.PutPayload(id, payload, nonce); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "expired or not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "put_payload failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handoverGet(c *gin.Context) {
	id := c.Param("id")
	h, err := s.store.Handovers.Get(id)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "expired or not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "get failed"})
		return
	}
	w := handoverWire{ExpiresAt: h.ExpiresAt.UTC().Format(time.RFC3339)}
	if h.EkAPub != nil {
		v := hex.EncodeToString(h.EkAPub)
		w.EkAPub = &v
	}
	if h.EkBPub != nil {
		v := hex.EncodeToString(h.EkBPub)
		w.EkBPub = &v
	}
	if h.PayloadForB != nil {
		v := hex.EncodeToString(h.PayloadForB)
		w.PayloadForB = &v
	}
	if h.PayloadNonce != nil {
		v := hex.EncodeToString(h.PayloadNonce)
		w.PayloadNonce = &v
	}
	c.JSON(http.StatusOK, w)
}

func (s *Server) handoverClear(c *gin.Context) {
	id := c.Param("id")
	if err := s.store.Handovers.Clear(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "clear failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
