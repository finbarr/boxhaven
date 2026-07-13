package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderBoxHavenSSHConfig(t *testing.T) {
	machines := []remoteMachine{
		{Name: "zeta", PublicIPv4: "203.0.113.20", SSHUser: "boxhaven", ProviderID: "200", BootstrapComplete: true},
		{Name: "alpha", PublicIPv4: "203.0.113.10", SSHUser: "ubuntu", ProviderID: "100", BootstrapComplete: true},
		{Name: "creating", PublicIPv4: "203.0.113.30"},
		{Name: "no-address", BootstrapComplete: true},
		{Name: "bad-address", PublicIPv4: "203.0.113.40\nProxyCommand bad", BootstrapComplete: true},
		{Name: "bad-name\nProxyCommand bad", PublicIPv4: "203.0.113.50", BootstrapComplete: true},
	}
	configured := sshConfigMachines(machines)
	if len(configured) != 2 || configured[0].Name != "alpha" || configured[1].Name != "zeta" {
		t.Fatalf("configured machines = %#v", configured)
	}

	config := renderBoxHavenSSHConfig(configured, "/Applications/Box Haven/bh", "https://api.example.com")
	for _, want := range []string{
		"Host bh-alpha",
		"HostName 203.0.113.10",
		"User ubuntu",
		"CertificateFile ~/.boxhaven/ssh/certs/bh-alpha-cert.pub",
		"HostKeyAlias boxhaven-alpha-100",
		`Match originalhost bh-alpha exec "env BOXHAVEN_BACKEND_URL='https://api.example.com' '/Applications/Box Haven/bh' ssh-config certificate 'alpha' >/dev/null"`,
	} {
		if !strings.Contains(config, want) {
			t.Fatalf("generated SSH config missing %q:\n%s", want, config)
		}
	}
	if strings.Index(config, "Host bh-alpha") > strings.Index(config, "Host bh-zeta") {
		t.Fatalf("generated SSH config is not sorted:\n%s", config)
	}
}

func TestSSHConfigUserRejectsConfigInjection(t *testing.T) {
	if got := sshConfigUser("ubuntu\nProxyCommand bad"); got != remoteDefaultSSHUser {
		t.Fatalf("unsafe SSH user = %q", got)
	}
	if got := sshConfigUser("ubuntu-24"); got != "ubuntu-24" {
		t.Fatalf("safe SSH user = %q", got)
	}
}

func TestRenderedSSHConfigParsesAndRunsMatchExec(t *testing.T) {
	if _, err := exec.LookPath("ssh"); err != nil {
		t.Skip("ssh is not installed")
	}
	temp := t.TempDir()
	marker := filepath.Join(temp, "match-ran")
	helper := filepath.Join(temp, "helper")
	script := fmt.Sprintf("#!/bin/sh\ntouch %s\n", shellQuote(marker))
	if err := os.WriteFile(helper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	config := renderBoxHavenSSHConfig([]remoteMachine{{
		Name: "parse-test", PublicIPv4: "127.0.0.1", SSHUser: "boxhaven", ProviderID: "42", BootstrapComplete: true,
	}}, helper, "https://api.example.com")
	configPath := filepath.Join(temp, "config")
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("ssh", "-G", "-F", configPath, "bh-parse-test")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("parse generated SSH config: %v: %s", err, output)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("Match exec did not run: %v", err)
	}
	if !strings.Contains(string(output), "hostname 127.0.0.1") {
		t.Fatalf("generated SSH config did not resolve host:\n%s", output)
	}
}

func TestSSHConfigIncludeInstallAndUninstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(sshDir, "config")
	original := "Host example\n    HostName example.com\n"
	if err := os.WriteFile(configPath, []byte(original), 0o640); err != nil {
		t.Fatal(err)
	}

	if err := installBoxHavenSSHConfigInclude(); err != nil {
		t.Fatal(err)
	}
	if err := installBoxHavenSSHConfigInclude(); err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(installed), boxHavenSSHConfigInclude) != 1 {
		t.Fatalf("include was not installed idempotently:\n%s", installed)
	}
	if !strings.Contains(string(installed), original) {
		t.Fatalf("existing SSH config was not preserved:\n%s", installed)
	}
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("SSH config mode = %o, want 640", info.Mode().Perm())
	}

	if err := uninstallBoxHavenSSHConfigInclude(); err != nil {
		t.Fatal(err)
	}
	uninstalled, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(uninstalled), boxHavenSSHConfigInclude) || !strings.Contains(string(uninstalled), original) {
		t.Fatalf("uninstall did not preserve existing SSH config:\n%s", uninstalled)
	}
}

func TestPersistentSSHDeviceKeyIsReused(t *testing.T) {
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("ssh-keygen is not installed")
	}
	t.Setenv("HOME", t.TempDir())
	firstPath, firstPublic, err := ensureBoxHavenSSHDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	secondPath, secondPublic, err := ensureBoxHavenSSHDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	if firstPath != secondPath || firstPublic != secondPublic {
		t.Fatalf("persistent key was not reused")
	}
	info, err := os.Stat(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("private key mode = %o, want 600", info.Mode().Perm())
	}
}

func TestRefreshSSHCertificateUsesPersistentKey(t *testing.T) {
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("ssh-keygen is not installed")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/machines/work/ssh-cert" {
			http.NotFound(response, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer token" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body remoteBackendSSHCertificateRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil || !strings.HasPrefix(body.PublicKey, "ssh-ed25519 ") {
			http.Error(response, "bad key", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(response).Encode(remoteBackendSSHCertificateResponse{
			Certificate: "ssh-ed25519-cert-v01@openssh.com certificate-data",
			Host:        "203.0.113.10",
			Port:        22,
			SSHUser:     "boxhaven",
		})
	}))
	defer server.Close()

	cfg := defaultConfig()
	cfg.Remote.BackendURL = server.URL
	cfg.Remote.Token = "token"
	machine := remoteMachine{Name: "work"}
	certificatePath, err := refreshBoxHavenSSHCertificate(cfg, &machine)
	if err != nil {
		t.Fatal(err)
	}
	if machine.SSHKeyPath != filepath.Join(home, ".boxhaven", "ssh", "id_ed25519") {
		t.Fatalf("SSH key path = %q", machine.SSHKeyPath)
	}
	if machine.SSHCertificatePath != certificatePath || machine.SSHHost != "203.0.113.10" || machine.SSHUser != "boxhaven" {
		t.Fatalf("machine SSH state = %#v", machine)
	}
	data, err := os.ReadFile(certificatePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "ssh-ed25519-cert-v01@openssh.com certificate-data\n" {
		t.Fatalf("certificate contents = %q", data)
	}
}
