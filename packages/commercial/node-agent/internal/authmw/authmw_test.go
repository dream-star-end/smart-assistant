package authmw

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/openclaude/node-agent/internal/config"
)

func TestMiddleware_ValidatesAndStripsNodePskHeader(t *testing.T) {
	dir := t.TempDir()
	const pskMarker = "synthetic-node-agent-psk-marker-feedface01234567"
	pskPath := filepath.Join(dir, "agent.psk")
	if err := os.WriteFile(pskPath, []byte(pskMarker), 0o600); err != nil {
		t.Fatalf("write psk: %v", err)
	}

	mw, err := New(&config.Config{PskPath: pskPath})
	if err != nil {
		t.Fatalf("New middleware: %v", err)
	}

	sanURI, err := url.Parse(MasterSpiffeURI)
	if err != nil {
		t.Fatalf("parse SAN URI: %v", err)
	}

	var seenAuth string
	var seenContainerId string
	var seenBridgeNonce string
	handler := mw.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		seenContainerId = r.Header.Get("X-OpenClaude-Container-Id")
		seenBridgeNonce = r.Header.Get("X-OpenClaude-Bridge-Nonce")
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/tunnel/containers/cid-1/internal/swarm/command?port=3001", nil)
	req.TLS = &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{{URIs: []*url.URL{sanURI}}},
	}
	req.Header.Set("Authorization", "Bearer "+pskMarker)
	req.Header.Set("X-OpenClaude-Container-Id", "42")
	req.Header.Set("X-OpenClaude-Bridge-Nonce", "nonce-123")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d (%s)", rec.Code, rec.Body.String())
	}
	if seenAuth != "" {
		t.Fatalf("Authorization header must be stripped after node auth, got %q", seenAuth)
	}
	if seenContainerId != "42" || seenBridgeNonce != "nonce-123" {
		t.Fatalf("container bridge headers must be preserved, got id=%q nonce=%q", seenContainerId, seenBridgeNonce)
	}
}
