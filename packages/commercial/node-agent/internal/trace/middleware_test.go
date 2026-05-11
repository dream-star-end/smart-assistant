package trace

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openclaude/node-agent/internal/logging"
)

// captureLogger 抓 slog JSON 输出到 buffer,用于断言 access log 字段。
func captureLogger(t *testing.T) (*slog.Logger, *strings.Builder) {
	t.Helper()
	var buf strings.Builder
	h := slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	return slog.New(h), &buf
}

// swapGlobalLogger 临时替换 logging.Logger,t.Cleanup 还原。不可平行运行。
func swapGlobalLogger(t *testing.T, l *slog.Logger) {
	t.Helper()
	old := logging.Logger
	logging.Logger = l
	t.Cleanup(func() { logging.Logger = old })
}

func TestHTTPMW_TunnelRoute_BindsConnectionTraceId(t *testing.T) {
	var captured *slog.Logger
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = LoggerFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
	l, buf := captureLogger(t)
	swapGlobalLogger(t, l)

	mw := HTTPMW(handler)
	req := httptest.NewRequest("GET", "/tunnel/containers/abc/ws?port=3000", nil)
	req.Header.Set("X-Connection-Trace-Id", "valid-trace-id-1234")
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if captured == nil {
		t.Fatal("handler did not run")
	}
	// 让 captured.Info 输出一条,断言 logger 已绑 connectionTraceId 字段
	captured.Info("probe")
	if !strings.Contains(buf.String(), `"connectionTraceId":"valid-trace-id-1234"`) {
		t.Errorf("expected connectionTraceId in logger context, got %q", buf.String())
	}
	// access log 也应该带
	if !strings.Contains(buf.String(), `"path":"/tunnel/containers/abc/ws"`) {
		t.Errorf("expected access log path, got %q", buf.String())
	}
}

func TestHTTPMW_ControlRoute_BindsTurnTraceId(t *testing.T) {
	var captured *slog.Logger
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = LoggerFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})
	l, buf := captureLogger(t)
	swapGlobalLogger(t, l)

	mw := HTTPMW(handler)
	req := httptest.NewRequest("POST", "/containers/run", nil)
	req.Header.Set("X-Openclaude-Trace-Id", "01234567890abcdef01234567890abcd") // 32 hex
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	captured.Info("probe")
	out := buf.String()
	if !strings.Contains(out, `"traceId":"01234567890abcdef01234567890abcd"`) {
		t.Errorf("expected traceId in logger context, got %q", out)
	}
	if strings.Contains(out, `"connectionTraceId":`) {
		t.Errorf("control route should not bind connectionTraceId, got %q", out)
	}
}

func TestHTTPMW_MissingHeader_FallbackIssueMissing_NoRawValueLog(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	l, buf := captureLogger(t)
	swapGlobalLogger(t, l)

	mw := HTTPMW(handler)
	req := httptest.NewRequest("POST", "/containers/run", nil)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	out := buf.String()
	if !strings.Contains(out, `"issue":"missing"`) {
		t.Errorf("expected issue=missing warn, got %q", out)
	}
	if !strings.Contains(out, `"traceId":"`) {
		t.Errorf("expected fallback traceId emitted in access log, got %q", out)
	}
}

func TestHTTPMW_InvalidHeader_NoRawValueInLog(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	l, buf := captureLogger(t)
	swapGlobalLogger(t, l)

	mw := HTTPMW(handler)
	req := httptest.NewRequest("POST", "/containers/run", nil)
	// Go net/http header set 会清 CR/LF 转义,直接传可触发 panic;
	// 用合法 HTTP header 字节但 charset 不合规(中文 / 路径符)即可触发 bad-charset
	poisonValue := "EVIL../INJECTED_LOG_LINE_aaaaaaaaaa"
	req.Header.Set("X-Openclaude-Trace-Id", poisonValue)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	out := buf.String()
	if strings.Contains(out, "EVIL") || strings.Contains(out, "INJECTED") {
		t.Fatalf("warn log leaked raw poison value: %q", out)
	}
	if !strings.Contains(out, `"issue":"bad-charset"`) {
		t.Errorf("expected issue=bad-charset, got %q", out)
	}
}

