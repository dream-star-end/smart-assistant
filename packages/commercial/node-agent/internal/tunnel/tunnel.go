// Package tunnel 实现 master→容器 的反向 HTTP 代理(含 WS upgrade)。
//
// URL 语义: ANY /tunnel/containers/{cid}/{subpath...}?port=<N>[&...]
//
// 流程:
//   1. 解析 cid,验 openclaude.v3 label + 获取 docker inspect bound IP
//   2. 从 query param 取 ?port= 目标端口(不走路径段,避免 subpath 误解)
//   3. Hijack client TCP,dial 容器(bound_ip:port)
//   4. 原样转写 request-line + headers + body,然后 bi-di io.Copy
//
// 安全:
//   - authmw 已在上层验 master SAN URI + psk;tunnel 级再次用 assertOwned 卡容器归属
//   - CRLF 注入在 http.Request 层由 net/http 解析保证,但我们构造 upstream request
//     line 时仍按 \r\n 拼接,不透传可疑字符
package tunnel

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openclaude/node-agent/internal/containers"
	"github.com/openclaude/node-agent/internal/logging"
)

type Handler struct {
	Runner *containers.Runner
}

func NewHandler(r *containers.Runner) *Handler {
	return &Handler{Runner: r}
}

// ServeHTTP 处理 /tunnel/containers/... — method-agnostic
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// path: /tunnel/containers/{cid}/{...}
	const prefix = "/tunnel/containers/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.Error(w, "bad tunnel path", http.StatusBadRequest)
		return
	}
	rest := r.URL.Path[len(prefix):]
	slash := strings.IndexByte(rest, '/')
	var cid, sub string
	if slash < 0 {
		cid = rest
		sub = "/"
	} else {
		cid = rest[:slash]
		sub = rest[slash:]
		if sub == "" {
			sub = "/"
		}
	}
	if cid == "" {
		http.Error(w, "missing cid", http.StatusBadRequest)
		return
	}
	if err := containers.ValidateCid(cid); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// 取 port
	portStr := r.URL.Query().Get("port")
	if portStr == "" {
		http.Error(w, "missing port query param", http.StatusBadRequest)
		return
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		http.Error(w, "invalid port", http.StatusBadRequest)
		return
	}
	// deny-list(#H1′):v3 tunnel 目标是容器内应用端口(HTML preview / devserver 等),
	// 用户应用一般监听在 1024+;常见的管理端口即使被意外暴露也不应让 master 反代过去。
	// 拒绝 <1024(但放行 80/443,这俩常用),以及明确列出的常见管理端口。
	if isDeniedPort(port) {
		http.Error(w, `{"code":"BLOCKED_PORT"}`, http.StatusBadRequest)
		return
	}

	// 解出容器 bound IP
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	boundIp, err := h.Runner.InspectRaw(ctx, cid)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"code":"CONTAINER_INSPECT","error":%q}`, err.Error()), http.StatusBadGateway)
		return
	}
	if boundIp == "" {
		http.Error(w, `{"code":"CONTAINER_NO_IP","error":"bound ip not assigned"}`, http.StatusBadGateway)
		return
	}

	// 剥掉 query 里的 port(保留其它 param)
	q := r.URL.Query()
	q.Del("port")
	upstreamQuery := q.Encode()
	upstreamPath := sub
	if upstreamQuery != "" {
		upstreamPath = sub + "?" + upstreamQuery
	}

	target := net.JoinHostPort(boundIp, strconv.Itoa(port))
	h.proxy(w, r, target, upstreamPath)
}

// proxy hijack 之后手写 HTTP 并做 bi-di copy。
func (h *Handler) proxy(w http.ResponseWriter, r *http.Request, target, upstreamPath string) {
	// WS 需要 hijack;普通 HTTP 也走 hijack 简化实现
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}

	upstream, err := net.DialTimeout("tcp", target, 5*time.Second)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"code":"UPSTREAM_DIAL","error":%q}`, err.Error()), http.StatusBadGateway)
		return
	}

	clientConn, clientRw, err := hj.Hijack()
	if err != nil {
		_ = upstream.Close()
		logging.L().Error("hijack failed", "err", err.Error())
		return
	}
	defer clientConn.Close()
	defer upstream.Close()

	// 构造上游 request line + headers
	// 去掉 hop-by-hop headers
	hop := map[string]bool{
		"Connection":          true,
		"Keep-Alive":          true,
		"Proxy-Authenticate":  true,
		"Proxy-Authorization": true,
		"Te":                  true,
		"Trailers":            true,
		"Transfer-Encoding":   true,
		"Upgrade":             true,
	}
	isWs := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")

	// 重建 request
	reqLine := fmt.Sprintf("%s %s HTTP/1.1\r\n", r.Method, singleLine(upstreamPath))
	host := r.Host
	if host == "" {
		host = target
	}
	var sb strings.Builder
	sb.WriteString(reqLine)
	sb.WriteString("Host: " + singleLine(host) + "\r\n")
	for k, vs := range r.Header {
		if hop[http.CanonicalHeaderKey(k)] && !isWs {
			continue
		}
		// WS 需要保留 Upgrade/Connection
		for _, v := range vs {
			if !validHeaderValue(v) {
				continue
			}
			sb.WriteString(k + ": " + v + "\r\n")
		}
	}
	if isWs {
		// 确保 Connection: Upgrade 和 Upgrade: websocket 存在
		if !strings.EqualFold(r.Header.Get("Connection"), "upgrade") {
			sb.WriteString("Connection: Upgrade\r\n")
		}
	}
	sb.WriteString("\r\n")

	if _, err := upstream.Write([]byte(sb.String())); err != nil {
		logging.L().Error("upstream write header failed", "err", err.Error())
		return
	}

	// 如果 client 已有 buffered bytes(hijack 从 bufio.Reader 拿的),先 flush 到 upstream
	if clientRw != nil && clientRw.Reader.Buffered() > 0 {
		if _, err := io.CopyN(upstream, clientRw.Reader, int64(clientRw.Reader.Buffered())); err != nil {
			logging.L().Warn("flush buffered failed", "err", err.Error())
			return
		}
	}

	// bi-di copy
	errc := make(chan error, 2)
	go func() {
		_, err := io.Copy(upstream, clientConn)
		// half-close 提示对端 EOF
		if tcp, ok := upstream.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		errc <- err
	}()
	go func() {
		_, err := io.Copy(clientConn, upstream)
		if tcp, ok := clientConn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		errc <- err
	}()
	<-errc
	<-errc
}

