package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func runUpgrade(args []string) error {
	version := ""
	if len(args) != 0 {
		if len(args) != 2 || args[0] != "--version" || !stableReleasePattern.MatchString(args[1]) {
			return fmt.Errorf("usage: bh upgrade [--version vX.Y.Z]")
		}
		version = args[1]
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	if reason := managedInstall(executable); reason != "" {
		return fmt.Errorf("%s", reason)
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	if version == "" {
		release, err := fetchLatestRelease(client, latestReleaseAPIURL)
		if err != nil {
			return err
		}
		version = release.TagName
		if !isNewerVersion(version, Version) {
			fmt.Printf("bh %s is up to date.\n", Version)
			return nil
		}
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return fmt.Errorf("no release available for %s", runtime.GOOS)
	}
	asset := fmt.Sprintf("bh_%s_%s_%s.tar.gz", version, runtime.GOOS, runtime.GOARCH)
	base := "https://github.com/finbarr/boxhaven/releases/download/" + version + "/"
	download := func(name string, limit int64) ([]byte, error) {
		response, err := client.Get(base + name)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("download %s: HTTP %d", name, response.StatusCode)
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > limit {
			return nil, fmt.Errorf("release asset exceeds size limit")
		}
		return data, nil
	}
	// Acquire the lock before downloading; keep staging on the executable's filesystem.
	lock := executable + ".upgrade-lock"
	if err := os.Mkdir(lock, 0700); err != nil {
		return fmt.Errorf("cannot lock %s for upgrade (check directory permissions or another upgrade): %w", executable, err)
	}
	defer os.RemoveAll(lock)
	sums, err := download("SHA256SUMS", 1<<20)
	if err != nil {
		return err
	}
	archive, err := download(asset, 128<<20)
	if err != nil {
		return err
	}
	staged := filepath.Join(lock, "bh")
	if err := stageUpgrade(archive, string(sums), asset, staged); err != nil {
		return err
	}
	output, err := exec.Command(staged, "version").Output()
	if err != nil {
		return fmt.Errorf("new executable failed its version check: %w", err)
	}
	if !strings.HasPrefix(string(output), "bh "+version+" (") {
		return fmt.Errorf("downloaded executable reported the wrong version")
	}
	if err := os.Rename(staged, executable); err != nil {
		return fmt.Errorf("could not replace bh; current executable is unchanged: %w", err)
	}
	fmt.Printf("Updated bh to %s at %s.\n", version, executable)
	return nil
}

func managedInstall(path string) string {
	path = filepath.ToSlash(path)
	if strings.Contains(path, "/Cellar/boxhaven/") {
		return "Homebrew manages this installation. Run: brew update && brew upgrade boxhaven"
	}
	if strings.Contains(path, ".app/Contents/") {
		return "This CLI belongs to the BoxHaven desktop app. Use Check for Updates in the app menu"
	}
	return ""
}

func stageUpgrade(archive []byte, sums, asset, destination string) error {
	digest := sha256.Sum256(archive)
	matches := 0
	for _, line := range strings.Split(sums, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == asset {
			matches++
			if fields[0] != hex.EncodeToString(digest[:]) {
				return fmt.Errorf("release checksum mismatch; existing bh is unchanged")
			}
		}
	}
	if matches != 1 {
		return fmt.Errorf("release must contain exactly one checksum for %s", asset)
	}
	reader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return err
	}
	defer reader.Close()
	tarball := tar.NewReader(reader)
	found := false
	for {
		header, err := tarball.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if header.Name != "bh" {
			continue
		}
		if found || header.Typeflag != tar.TypeReg || header.Size > 128<<20 {
			return fmt.Errorf("invalid bh executable in release archive")
		}
		found = true
		file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0755)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(file, tarball)
		syncErr := file.Sync()
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if !found {
		return fmt.Errorf("release archive has no bh executable")
	}
	return nil
}
