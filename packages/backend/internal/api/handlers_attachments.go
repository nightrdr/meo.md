package api

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/store"
)

// createAttachment accepts JSON metadata + the encrypted blob (base64
// in `encrypted_content`). Why not multipart: keeps the handler
// simple and the desktop's encrypt-then-upload code path identical to
// the notes path. Browsers handle multi-MB base64 fine.
type attachmentCreateBody struct {
	ID                string `json:"id"`
	NoteID            string `json:"note_id"`
	Nonce             string `json:"nonce"`              // base64
	EncryptedMetadata string `json:"encrypted_metadata"` // base64
	MetadataNonce     string `json:"metadata_nonce"`     // base64
	EncryptedContent  string `json:"encrypted_content"`  // base64
}

func (s *Server) createAttachment(c *gin.Context) {
	var req attachmentCreateBody
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if req.ID == "" || req.NoteID == "" || req.Nonce == "" || req.EncryptedContent == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing fields"})
		return
	}
	nonce, e1 := base64.StdEncoding.DecodeString(req.Nonce)
	encMeta, e2 := base64.StdEncoding.DecodeString(req.EncryptedMetadata)
	metaNonce, e3 := base64.StdEncoding.DecodeString(req.MetadataNonce)
	blob, e4 := base64.StdEncoding.DecodeString(req.EncryptedContent)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid base64"})
		return
	}

	userID := claimsFor(c).Sub

	// Verify the user actually owns the note before stashing bytes.
	owns, err := s.store.Attachments.VerifyNoteOwnership(userID, req.NoteID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "ownership check failed"})
		return
	}
	if !owns {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	// Tier checks: per-attachment max + total workspace cap.
	sub, err := s.store.Subscriptions.Get(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "subscription lookup failed"})
		return
	}
	limits := store.Limits(sub.Tier)
	size := int64(len(blob))
	if size > limits.MaxAttachmentBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{
			"error": "attachment_too_large",
			"code":  "attachment_too_large",
			"max":   limits.MaxAttachmentBytes,
			"got":   size,
		})
		return
	}
	used, err := s.store.Attachments.TotalBytes(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "usage lookup failed"})
		return
	}
	if used+size > limits.StorageCapBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{
			"error": "storage_cap_exceeded",
			"code":  "storage_cap_exceeded",
			"cap":   limits.StorageCapBytes,
			"used":  used,
		})
		return
	}

	// Persist blob to disk under <attachmentDir>/<user>/<id>.bin.
	storageKey := filepath.ToSlash(filepath.Join(userID, req.ID+".bin"))
	full := filepath.Join(s.attachmentDir, storageKey)
	if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "disk init failed"})
		return
	}
	if err := os.WriteFile(full, blob, 0o600); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "disk write failed"})
		return
	}

	att, err := s.store.Attachments.Create(store.CreateInput{
		ID: req.ID, NoteID: req.NoteID, UserID: userID,
		StorageKey: storageKey, EncryptedSize: size,
		Nonce: nonce, EncryptedMetadata: encMeta, MetadataNonce: metaNonce,
	})
	if err != nil {
		// Roll back the on-disk write so we don't leak orphans.
		_ = os.Remove(full)
		if errors.Is(err, store.ErrConflict) {
			c.JSON(http.StatusConflict, gin.H{"error": "duplicate id"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "insert failed"})
		return
	}
	c.JSON(http.StatusOK, attachmentToWire(att))
}

// listAttachmentsByNote returns all rows for a given note, scoped to
// the requesting user.
func (s *Server) listAttachmentsByNote(c *gin.Context) {
	noteID := c.Param("note_id")
	rows, err := s.store.Attachments.ListByNote(claimsFor(c).Sub, noteID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	out := make([]attachmentWire, 0, len(rows))
	for _, a := range rows {
		out = append(out, attachmentToWire(a))
	}
	c.JSON(http.StatusOK, gin.H{"attachments": out})
}

// streamAttachment returns the raw encrypted bytes for the row.
// Range support gets us resumable downloads for free via http.ServeFile.
func (s *Server) streamAttachment(c *gin.Context) {
	id := c.Param("id")
	att, err := s.store.Attachments.Get(claimsFor(c).Sub, id)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lookup failed"})
		return
	}
	full := filepath.Join(s.attachmentDir, att.StorageKey)
	f, err := os.Open(full)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "blob missing"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "open failed"})
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "stat failed"})
		return
	}
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.bin"`, id))
	// http.ServeContent honours Range and sets Content-Length itself,
	// giving us resumable downloads for free.
	http.ServeContent(c.Writer, c.Request, st.Name(), st.ModTime(), f)
}

// deleteAttachment removes the row and the on-disk blob.
func (s *Server) deleteAttachment(c *gin.Context) {
	id := c.Param("id")
	key, err := s.store.Attachments.Delete(claimsFor(c).Sub, id)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	full := filepath.Join(s.attachmentDir, key)
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		// Log but don't surface — the row is gone, the user is
		// done. A janitor cleans orphaned blobs eventually.
		c.Set("warn_orphan_blob", err.Error())
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

