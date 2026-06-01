package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRemoteName(t *testing.T) {
	valid := []string{"dev", "agent-1", "boxhaven"}
	for _, name := range valid {
		if err := validateRemoteName(name); err != nil {
			t.Fatalf("validateRemoteName(%q) returned %v", name, err)
		}
	}

	invalid := []string{"", "-dev", "Dev", "dev_", "dev-"}
	for _, name := range invalid {
		if err := validateRemoteName(name); err == nil {
			t.Fatalf("validateRemoteName(%q) unexpectedly passed", name)
		}
	}
}

func TestConfigPathsUseBoxHaven(t *testing.T) {
	temp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", temp)
	path, err := globalConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(temp, "boxhaven", "config.toml")
	if path != want {
		t.Fatalf("globalConfigPath() = %q, want %q", path, want)
	}
}

func TestSaveAndLoadGlobalConfig(t *testing.T) {
	temp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", temp)
	cfg := defaultConfig()
	cfg.Remote.BackendURL = "https://api.example.com"
	cfg.Remote.Token = "test-token"
	cfg.Remote.SSHUser = "root"
	cfg.Remote.Setup = []string{"make setup"}

	if err := saveGlobalConfig(cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadSetupDefaults()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Remote.BackendURL != cfg.Remote.BackendURL {
		t.Fatalf("backend URL = %q, want %q", loaded.Remote.BackendURL, cfg.Remote.BackendURL)
	}
	if loaded.Remote.Token != cfg.Remote.Token {
		t.Fatalf("token = %q, want %q", loaded.Remote.Token, cfg.Remote.Token)
	}
}

func TestTopLevelHelpMentionsBHCommands(t *testing.T) {
	output := captureStderr(t, func() {
		printUsage()
	})
	for _, want := range []string{"bh create", "bh list", "bh destroy", "bh connect", "bh run"} {
		if !strings.Contains(output, want) {
			t.Fatalf("help output missing %q:\n%s", want, output)
		}
	}
}

func TestGitHubRepoURLDetection(t *testing.T) {
	cases := map[string]bool{
		"https://github.com/finbarr/boxhaven.git":   true,
		"git@github.com:finbarr/boxhaven.git":       true,
		"ssh://git@github.com/finbarr/boxhaven.git": true,
		"https://www.github.com/finbarr/boxhaven":   true,
		"https://gitlab.com/finbarr/boxhaven.git":   false,
		"git@gitlab.com:finbarr/boxhaven.git":       false,
		"not a repo":                                false,
		"":                                          false,
	}
	for repoURL, want := range cases {
		if got := isGitHubRepoURL(repoURL); got != want {
			t.Fatalf("isGitHubRepoURL(%q) = %t, want %t", repoURL, got, want)
		}
	}
}

func TestRemoteGitAuthEnvForGitHubRepos(t *testing.T) {
	t.Setenv("GH_TOKEN", "gh-token")
	t.Setenv("GITHUB_TOKEN", "")

	env := remoteGitAuthEnv("https://github.com/finbarr/boxhaven.git")
	if env["GH_TOKEN"] != "gh-token" {
		t.Fatalf("GH_TOKEN = %q, want forwarded token", env["GH_TOKEN"])
	}
	if env["GITHUB_TOKEN"] != "gh-token" {
		t.Fatalf("GITHUB_TOKEN = %q, want GH_TOKEN mirrored", env["GITHUB_TOKEN"])
	}

	if env := remoteGitAuthEnv("https://gitlab.com/finbarr/boxhaven.git"); len(env) != 0 {
		t.Fatalf("non-GitHub repo unexpectedly received auth env: %#v", env)
	}
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	fn()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	os.Stderr = old
	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	return string(data)
}
