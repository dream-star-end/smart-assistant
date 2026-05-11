package tunnel

import (
	"net/http"
	"strings"
	"testing"
)

func TestIsDeniedPort(t *testing.T) {
	cases := []struct {
		port   int
		denied bool
	}{
		// 允许:常用 HTTP 端口
		{80, false},
		{443, false},
		// 允许:典型应用 / devserver 段
		{1024, false},
		{3000, false},
		{3001, false},
		{5173, false},  // vite
		{8000, false},
		{8080, false},
		{8888, false},
		{9090, false},
		{65535, false},

		// 拒绝:明确清单
		{22, true},    // ssh
		{25, true},    // smtp
		{111, true},   // rpcbind
		{445, true},   // smb
		{465, true},
		{587, true},
		{2375, true},  // docker
		{2376, true},
		{3306, true},  // mysql
		{3389, true},  // rdp
		{5432, true},  // postgres
		{5984, true},  // couchdb
		{6379, true},  // redis
		{9200, true},  // es
		{9300, true},
		{11211, true}, // memcached
		{27017, true},
		{27018, true},

		// 拒绝:所有 <1024 除 80/443
		{1, true},
		{21, true},
		{23, true},
		{53, true},
		{123, true},
		{1023, true},
	}
	for _, c := range cases {
		got := isDeniedPort(c.port)
		if got != c.denied {
			t.Errorf("isDeniedPort(%d) = %v, want %v", c.port, got, c.denied)
		}
	}
}

// V3 S12e CG5 — buildUpstreamRequest pure helper 单测。
//
// 直接覆盖三件事(无需拉 docker / hijack):
//   - X-Connection-Trace-Id 透传到上游容器(合同 A 数据面)
//   - 非 WS 路径下 hop-by-hop headers 被 drop
//   - 含 CR/LF 的 header value 被**整条丢弃**(CRLF 注入防御)

func TestBuildUpstreamRequest_ForwardsConnTrace(t *testing.T) {
	h := http.Header{}
	h.Set("X-Connection-Trace-Id", "valid-trace-id-1234567890ab")
	h.Set("Upgrade", "websocket")
	h.Set("Connection", "Upgrade")
	h.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	h.Set("Sec-WebSocket-Version", "13")

	out := string(buildUpstreamRequest("GET", "/ws", "127.0.0.1:3000", h, true))
	// request line
	if !strings.HasPrefix(out, "GET /ws HTTP/1.1\r\n") {
		t.Fatalf("expected GET /ws request line, got: %q", out)
	}
	if !strings.Contains(out, "Host: 127.0.0.1:3000\r\n") {
		t.Errorf("expected Host header, got %q", out)
	}
	// trace 头透传(不在 hop-by-hop drop list)
	if !strings.Contains(out, "X-Connection-Trace-Id: valid-trace-id-1234567890ab\r\n") {
		t.Errorf("expected X-Connection-Trace-Id forwarded to upstream, got %q", out)
	}
	// WS 路径下 Upgrade / Connection 保留
	if !strings.Contains(out, "Upgrade: websocket\r\n") {
		t.Errorf("expected Upgrade: websocket retained on WS path, got %q", out)
	}
	// 注:Go net/http 把 header key 走 CanonicalMIMEHeaderKey,"Sec-WebSocket-Key" →
	// "Sec-Websocket-Key"(只大写每个 "-" 后第一个字母)。值不被改,容器内的 WS server
	// header 解析 case-insensitive,upstream 正确收得到。
	if !strings.Contains(out, "Sec-Websocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n") {
		t.Errorf("expected Sec-WebSocket-Key forwarded (canonical form), got %q", out)
	}
	// 结尾 CRLF
	if !strings.HasSuffix(out, "\r\n\r\n") {
		t.Errorf("expected request to end with CRLFCRLF, got tail %q", out[len(out)-8:])
	}
}

func TestBuildUpstreamRequest_DropsHopByHopOnNonWs(t *testing.T) {
	h := http.Header{}
	h.Set("Connection", "keep-alive")
	h.Set("Keep-Alive", "timeout=5")
	h.Set("Proxy-Authorization", "Basic xxx")
	h.Set("Te", "trailers")
	h.Set("Trailers", "Expires")
	h.Set("Transfer-Encoding", "chunked")
	h.Set("Upgrade", "h2c")
	h.Set("X-Custom-App", "kept") // 应保留
	h.Set("X-Openclaude-Trace-Id", "01234567890abcdef01234567890abcd")

	out := string(buildUpstreamRequest("POST", "/api", "127.0.0.1:8080", h, false))

	mustNot := []string{
		"Connection:", "Keep-Alive:", "Proxy-Authorization:", "Te:",
		"Trailers:", "Transfer-Encoding:", "Upgrade:",
	}
	for _, m := range mustNot {
		if strings.Contains(out, m) {
			t.Errorf("hop-by-hop %q must be dropped on non-WS path, but found in: %q", m, out)
		}
	}
	if !strings.Contains(out, "X-Custom-App: kept\r\n") {
		t.Errorf("non-hop-by-hop X-Custom-App must be forwarded, got %q", out)
	}
	// turn-level trace 头也应该透传到容器(给容器内 OpenClaude /ws 用)
	if !strings.Contains(out, "X-Openclaude-Trace-Id: 01234567890abcdef01234567890abcd\r\n") {
		t.Errorf("X-Openclaude-Trace-Id must be forwarded to in-container service, got %q", out)
	}
}

func TestBuildUpstreamRequest_DropsCRLFHeaderValues(t *testing.T) {
	// 直接 http.Header.Set CR/LF Go 会 panic;构造 raw map 测试 helper 内部 CRLF 防护。
	h := http.Header{
		"X-Evil":     []string{"injected\r\nLog: poisoned"},
		"X-Legit":    []string{"kept-value"},
		"X-Mixed":    []string{"good", "bad\rline"},
	}
	out := string(buildUpstreamRequest("GET", "/path", "127.0.0.1:80", h, false))
	if strings.Contains(out, "injected") || strings.Contains(out, "poisoned") {
		t.Errorf("CRLF-injected header value must be dropped entirely, got %q", out)
	}
	if !strings.Contains(out, "X-Legit: kept-value\r\n") {
		t.Errorf("clean header must be preserved, got %q", out)
	}
	if !strings.Contains(out, "X-Mixed: good\r\n") {
		t.Errorf("clean value in multi-value header must be preserved, got %q", out)
	}
	if strings.Contains(out, "X-Mixed: bad\rline") || strings.Contains(out, "bad\rline") {
		t.Errorf("CR-injected sibling value must be dropped, got %q", out)
	}
}
