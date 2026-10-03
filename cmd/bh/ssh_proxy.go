package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/coder/websocket"
)

type sshAccess struct {
	Kind      string            `json:"kind"`
	URL       string            `json:"url,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	ExpiresAt time.Time         `json:"expires_at,omitempty"`
}

func validateSSHAccess(access sshAccess) error {
	u, err := url.Parse(access.URL)
	if err != nil {
		return fmt.Errorf("backend returned an invalid SSH WebSocket grant")
	}
	loopback := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
	secure := u.Scheme == "wss" || (u.Scheme == "ws" && loopback)
	if access.Kind != "websocket" || !secure || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("backend returned an invalid SSH WebSocket grant")
	}
	if !access.ExpiresAt.After(time.Now()) || access.ExpiresAt.After(time.Now().Add(time.Hour+time.Minute)) {
		return fmt.Errorf("SSH WebSocket grant is expired or has an invalid lifetime")
	}
	return nil
}

// SSH invokes this internal command. Only a file path appears in process arguments;
// bearer credentials are read from a private file and never printed.
func runSSHProxy(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("ssh-proxy requires an access grant file")
	}
	file, err := os.Open(args[0])
	if err != nil {
		return fmt.Errorf("open SSH access grant: %w", err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("SSH access grant must be a private regular file (0600)")
	}
	var access sshAccess
	if err := json.NewDecoder(io.LimitReader(file, 16384)).Decode(&access); err != nil {
		return fmt.Errorf("invalid SSH access grant file")
	}
	if err := validateSSHAccess(access); err != nil {
		return err
	}
	ctx, cancel := context.WithDeadline(context.Background(), access.ExpiresAt)
	defer cancel()
	// Redirects could disclose provider or runtime credentials to a different host.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if bundle := os.Getenv("SSL_CERT_FILE"); bundle != "" {
		pem, err := os.ReadFile(bundle)
		if err != nil {
			return fmt.Errorf("read SSH transport CA bundle: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			return fmt.Errorf("load system certificate roots: %w", err)
		}
		if !pool.AppendCertsFromPEM(pem) {
			return fmt.Errorf("SSH transport CA bundle contains no certificates")
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		client.Transport = transport
	}
	return proxySSHWebSocket(ctx, access, os.Stdin, os.Stdout, client)
}

func proxySSHWebSocket(ctx context.Context, access sshAccess, input io.Reader, output io.Writer, client *http.Client) error {
	headers := http.Header{}
	for name, value := range access.Headers {
		headers.Set(name, value)
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	socket, _, err := websocket.Dial(dialCtx, access.URL, &websocket.DialOptions{HTTPHeader: headers, HTTPClient: client})
	cancel()
	if err != nil {
		return fmt.Errorf("could not connect to sandbox SSH WebSocket")
	}
	defer func() { _ = socket.CloseNow() }()
	conn := websocket.NetConn(ctx, socket, websocket.MessageBinary)
	socket.SetReadLimit(64 * 1024)
	done := make(chan error, 2)
	go func() { _, err := io.CopyBuffer(conn, input, make([]byte, 32*1024)); done <- err }()
	go func() { _, err := io.CopyBuffer(output, conn, make([]byte, 32*1024)); done <- err }()
	err = <-done
	if err != nil {
		return fmt.Errorf("sandbox SSH WebSocket disconnected")
	}
	return nil
}
