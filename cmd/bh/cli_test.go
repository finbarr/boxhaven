package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestParseRemoteCreateArgsTeam(t *testing.T) {
	cfg := defaultConfig()

	opts, _, err := parseRemoteCreateArgs([]string{"dev", "--team", "acme-inc"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Team != "acme-inc" {
		t.Fatalf("team = %q, want %q", opts.Team, "acme-inc")
	}

	opts, _, err = parseRemoteCreateArgs([]string{"dev", "--team=beta"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Team != "beta" {
		t.Fatalf("flag=value team = %q, want %q", opts.Team, "beta")
	}

	opts, _, err = parseRemoteCreateArgs([]string{"dev"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Team != "" {
		t.Fatalf("default team = %q, want empty", opts.Team)
	}

	if _, _, err := parseRemoteCreateArgs([]string{"dev", "--team"}, cfg); err == nil {
		t.Fatal("parseRemoteCreateArgs accepted --team without a value")
	}
}

func TestRemoteMachineTeamLabel(t *testing.T) {
	cases := []struct {
		machine remoteMachine
		want    string
	}{
		{remoteMachine{TeamSlug: "acme-inc", TeamName: "Acme Inc"}, "acme-inc"},
		{remoteMachine{TeamName: "Acme Inc"}, "Acme Inc"},
		{remoteMachine{}, "-"},
	}
	for _, tc := range cases {
		if got := remoteMachineTeamLabel(tc.machine); got != tc.want {
			t.Fatalf("remoteMachineTeamLabel(%#v) = %q, want %q", tc.machine, got, tc.want)
		}
	}
}

func TestRemoteVMInstallSupportsGhosttyTerminfo(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("assets", "remote-vm-install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	for _, want := range []string{
		"install_terminal_compat",
		"xterm-ghostty",
		"tic -x -o /usr/share/terminfo",
		"infocmp xterm-ghostty",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("remote-vm-install.sh is missing %q", want)
		}
	}
}

func TestConfirmDestructiveActionRequiresForceWithoutTTY(t *testing.T) {
	if err := confirmDestructiveAction("Destroy test", true); err != nil {
		t.Fatal(err)
	}

	oldStdin := os.Stdin
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = write.Close()
	os.Stdin = read
	defer func() {
		os.Stdin = oldStdin
		_ = read.Close()
	}()

	err = confirmDestructiveAction("Destroy test", false)
	if err == nil || !strings.Contains(err.Error(), "pass --force") {
		t.Fatalf("confirmDestructiveAction error = %v, want pass --force", err)
	}
}

func TestTeamActiveLabel(t *testing.T) {
	cases := []struct {
		team *teamOrganization
		want string
	}{
		{nil, "-"},
		{&teamOrganization{ID: "org-1", Name: "Acme Inc", Slug: "acme-inc"}, "Acme Inc (acme-inc)"},
		{&teamOrganization{ID: "org-1", Name: "Acme Inc"}, "Acme Inc"},
		{&teamOrganization{ID: "org-1", Slug: "acme-inc"}, "acme-inc"},
		{&teamOrganization{ID: "org-1"}, "org-1"},
		{&teamOrganization{}, "-"},
	}
	for _, tc := range cases {
		if got := teamActiveLabel(tc.team); got != tc.want {
			t.Fatalf("teamActiveLabel(%#v) = %q, want %q", tc.team, got, tc.want)
		}
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
	for _, want := range []string{"bh create", "bh list", "bh destroy", "bh rename", "bh move", "bh connect", "bh run", "bh image", "bh team"} {
		if !strings.Contains(output, want) {
			t.Fatalf("help output missing %q:\n%s", want, output)
		}
	}
	for _, want := range []string{".boxhavenignore", "reports elapsed transfer stats"} {
		if !strings.Contains(output, want) {
			t.Fatalf("help output missing sync note %q:\n%s", want, output)
		}
	}
}

func TestTeamUsageMentionsSwitchAndStatus(t *testing.T) {
	output := captureStderr(t, func() {
		printTeamUsage()
	})
	for _, want := range []string{"bh team switch <team>", "bh team status"} {
		if !strings.Contains(output, want) {
			t.Fatalf("team usage missing %q:\n%s", want, output)
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

func TestSelectTeamOrganizationPrecedenceAndAmbiguity(t *testing.T) {
	orgs := []teamOrganization{
		{ID: "id-1", Slug: "alpha", Name: "acme"},
		{ID: "id-2", Slug: "acme", Name: "Beta"},
		{ID: "id-3", Slug: "same", Name: "Twin"},
		{ID: "id-4", Slug: "same-2", Name: "Twin"},
	}

	bySlug, err := selectTeamOrganization(orgs, "acme")
	if err != nil {
		t.Fatalf("expected slug match, got error: %v", err)
	}
	if bySlug.ID != "id-2" {
		t.Fatalf("expected exact slug match to win over name match, got %s", bySlug.ID)
	}

	if _, err := selectTeamOrganization(orgs, "Twin"); err == nil {
		t.Fatal("expected ambiguous name selection to error")
	} else if !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("expected ambiguity error, got: %v", err)
	}
}

func TestRemoteCommandNeedsTTYShellWithArgs(t *testing.T) {
	if !remoteCommandNeedsTTY([]string{"bash"}) {
		t.Fatal("bare bash should be interactive")
	}
	if remoteCommandNeedsTTY([]string{"bash", "-lc", "echo hi"}) {
		t.Fatal("bash -lc should run over direct SSH, not a session")
	}
	if remoteCommandNeedsTTY([]string{"sh", "script.sh"}) {
		t.Fatal("sh with a script should run over direct SSH")
	}
	if !remoteCommandNeedsTTY([]string{"claude", "--continue"}) {
		t.Fatal("agents stay interactive even with arguments")
	}
}

func TestRemoteSyncIgnoresIncludeDefaultsAndProjectFile(t *testing.T) {
	project := t.TempDir()
	mustWriteFile(t, filepath.Join(project, remoteSyncIgnoreFile), `
# comments and blanks are ignored
docs/.vitepress/dist/
backend/dist-app/

`)

	ignores, err := remoteSyncIgnores(project)
	if err != nil {
		t.Fatal(err)
	}
	if ignores.ProjectPatternCount != 2 {
		t.Fatalf("ProjectPatternCount = %d, want 2", ignores.ProjectPatternCount)
	}
	patterns := map[string]bool{}
	for _, pattern := range ignores.Patterns {
		patterns[pattern] = true
	}
	for _, want := range []string{"node_modules/", ".next/", "__pycache__/", "docs/.vitepress/dist/", "backend/dist-app/"} {
		if !patterns[want] {
			t.Fatalf("sync ignore patterns missing %q: %#v", want, ignores.Patterns)
		}
	}
}

func TestAppendRsyncExcludeArgs(t *testing.T) {
	args := appendRsyncExcludeArgs([]string{"-az", "--delete"}, []string{"node_modules/", "", "docs/.vitepress/dist/"})
	got := strings.Join(args, "\x00")
	for _, want := range []string{
		"--exclude\x00node_modules/",
		"--exclude\x00docs/.vitepress/dist/",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("rsync args missing %q: %#v", want, args)
		}
	}
	if strings.Contains(got, "--exclude\x00\x00") {
		t.Fatalf("rsync args included empty exclude: %#v", args)
	}
}

func TestParseRsyncTransferStatsOpenRsync(t *testing.T) {
	stats := parseRsyncTransferStats(`Number of files: 2
Number of files transferred: 1
Total file size: 5 B
Total transferred file size: 5 B
Unmatched data: 5 B
Matched data: 0 B
File list size: 91 B
File list generation time: 0.001 seconds
File list transfer time: 0.001 seconds
Total sent: 159 B
Total received: 42 B

sent 159 bytes  received 42 bytes  182727 bytes/sec
total size is 5  speedup is 0.02
`)
	if stats.FilesTotal != 2 || !stats.HasFilesTotal {
		t.Fatalf("FilesTotal = %d, has=%v, want 2 true", stats.FilesTotal, stats.HasFilesTotal)
	}
	if stats.FilesTransferred != 1 || !stats.HasFilesTransferred {
		t.Fatalf("FilesTransferred = %d, has=%v, want 1 true", stats.FilesTransferred, stats.HasFilesTransferred)
	}
	if stats.TransferredFileSize != 5 || !stats.HasTransferredFileSize {
		t.Fatalf("TransferredFileSize = %d, has=%v, want 5 true", stats.TransferredFileSize, stats.HasTransferredFileSize)
	}
	if stats.SentBytes != 159 || stats.ReceivedBytes != 42 {
		t.Fatalf("network bytes = sent %d received %d, want 159 42", stats.SentBytes, stats.ReceivedBytes)
	}
	if got, want := stats.summary(), " (201B network, 5B changed, 1/2 files transferred)"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
}

func TestParseRsyncTransferStatsGNU(t *testing.T) {
	stats := parseRsyncTransferStats(`Number of files: 1,234 (reg: 1,200, dir: 34)
Number of regular files transferred: 12
Total file size: 1,048,576 bytes
Total transferred file size: 2.5K bytes
Literal data: 2.5K bytes
Matched data: 0 bytes
File list size: 12.3K
Total bytes sent: 6,144 bytes
Total bytes received: 512 bytes
`)
	if stats.FilesTotal != 1234 {
		t.Fatalf("FilesTotal = %d, want 1234", stats.FilesTotal)
	}
	if stats.FilesTransferred != 12 {
		t.Fatalf("FilesTransferred = %d, want 12", stats.FilesTransferred)
	}
	if stats.TotalFileSize != 1048576 {
		t.Fatalf("TotalFileSize = %d, want 1048576", stats.TotalFileSize)
	}
	if stats.TransferredFileSize != 2560 {
		t.Fatalf("TransferredFileSize = %d, want 2560", stats.TransferredFileSize)
	}
	if stats.SentBytes != 6144 || stats.ReceivedBytes != 512 {
		t.Fatalf("network bytes = sent %d received %d, want 6144 512", stats.SentBytes, stats.ReceivedBytes)
	}
}

func TestRemoteMachineStatusLabel(t *testing.T) {
	now := time.Now()
	cases := []struct {
		machine remoteMachine
		want    string
	}{
		{remoteMachine{BootstrapComplete: false}, "creating"},
		{remoteMachine{BootstrapComplete: true}, "-"},
		{remoteMachine{BootstrapComplete: true, AgentLastSeenAt: now.Add(-time.Minute)}, "online"},
		{remoteMachine{BootstrapComplete: true, AgentLastSeenAt: now.Add(-time.Hour)}, "offline"},
	}
	for _, tc := range cases {
		if got := remoteMachineStatusLabel(tc.machine, now); got != tc.want {
			t.Fatalf("status label = %q, want %q", got, tc.want)
		}
	}
}

func TestRemoteBackendErrorMessage(t *testing.T) {
	err := &remoteBackendError{Method: "GET", Endpoint: "/v1/machines/x", Status: 404, Detail: `{"id":"not_found","message":"machine does not exist"}`}
	if err.Error() != "machine does not exist" {
		t.Fatalf("expected clean message, got %q", err.Error())
	}
	if err.Code() != "not_found" {
		t.Fatalf("expected code not_found, got %q", err.Code())
	}
	raw := &remoteBackendError{Method: "GET", Endpoint: "/x", Status: 502, Detail: "bad gateway"}
	if !strings.Contains(raw.Error(), "bad gateway") || !strings.Contains(raw.Error(), "/x") {
		t.Fatalf("raw errors keep context, got %q", raw.Error())
	}
}

func TestClaudeProjectDirName(t *testing.T) {
	if got := claudeProjectDirName("/Users/finbarr/code/boxhaven"); got != "-Users-finbarr-code-boxhaven" {
		t.Fatalf("local dir name = %q", got)
	}
	if got := claudeProjectDirName("/opt/boxhaven/project"); got != "-opt-boxhaven-project" {
		t.Fatalf("remote dir name = %q", got)
	}
}

func TestClaudeSessionFilesSelection(t *testing.T) {
	home := t.TempDir()
	project := "/Users/x/proj"
	dir := filepath.Join(home, ".claude", "projects", claudeProjectDirName(project))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for i, name := range []string{"a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl", "skip.txt"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Now().Add(-time.Duration(i) * time.Hour)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	files := claudeSessionFiles(home, project, "/opt/boxhaven/project")
	if len(files) != 3 {
		t.Fatalf("expected 3 newest sessions, got %d", len(files))
	}
	if filepath.Base(files[0].LocalPath) != "a.jsonl" {
		t.Fatalf("expected newest first, got %s", files[0].LocalPath)
	}
	want := filepath.Join(".claude", "projects", "-opt-boxhaven-project", "a.jsonl")
	if files[0].RemoteRelativePath != want {
		t.Fatalf("remote path = %q, want %q", files[0].RemoteRelativePath, want)
	}
}
