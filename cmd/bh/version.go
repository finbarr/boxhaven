package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	backgroundVersionCheckCommand = "__check-for-updates"
	latestReleaseAPIURL           = "https://api.github.com/repos/finbarr/boxhaven/releases/latest"
	versionCheckInterval          = 24 * time.Hour
)

var versionPattern = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)`)
var startBackgroundVersionCheck = startBackgroundVersionCheckProcess

type versionCache struct {
	LatestVersion string    `json:"latest_version"`
	ReleaseURL    string    `json:"release_url"`
	CheckedAt     time.Time `json:"checked_at"`
}

type githubRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
}

func versionCachePath() (string, error) {
	configPath, err := globalConfigPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(configPath), "version-check.json"), nil
}

// checkForUpdates only reads local state and starts a background process when
// that state is stale. A normal command never waits for the network request.
func checkForUpdates() {
	path, err := versionCachePath()
	if err != nil {
		return
	}

	cache, cacheErr := readVersionCache(path)
	if cacheErr == nil {
		showUpdateMessage(cache)
		if versionCacheUsable(cache, time.Now()) {
			return
		}
	}

	startBackgroundVersionCheck()
}

func startBackgroundVersionCheckProcess() {
	executable, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command(executable, backgroundVersionCheckCommand)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return
	}
	go func() {
		_ = cmd.Wait()
	}()
}

func runBackgroundVersionCheck() {
	path, err := versionCachePath()
	if err != nil {
		return
	}
	client := &http.Client{Timeout: 5 * time.Second}
	_ = refreshVersionCache(path, client, latestReleaseAPIURL, time.Now())
}

func refreshVersionCache(path string, client *http.Client, apiURL string, checkedAt time.Time) error {
	release, err := fetchLatestRelease(client, apiURL)
	if err != nil {
		return err
	}
	latestVersion := latestVersionFromRelease(release)
	if comparableVersion(latestVersion) == "" {
		return fmt.Errorf("latest release is missing a semantic version tag")
	}
	return writeVersionCache(path, versionCache{
		LatestVersion: latestVersion,
		ReleaseURL:    releaseURL(release),
		CheckedAt:     checkedAt,
	})
}

func fetchLatestRelease(client *http.Client, apiURL string) (githubRelease, error) {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
	if err != nil {
		return githubRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "BoxHaven-bh/"+Version)
	resp, err := client.Do(req)
	if err != nil {
		return githubRelease{}, err
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		return githubRelease{}, fmt.Errorf("latest release request returned HTTP %d", resp.StatusCode)
	}
	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return githubRelease{}, err
	}
	return release, nil
}

func readVersionCache(path string) (versionCache, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return versionCache{}, err
	}
	var cache versionCache
	if err := json.Unmarshal(data, &cache); err != nil {
		return versionCache{}, err
	}
	return cache, nil
}

func writeVersionCache(path string, cache versionCache) error {
	data, err := json.Marshal(cache)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".version-check-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = os.Remove(tmpPath)
	}()
	if err := tmp.Chmod(0644); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func versionCacheUsable(cache versionCache, now time.Time) bool {
	return comparableVersion(cache.LatestVersion) != "" &&
		cache.ReleaseURL != "" &&
		!cache.CheckedAt.IsZero() &&
		!cache.CheckedAt.After(now) &&
		now.Sub(cache.CheckedAt) < versionCheckInterval
}

func latestVersionFromRelease(release githubRelease) string {
	return strings.TrimPrefix(strings.TrimSpace(release.TagName), "v")
}

func releaseURL(release githubRelease) string {
	const releasePrefix = "https://github.com/finbarr/boxhaven/releases/"
	if strings.HasPrefix(release.HTMLURL, releasePrefix) {
		return release.HTMLURL
	}
	version := comparableVersion(latestVersionFromRelease(release))
	if version == "" {
		return "https://github.com/finbarr/boxhaven/releases"
	}
	return "https://github.com/finbarr/boxhaven/releases/tag/" + version
}

func showUpdateMessage(cache versionCache) {
	if !isNewerVersion(cache.LatestVersion, Version) {
		return
	}
	current := comparableVersion(Version)
	if current == "" {
		current = Version
	}
	fmt.Fprintf(os.Stderr, "\nA newer bh release is available: %s (current %s). %s\n\n", comparableVersion(cache.LatestVersion), current, cache.ReleaseURL)
}

func comparableVersion(version string) string {
	match := versionPattern.FindStringSubmatch(strings.TrimSpace(version))
	if len(match) != 4 {
		return ""
	}
	return "v" + strings.Join(match[1:], ".")
}

func isNewerVersion(latestVersion, currentVersion string) bool {
	latest := comparableVersion(latestVersion)
	if latest == "" {
		return false
	}
	current := comparableVersion(currentVersion)
	if current == "" {
		return true
	}
	return compareSemver(latest, current) > 0
}

func compareSemver(a, b string) int {
	parse := func(version string) [3]int {
		match := versionPattern.FindStringSubmatch(version)
		var parts [3]int
		for i := range parts {
			if len(match) > i+1 {
				parts[i], _ = strconv.Atoi(match[i+1])
			}
		}
		return parts
	}
	av := parse(a)
	bv := parse(b)
	for i := range av {
		if av[i] < bv[i] {
			return -1
		}
		if av[i] > bv[i] {
			return 1
		}
	}
	return 0
}
