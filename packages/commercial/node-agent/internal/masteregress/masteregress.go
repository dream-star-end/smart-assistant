// Package masteregress 实现 master → api.anthropic.com 的 mTLS HTTP CONNECT forward proxy
// (监听 :9444,在每台 compute_host 上,master 端 egressDispatcher 拨入)。
//
// 架构(0038):
//   - 每台 compute_host 都有此 listener,以本机 NIC 出口为锚点。
//   - master 把 OAuth 账号绑到 host 后,该账号所有 chat 请求经 master.fetch.dispatcher
//     发到 https://<host>:9444 ,CONNECT api.anthropic.com:443,再 raw TCP forward。
//   - 容器→本机 :3128 → master 的链路不动。:9444 是新增旁路,只服务 master 自己的
//     "账号专属稳定 IP" 需求。
//
// 信任面(独立于 :9443 RPC 与 :3128 容器 egress):
//   - mTLS,client cert 必须出示 master leaf(SAN URI = spiffe://openclaude/master)
//   - 第二因子:Authorization: Bearer <psk-hex>(同 :9443 用同一 psk 文件)
//   - 目标 hardcoded api.anthropic.com:443;任何其他 host:port 直接 403
//
// 失败模式 / 安全:
//   - hijack 之前 401/403/405 走 http.Error JSON;hijack 之后纯 raw TCP
//   - 读 CONNECT 后 10s 上游 dial 超时;之后两条 io.Copy 不设硬超时(SSE 流可能很长)
//   - 不解析 master 的 CONNECT 请求里的任何业务头(没有也不需要)— 我们只关心
//     "谁来了 + 上哪去",身份在 mTLS+PSK,目的地在 CONNECT URI
package masteregress

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/logging"
)

// MasterSpiffeURI 与 authmw 镜像;单独定义避免反向依赖 authmw 包。
const MasterSpiffeURI = "spiffe://openclaude/master"

// AllowedTarget 仅放行此 authority 的 CONNECT。任何 typo / 风控绕道都会被拒。
// hostname 部分小写比对;端口必须严格 443。
const AllowedTargetHost = "api.anthropic.com"
const AllowedTargetPort = "443"

// 上游 dial 超时(api.anthropic.com TCP 握手)
const upstreamDialTimeout = 10 * time.Second

// CONNECT 请求 read header 超时
const readHeaderTimeout = 10 * time.Second

type Server struct {
	cfg    *config.Config
	cert   atomic.Pointer[tls.Certificate]
	caPool *x509.CertPool

	pskRef atomic.Pointer[[]byte]
	pskMu  sync.Mutex
	pskAt  time.Time
}

