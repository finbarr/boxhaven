package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestUpgradeIntegrityAndInstallOwnership(t *testing.T) {
	for _, p := range []string{"/opt/homebrew/Cellar/boxhaven/0.1/bin/bh", "/Applications/BoxHaven.app/Contents/Resources/app/bin/bh"} {
		if managedInstall(p) == "" {
			t.Fatalf("managed installation accepted: %s", p)
		}
	}
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	contents := []byte("verified executable")
	if err := tw.WriteHeader(&tar.Header{Name: "bh", Typeflag: tar.TypeReg, Size: int64(len(contents)), Mode: 0755}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	sums := fmt.Sprintf("%x  archive.tar.gz\n", sha256.Sum256(b.Bytes()))
	dest := filepath.Join(t.TempDir(), "bh")
	if err := stageUpgrade(b.Bytes(), sums, "archive.tar.gz", dest); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || !bytes.Equal(got, contents) {
		t.Fatalf("staged executable: %s %v", got, err)
	}
	for _, sum := range []string{"bad  archive.tar.gz", sums + sums, ""} {
		if err := stageUpgrade(b.Bytes(), sum, "archive.tar.gz", filepath.Join(t.TempDir(), "bh")); err == nil {
			t.Fatal("bad checksum accepted")
		}
	}
}
