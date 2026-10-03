package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestSSHWebSocketStreamsBinaryData(t *testing.T) {
	payload := bytes.Repeat([]byte{0, 1, 255, 13, 10, 128}, 350000)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-BoxHaven-Access") != "scoped-secret" {
			t.Error("missing runtime grant")
			w.WriteHeader(401)
			return
		}
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = socket.CloseNow() }()
		conn := websocket.NetConn(r.Context(), socket, websocket.MessageBinary)
		read := make([]byte, len(payload))
		if _, err := io.ReadFull(conn, read); err != nil {
			t.Error(err)
			return
		}
		if !bytes.Equal(read, payload) {
			t.Error("binary data corrupted")
		}
		for len(read) > 0 {
			n := min(len(read), 32768)
			if _, err := conn.Write(read[:n]); err != nil {
				return
			}
			read = read[n:]
		}
		if err := socket.Close(websocket.StatusNormalClosure, ""); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Keep stdin open as an SSH process does while receiving stdout.
	input, writer := io.Pipe()
	defer func() { _ = writer.Close() }()
	go func() { _, _ = writer.Write(payload) }()
	var output bytes.Buffer
	err := proxySSHWebSocket(ctx, sshAccess{URL: server.URL, Headers: map[string]string{"X-BoxHaven-Access": "scoped-secret"}}, input, &output, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), payload) {
		t.Fatalf("received %d bytes; want %d", output.Len(), len(payload))
	}
}

func TestSSHGrantRejectsUnencryptedURLsAndInvalidExpiry(t *testing.T) {
	for _, raw := range []string{"ws://example/ssh", "wss://u:p@example/ssh", "wss://example/ssh?key=secret", "wss://example/ssh#key"} {
		if err := validateSSHAccess(sshAccess{Kind: "websocket", URL: raw, ExpiresAt: time.Now().Add(time.Minute)}); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if err := validateSSHAccess(sshAccess{Kind: "websocket", URL: "wss://example/ssh", ExpiresAt: time.Now().Add(-time.Minute)}); err == nil {
		t.Fatal("accepted expired grant")
	}
	machine := remoteMachine{Name: "one", SSHTransport: "websocket", SSHKeyPath: "key", SSHCertificatePath: "cert", SSHHost: "resource.invalid", SSHGrantPath: "/private/access.json"}
	t.Setenv("HOME", t.TempDir())
	args, err := remoteSSHOptions(machine, false)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "ProxyCommand=") || !strings.Contains(joined, "StrictHostKeyChecking=accept-new") || !strings.Contains(joined, "CertificateFile=cert") {
		t.Fatal(joined)
	}
}
