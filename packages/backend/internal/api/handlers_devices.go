package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/store"
)

// listDevices returns the user's registered devices.
func (s *Server) listDevices(c *gin.Context) {
	rows, err := s.store.Devices.List(claimsFor(c).Sub)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	out := make([]deviceWire, 0, len(rows))
	for _, d := range rows {
		out = append(out, deviceToWire(d))
	}
	c.JSON(http.StatusOK, gin.H{"devices": out})
}

// registerDevice upserts the row for (user, device_id). Enforces the
// per-tier device cap before accepting a new device — re-registration
// of an existing device_id always succeeds (it's a heartbeat).
func (s *Server) registerDevice(c *gin.Context) {
	var req deviceRegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.DeviceID == "" || req.Platform == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "device_id and platform required"})
		return
	}
	userID := claimsFor(c).Sub

	// Tier-cap check: only when this is a NEW device. A re-register
	// for an existing device_id is a heartbeat, not a new install.
	exists, err := s.store.Devices.HasDevice(userID, req.DeviceID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lookup failed"})
		return
	}
	if !exists {
		sub, err := s.store.Subscriptions.Get(userID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "subscription lookup failed"})
			return
		}
		limit := store.Limits(sub.Tier).DeviceCap
		count, err := s.store.Devices.Count(userID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "count failed"})
			return
		}
		if count >= limit {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error": "device_cap_exceeded",
				"code":  "device_cap_exceeded",
				"limit": limit,
				"count": count,
			})
			return
		}
	}

	name := req.Name
	if name == "" {
		name = "Unnamed device"
	}
	ip := c.ClientIP()
	var ipPtr *string
	if ip != "" {
		ipPtr = &ip
	}
	if err := s.store.Devices.Register(userID, req.DeviceID, req.Platform, name, req.UA, ipPtr); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "register failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// revokeDevice deletes the (user, device_id) row.
func (s *Server) revokeDevice(c *gin.Context) {
	id := c.Param("device_id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "device_id required"})
		return
	}
	if err := s.store.Devices.Revoke(claimsFor(c).Sub, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "revoke failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
