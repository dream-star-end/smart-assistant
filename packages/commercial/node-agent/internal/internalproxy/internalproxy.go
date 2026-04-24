// Package internalproxy 实现 L7 反代:container plain HTTP → master mTLS HTTPS。
//
// 背景:
//   - 容器出站 anthropic API 流量,master 要用 (host_uuid, bound_ip) 定位容器身份。
//   - self host 不需要本进程(container 直连 master 的 INTERNAL_PROXY 18791)。
//   - remote host 则:container → plain HTTP 到 bridge gw (172.30.X.1:18791) →
//     **本 handler** → mTLS HTTPS POST 到 master:18443(host leaf cert 作 client cert)→
//     master anthropicProxy 继续跑 verifyContainerIdentity → 上游 Anthropic。
//
// X-V3-Container-IP 头:客户端可能伪造,本 handler 一律剥掉 (X-V3-* 所有都剥),
// 然后用真实 r.RemoteAddr 重塞 —— master 侧 handleExternalMtls 三重校验该头。
package internalproxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/logging"
)

type Server struct {
	cfg       *config.Config
	subnet    *net.IPNet
	client    *http.Client
	masterURL string
	server    *http.Server
}

// shutdownGraceSec:SSE 流可能持续数分钟;shutdown 给 60s 宽限让 in-flight 请求
// 自然走完,到期再强断。比 5s 短窗口强断 SSE 友善很多。
const shutdownGraceSec = 60

// New 装配反代。cfg.InternalProxyBind / cfg.MasterMtlsURL 已被 Validate 校验过。
func New(cfg *config.Config) (*Server, error) {
	if cfg.InternalProxyBind == "" {
		return nil, fmt.Errorf("internal_proxy_bind not set")
	}
	_, subnet, err := net.ParseCIDR(cfg.BridgeCIDR)
	if err != nil {
		return nil, fmt.Errorf("parse bridge_cidr: %w", err)
	}

	// 初次加载:确保 cert/key/ca 路径能读出来,启动期有问题立刻报。
	if _, err := tls.LoadX509KeyPair(cfg.TLSCrt, cfg.TLSKey); err != nil {
		return nil, fmt.Errorf("load host leaf cert: %w", err)
	}
	caPem, err := os.ReadFile(cfg.CACrt)
	if err != nil {
		return nil, fmt.Errorf("read ca cert: %w", err)
	}
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caPem) {
		return nil, fmt.Errorf("parse ca cert pem")
	}

	// 证书热更新:GetClientCertificate 每次 TLS handshake 触发,重新从磁盘读 leaf cert。
	// 这样 baseline poller 替换磁盘上的 cert/key 后,下一个新连接(或 idle 过期重连)自动用新证书;
	// 无需重启进程。CA pool 放内存不变(主 CA 不轮换,靠 master 签新 leaf 即可)。
	getCert := func(_ *tls.CertificateRequestInfo) (*tls.Certificate, error) {
		c, err := tls.LoadX509KeyPair(cfg.TLSCrt, cfg.TLSKey)
		if err != nil {
			return nil, err
		}
		return &c, nil
	}

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			GetClientCertificate: getCert,
			RootCAs:              caPool,
			MinVersion:           tls.VersionTLS13, // 与 master D.1b minVersion 一致
		},
		// SSE 流式:拒绝压缩(避免 gzip 缓冲),ResponseHeader 之后不限 Body 长度。
		DisableCompression:    true,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// master 端 keep-alive 友好;但 idle too long 会被两边中间件关,这里留宽松。
		IdleConnTimeout: 90 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		// 不设 Timeout —— anthropic streaming 可以持续数分钟。各段超时由 Transport 分项控制。
		Timeout: 0,
	}

	return &Server{
		cfg:       cfg,
		subnet:    subnet,
		client:    client,
		masterURL: strings.TrimRight(cfg.MasterMtlsURL, "/"),
	}, nil
}

