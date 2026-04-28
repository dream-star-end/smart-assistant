// 0042 selfprobe 单元测试。
//
// 覆盖纯 IO 函数 probeUplink / probeEgressListener / probeImage:
//   - probeEgressListener: listener 在线 → OK;listener 关闭 → 失败 + 可读 Err
//   - probeUplink: 起一个本机 mTLS httptest server,用动态生成的 CA + leaf 跑通完整握手
//     → 仅 2xx 视作 OK(plan v4 round-2),401/403/404/500/503 都返失败 + Err 含状态码;
//     cert 文件路径错 → "load cert" 错;CA 不解析 → 错
//   - probeImage: docker bin 找不到 → 返 nil(不污染缓存);RuntimeImageTag 为空时上层
//     tickImage 提前 return,这里直测 probeImage 在 bin 不存在时的行为
//
// 不测 Poller.Start 时序(time.NewTicker 真等 30s 在单测里不合理),只测各 prober 函数本身。

package selfprobe

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/openclaude/node-agent/internal/config"
)

// ─── probeEgressListener ────────────────────────────────────────────────

func TestProbeEgressListener_Open(t *testing.T) {
	// 起 TCP listener,把 :port 写到 cfg,probe 应 OK
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		// accept 一次就行,不读不写
		c, _ := ln.Accept()
		if c != nil {
			c.Close()
		}
	}()

	cfg := &config.Config{MasterEgressBind: ln.Addr().String()}
	res := probeEgressListener(context.Background(), cfg)
	if !res.OK {
		t.Fatalf("expected OK, got Err=%q", res.Err)
	}
	if res.At.IsZero() {
		t.Errorf("At should be set")
	}
}

func TestProbeEgressListener_Closed(t *testing.T) {
	// 拿一个端口然后立刻关掉 listener,dial 必失败
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close()

	cfg := &config.Config{MasterEgressBind: addr}
	res := probeEgressListener(context.Background(), cfg)
	if res.OK {
		t.Fatalf("expected failure, got OK")
	}
	if !strings.Contains(res.Err, "egress dial") {
		t.Errorf("Err should describe dial failure, got %q", res.Err)
	}
}

func TestProbeEgressListener_BadBind(t *testing.T) {
	cfg := &config.Config{MasterEgressBind: "not-a-valid-bind"}
	res := probeEgressListener(context.Background(), cfg)
	if res.OK {
		t.Fatalf("expected failure on invalid bind")
	}
	if !strings.Contains(res.Err, "parse master_egress_bind") {
		t.Errorf("expected parse error, got %q", res.Err)
	}
}

func TestProbeEgressListener_NormalizesWildcardHost(t *testing.T) {
	// listener 真听 127.0.0.1,但 cfg 写 "0.0.0.0:port" 应 dial 127.0.0.1:port 成功
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		c, _ := ln.Accept()
		if c != nil {
			c.Close()
		}
	}()
	_, port, _ := net.SplitHostPort(ln.Addr().String())

	cfg := &config.Config{MasterEgressBind: "0.0.0.0:" + port}
	res := probeEgressListener(context.Background(), cfg)
	if !res.OK {
		t.Fatalf("expected wildcard host to normalize and probe OK, got Err=%q", res.Err)
	}
}

// ─── probeUplink ────────────────────────────────────────────────────────

// genCAAndLeaf 生成一个自签 CA + 一张由它签发的 leaf cert(同时给 httptest server 与 agent
// 共用 — 真实部署里两边证书不同,但本测试目标是验 mTLS 握手成功路径,共用 leaf 不影响逻辑)。
func genCAAndLeaf(t *testing.T) (caPEM []byte, leafCertPEM, leafKeyPEM []byte) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("gen ca key: %v", err)
	}
	caTpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("sign ca: %v", err)
	}
	caPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("gen leaf key: %v", err)
	}
	leafTpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
			x509.ExtKeyUsageClientAuth,
		},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:    []string{"localhost"},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTpl, caTpl, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("sign leaf: %v", err)
	}
	leafCertPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	keyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		t.Fatalf("marshal leaf key: %v", err)
	}
	leafKeyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return caPEM, leafCertPEM, leafKeyPEM
}

func writeTempFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}