// New 构造但不启动。bind 空时 main 不会调 ListenAndServe。
func New(cfg *config.Config) (*Server, error) {
	caBytes, err := os.ReadFile(cfg.CACrt)
	if err != nil {
		return nil, fmt.Errorf("masteregress: read ca: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		return nil, fmt.Errorf("masteregress: ca_cert not valid PEM chain")
	}
	s := &Server{cfg: cfg, caPool: pool}
	if err := s.reloadCert(); err != nil {
		return nil, err
	}
	if err := s.reloadPsk(); err != nil {
		return nil, err
	}
	return s, nil
}

// ReloadCert 由 renew handler 在 deliver 新 leaf 后调,原子切换 :9444 出示的证书。
// 无此方法 cert 续期后 :9444 仍出示旧 cert,master egressDispatcher 会因 fingerprint
// pinning 不匹配而握手失败。新连接用新 cert,旧连接保持(atomic.Pointer 语义)。
func (s *Server) ReloadCert() error {
	cert, err := tls.LoadX509KeyPair(s.cfg.TLSCrt, s.cfg.TLSKey)
	if err != nil {
		return fmt.Errorf("masteregress: load cert/key: %w", err)
	}
	s.cert.Store(&cert)
	return nil
}

func (s *Server) reloadCert() error { return s.ReloadCert() }

// reloadPsk 60s 节流。和 authmw 各持一份是 ok 的:同一 psk 文件,两路读各算各的。
func (s *Server) reloadPsk() error {
	s.pskMu.Lock()
	defer s.pskMu.Unlock()
	if time.Since(s.pskAt) < 60*time.Second && s.pskRef.Load() != nil {
		return nil
	}
	b, err := s.cfg.ReadPsk()
	if err != nil {
		return err
	}
	s.pskRef.Store(&b)
	s.pskAt = time.Now()
	return nil
}

func (s *Server) getCertForClient(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	c := s.cert.Load()
	if c == nil {
		return nil, errors.New("masteregress: no cert loaded")
	}
	return c, nil
}

// ListenAndServe 阻塞直到 ctx done 或 listener 出错。
func (s *Server) ListenAndServe(ctx context.Context) error {
	if s.cfg.MasterEgressBind == "" {
		// main 不应该走到这条路径,稳妥起见再判一次
		return errors.New("masteregress: bind empty (disabled)")
	}
	tlsCfg := &tls.Config{
		GetCertificate: s.getCertForClient,
		ClientCAs:      s.caPool,
		ClientAuth:     tls.RequireAndVerifyClientCert,
		MinVersion:     tls.VersionTLS12,
	}
	srv := &http.Server{
		Addr:              s.cfg.MasterEgressBind,
		TLSConfig:         tlsCfg,
		Handler:           http.HandlerFunc(s.handle),
		ReadHeaderTimeout: readHeaderTimeout,
	}
	errc := make(chan error, 1)
	go func() {
		logging.L().Info("master egress proxy listening", "bind", s.cfg.MasterEgressBind)
		err := srv.ListenAndServeTLS("", "")
		if err != nil && err != http.ErrServerClosed {
			errc <- err
		}
		close(errc)
	}()
	select {
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(sctx)
	case err := <-errc:
		return err
	}
}

// handle 只接 CONNECT api.anthropic.com:443。其他一律 4xx。
func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.Error(w, `{"code":"METHOD","error":"only CONNECT"}`, http.StatusMethodNotAllowed)
		return
	}
	// 1) SAN URI = master spiffe(链验证已由 tls.Config 做)
	if !peerHasMasterSAN(r) {
		logging.L().Warn("masteregress reject: no master SAN", "remote", r.RemoteAddr)
		http.Error(w, `{"code":"AUTH_SAN","error":"client cert SAN mismatch"}`, http.StatusForbidden)
		return
	}
	// 2) Bearer PSK
	ah := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(ah, prefix) {
		logging.L().Warn("masteregress reject: no bearer", "remote", r.RemoteAddr)
		http.Error(w, `{"code":"AUTH_MISSING","error":"bearer required"}`, http.StatusUnauthorized)
		return
	}
	given := []byte(strings.TrimSpace(ah[len(prefix):]))
	if err := s.reloadPsk(); err != nil {
		logging.L().Error("masteregress psk reload failed (serving stale)", "err", err.Error())
	}
	ref := s.pskRef.Load()
	if ref == nil || len(*ref) == 0 {
		http.Error(w, `{"code":"AUTH_SERVER","error":"psk unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	expected := *ref
	if len(given) != len(expected) || subtle.ConstantTimeCompare(given, expected) != 1 {
		logging.L().Warn("masteregress reject: bearer mismatch", "remote", r.RemoteAddr)
		http.Error(w, `{"code":"AUTH_BEARER","error":"bearer invalid"}`, http.StatusUnauthorized)
		return
	}
	// 3) CONNECT 目标白名单。Go http.Server 把 CONNECT 的 authority 放 r.Host
	authority := r.Host
	if authority == "" && r.URL != nil {
		authority = r.URL.Host
	}
	host, port, err := net.SplitHostPort(authority)
	if err != nil {
		http.Error(w, `{"code":"BAD_AUTHORITY","error":"malformed host:port"}`, http.StatusBadRequest)
		return
	}
	if !strings.EqualFold(host, AllowedTargetHost) || port != AllowedTargetPort {
		logging.L().Warn("masteregress reject: target not allowed",
			"remote", r.RemoteAddr, "target", authority)
		http.Error(w, `{"code":"TARGET_DENIED","error":"only api.anthropic.com:443"}`, http.StatusForbidden)
		return
	}

	// 4) hijack + dial upstream + 200 + bidi copy
	hj, ok := w.(http.Hijacker)
	if !ok {
		// 理论上 http.Server 实现 Hijacker;TLS 也支持。守门 panic
		http.Error(w, `{"code":"NO_HIJACK","error":"hijacker unavailable"}`, http.StatusInternalServerError)
		return
	}
	dialer := &net.Dialer{Timeout: upstreamDialTimeout}
	upstream, err := dialer.DialContext(r.Context(), "tcp", net.JoinHostPort(AllowedTargetHost, AllowedTargetPort))
	if err != nil {
		logging.L().Warn("masteregress upstream dial failed", "err", err.Error())
		http.Error(w, `{"code":"UPSTREAM","error":"dial api.anthropic.com failed"}`, http.StatusBadGateway)
		return
	}
	clientConn, brw, err := hj.Hijack()
	if err != nil {
		_ = upstream.Close()
		// hijack 后 ResponseWriter 不可用,只能 log
		logging.L().Error("masteregress hijack failed", "err", err.Error())
		return
	}
	// hijack 之后 deadline 由我们自己管
	_ = clientConn.SetDeadline(time.Time{})

	// 200 给 master(用 raw bytes,避免 net/http 再插 chunked / Connection 头)
	if _, err := clientConn.Write([]byte("HTTP/1.1 200 OK\r\n\r\n")); err != nil {
		_ = upstream.Close()
		_ = clientConn.Close()
		return
	}

	// 如果 hijack 时 bufio.Reader 里还有 master 早发来的字节(罕见,
	// 因为 master 是 https.request 出去 CONNECT,不会预 push body),
	// 先 flush 给上游
	if brw != nil && brw.Reader != nil && brw.Reader.Buffered() > 0 {
		if _, err := io.CopyN(upstream, brw.Reader, int64(brw.Reader.Buffered())); err != nil {
			_ = upstream.Close()
			_ = clientConn.Close()
			return
		}
	}

	// bidi copy。两端都用 *net.TCPConn(clientConn 来自 net/http hijack 的 *tls.Conn,
	// 直接 io.Copy + Close 即可,Half-close 不强求)
	errc := make(chan error, 2)
	go func() {
		_, e := io.Copy(upstream, clientConn)
		if tcp, ok := upstream.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		errc <- e
	}()
	go func() {
		_, e := io.Copy(clientConn, upstream)
		// clientConn 是 *tls.Conn,没有 CloseWrite —— 直接 close 让对端读到 EOF
		errc <- e
	}()
	<-errc
	// 触发另一方向也收尾
	_ = clientConn.Close()
	_ = upstream.Close()
	<-errc
}

// peerHasMasterSAN 同 authmw.peerHasMasterSAN;独立实现避免跨 internal 包暴露。
func peerHasMasterSAN(r *http.Request) bool {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		return false
	}
	leaf := r.TLS.PeerCertificates[0]
	for _, u := range leaf.URIs {
		if u.String() == MasterSpiffeURI {
			return true
		}
	}
	return false
}
