// Package renew 实现 cert 续期流程(node-agent 侧)。
//
// 流程:
//   1. master POST /renew-cert with body {nonce}
//      → node-agent 本地 openssl 生成 CSR(私钥复用本地 tls_key;SAN URI=spiffe://openclaude/host/<uuid>)
//      → 记下 nonce(内存,3 分钟过期,单次有效)
//      → 返回 {csrPem}
//   2. master 签名后 POST /renew-cert/deliver with {nonce, certPem}
//      → 验 nonce 有效 + 一次性使用 + 不过期
//      → atomic rename tls_cert 文件
//      → 通知 server.ReloadTLS() 切换 GetCertificate 回调
package renew

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/logging"
)

// Reloader 由 server 传入,用来在写入新 cert 后触发 TLS 重载。
type Reloader interface {
	ReloadTLS() error
}

type Handler struct {
	cfg      *config.Config
	reloader Reloader

	mu     sync.Mutex
	active map[string]time.Time // nonce -> issuedAt
}

const nonceTTL = 3 * time.Minute

func New(cfg *config.Config, r Reloader) *Handler {
	return &Handler{cfg: cfg, reloader: r, active: map[string]time.Time{}}
}

// gcLocked 清掉过期 nonce。
func (h *Handler) gcLocked(now time.Time) {
	for n, t := range h.active {
		if now.Sub(t) > nonceTTL {
			delete(h.active, n)
		}
	}
}

// acceptNonce 首次注册 nonce。若已存在则**保持原 issuedAt 不刷新**,
// 避免同一 nonce 被反复 POST /renew-cert 无限延长窗口。
// 活跃 nonce 上限防止 map 爆炸;超限直接拒。
func (h *Handler) acceptNonce(n string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.gcLocked(time.Now())
	if _, exists := h.active[n]; exists {
		return true // 已注册过,返回 true 让 CSR 生成继续,但不刷新 TTL
	}
	if len(h.active) >= maxActiveNonces {
		return false
	}
	h.active[n] = time.Now()
	return true
}

const maxActiveNonces = 32

func (h *Handler) consumeNonce(n string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.gcLocked(time.Now())
	t, ok := h.active[n]
	if !ok {
		return false
	}
	if time.Since(t) > nonceTTL {
		delete(h.active, n)
		return false
	}
	delete(h.active, n) // 一次性
	return true
}

// Generate 运行 openssl,用现有 tls_key 生成一张 CSR(不换 private key)。
func (h *Handler) generateCsr(ctx context.Context) (string, error) {
	// openssl req -new -key <tls_key> -subj "/CN=node:<uuid>" \
	//   -addext "subjectAltName=URI:spiffe://openclaude/host/<uuid>"
	// 输出 PEM 到 stdout
	subj := fmt.Sprintf("/CN=node:%s", h.cfg.HostUUID)
	// 校验 uuid 字符安全(migration 保证,但双保险)
	for _, r := range h.cfg.HostUUID {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') || r == '-') {
			return "", fmt.Errorf("invalid host_uuid in config")
		}
	}
	san := fmt.Sprintf("subjectAltName=URI:spiffe://openclaude/host/%s", h.cfg.HostUUID)
	cmd := exec.CommandContext(ctx, "openssl",
		"req", "-new", "-key", h.cfg.TLSKey,
		"-subj", subj,
		"-addext", san,
		"-outform", "PEM")
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		es := stderr.String()
		if len(es) > 300 {
			es = es[:300]
		}
		return "", fmt.Errorf("openssl req failed: %w: %s", err, es)
	}
	return out.String(), nil
}

// RenewRequest handler /renew-cert
func (h *Handler) HandleRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Nonce string `json:"nonce"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"code":"BAD_BODY"}`, http.StatusBadRequest)
		return
	}
	if !validNonce(body.Nonce) {
		http.Error(w, `{"code":"BAD_NONCE"}`, http.StatusBadRequest)
		return
	}
	if !h.acceptNonce(body.Nonce) {
		http.Error(w, `{"code":"NONCE_POOL_FULL"}`, http.StatusTooManyRequests)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	csr, err := h.generateCsr(ctx)
	if err != nil {
		logging.L().Error("csr gen failed", "err", err.Error())
		http.Error(w, `{"code":"CSR_GEN"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"csrPem": csr})
}

// Deliver handler /renew-cert/deliver
func (h *Handler) HandleDeliver(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Nonce   string `json:"nonce"`
		CertPem string `json:"certPem"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"code":"BAD_BODY"}`, http.StatusBadRequest)
		return
	}
	if !validNonce(body.Nonce) {
		http.Error(w, `{"code":"BAD_NONCE"}`, http.StatusBadRequest)
		return
	}
	if !h.consumeNonce(body.Nonce) {
		http.Error(w, `{"code":"STALE_NONCE"}`, http.StatusBadRequest)
		return
	}
	// 基础 PEM 校验:must 开头是 -----BEGIN CERTIFICATE-----
	if !bytes.Contains([]byte(body.CertPem), []byte("-----BEGIN CERTIFICATE-----")) {
		http.Error(w, `{"code":"BAD_CERT_PEM"}`, http.StatusBadRequest)
		return
	}
	// 原子写
	if err := atomicWrite(h.cfg.TLSCrt, []byte(body.CertPem), 0o644); err != nil {
		logging.L().Error("cert atomic write failed", "err", err.Error())
		http.Error(w, `{"code":"FS_WRITE"}`, http.StatusInternalServerError)
		return
	}
	// 触发 TLS reload
	if err := h.reloader.ReloadTLS(); err != nil {
		logging.L().Error("tls reload failed", "err", err.Error())
		// 不回滚 cert(master 已确认新 cert 可用);TLS 继续用旧 cache 直到下次 reload
		http.Error(w, `{"code":"RELOAD_FAIL"}`, http.StatusInternalServerError)
		return
	}
	logging.L().Info("cert renewed and reloaded", "uuid", h.cfg.HostUUID)
	w.WriteHeader(http.StatusNoContent)
}

// atomicWrite tmp + fsync + rename
func atomicWrite(dst string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(dst)
	tmp, err := os.CreateTemp(dir, ".cert.*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Chmod(tmpPath, mode); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

func validNonce(n string) bool {
	// hex 64(对应 32 字节),master 端生成
	if len(n) < 16 || len(n) > 128 {
		return false
	}
	if _, err := hex.DecodeString(n); err != nil {
		return false
	}
	return true
}

// sentinel
var ErrStale = errors.New("stale nonce")

// NewNonce helper(供测试)。
func NewNonce() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