func TestProbeUplink_Success(t *testing.T) {
	caPEM, leafPEM, keyPEM := genCAAndLeaf(t)
	tmp := t.TempDir()
	caPath := writeTempFile(t, tmp, "ca.pem", caPEM)
	crtPath := writeTempFile(t, tmp, "leaf.pem", leafPEM)
	keyPath := writeTempFile(t, tmp, "leaf.key", keyPEM)

	// httptest TLS server,要求 client cert + 用 CA 验证
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caPEM) {
		t.Fatal("ca PEM not parseable")
	}
	leafPair, err := tls.X509KeyPair(leafPEM, keyPEM)
	if err != nil {
		t.Fatalf("load leaf: %v", err)
	}

	hits := 0
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path != "/v3/agent-uplink-probe" {
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	srv.TLS = &tls.Config{
		Certificates: []tls.Certificate{leafPair},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    caPool,
		MinVersion:   tls.VersionTLS12,
	}
	srv.StartTLS()
	defer srv.Close()

	cfg := &config.Config{
		MasterMtlsURL: srv.URL,
		TLSCrt:        crtPath,
		TLSKey:        keyPath,
		CACrt:         caPath,
	}
	res := probeUplink(context.Background(), cfg)
	if !res.OK {
		t.Fatalf("expected OK, got Err=%q", res.Err)
	}
	if hits != 1 {
		t.Errorf("server should be hit once, got %d", hits)
	}
}

