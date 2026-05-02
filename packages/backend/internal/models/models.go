// Package models hosts the on-device LLM file catalogue and the
// helpers the HTTP layer needs to serve / accept uploads of those
// files.
//
// Wire shape:
//
//	GET  /models/manifest    -> JSON list of available models
//	GET  /models/:id/file    -> stream the GGUF/ONNX bytes (Range OK)
//	POST /models/:id/upload  -> admin-only ingest, sha256-verified
//
// We intentionally keep the catalogue as a static JSON file checked
// into the repo so we can ship without a real CDN: the binary serves
// the file straight off disk from MEO_MODEL_DIR.
package models

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// ManifestEntry mirrors the JSON shape on disk. download_url is left
// as "" in the file and filled in dynamically by the HTTP layer (it's
// a self-referential URL that depends on the listening base URL).
type ManifestEntry struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Family      string   `json:"family"`
	Params      string   `json:"params"`
	Quant       string   `json:"quant"`
	SizeBytes   int64    `json:"size_bytes"`
	SHA256      *string  `json:"sha256"`
	DownloadURL *string  `json:"download_url"`
	DefaultFor  []string `json:"default_for"`
}

//go:embed manifest.json
var embeddedManifest embed.FS

// Catalogue is the in-memory copy of the manifest. Loaded once from
// the embedded file (or from disk if MEO_MODEL_MANIFEST overrides),
// then handed out as a deep copy on each request so callers can
// mutate fields like DownloadURL without racing each other.
type Catalogue struct {
	mu      sync.RWMutex
	entries []ManifestEntry
}

// LoadCatalogue resolves the manifest. If `manifestPath` is empty we
// use the embedded copy that ships with the binary. Otherwise we
// read from disk so ops can hot-swap without a redeploy.
func LoadCatalogue(manifestPath string) (*Catalogue, error) {
	var raw []byte
	var err error
	if manifestPath != "" {
		raw, err = os.ReadFile(manifestPath)
	} else {
		raw, err = embeddedManifest.ReadFile("manifest.json")
	}
	if err != nil {
		return nil, fmt.Errorf("load manifest: %w", err)
	}
	var entries []ManifestEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	return &Catalogue{entries: entries}, nil
}

// All returns a copy of every entry. Caller is free to mutate.
func (c *Catalogue) All() []ManifestEntry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]ManifestEntry, len(c.entries))
	copy(out, c.entries)
	return out
}

// Get returns a single entry by id. nil if unknown.
func (c *Catalogue) Get(id string) *ManifestEntry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for i := range c.entries {
		if c.entries[i].ID == id {
			e := c.entries[i]
			return &e
		}
	}
	return nil
}

// SetSHA256 updates the expected hash for a model. Used after an
// admin upload computes the real hash so subsequent uploads can be
// verified. In-memory only — the JSON file on disk is the source of
// truth for what's *expected*; SetSHA256 is a runtime override for
// dev / first-time-population workflows.
func (c *Catalogue) SetSHA256(id, hex string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.entries {
		if c.entries[i].ID == id {
			c.entries[i].SHA256 = &hex
			return true
		}
	}
	return false
}

// ─── File storage ────────────────────────────────────────────────────

// Store knows how to read and write the binary files referenced by
// the catalogue. The on-disk layout is:
//
//	<root>/<id>.bin
//
// We don't preserve original filenames because the manifest is the
// source of truth — the client only ever sees /models/<id>/file.
type Store struct {
	root string
}

// ErrNotFound is returned when a requested model file isn't on disk.
var ErrNotFound = errors.New("model file not found")

// NewStore creates the directory if it doesn't exist.
func NewStore(root string) (*Store, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("model dir: %w", err)
	}
	return &Store{root: root}, nil
}

// Path returns the absolute path where this id's binary lives.
// Callers should treat this as opaque — the format is internal.
func (s *Store) Path(id string) string {
	return filepath.Join(s.root, id+".bin")
}

// Open returns a read-only handle to the file plus its size. Caller
// closes. Returns ErrNotFound if the file isn't there.
func (s *Store) Open(id string) (*os.File, int64, error) {
	f, err := os.Open(s.Path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, 0, ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, st.Size(), nil
}

// WriteFrom streams `r` into a temp file, computes sha256 along the
// way, and renames to the final path on close. This avoids serving a
// half-written file and lets the caller verify the hash before
// committing.
func (s *Store) WriteFrom(id string, r io.Reader, hash io.Writer) (int64, error) {
	tmp, err := os.CreateTemp(s.root, id+".*.tmp")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	defer func() {
		// best-effort cleanup if rename never fires
		os.Remove(tmpName)
	}()

	w := io.MultiWriter(tmp, hash)
	n, err := io.Copy(w, r)
	if err != nil {
		tmp.Close()
		return n, err
	}
	if err := tmp.Close(); err != nil {
		return n, err
	}
	if err := os.Rename(tmpName, s.Path(id)); err != nil {
		return n, err
	}
	return n, nil
}
