package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFirstLoginBackendChoice(t *testing.T) {
	for _, tc := range []struct {
		name, configured, answer, want, wantErr string
		interactive                             bool
	}{
		{name: "accept hosted", answer: "\n", interactive: true, want: suggestedHostedBackendURL},
		{name: "choose self hosted", answer: " https://api.example.com/ \n", interactive: true, want: "https://api.example.com"},
		{name: "saved backend", configured: "https://saved.example.com/", want: "https://saved.example.com"},
		{name: "no implicit noninteractive default", answer: "\n", wantErr: "backend URL is required on first login"},
		{name: "eof does not accept hosted", interactive: true, wantErr: "read backend URL"},
		{name: "invalid scheme", answer: "ftp://example.com\n", interactive: true, wantErr: "expected http or https"},
		{name: "missing host", answer: "https://\n", interactive: true, wantErr: "expected URL host"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			got, err := loginBackendURL(tc.configured, strings.NewReader(tc.answer), &output, tc.interactive)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("got %q, %v; want error %q", got, err, tc.wantErr)
				}
			} else if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
			if tc.configured != "" || !tc.interactive {
				if output.Len() != 0 {
					t.Fatalf("unexpected prompt: %s", output.String())
				}
			} else if !strings.Contains(output.String(), "Backend URL ["+suggestedHostedBackendURL+"]:") {
				t.Fatalf("missing hosted suggestion: %s", output.String())
			}
		})
	}
}

func TestBackendURLRequiresConfigurationAndPersistsHostedChoice(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv(remoteBackendURLEnv, "")
	cfg := defaultConfig()
	if got := remoteBackendURL(cfg); got != "" {
		t.Fatalf("unconfigured backend = %q", got)
	}
	if err := remoteBackendRequest(cfg, http.MethodGet, "/v1/machines", nil, nil); err == nil || !strings.Contains(err.Error(), "bh login") {
		t.Fatalf("unconfigured request should explain login: %v", err)
	}
	cfg.Remote.BackendURL = suggestedHostedBackendURL
	if err := saveGlobalConfig(cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadSetupDefaults()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Remote.BackendURL != suggestedHostedBackendURL {
		t.Fatalf("hosted choice was not saved: %q", loaded.Remote.BackendURL)
	}
	t.Setenv(remoteBackendURLEnv, "https://env.example.com/")
	if got := remoteBackendURL(loaded); got != "https://env.example.com" {
		t.Fatalf("environment override = %q", got)
	}
}

func TestLoginUsesSelectedBackendAndReusesSavedURL(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	selectedCalls := 0
	selected := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		selectedCalls++
		if r.URL.Path != "/v1/auth/whoami" || r.Header.Get("Authorization") != "Bearer selected-token" {
			t.Errorf("unexpected selected-backend request: %s, authorization matches=%t", r.URL.Path, r.Header.Get("Authorization") == "Bearer selected-token")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"team":{"slug":"test-team"}}`)
	}))
	defer selected.Close()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("login contacted the environment backend instead of the explicitly selected backend")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer other.Close()
	t.Setenv(remoteBackendURLEnv, other.URL)
	t.Setenv(remoteAuthTokenEnv, "unrelated-env-token")
	if err := runLogin([]string{"--backend-url", selected.URL + "/", "--token", "selected-token"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv(remoteBackendURLEnv, "")
	t.Setenv(remoteAuthTokenEnv, "")
	if err := runLogin([]string{"--token", "selected-token"}); err != nil {
		t.Fatal(err)
	}
	if selectedCalls != 2 {
		t.Fatalf("selected backend received %d calls, want 2", selectedCalls)
	}
	loaded, err := loadSetupDefaults()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Remote.BackendURL != selected.URL || loaded.Remote.Token != "selected-token" {
		t.Fatal("login did not persist selected credentials")
	}
}
