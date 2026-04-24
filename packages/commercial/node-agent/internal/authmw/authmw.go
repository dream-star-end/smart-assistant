// Package authmw 是 mTLS 调用方身份校验中间件。
//
// 校验顺序(任一失败直接 401/403,不进业务 handler,日志不打敏感字段):
//   1. r.TLS.PeerCertificates 非空
//   2. 证书 SAN URI 包含 MasterSpiffeURI
//   3. Authorization: Bearer <token>,constant-time 对比 psk 文件内容
package authmw

import (
	"crypto/subtle"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/logging"
)

const MasterSpiffeURI = "spiffe://openclaude/master"

type Middleware struct {
	cfg     *config.Config
	pskRef  atomic.Pointer[[]byte]
	loadMu  sync.Mutex
	loaded  time.Time
}

func New(cfg *config.Config) (*Middleware, error) {
	m := &Middleware{cfg: cfg}
	if err := m.reloadPsk(); err != nil {
		return nil, err
	}
	return m, nil
}

// reloadPsk 每 60s 最多一次从磁盘重读,支持外部热更。
func (m *Middleware) reloadPsk() error {
	m.loadMu.Lock()
	defer m.loadMu.Unlock()
	if time.Since(m.loaded) < 60*time.Second && m.pskRef.Load() != nil {
		return nil
	}
	b, err := m.cfg.ReadPsk()
	if err != nil {
		return err
	}
	m.pskRef.Store(&b)
	m.loaded = time.Now()
	return nil
}

// peerHasMasterSAN 验证 client 证书的 SAN URIs 含 master spiffe。
// 链验证本身已由 tls.Config(ClientCAs + RequireAndVerifyClientCert) 完成。
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

// Wrap 包装 HTTP handler,失败直接短路返回。
func (m *Middleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !peerHasMasterSAN(r) {
			logging.L().Warn("auth reject: no master SAN",
				"remote", r.RemoteAddr, "path", r.URL.Path)
			http.Error(w, `{"code":"AUTH_SAN","error":"client cert SAN mismatch"}`, http.StatusForbidden)
			return
		}
		ah := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(ah, prefix) {
			logging.L().Warn("auth reject: no bearer",
				"remote", r.RemoteAddr, "path", r.URL.Path)
			http.Error(w, `{"code":"AUTH_MISSING","error":"bearer required"}`, http.StatusUnauthorized)
			return
		}
		given := []byte(strings.TrimSpace(ah[len(prefix):]))
		// psk cache;失败不影响请求但写警告
		if err := m.reloadPsk(); err != nil {
			logging.L().Error("psk reload failed (serving stale)", "err", err.Error())
		}
		ref := m.pskRef.Load()
		if ref == nil || len(*ref) == 0 {
			logging.L().Error("no psk loaded")
			http.Error(w, `{"code":"AUTH_SERVER","error":"psk unavailable"}`, http.StatusServiceUnavailable)
			return
		}
		expected := *ref
		if len(given) != len(expected) || subtle.ConstantTimeCompare(given, expected) != 1 {
			logging.L().Warn("auth reject: bearer mismatch",
				"remote", r.RemoteAddr, "path", r.URL.Path)
			http.Error(w, `{"code":"AUTH_BEARER","error":"bearer invalid"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
