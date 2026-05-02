package models

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadCatalogueEmbedded(t *testing.T) {
	cat, err := LoadCatalogue("")
	if err != nil {
		t.Fatalf("load embedded: %v", err)
	}
	all := cat.All()
	if len(all) == 0 {
		t.Fatal("expected at least one entry in the embedded manifest")
	}
	// Spot-check a known entry from the seed list.
	if got := cat.Get("qwen2.5-1.5b-q4"); got == nil {
		t.Fatal("expected qwen2.5-1.5b-q4 in catalogue")
	} else if got.Family != "qwen" {
		t.Errorf("qwen2.5-1.5b-q4 family = %q, want qwen", got.Family)
	}
	if cat.Get("does-not-exist") != nil {
		t.Error("Get(unknown) should return nil")
	}
}

func TestStoreWriteAndOpen(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	// Initial Open should report ErrNotFound.
	if _, _, err := s.Open("foo"); err != ErrNotFound {
		t.Errorf("Open before write: err = %v, want ErrNotFound", err)
	}

	payload := []byte("hello, models!")
	h := sha256.New()
	n, err := s.WriteFrom("foo", bytes.NewReader(payload), h)
	if err != nil {
		t.Fatalf("WriteFrom: %v", err)
	}
	if n != int64(len(payload)) {
		t.Errorf("WriteFrom n = %d, want %d", n, len(payload))
	}
	// Sanity-check: our hash matches a fresh sha256 of the same bytes.
	gotHex := hex.EncodeToString(h.Sum(nil))
	digest := sha256.Sum256(payload)
	wantHex := hex.EncodeToString(digest[:])
	if gotHex != wantHex {
		t.Errorf("WriteFrom hash mismatch: got %s want %s", gotHex, wantHex)
	}

	// Open after write.
	f, size, err := s.Open("foo")
	if err != nil {
		t.Fatalf("Open after write: %v", err)
	}
	defer f.Close()
	if size != int64(len(payload)) {
		t.Errorf("Open size = %d, want %d", size, len(payload))
	}
	got, _ := io.ReadAll(f)
	if !bytes.Equal(got, payload) {
		t.Errorf("read back = %q, want %q", got, payload)
	}

	// File should be at the expected path.
	if _, err := os.Stat(filepath.Join(dir, "foo.bin")); err != nil {
		t.Errorf("expected foo.bin on disk: %v", err)
	}

	// SetSHA256 should round-trip via Get.
	cat, err := LoadCatalogue("")
	if err != nil {
		t.Fatalf("LoadCatalogue: %v", err)
	}
	hexStr := gotHex
	if !cat.SetSHA256("qwen2.5-1.5b-q4", hexStr) {
		t.Fatal("SetSHA256 returned false for known id")
	}
	if got := cat.Get("qwen2.5-1.5b-q4"); got == nil || got.SHA256 == nil || *got.SHA256 != hexStr {
		t.Errorf("after SetSHA256, sha256 not round-tripped")
	}
}
