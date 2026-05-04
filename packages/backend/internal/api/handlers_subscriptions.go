package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/store"
)

// getSubscription returns the user's tier + billing fields. Falls
// back to a synthesized 'free' row when no record exists.
func (s *Server) getSubscription(c *gin.Context) {
	sub, err := s.store.Subscriptions.Get(claimsFor(c).Sub)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lookup failed"})
		return
	}
	c.JSON(http.StatusOK, subscriptionToWire(sub))
}

// getStorageUsage returns the user's bytes-used + tier caps. The desktop
// uses this to display a "X% of Y GB" bar in Settings → Storage and to
// pre-flight attachment uploads.
func (s *Server) getStorageUsage(c *gin.Context) {
	userID := claimsFor(c).Sub
	att, err := s.store.Attachments.TotalBytes(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "att total failed"})
		return
	}
	notes, err := s.store.Attachments.NoteSizeBytes(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "note total failed"})
		return
	}
	sub, err := s.store.Subscriptions.Get(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "subscription lookup failed"})
		return
	}
	limits := store.Limits(sub.Tier)
	c.JSON(http.StatusOK, storageUsageResponse{
		AttachmentBytes:    att,
		NoteBytes:          notes,
		TotalBytes:         att + notes,
		CapBytes:           limits.StorageCapBytes,
		MaxAttachmentBytes: limits.MaxAttachmentBytes,
	})
}
