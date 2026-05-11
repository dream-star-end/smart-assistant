// Package trace 是 v3 S12e 跨语言 trace_id 端到端的 Go 端实现。
//
// 复制 TS `packages/protocol/src/traceId.ts`:
//   - parseTraceIdCandidate(unknown) → ParseCandidate(any)
//   - newTraceId()                   → NewTraceID()
//
// 跨语言契约由 `packages/protocol/testdata/trace-id-cases.json` 兜底,
// 任何对 issue 优先级 / 字符集 / 长度阈值的改动必须同时更新 TS 端与 fixture。
//
// 失败原因优先级(与 TS 严格一致):
//   missing → wrong-type → empty → bad-charset → too-short → too-long
//
// 安全要点:
//   - 日志层只记 issue 名(本包提供 enum),**不**记 raw 值 — 防 log injection / DoS
//   - byte length 用于阈值判断;合法 charset 全 ASCII,与 TS `.length` 等价
package trace

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
)

// Issue 是 ParseCandidate 失败时返回的归因 enum。logger 应只记此 enum,**不**记 raw 值。
type Issue string

const (
	IssueMissing    Issue = "missing"
	IssueWrongType  Issue = "wrong-type"
	IssueEmpty      Issue = "empty"
	IssueBadCharset Issue = "bad-charset"
	IssueTooShort   Issue = "too-short"
	IssueTooLong    Issue = "too-long"
)

// traceCharset 必须与 TS 端 TRACE_ID_CHARSET 完全一致。Go 不做长度+字符集合并
// (与 TS TRACE_ID_REGEX 二步走的语义对齐),以便 charset 优先级高于 too-short。
var traceCharset = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// ParseCandidate 接受 any(用于跨 rawType 的 fixture-driven 测试),返回:
//
//   - ok=true:  id, "", true   — id 与 raw 完全一致(不 trim、不 normalize)
//   - ok=false: "", issue, false
//
// raw 可以是 nil / string / 任何其它类型;**byte length**(非 rune count)用于阈值判断。
// 合法 charset 全 ASCII,Go byte length 与 TS `.length`(UTF-16 code unit)在此范围等价。
//
// 与 TS 同步:不做 trim,不做 normalize,空白等价 bad-charset(不在 charset 内)。
func ParseCandidate(raw any) (string, Issue, bool) {
	if raw == nil {
		return "", IssueMissing, false
	}
	s, ok := raw.(string)
	if !ok {
		return "", IssueWrongType, false
	}
	if len(s) == 0 {
		return "", IssueEmpty, false
	}
	if !traceCharset.MatchString(s) {
		return "", IssueBadCharset, false
	}
	if len(s) < 16 {
		return "", IssueTooShort, false
	}
	if len(s) > 64 {
		return "", IssueTooLong, false
	}
	return s, "", true
}

// ParseHeader 是 Go HTTP server 常见路径的便利函数。
//
//   - present=false → IssueMissing(等价 TS undefined 分支)
//   - present=true  → 走 ParseCandidate(rawValue)
//
// Header 多值数组 unwrap(`r.Header.Values(k)[0]`)由 caller 完成,本函数不参与;
// 跨语言契约 fixture 的 headerArrayCases 也是按这个规约设计。
func ParseHeader(rawValue string, present bool) (string, Issue, bool) {
	if !present {
		return "", IssueMissing, false
	}
	return ParseCandidate(rawValue)
}

// NewTraceID 生成 16 bytes hex = 32 chars,落在 TRACE_ID_REGEX 合法范围。
// 与 TS `newTraceId()` 输出格式一致;fixture `32-hex newTraceId shape` case 覆盖。
//
// 错误兜底:crypto/rand.Read 在 Linux 由 getrandom 提供,理论不会失败。失败时
// 落 sentinel 32 字符全零字符串而非 panic — 本函数仅给 fallback log 路径用,
// panic 会影响业务请求 handler。全 0 hex 在监控面板里很显眼,运维易识别。
func NewTraceID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000000000000000000000000000"
	}
	return hex.EncodeToString(b[:])
}
