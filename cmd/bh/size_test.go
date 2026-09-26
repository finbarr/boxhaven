package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSizeCatalogJSON(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	project := t.TempDir()
	mustWriteFile(t, filepath.Join(project, ".boxhaven.toml"), "[remote]\nprovider = \"configured\"\n")
	provider := "configured"
	failProviders := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing authentication")
		}
		switch r.URL.Path {
		case "/v1/sizes":
			if r.URL.Query().Get("provider") != provider || r.URL.Query().Get("region") != "nyc3" || r.URL.Query().Get("team") != "demo" {
				t.Errorf("unexpected filters: %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `{"provider":{"name":"configured","label":"Configured","default_region":"nyc3"},"plans":[],"sizes":[{"name":"small","provider":"configured","hourly_price_cents":10,"plan":{"slug":"s-2vcpu-4gb","available":true,"regions":["nyc3"],"prices":[{"region":"nyc3","hourly":0.02,"monthly":12,"currency":"USD"}]}}]}`)
		case "/v1/providers":
			if failProviders {
				w.WriteHeader(503)
				fmt.Fprint(w, `{"message":"Catalog unavailable"}`)
				return
			}
			fmt.Fprint(w, `{"providers":[{"name":"configured","label":"Configured","default":true}]}`)
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	t.Setenv(remoteBackendURLEnv, server.URL)
	t.Setenv(remoteAuthTokenEnv, "test-token")
	output, err := os.CreateTemp(t.TempDir(), "catalog")
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	original := os.Stdout
	os.Stdout = output
	defer func() { os.Stdout = original }()
	for _, explicit := range []bool{false, true} {
		args := []string{"--json", "--region", "nyc3", "--team", "demo"}
		if explicit {
			provider = "override"
			args = append(args, "--provider", provider)
		}
		if err := runSizeList(args, project, false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := output.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	var catalog remoteSizesResponse
	if err := json.NewDecoder(output).Decode(&catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.Provider.DefaultRegion != "nyc3" || len(catalog.Providers) != 1 || len(catalog.Sizes) != 1 || catalog.Sizes[0].HourlyPriceCents == nil || *catalog.Sizes[0].HourlyPriceCents != 10 || len(catalog.Sizes[0].Plan.Prices) != 1 {
		t.Fatalf("incomplete catalog: %+v", catalog)
	}
	provider = "configured"
	failProviders = true
	if err := runSizeList([]string{"--json", "--region", "nyc3", "--team", "demo"}, project, false); err == nil || !strings.Contains(err.Error(), "Catalog unavailable") {
		t.Fatalf("expected catalog failure, got %v", err)
	}
}
