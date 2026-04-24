package internalproxy

import (
	"net/http"
	"strings"
	"testing"
)

func TestIsHopHeader(t *testing.T) {
	positives := []string{
		"Connection",
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Te",
		"Trailers",
		"Transfer-Encoding",
		"Upgrade",
	}
	for _, h := range positives {
		if !isHopHeader(h) {
			t.Errorf("expected %q to be hop header", h)
		}
	}
	negatives := []string{
		"Content-Type", "Content-Length", "Authorization", "Accept", "X-V3-Container-IP",
	}
	for _, h := range negatives {
		if isHopHeader(h) {
			t.Errorf("expected %q to NOT be hop header", h)
		}
	}
}

func TestCopySafeHeaders_stripsHopByHop(t *testing.T) {
	src := http.Header{}
	src.Set("Content-Type", "application/json")
	src.Set("Connection", "keep-alive")
	src.Set("Transfer-Encoding", "chunked")
	src.Set("Upgrade", "h2c")
	src.Set("Authorization", "Bearer abc")

	dst := http.Header{}
	copySafeHeaders(dst, src)

	if dst.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type lost: %q", dst.Get("Content-Type"))
	}
	if dst.Get("Authorization") != "Bearer abc" {
		t.Errorf("Authorization lost: %q", dst.Get("Authorization"))
	}
	for _, h := range []string{"Connection", "Transfer-Encoding", "Upgrade"} {
		if dst.Get(h) != "" {
			t.Errorf("hop-by-hop %q leaked: %q", h, dst.Get(h))
		}
	}
}

func TestCopySafeHeaders_stripsXV3Prefix(t *testing.T) {
	// 客户端伪造 X-V3-Host-UUID 等,必须剥掉;handler 会重塞 X-V3-Container-IP
	src := http.Header{}
	src.Set("X-V3-Host-UUID", "attacker-host")
	src.Set("X-V3-Container-IP", "6.6.6.6")
	src.Set("X-V3-Anything", "payload")
	src.Set("Content-Type", "application/json")

	dst := http.Header{}
	copySafeHeaders(dst, src)

	if dst.Get("X-V3-Host-UUID") != "" {
		t.Errorf("X-V3-Host-UUID leaked: %q", dst.Get("X-V3-Host-UUID"))
	}
	if dst.Get("X-V3-Container-IP") != "" {
		t.Errorf("X-V3-Container-IP leaked (handler should reset it): %q", dst.Get("X-V3-Container-IP"))
	}
	if dst.Get("X-V3-Anything") != "" {
		t.Errorf("X-V3-Anything leaked: %q", dst.Get("X-V3-Anything"))
	}
	if dst.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type dropped")
	}
}

func TestCopySafeHeaders_stripsCRLFValues(t *testing.T) {
	// header smuggling 防御:含 \r\n 的 header value 直接丢,不做 sanitize
	src := http.Header{}
	src.Set("Content-Type", "application/json")
	// net/http 的 Header.Set 会自己丢 \n 吗?Add 更原始。手动塞
	src["X-Evil"] = []string{"normal\r\nX-V3-Container-IP: 6.6.6.6"}
	src["X-Multi-Line"] = []string{"line1\nline2"}

	dst := http.Header{}
	copySafeHeaders(dst, src)

	if dst.Get("X-Evil") != "" {
		t.Errorf("X-Evil with CRLF was copied: %q", dst.Get("X-Evil"))
	}
	if dst.Get("X-Multi-Line") != "" {
		t.Errorf("X-Multi-Line with LF was copied: %q", dst.Get("X-Multi-Line"))
	}
	if dst.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type lost")
	}
}

func TestCopySafeHeaders_stripsConnectionTokens(t *testing.T) {
	// RFC 7230 §6.1:Connection 头里列的 token 也必须按 hop-by-hop 处理。
	src := http.Header{}
	src.Set("Content-Type", "application/json")
	src.Set("Connection", "keep-alive, X-Custom-Hop")
	src.Set("X-Custom-Hop", "leaked")
	src.Set("Proxy-Connection", "keep-alive") // 非标准但常见
	src.Set("X-Keep", "stays")

	dst := http.Header{}
	copySafeHeaders(dst, src)

	if dst.Get("X-Custom-Hop") != "" {
		t.Errorf("X-Custom-Hop (listed in Connection) leaked: %q", dst.Get("X-Custom-Hop"))
	}
	if dst.Get("Proxy-Connection") != "" {
		t.Errorf("Proxy-Connection leaked: %q", dst.Get("Proxy-Connection"))
	}
	if dst.Get("Connection") != "" {
		t.Errorf("Connection leaked: %q", dst.Get("Connection"))
	}
	if dst.Get("X-Keep") != "stays" {
		t.Errorf("X-Keep should be preserved")
	}
	if dst.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type lost")
	}
}

func TestCopySafeHeaders_caseInsensitivePrefix(t *testing.T) {
	// X-V3-* 前缀匹配应走 CanonicalHeaderKey,大小写无关
	src := http.Header{}
	src["x-v3-HOST-uuid"] = []string{"attacker"} // 小写混大写
	src["X-v3-Weird"] = []string{"payload"}

	dst := http.Header{}
	copySafeHeaders(dst, src)

	for k := range dst {
		if strings.HasPrefix(strings.ToUpper(k), "X-V3-") {
			t.Errorf("X-V3-* prefix leaked: %q", k)
		}
	}
}
