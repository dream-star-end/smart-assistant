package trace

import (
	"context"
	"log/slog"

	"github.com/openclaude/node-agent/internal/logging"
)

// loggerCtxKey 是 context.Value 的私有 key 类型,避免与第三方 ctx 撞键。
type loggerCtxKey struct{}

// WithLogger 把已绑定 trace 字段的 slog logger 注入到 ctx,downstream
// 通过 LoggerFromContext 取出复用。HTTPMW 在请求入口调一次。
func WithLogger(parent context.Context, l *slog.Logger) context.Context {
	return context.WithValue(parent, loggerCtxKey{}, l)
}

// LoggerFromContext 从 ctx 取出 logger;若没有(测试 / 直接被 mux 调用 / nil ctx),
// 回退到全局 logging.L() — 永远返回非 nil。
//
// 调用方原则:打 log 时优先用 LoggerFromContext(r.Context()),把 trace 字段
// 带进每条业务日志。不强制 — 老代码 logging.L() 直调也能用,只是少了 trace 字段。
func LoggerFromContext(ctx context.Context) *slog.Logger {
	if ctx == nil {
		return logging.L()
	}
	if l, ok := ctx.Value(loggerCtxKey{}).(*slog.Logger); ok && l != nil {
		return l
	}
	return logging.L()
}
