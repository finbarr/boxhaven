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
	cfg.Remote.SSHUser = "ubuntu"
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

func TestParseRemoteCreateArgsProviderRegionImage(t *testing.T) {
	cfg := defaultConfig()

	opts, noSync, err := parseRemoteCreateArgs([]string{"dev", "--provider", "Hetzner", "--region", "nbg1", "--image", "12345"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if noSync {
		t.Fatal("noSync = true, want false")
	}
	if opts.Provider != "hetzner" {
		t.Fatalf("provider = %q, want %q", opts.Provider, "hetzner")
	}
	if opts.Region != "nbg1" {
		t.Fatalf("region = %q, want %q", opts.Region, "nbg1")
	}
	if opts.Image != "12345" {
		t.Fatalf("image = %q, want %q", opts.Image, "12345")
	}

	opts, _, err = parseRemoteCreateArgs([]string{"dev", "--provider=digitalocean", "--region=nyc3", "--image=ubuntu-24-04-x64"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Provider != "digitalocean" || opts.Region != "nyc3" || opts.Image != "ubuntu-24-04-x64" {
		t.Fatalf("flag=value form parsed %q/%q/%q", opts.Provider, opts.Region, opts.Image)
	}

	for _, flag := range []string{"--provider", "--region", "--image"} {
		if _, _, err := parseRemoteCreateArgs([]string{"dev", flag}, cfg); err == nil {
			t.Fatalf("parseRemoteCreateArgs accepted %s without a value", flag)
		}
	}
}

func TestParseRemoteCreateArgsDefaultProviderFromConfig(t *testing.T) {
	cfg := defaultConfig()
	cfg.Remote.Provider = "hetzner"

	opts, _, err := parseRemoteCreateArgs([]string{"dev"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Provider != "hetzner" {
		t.Fatalf("provider = %q, want config default %q", opts.Provider, "hetzner")
	}

	opts, _, err = parseRemoteCreateArgs([]string{"dev", "--provider", "digitalocean"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Provider != "digitalocean" {
		t.Fatalf("provider = %q, want flag override %q", opts.Provider, "digitalocean")
	}
}

func TestTeamSlugFromName(t *testing.T) {
	cases := map[string]string{
		"Acme":              "acme",
		"Acme Inc.":         "acme-inc",
		"  Big   Corp  ":    "big-corp",
		"Team_42!":          "team-42",
		"--Already-Slug--":  "already-slug",
		"ümlaut & friends!": "mlaut-friends",
		"!!!":               "",
		"":                  "",
	}
	for name, want := range cases {
		if got := teamSlugFromName(name); got != want {
			t.Fatalf("teamSlugFromName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestSelectTeamOrganization(t *testing.T) {
	acme := teamOrganization{ID: "org-1", Name: "Acme Inc", Slug: "acme-inc"}
	beta := teamOrganization{ID: "org-2", Name: "Beta", Slug: "beta"}

	if _, err := selectTeamOrganization(nil, ""); err == nil || !strings.Contains(err.Error(), "bh team create") {
		t.Fatalf("zero teams error = %v, want bh team create hint", err)
	}

	org, err := selectTeamOrganization([]teamOrganization{acme}, "")
	if err != nil || org.ID != acme.ID {
		t.Fatalf("single team selection = %v, %v; want %s", org, err, acme.ID)
	}

	if _, err := selectTeamOrganization([]teamOrganization{acme, beta}, ""); err == nil ||
		!strings.Contains(err.Error(), "--team") || !strings.Contains(err.Error(), "acme-inc") || !strings.Contains(err.Error(), "beta") {
		t.Fatalf("multiple teams error = %v, want slugs and --team hint", err)
	}

	for selector, want := range map[string]string{
		"org-2":    beta.ID,
		"acme-inc": acme.ID,
		"ACME-INC": acme.ID,
		"Beta":     beta.ID,
		"acme inc": acme.ID,
	} {
		org, err := selectTeamOrganization([]teamOrganization{acme, beta}, selector)
		if err != nil {
			t.Fatalf("selectTeamOrganization(%q) returned %v", selector, err)
		}
		if org.ID != want {
			t.Fatalf("selectTeamOrganization(%q) = %s, want %s", selector, org.ID, want)
		}
	}

	if _, err := selectTeamOrganization([]teamOrganization{acme, beta}, "nope"); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("unknown selector error = %v, want selector in message", err)
	}
}

func TestTopLevelHelpMentionsBHCommands(t *testing.T) {
	output := captureStderr(t, func() {
		printUsage()
	})
	for _, want := range []string{"bh create", "bh list", "bh destroy", "bh rename", "bh connect", "bh run", "bh image", "bh team"} {
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

func TestRemoteGitAuthEnvFallsBackToGitHubCLI(t *testing.T) {
	temp := t.TempDir()
	ghPath := filepath.Join(temp, "gh")
	script := "#!/usr/bin/env sh\nif [ \"$1\" = auth ] && [ \"$2\" = token ]; then echo gh-cli-token; exit 0; fi\nexit 1\n"
	if err := os.WriteFile(ghPath, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", temp+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")

	env := remoteGitAuthEnv("https://github.com/finbarr/boxhaven.git")
	if env["GH_TOKEN"] != "gh-cli-token" {
		t.Fatalf("GH_TOKEN = %q, want GitHub CLI token", env["GH_TOKEN"])
	}
	if env["GITHUB_TOKEN"] != "gh-cli-token" {
		t.Fatalf("GITHUB_TOKEN = %q, want GitHub CLI token", env["GITHUB_TOKEN"])
	}
}

func TestLocalRemoteAuthFilesSelectsAgentLoginFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	mustWriteFile(t, filepath.Join(home, ".codex", "auth.json"), `{"token":"codex"}`)
	mustWriteFile(t, filepath.Join(home, ".codex", "config.toml"), "model = \"gpt\"\n")
	mustWriteFile(t, filepath.Join(home, ".claude.json"), `{"oauth":"claude"}`)
	mustWriteFile(t, filepath.Join(home, ".codex", "history.jsonl"), "do not copy\n")

	files := localRemoteAuthFiles(remoteDefaultSSHUser)
	targets := map[string]string{}
	for _, file := range files {
		targets[file.Target] = file.Data
	}
	for _, want := range []string{"/home/boxhaven/.codex/auth.json", "/home/boxhaven/.codex/config.toml", "/home/boxhaven/.claude.json"} {
		if targets[want] == "" {
			t.Fatalf("auth files missing %s: %#v", want, targets)
		}
	}
	if _, ok := targets["/home/boxhaven/.codex/history.jsonl"]; ok {
		t.Fatalf("auth files unexpectedly included history: %#v", targets)
	}
}

func TestCurrentGitIdentityUsesEffectiveConfig(t *testing.T) {
	temp := t.TempDir()
	gitPath := filepath.Join(temp, "git")
	script := "#!/usr/bin/env sh\nif [ \"$1\" = config ] && [ \"$2\" = --get ]; then\n  case \"$3\" in\n    user.name) echo 'Ada Lovelace'; exit 0 ;;\n    user.email) echo 'ada@example.com'; exit 0 ;;\n  esac\nfi\nexit 1\n"
	if err := os.WriteFile(gitPath, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", temp+string(os.PathListSeparator)+os.Getenv("PATH"))

	identity := currentGitIdentity(t.TempDir())
	if identity.Name != "Ada Lovelace" {
		t.Fatalf("name = %q, want effective git user.name", identity.Name)
	}
	if identity.Email != "ada@example.com" {
		t.Fatalf("email = %q, want effective git user.email", identity.Email)
	}
}

func TestRemoteGitIdentityScript(t *testing.T) {
	script := remoteGitIdentityScript(gitIdentity{
		Name:  "Ada O'Neil",
		Email: "ada@example.com",
	})
	if !strings.Contains(script, "git config --global user.name 'Ada O'\"'\"'Neil'") {
		t.Fatalf("script did not quote user.name correctly:\n%s", script)
	}
	if !strings.Contains(script, "git config --global user.email 'ada@example.com'") {
		t.Fatalf("script did not include user.email:\n%s", script)
	}
	if got := remoteGitIdentityScript(gitIdentity{}); got != "" {
		t.Fatalf("empty identity script = %q, want empty", got)
	}
}

func mustWriteFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
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
