// Package logging 封装 slog 标准库,统一 JSON 输出到 stderr(由 systemd 收走)。
//
// 禁止记录 psk / authorization header / cert 私钥等敏感内容,在 authmw 层面 mask。
package logging

import (
	"log/slog"
	"os"
)

var Logger *slog.Logger

func Init(debug bool) {
	level := slog.LevelInfo
	if debug {
		level = slog.LevelDebug
	}
	h := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: level,
	})
	Logger = slog.New(h).With("app", "node-agent")
}

func L() *slog.Logger {
	if Logger == nil {
		Init(false)
	}
	return Logger
}