// plan v4 round-2:仅 2xx 视为 OK。401/403/404/5xx 都判失败,Err 应包含 status code。
func TestProbeUplink_NonSuccessIsFail(t *testing.T) {
	caPEM, leafPEM, keyPEM := genCAAndLeaf(t)
	tmp := t.TempDir()
	caPath := writeTempFile(t, tmp, "ca.pem", caPEM)
	crtPath := writeTempFile(t, tmp, "leaf.pem", leafPEM)
	keyPath := writeTempFile(t, tmp, "leaf.key", keyPEM)

	caPool := x509.NewCertPool()
	caPool.AppendCertsFromPEM(caPEM)
	leafPair, _ := tls.X509KeyPair(leafPEM, keyPEM)

	cases := []struct {
		name   string
		status int
	}{
		{"401-unauth", http.StatusUnauthorized},
		{"403-forbid", http.StatusForbidden},
		{"404-missing", http.StatusNotFound},
		{"500-internal", http.StatusInternalServerError},
		{"503-unavail", http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"err":"nope"}`))
			}))
			srv.TLS = &tls.Config{
				Certificates: []tls.Certificate{leafPair},
				ClientAuth:   tls.RequireAndVerifyClientCert,
				ClientCAs:    caPool,
				MinVersion:   tls.VersionTLS12,
			}
			srv.StartTLS()
			defer srv.Close()

			cfg := &config.Config{
				MasterMtlsURL: srv.URL,
				TLSCrt:        crtPath,
				TLSKey:        keyPath,
				CACrt:         caPath,
			}
			res := probeUplink(context.Background(), cfg)
			if res.OK {
				t.Fatalf("expected failure on status %d, got OK", tc.status)
			}
			wantSub := fmt.Sprintf("unexpected status %d", tc.status)
			if !strings.Contains(res.Err, wantSub) {
				t.Errorf("Err should contain %q, got %q", wantSub, res.Err)
			}
		})
	}
}

// 200/201/204 等 2xx 应判 OK。
func TestProbeUplink_TwoXXIsOK(t *testing.T) {
	caPEM, leafPEM, keyPEM := genCAAndLeaf(t)
	tmp := t.TempDir()
	caPath := writeTempFile(t, tmp, "ca.pem", caPEM)
	crtPath := writeTempFile(t, tmp, "leaf.pem", leafPEM)
	keyPath := writeTempFile(t, tmp, "leaf.key", keyPEM)

	caPool := x509.NewCertPool()
	caPool.AppendCertsFromPEM(caPEM)
	leafPair, _ := tls.X509KeyPair(leafPEM, keyPEM)

	for _, status := range []int{200, 201, 204, 299} {
		t.Run(fmt.Sprintf("%d", status), func(t *testing.T) {
			srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
			}))
			srv.TLS = &tls.Config{
				Certificates: []tls.Certificate{leafPair},
				ClientAuth:   tls.RequireAndVerifyClientCert,
				ClientCAs:    caPool,
				MinVersion:   tls.VersionTLS12,
			}
			srv.StartTLS()
			defer srv.Close()

			cfg := &config.Config{
				MasterMtlsURL: srv.URL,
				TLSCrt:        crtPath,
				TLSKey:        keyPath,
				CACrt:         caPath,
			}
			res := probeUplink(context.Background(), cfg)
			if !res.OK {
				t.Fatalf("expected OK on %d, got Err=%q", status, res.Err)
			}
		})
	}
}

func TestProbeUplink_LoadCertError(t *testing.T) {
	cfg := &config.Config{
		MasterMtlsURL: "https://127.0.0.1:1",
		TLSCrt:        "/nonexistent/cert.pem",
		TLSKey:        "/nonexistent/key.pem",
		CACrt:         "/nonexistent/ca.pem",
	}
	res := probeUplink(context.Background(), cfg)
	if res.OK {
		t.Fatalf("expected failure")
	}
	if !strings.Contains(res.Err, "load cert") {
		t.Errorf("expected load cert err, got %q", res.Err)
	}
}

func TestProbeUplink_BadCAFile(t *testing.T) {
	caPEM, leafPEM, keyPEM := genCAAndLeaf(t)
	tmp := t.TempDir()
	crtPath := writeTempFile(t, tmp, "leaf.pem", leafPEM)
	keyPath := writeTempFile(t, tmp, "leaf.key", keyPEM)
	// 写一份非 PEM 的"CA"
	badCAPath := writeTempFile(t, tmp, "ca.pem", []byte("not pem at all"))
	_ = caPEM

	cfg := &config.Config{
		MasterMtlsURL: "https://127.0.0.1:1",
		TLSCrt:        crtPath,
		TLSKey:        keyPath,
		CACrt:         badCAPath,
	}
	res := probeUplink(context.Background(), cfg)
	if res.OK {
		t.Fatalf("expected failure")
	}
	if !strings.Contains(res.Err, "ca not valid PEM") {
		t.Errorf("expected ca PEM err, got %q", res.Err)
	}
}

// MasterMtlsURL 解析失败 → 显式错(虽然 cfg.Load 已校验,probeUplink 仍兜底)
func TestProbeUplink_DialFailure(t *testing.T) {
	caPEM, leafPEM, keyPEM := genCAAndLeaf(t)
	tmp := t.TempDir()
	caPath := writeTempFile(t, tmp, "ca.pem", caPEM)
	crtPath := writeTempFile(t, tmp, "leaf.pem", leafPEM)
	keyPath := writeTempFile(t, tmp, "leaf.key", keyPEM)

	// 拿一个肯定关闭的端口
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()

	cfg := &config.Config{
		MasterMtlsURL: "https://" + addr,
		TLSCrt:        crtPath,
		TLSKey:        keyPath,
		CACrt:         caPath,
	}
	res := probeUplink(context.Background(), cfg)
	if res.OK {
		t.Fatalf("expected dial failure")
	}
	if !strings.Contains(res.Err, "uplink:") {
		t.Errorf("expected uplink prefix, got %q", res.Err)
	}
}

// ─── probeImage ─────────────────────────────────────────────────────────

func TestProbeImage_DockerBinNotFound(t *testing.T) {
	cfg := &config.Config{
		DockerBin:       "/definitely-not-a-real-binary-" + fmt.Sprint(time.Now().UnixNano()),
		RuntimeImageTag: "any:tag",
	}
	got := probeImage(context.Background(), cfg)
	if got != nil {
		t.Fatalf("expected nil on docker bin missing, got %+v", got)
	}
}

// 用一个 stub bin(写个 shell 脚本输出 "sha256:fake")测 happy path。
func TestProbeImage_StubReturnsID(t *testing.T) {
	tmp := t.TempDir()
	stub := filepath.Join(tmp, "docker")
	script := "#!/bin/sh\necho 'sha256:abc123'\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	cfg := &config.Config{
		DockerBin:       stub,
		RuntimeImageTag: "openclaude-runtime:test",
	}
	got := probeImage(context.Background(), cfg)
	if got == nil {
		t.Fatalf("expected ImageInfo, got nil")
	}
	if got.ID != "sha256:abc123" {
		t.Errorf("ID got %q", got.ID)
	}
	if got.Tag != "openclaude-runtime:test" {
		t.Errorf("Tag got %q", got.Tag)
	}
	if got.At.IsZero() {
		t.Errorf("At should be set")
	}
}

// stub 返非零 → 视为 image not found,不更新缓存(返 nil)
func TestProbeImage_StubNonzeroReturnsNil(t *testing.T) {
	tmp := t.TempDir()
	stub := filepath.Join(tmp, "docker")
	script := "#!/bin/sh\necho 'no such image' >&2\nexit 1\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	cfg := &config.Config{
		DockerBin:       stub,
		RuntimeImageTag: "openclaude-runtime:missing",
	}
	got := probeImage(context.Background(), cfg)
	if got != nil {
		t.Fatalf("expected nil on exit 1, got %+v", got)
	}
}

// stub 返空字符串 → 视为未拿到 ID,返 nil(避免污染 master 侧 loaded_image)
func TestProbeImage_EmptyOutputReturnsNil(t *testing.T) {
	tmp := t.TempDir()
	stub := filepath.Join(tmp, "docker")
	script := "#!/bin/sh\necho ''\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	cfg := &config.Config{
		DockerBin:       stub,
		RuntimeImageTag: "openclaude-runtime:empty",
	}
	got := probeImage(context.Background(), cfg)
	if got != nil {
		t.Fatalf("expected nil on empty output, got %+v", got)
	}
}

// ─── Poller.Snapshot 并发安全 ──────────────────────────────────────────

func TestPollerSnapshot_NilWhenUnpolled(t *testing.T) {
	p := New(&config.Config{})
	s := p.Snapshot()
	if s.Uplink != nil || s.Egress != nil || s.Image != nil {
		t.Errorf("unpolled snapshot should be all-nil, got %+v", s)
	}
}