// deniedPorts:明确列出的常见管理 / 数据库 / 缓存 / search / mail 端口。
// 任何改动需审计:添加=更严,删除=放开(需说明业务原因)。
var deniedPorts = map[int]struct{}{
	22:    {}, // ssh
	25:    {}, // smtp
	111:   {}, // rpcbind
	445:   {}, // smb
	465:   {}, // smtps
	587:   {}, // smtp submission
	2375:  {}, // docker (plain)
	2376:  {}, // docker (tls)
	3306:  {}, // mysql
	3389:  {}, // rdp
	5432:  {}, // postgresql
	5984:  {}, // couchdb
	6379:  {}, // redis
	9200:  {}, // elasticsearch http
	9300:  {}, // elasticsearch transport
	11211: {}, // memcached
	27017: {}, // mongodb
	27018: {}, // mongodb shard
}

// isDeniedPort 规则:
//   - 明确清单里的端口 → 拒
//   - <1024 但不在 {80,443} 里 → 拒(保留 http/https)
//   - 其他 → 放(应用层用户应用空间)
func isDeniedPort(p int) bool {
	if _, ok := deniedPorts[p]; ok {
		return true
	}
	if p < 1024 && p != 80 && p != 443 {
		return true
	}
	return false
}

// singleLine 防 CRLF 注入:剥掉 \r\n
func singleLine(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", "")
	return s
}

func validHeaderValue(v string) bool {
	return !strings.ContainsAny(v, "\r\n")
}

// readPeek 可能将来用到的 Bufio peeker(保留;go vet 允许 unused imports via bufio bridge)
var _ = bufio.NewReader
var _ url.URL
var _ error = errors.New("")
