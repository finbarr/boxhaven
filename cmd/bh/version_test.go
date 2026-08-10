package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestComparableVersionAndOrdering(t *testing.T) {
	for _, test := range []struct {
		latest  string
		current string
		want    bool
	}{
		{latest: "0.10.0", current: "0.9.4", want: true},
		{latest: "v0.10.0", current: "v0.10.0-9-gabcdef", want: false},
		{latest: "0.10.0", current: "0.10.1", want: false},
		{latest: "0.10.0", current: "dev", want: true},
		{latest: "not-a-version", current: "0.9.0", want: false},
	} {
		if got := isNewerVersion(test.latest, test.current); got != test.want {
			t.Errorf("isNewerVersion(%q, %q) = %t, want %t", test.latest, test.current, got, test.want)
		}
	}
	if got := comparableVersion("v1.2.3-4-gabcdef"); got != "v1.2.3" {
		t.Fatalf("comparableVersion() = %q, want v1.2.3", got)
	}
}

func TestCheckForUpdatesUsesCacheAndRefreshesOnlyWhenStale(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	path, err := versionCachePath()
	if err != nil {
		t.Fatal(err)
	}
	oldVersion := Version
	oldStarter := startBackgroundVersionCheck
	Version = "v0.1.0"
	t.Cleanup(func() {
		Version = oldVersion
		startBackgroundVersionCheck = oldStarter
	})

	refreshes := 0
	startBackgroundVersionCheck = func() { refreshes++ }
	cache := versionCache{
		LatestVersion: "0.2.0",
		ReleaseURL:    "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0",
		CheckedAt:     time.Now(),
	}
	if err := writeVersionCache(path, cache); err != nil {
		t.Fatal(err)
	}
	output := captureStderr(t, checkForUpdates)
	if refreshes != 0 {
		t.Fatalf("fresh cache started %d background refreshes", refreshes)
	}
	for _, want := range []string{"newer bh release", "v0.2.0", "current v0.1.0", cache.ReleaseURL} {
		if !strings.Contains(output, want) {
			t.Fatalf("cached notice missing %q:\n%s", want, output)
		}
	}

	cache.CheckedAt = time.Now().Add(-versionCheckInterval - time.Minute)
	if err := writeVersionCache(path, cache); err != nil {
		t.Fatal(err)
	}
	output = captureStderr(t, checkForUpdates)
	if refreshes != 1 {
		t.Fatalf("stale cache started %d background refreshes, want 1", refreshes)
	}
	if !strings.Contains(output, "v0.2.0") {
		t.Fatalf("stale cached update should remain visible while refreshing:\n%s", output)
	}
}

func TestCheckForUpdatesWithoutCacheStartsSilently(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	oldStarter := startBackgroundVersionCheck
	t.Cleanup(func() { startBackgroundVersionCheck = oldStarter })
	refreshes := 0
	startBackgroundVersionCheck = func() { refreshes++ }

	output := captureStderr(t, checkForUpdates)
	if output != "" {
		t.Fatalf("uncached check printed output: %q", output)
	}
	if refreshes != 1 {
		t.Fatalf("uncached check started %d background refreshes, want 1", refreshes)
	}
}

func TestRefreshVersionCacheUsesGitHubReleaseMetadata(t *testing.T) {
	checkedAt := time.Date(2026, time.August, 10, 12, 0, 0, 0, time.UTC)
	var accept, userAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accept = r.Header.Get("Accept")
		userAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"v0.2.0","html_url":"https://github.com/finbarr/boxhaven/releases/tag/v0.2.0"}`))
	}))
	t.Cleanup(server.Close)

	path := filepath.Join(t.TempDir(), "nested", "version-check.json")
	if err := refreshVersionCache(path, server.Client(), server.URL, checkedAt); err != nil {
		t.Fatal(err)
	}
	cache, err := readVersionCache(path)
	if err != nil {
		t.Fatal(err)
	}
	if cache.LatestVersion != "0.2.0" || cache.ReleaseURL != "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0" || !cache.CheckedAt.Equal(checkedAt) {
		t.Fatalf("unexpected cache: %#v", cache)
	}
	if accept != "application/vnd.github+json" {
		t.Fatalf("Accept = %q", accept)
	}
	if !strings.HasPrefix(userAgent, "BoxHaven-bh/") {
		t.Fatalf("User-Agent = %q", userAgent)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("cache mode = %o, want 644", info.Mode().Perm())
	}
}

func TestRefreshVersionCacheLeavesExistingCacheOnFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "offline", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)

	path := filepath.Join(t.TempDir(), "version-check.json")
	original := versionCache{LatestVersion: "0.2.0", ReleaseURL: "https://example.com/release", CheckedAt: time.Now().Add(-48 * time.Hour)}
	if err := writeVersionCache(path, original); err != nil {
		t.Fatal(err)
	}
	if err := refreshVersionCache(path, server.Client(), server.URL, time.Now()); err == nil {
		t.Fatal("refreshVersionCache() succeeded for HTTP 503")
	}
	cache, err := readVersionCache(path)
	if err != nil {
		t.Fatal(err)
	}
	if cache.LatestVersion != original.LatestVersion || cache.ReleaseURL != original.ReleaseURL || !cache.CheckedAt.Equal(original.CheckedAt) {
		t.Fatalf("failed refresh changed cache: %#v", cache)
	}
}

func TestReleaseURLStaysOnBoxHavenRepository(t *testing.T) {
	got := releaseURL(githubRelease{TagName: "v0.2.0", HTMLURL: "https://example.com/not-boxhaven"})
	if got != "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0" {
		t.Fatalf("releaseURL() = %q", got)
	}
}

func TestVersionCacheRejectsFutureChecks(t *testing.T) {
	cache := versionCache{
		LatestVersion: "0.2.0",
		ReleaseURL:    "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0",
		CheckedAt:     time.Now().Add(time.Hour),
	}
	if versionCacheUsable(cache, time.Now()) {
		t.Fatal("cache with a future check time should be refreshed")
	}
}
