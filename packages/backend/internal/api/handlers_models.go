package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/models"
)

// listModelManifest returns the static catalogue with download_url
// rewritten to be absolute against the request's host. Public - no
// auth needed (manifest is the same for everyone, and clients hit
// this on first run before they have a token).
func (s *Server) listModelManifest(c *gin.Context) {
	if s.models == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "model service unavailable"})
		return
	}
	entries := s.models.All()
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	if h := c.GetHeader("X-Forwarded-Proto"); h != "" {
		scheme = h
	}
	base := fmt.Sprintf("%s://%s", scheme, c.Request.Host)
	for i := range entries {
		u := fmt.Sprintf("%s/models/%s/file", base, entries[i].ID)
		entries[i].DownloadURL = &u
	}
	c.JSON(http.StatusOK, gin.H{"models": entries})
}

// streamModelFile serves the binary with Range support so clients can
// resume large downloads. Public - model files are public artifacts.
//
// We rely on Gin's c.File which delegates to http.ServeContent and
// gets us If-Modified-Since + Range for free.
func (s *Server) streamModelFile(c *gin.Context) {
	if s.models == nil || s.modelStore == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "model service unavailable"})
		return
	}
	id := c.Param("id")
	if s.models.Get(id) == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown model id"})
		return
	}
	f, size, err := s.modelStore.Open(id)
	if errors.Is(err, models.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "model not uploaded yet"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "open failed"})
		return
	}
	defer f.Close()
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.bin"`, id))
	// http.ServeContent honors Range and sets Content-Length itself.
	st, err := f.Stat()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "stat failed"})
		return
	}
	_ = size
	http.ServeContent(c.Writer, c.Request, id+".bin", st.ModTime(), f)
}

// uploadModelFile receives an admin upload. multipart/form-data with
// field "file". On success we compute sha256 and either pin it to the
// catalogue (if the manifest hash was nil) or reject if it doesn't
// match the manifest's expected hash.
func (s *Server) uploadModelFile(c *gin.Context) {
	if s.models == nil || s.modelStore == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "model service unavailable"})
		return
	}
	if !s.checkAdminToken(c) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "admin token required"})
		return
	}
	id := c.Param("id")
	entry := s.models.Get(id)
	if entry == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown model id"})
		return
	}
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing 'file' multipart field"})
		return
	}
	src, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "open upload failed"})
		return
	}
	defer src.Close()

	h := sha256.New()
	n, err := s.modelStore.WriteFrom(id, src, h)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "write failed: " + err.Error()})
		return
	}
	gotHex := hex.EncodeToString(h.Sum(nil))

	// If the manifest pre-declared a sha256, enforce it.
	if entry.SHA256 != nil && *entry.SHA256 != "" {
		if gotHex != *entry.SHA256 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "sha256 mismatch",
				"want":  *entry.SHA256,
				"got":   gotHex,
			})
			return
		}
	} else {
		// Pin the hash for subsequent uploads.
		s.models.SetSHA256(id, gotHex)
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":         true,
		"id":         id,
		"size_bytes": n,
		"sha256":     gotHex,
	})
}

// checkAdminToken validates the Authorization: Bearer <token> header
// against the configured MEO_ADMIN_TOKEN. Returns true on match.
// If no admin token is configured, all writes are refused.
func (s *Server) checkAdminToken(c *gin.Context) bool {
	if s.adminToken == "" {
		return false
	}
	h := c.GetHeader("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || h[:len(prefix)] != prefix {
		return false
	}
	return h[len(prefix):] == s.adminToken
}

