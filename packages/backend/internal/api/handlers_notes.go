package api

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/store"
)

// syncNotes returns every note for the user with version > since.
// Cursor in the response is the highest version seen, or `since` if
// nothing came back — clients persist this and pass it on the next
// poll.
func (s *Server) syncNotes(c *gin.Context) {
	since, _ := strconv.ParseInt(c.DefaultQuery("since", "0"), 10, 64)
	rows, err := s.notes.ListSince(claimsFor(c).Sub, since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "sync failed"})
		return
	}
	out := make([]noteWire, 0, len(rows))
	cursor := since
	for _, r := range rows {
		out = append(out, noteToWire(r))
		if r.Version > cursor {
			cursor = r.Version
		}
	}
	c.JSON(http.StatusOK, syncResponse{Notes: out, Cursor: cursor})
}

// upsertNote is the create-or-update path. Behavior:
//   - 400 if any required field is missing or unparseable
//   - 403 if the note id exists under a different user
//   - 409 if the incoming HLC is not strictly greater than stored
//     (returns the current row in `current` so the client can refresh)
//   - 200 with the saved row otherwise
func (s *Server) upsertNote(c *gin.Context) {
	var req upsertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if req.ID == "" || req.EncryptedContent == "" || req.Nonce == "" || req.HLCTimestamp == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing fields"})
		return
	}
	ct, err1 := base64.StdEncoding.DecodeString(req.EncryptedContent)
	nonce, err2 := base64.StdEncoding.DecodeString(req.Nonce)
	if err1 != nil || err2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid base64"})
		return
	}

	saved, err := s.notes.Upsert(claimsFor(c).Sub, s.sync, store.UpsertInput{
		ID: req.ID, EncryptedContent: ct, Nonce: nonce, HLCTimestamp: req.HLCTimestamp,
	})
	switch {
	case errors.Is(err, store.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
	case errors.Is(err, store.ErrStaleWrite):
		// Re-read so the client gets the current row in the same
		// response — saves a round trip on the conflict-resolve path.
		current, getErr := s.notes.Get(req.ID)
		if getErr != nil {
			c.JSON(http.StatusConflict, gin.H{"error": "stale write"})
			return
		}
		c.JSON(http.StatusConflict, staleConflictResponse{
			Error: "stale write", Current: noteToWire(current),
		})
	case err != nil:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed"})
	default:
		c.JSON(http.StatusOK, noteToWire(saved))
	}
}

// deleteNote tombstones the note (deleted_at = now, version bump) so
// other devices learn about the removal via the sync poll.
func (s *Server) deleteNote(c *gin.Context) {
	id := c.Param("id")
	saved, err := s.notes.Tombstone(claimsFor(c).Sub, id, s.sync)
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	case errors.Is(err, store.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
	case err != nil:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
	default:
		c.JSON(http.StatusOK, noteToWire(saved))
	}
}
