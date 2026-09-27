package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBackendProtocolMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-BoxHaven-Protocol") != "1" {
			t.Error("missing client protocol")
		}
		w.Header().Set("X-BoxHaven-Protocol", "2")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	err := remoteBackendSessionRequest(server.URL, "test-token", "GET", "/v1/machines", nil, nil, time.Second)
	if err == nil || !strings.Contains(err.Error(), "bh upgrade") {
		t.Fatalf("expected clear upgrade error: %v", err)
	}
}