func TestHTTPMW_EmptyVsMissing_DistinctIssues(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})

	// case A: header 完全缺失 → issue=missing
	{
		l, buf := captureLogger(t)
		swapGlobalLogger(t, l)
		mw := HTTPMW(handler)
		req := httptest.NewRequest("POST", "/containers/run", nil)
		mw.ServeHTTP(httptest.NewRecorder(), req)
		if !strings.Contains(buf.String(), `"issue":"missing"`) {
			t.Errorf("absent header → expected issue=missing, got %q", buf.String())
		}
	}

	// case B: header 存在但值为空字符串 → issue=empty
	// Go net/http 在 req.Header.Set(k, "") 后 Values(k) 返回 [""],非空数组,
	// 走 ParseHeader(present=true, "") → ParseCandidate("") → empty。
	{
		l, buf := captureLogger(t)
		swapGlobalLogger(t, l)
		mw := HTTPMW(handler)
		req := httptest.NewRequest("POST", "/containers/run", nil)
		req.Header.Set("X-Openclaude-Trace-Id", "")
		mw.ServeHTTP(httptest.NewRecorder(), req)
		if !strings.Contains(buf.String(), `"issue":"empty"`) {
			t.Errorf("empty header value → expected issue=empty, got %q", buf.String())
		}
	}
}

// bareRW 仅实现 ResponseWriter 三方法,无 Hijacker/Flusher。
type bareRW struct {
	headers http.Header
	body    *strings.Builder
	code    int
}

func newBareRW() *bareRW { return &bareRW{headers: http.Header{}, body: &strings.Builder{}} }
func (w *bareRW) Header() http.Header         { return w.headers }
func (w *bareRW) Write(b []byte) (int, error) { return w.body.Write(b) }
func (w *bareRW) WriteHeader(code int)        { w.code = code }

// hijOnlyRW 实现 Hijacker,不实现 Flusher。
type hijOnlyRW struct{ *bareRW }

func (w *hijOnlyRW) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, fmt.Errorf("test stub hijack")
}

// flushOnlyRW 实现 Flusher,不实现 Hijacker。
type flushOnlyRW struct{ *bareRW }

func (w *flushOnlyRW) Flush() {}

// hjFlRW 都实现。
type hjFlRW struct{ *bareRW }

func (w *hjFlRW) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, fmt.Errorf("test stub hijack")
}
func (w *hjFlRW) Flush() {}

// TestHTTPMW_OptionalInterfaceCapabilityMirror 直击 plan v2 BLOCKER 1 修复:
// wrapper 暴露的可选接口集必须**等于**底层 ResponseWriter 实际实现的集合,
// 不能假阳性(给 bare RW 凭空塞 Hijacker)。
func TestHTTPMW_OptionalInterfaceCapabilityMirror(t *testing.T) {
	cases := []struct {
		name     string
		makeBase func() http.ResponseWriter
		wantHJ   bool
		wantFL   bool
	}{
		{"bare ResponseWriter", func() http.ResponseWriter { return newBareRW() }, false, false},
		{"Hijacker only", func() http.ResponseWriter { return &hijOnlyRW{newBareRW()} }, true, false},
		{"Flusher only", func() http.ResponseWriter { return &flushOnlyRW{newBareRW()} }, false, true},
		{"Hijacker + Flusher", func() http.ResponseWriter { return &hjFlRW{newBareRW()} }, true, true},
	}
	l, _ := captureLogger(t)
	swapGlobalLogger(t, l)
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			var gotHJ, gotFL bool
			handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, gotHJ = w.(http.Hijacker)
				_, gotFL = w.(http.Flusher)
				w.WriteHeader(http.StatusOK)
			})
			mw := HTTPMW(handler)
			req := httptest.NewRequest("POST", "/containers/run", nil)
			req.Header.Set("X-Openclaude-Trace-Id", "01234567890abcdef01234567890abcd")
			mw.ServeHTTP(c.makeBase(), req)
			if gotHJ != c.wantHJ {
				t.Errorf("Hijacker capability: got %v want %v", gotHJ, c.wantHJ)
			}
			if gotFL != c.wantFL {
				t.Errorf("Flusher capability: got %v want %v", gotFL, c.wantFL)
			}
		})
	}
}
