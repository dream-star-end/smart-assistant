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
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
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
	caPool   *x509.CertPool

	mu     sync.Mutex
	active map[string]time.Time // nonce -> issuedAt
}

const nonceTTL = 3 * time.Minute

// New 构建 renew handler。caPool 用于 /renew-cert/deliver 的 leaf 证书链校验,
// 必须传入(nil 会在 Deliver 时拒绝所有新 cert)。
func New(cfg *config.Config, r Reloader, caPool *x509.CertPool) *Handler {
	return &Handler{cfg: cfg, reloader: r, caPool: caPool, active: map[string]time.Time{}}
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
//
// 写盘前必须做全套校验,避免 master 误签(或被攻陷后发垃圾 cert)把节点 TLS 搞挂:
//  1. 解析 PEM 链 —— 第一张当 leaf,其余当 intermediates
//  2. leaf.Verify(Roots=caPool, Intermediates=chain) 校验 CA 信任链
//  3. leaf.URIs 必须恰好是 `spiffe://openclaude/host/<uuid>`(和本节点身份一致)
//  4. tls.X509KeyPair(certPem, keyBytes) 校验本地私钥与新 cert 配对
// 任一失败 → 400,不改动磁盘。
//
// 写盘后 ReloadTLS 失败 → 用保存在内存的 oldBytes atomicWrite 回去,再 ReloadTLS 一次
// 让节点继续跑旧 cert(master 可再发一次 renew)。不用 .bak rename 方案因为
// rename 会让 cfg.TLSCrt 有一瞬间不存在,此时进程重启会起不来。
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
	certBytes := []byte(body.CertPem)

	// 1. 校验 PEM 链并取 leaf + intermediates
	leaf, interPool, err := parseCertChain(certBytes)
	if err != nil {
		logging.L().Warn("cert chain parse failed", "err", err.Error())
		http.Error(w, `{"code":"BAD_CERT_PEM"}`, http.StatusBadRequest)
		return
	}

	// 2. CA 信任链校验
	if h.caPool == nil {
		logging.L().Error("renew caPool not configured; refusing deliver")
		http.Error(w, `{"code":"NO_CA_POOL"}`, http.StatusInternalServerError)
		return
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:         h.caPool,
		Intermediates: interPool,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		logging.L().Warn("cert ca verify failed", "err", err.Error())
		http.Error(w, `{"code":"BAD_CERT_VERIFY"}`, http.StatusBadRequest)
		return
	}

	// 3. SPIFFE URI 必须精确匹配本节点身份
	wantURI := fmt.Sprintf("spiffe://openclaude/host/%s", h.cfg.HostUUID)
	if len(leaf.URIs) != 1 || leaf.URIs[0].String() != wantURI {
		logging.L().Warn("cert SAN URI mismatch",
			"want", wantURI,
			"got", fmt.Sprintf("%v", leaf.URIs),
		)
		http.Error(w, `{"code":"BAD_CERT_SAN"}`, http.StatusBadRequest)
		return
	}

	// 4. 私钥配对 —— 确保新 cert 的公钥和本地 tls_key 匹配
	keyBytes, err := os.ReadFile(h.cfg.TLSKey)
	if err != nil {
		logging.L().Error("read tls key failed", "err", err.Error())
		http.Error(w, `{"code":"FS_READ_KEY"}`, http.StatusInternalServerError)
		return
	}
	if _, err := tls.X509KeyPair(certBytes, keyBytes); err != nil {
		logging.L().Warn("cert/key pair mismatch", "err", err.Error())
		http.Error(w, `{"code":"KEY_MISMATCH"}`, http.StatusBadRequest)
		return
	}

	// 5. 保存旧 cert 内存副本(首次部署可能没有,忽略 ENOENT)
	oldBytes, readErr := os.ReadFile(h.cfg.TLSCrt)
	if readErr != nil && !os.IsNotExist(readErr) {
		logging.L().Error("read old cert failed", "err", readErr.Error())
		http.Error(w, `{"code":"FS_READ_OLD"}`, http.StatusInternalServerError)
		return
	}

	// 6. 原子写新 cert
	if err := atomicWrite(h.cfg.TLSCrt, certBytes, 0o644); err != nil {
		logging.L().Error("cert atomic write failed", "err", err.Error())
		http.Error(w, `{"code":"FS_WRITE"}`, http.StatusInternalServerError)
		return
	}

	// 7. ReloadTLS;失败就用旧 bytes 回滚,再 reload 一次恢复旧 cert
	if err := h.reloader.ReloadTLS(); err != nil {
		logging.L().Error("tls reload failed; rolling back", "err", err.Error())
		if oldBytes != nil {
			if wErr := atomicWrite(h.cfg.TLSCrt, oldBytes, 0o644); wErr != nil {
				logging.L().Error("rollback write failed", "err", wErr.Error())
			} else if rErr := h.reloader.ReloadTLS(); rErr != nil {
				logging.L().Error("rollback reload failed", "err", rErr.Error())
			} else {
				logging.L().Info("cert rolled back to previous version")
			}
		} else {
			logging.L().Warn("no old cert to roll back to (first-install path)")
		}
		http.Error(w, `{"code":"RELOAD_FAIL"}`, http.StatusInternalServerError)
		return
	}
	logging.L().Info("cert renewed and reloaded", "uuid", h.cfg.HostUUID)
	w.WriteHeader(http.StatusNoContent)
}

// parseCertChain 解析 PEM 链:第一张 CERTIFICATE block 当 leaf,
// 后续所有 CERTIFICATE block 塞进 intermediates pool(可为空)。
// 非 CERTIFICATE 类型 block 一律拒绝(防止夹带 PRIVATE KEY 等)。
func parseCertChain(pemBytes []byte) (*x509.Certificate, *x509.CertPool, error) {
	if !bytes.Contains(pemBytes, []byte("-----BEGIN CERTIFICATE-----")) {
		return nil, nil, errors.New("no CERTIFICATE block found")
	}
	var leaf *x509.Certificate
	interPool := x509.NewCertPool()
	rest := pemBytes
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			return nil, nil, fmt.Errorf("unexpected PEM block type %q", block.Type)
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, nil, fmt.Errorf("parse cert: %w", err)
		}
		if leaf == nil {
			leaf = c
		} else {
			interPool.AddCert(c)
		}
	}
	if leaf == nil {
		return nil, nil, errors.New("empty PEM chain")
	}
	return leaf, interPool, nil
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
