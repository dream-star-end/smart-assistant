package trace

import (
	"bufio"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/openclaude/node-agent/internal/logging"
)

const (
	// HeaderTurnTrace 与 TS `packages/protocol/src/traceId.ts` TRACE_ID_HEADER 字面对齐
	// (turn-level / 合同 B)。Go net/http 大小写不敏感(CanonicalMIMEHeaderKey),
	// 这里保留 X-Openclaude-Trace-Id 以与 TS 端 lowercase 'x-openclaude-trace-id' 对应。
	HeaderTurnTrace = "X-Openclaude-Trace-Id"
	// HeaderConnTrace 与 master `tunnelContainerSocket._buildTunnelHeaders` 字面对齐
	// (connection-level / 合同 A)。
	HeaderConnTrace = "X-Connection-Trace-Id"
)

// HTTPMW 是 trace 注入中间件,挂在 authmw 内层、业务 mux 外层。
//
// 行为:
//   - /tunnel/containers/*    路径:读 HeaderConnTrace,slog field = "connectionTraceId"
//   - 其它(/containers/* 等):读 HeaderTurnTrace,slog field = "traceId"
//   - 头缺失 / 不合法 → NewTraceID() 兜底 + slog.Warn(issue) **不带 raw 值**
//   - defer 写一条 request-level access log:method / path / status / durMs + trace 字段
//
// access log 给控制面合同 B 在 Go 侧最小可观测落点;业务 handler 不强制切到
// LoggerFromContext,留 follow-up commit 单独推。
//
// **不实现** http.Hijacker / http.Flusher 等可选接口的"统一暴露"——见 wrapWithStatus,
// 严格按底层 ResponseWriter 的能力组合返回对应 wrapper 类型,避免假阳性破坏 type assertion。
func HTTPMW(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var field, headerOf string
		if strings.HasPrefix(r.URL.Path, "/tunnel/containers/") {
			field, headerOf = "connectionTraceId", HeaderConnTrace
		} else {
			field, headerOf = "traceId", HeaderTurnTrace
		}

		// r.Header.Values 返回 nil(absent) 或 ≥1 长度切片。
		// 多值场景按 fixture headerArrayCases 规约:取 [0],其余忽略。
		values := r.Header.Values(headerOf)
		var rawValue string
		present := len(values) > 0
		if present {
			rawValue = values[0]
		}
		id, issue, ok := ParseHeader(rawValue, present)
		if !ok {
			// fallback + warn,**不带 raw 值**(防 log injection / log size DoS)
			id = NewTraceID()
			logging.L().Warn("invalid trace header",
				"field", field,
				"issue", string(issue),
				"method", r.Method,
				"path", r.URL.Path)
		}
		l := logging.L().With(field, id)
		ctx := WithLogger(r.Context(), l)

		sw, base := wrapWithStatus(w)
		started := time.Now()
		defer func() {
			status := base.status
			if !base.wroteHeader {
				// hijacked / handler 既未 Write 也未 WriteHeader → sentinel -1
				// 运维看到 -1 立刻识别为 long-lived connection,prom 也不会聚合错。
				status = -1
			}
			l.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", status,
				"durMs", time.Since(started).Milliseconds())
		}()
		next.ServeHTTP(sw, r.WithContext(ctx))
	})
}

// statusCapturingBase 仅实现 ResponseWriter 三方法,**不主动**实现可选接口。
// 真正的 Hijacker / Flusher 暴露由 wrapWithStatus 按底层能力组合决定。
type statusCapturingBase struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusCapturingBase) WriteHeader(code int) {
	if !w.wroteHeader {
		w.status = code
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusCapturingBase) Write(b []byte) (int, error) {
	if !w.wroteHeader {
		w.status = http.StatusOK
		w.wroteHeader = true
	}
	return w.ResponseWriter.Write(b)
}

// wrapWithStatus 按底层 ResponseWriter 实际实现的可选接口组合,选 4 个 wrapper
// 变体之一返回。**绝不**给一个 bare RW 凭空塞 Hijacker / Flusher:
//
//   - tunnel.proxy() 现有 `w.(http.Hijacker)` 探测必须保持"假者为假"
//     (httptest.ResponseRecorder + bare custom RW 走 ok=false → 500 短路)
//   - 假阳性 Hijacker 会让 .Hijack() 返回 error 而非 type assertion 失败,
//     改变 tunnel error 路径语义
//
// 返回值:
//   - 第一个 http.ResponseWriter:实际暴露的 wrapper(可被 type-assert 到对应可选接口)
//   - 第二个 *statusCapturingBase:base 引用,供 defer 读 status/wroteHeader
func wrapWithStatus(w http.ResponseWriter) (http.ResponseWriter, *statusCapturingBase) {
	base := &statusCapturingBase{ResponseWriter: w}
	h, isH := w.(http.Hijacker)
	f, isF := w.(http.Flusher)
	switch {
	case isH && isF:
		return &swHF{statusCapturingBase: base, h: h, f: f}, base
	case isH:
		return &swH{statusCapturingBase: base, h: h}, base
	case isF:
		return &swF{statusCapturingBase: base, f: f}, base
	default:
		return base, base
	}
}

type swH struct {
	*statusCapturingBase
	h http.Hijacker
}

// Hijack 后 wroteHeader 状态丢失,defer access log 会用 sentinel -1 表达。
func (w *swH) Hijack() (net.Conn, *bufio.ReadWriter, error) { return w.h.Hijack() }

type swF struct {
	*statusCapturingBase
	f http.Flusher
}

func (w *swF) Flush() { w.f.Flush() }

type swHF struct {
	*statusCapturingBase
	h http.Hijacker
	f http.Flusher
}

func (w *swHF) Hijack() (net.Conn, *bufio.ReadWriter, error) { return w.h.Hijack() }
func (w *swHF) Flush()                                       { w.f.Flush() }