// ListenAndServe 阻塞直到 ctx done。
func (s *Server) ListenAndServe(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)

	s.server = &http.Server{
		Addr:    s.cfg.InternalProxyBind,
		Handler: mux,
		// 不设 ReadTimeout/WriteTimeout —— SSE 流可能很长;ReadHeaderTimeout 扛慢 header 攻击
		ReadHeaderTimeout: 10 * time.Second,
	}

	// ctx done → graceful shutdown(shutdownGraceSec 宽限);超过就强关。
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), shutdownGraceSec*time.Second)
		defer cancel()
		_ = s.server.Shutdown(shutCtx)
	}()

	logging.L().Info("internal proxy listening",
		"bind", s.cfg.InternalProxyBind,
		"master", s.masterURL,
		"subnet", s.cfg.BridgeCIDR,
	)
	err := s.server.ListenAndServe()
	if err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	// 1. 源 IP 必须在 bridge subnet 内(container 的 bound_ip)。
	rip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		http.Error(w, `{"error":{"code":"BAD_REMOTE_ADDR"}}`, http.StatusBadRequest)
		return
	}
	ip := net.ParseIP(rip)
	if ip == nil {
		http.Error(w, `{"error":{"code":"BAD_REMOTE_ADDR"}}`, http.StatusBadRequest)
		return
	}
	ip4 := ip.To4()
	if ip4 == nil || !s.subnet.Contains(ip4) {
		logging.L().Warn("internal-proxy reject: source outside bridge subnet", "remote", r.RemoteAddr)
		http.Error(w, `{"error":{"code":"SRC_NOT_IN_BRIDGE"}}`, http.StatusForbidden)
		return
	}
	containerIP := ip4.String()

	// 2. 构造上游 URL:保留 request-URI(path + query)。
	// r.URL.RequestURI() 返回原始 path(带 RawPath 编码)+ RawQuery,master anthropicProxy 按 path 分发。
	upstreamURL := s.masterURL + r.URL.RequestURI()

	// 3. 复制 request:strip hop-by-hop + strip X-V3-* 避免 client 伪造 hostUuid 等头。
	upReq, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL, r.Body)
	if err != nil {
		http.Error(w, `{"error":{"code":"BAD_REQ_BUILD"}}`, http.StatusBadRequest)
		return
	}
	copySafeHeaders(upReq.Header, r.Header)
	// 真实 container IP —— master handleExternalMtls 会再做 isIPv4 + CRLF 校验。
	upReq.Header.Set("X-V3-Container-IP", containerIP)
	// Content-Length 让 net/http 自行根据 Body 计算;Host 由 URL 决定。
	upReq.Host = ""

	// 4. dispatch。SSE 的话 Do 会在 header 回来时返回,Body 之后由我们流式转发。
	resp, err := s.client.Do(upReq)
	if err != nil {
		logging.L().Warn("internal-proxy upstream err",
			"remote", r.RemoteAddr, "err", err.Error())
		// 502 统一:容器看到的就是 "master 挂了",不区分 DNS/TLS/connect 细节
		http.Error(w, `{"error":{"code":"UPSTREAM"}}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// 5. 回写 header → 回写 body(SSE 时需要 Flusher)
	for k, vs := range resp.Header {
		if isHopHeader(http.CanonicalHeaderKey(k)) {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 8*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				// container 侧断了,直接 return。resp.Body 在 defer 里 close。
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			// io.EOF / net error 都是结束信号;不必日志(anthropic 1k req/s 时噪音太多)。
			return
		}
	}
}

// copySafeHeaders 把 src 复制到 dst,排除 hop-by-hop 头,排除 X-V3-* 前缀,
// 排除带 CRLF 的 header 值。
// RFC 7230 §6.1:除固定 hop-by-hop 列表外,Connection: 里列出的 token
// 也必须按 hop-by-hop 处理(允许上游标记自定义 per-connection 头)。
func copySafeHeaders(dst, src http.Header) {
	extraHop := connectionTokens(src)
	for k, vs := range src {
		ck := http.CanonicalHeaderKey(k)
		if isHopHeader(ck) {
			continue
		}
		if _, ok := extraHop[ck]; ok {
			continue
		}
		if strings.HasPrefix(ck, "X-V3-") {
			// 客户端可能伪造 X-V3-Host-UUID 等,一律丢;X-V3-Container-IP 由调用方重塞。
			continue
		}
		for _, v := range vs {
			if strings.ContainsAny(v, "\r\n") {
				continue
			}
			dst.Add(k, v)
		}
	}
}

// connectionTokens 解析 Connection 头里列出的 token,返回 canonical key 集合。
// 例如 "Connection: keep-alive, X-Custom" → {"Keep-Alive":{}, "X-Custom":{}}。
func connectionTokens(h http.Header) map[string]struct{} {
	out := map[string]struct{}{}
	for _, v := range h.Values("Connection") {
		for _, tok := range strings.Split(v, ",") {
			tok = strings.TrimSpace(tok)
			if tok == "" {
				continue
			}
			out[http.CanonicalHeaderKey(tok)] = struct{}{}
		}
	}
	return out
}

func isHopHeader(k string) bool {
	switch k {
	case "Connection",
		"Proxy-Connection", // 非标但常见,always strip
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Te",
		"Trailers",
		"Transfer-Encoding",
		"Upgrade":
		return true
	}
	return false
}
