// Package baseline 负责从 master 拉取 CCB baseline 文件包并本地化到
// /var/lib/openclaude/baseline/,供容器启动时 bind mount 使用。
//
// 协议(与 master baselineServer 对齐):
//
//	GET <base>/internal/v3/baseline-version  →  {"version":"sha256:..."}
//	GET <base>/internal/v3/baseline-tarball  →  application/gzip,X-Baseline-Version 头
//
// 认证:用 node-agent 已有的 mTLS 证书 + psk Bearer 对 master 发起客户端 TLS。
//
// 原子替换:
//   - 新包解到 /var/lib/openclaude/baseline.new/
//   - rename baseline/ → baseline.old/(若存在)
//   - rename baseline.new/ → baseline/
//   - rmrf baseline.old/
//
// 版本文件:/var/lib/openclaude/baseline/.version 保存当前已同步的 version 字符串。
package baseline

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/logging"
)

const (
	// BaselineDir 是本地解包目标目录;files.go AllowedRoots 里也写死这个路径。
	BaselineDir        = "/var/lib/openclaude/baseline"
	versionFileName    = ".version"
	tarballEndpoint    = "/internal/v3/baseline-tarball"
	versionEndpoint    = "/internal/v3/baseline-version"
	pollInterval       = 60 * time.Second
	maxTarballBytes    = 32 << 20 // 32 MiB,防被污染的 master 恶意大包
	httpTimeout        = 30 * time.Second
	refreshTimeoutBase = 2 * time.Minute
)

// Poller 按固定间隔轮询 master 的 baseline version;不匹配时拉新 tarball。
type Poller struct {
	cfg    *config.Config
	client *http.Client

	mu          sync.Mutex
	refreshing  bool
	lastVersion string
}

// New 构建 Poller。若 cfg.MasterBaselineBaseURL 为空,返回 nil,调用方应跳过启动。
func New(cfg *config.Config) (*Poller, error) {
	if cfg.MasterBaselineBaseURL == "" {
		return nil, nil
	}

	// 构建 mTLS client:用本 host 的证书 + CA(跟 server 用同一套)
	cert, err := tls.LoadX509KeyPair(cfg.TLSCrt, cfg.TLSKey)
	if err != nil {
		return nil, fmt.Errorf("load mTLS keypair: %w", err)
	}
	caBytes, err := os.ReadFile(cfg.CACrt)
	if err != nil {
		return nil, fmt.Errorf("read ca: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		return nil, fmt.Errorf("ca_cert not PEM")
	}
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      pool,
		MinVersion:   tls.VersionTLS12,
	}
	return &Poller{
		cfg: cfg,
		client: &http.Client{
			Timeout: httpTimeout,
			Transport: &http.Transport{
				TLSClientConfig: tlsCfg,
				// baseline 是长连接频次很低的场景,默认连接复用即可
			},
		},
	}, nil
}

// Start 启动轮询 goroutine,阻塞到 ctx 被取消。
func (p *Poller) Start(ctx context.Context) {
	log := logging.L()
	log.Info("baseline poller start", "base_url", p.cfg.MasterBaselineBaseURL)

	// 启动时立即跑一次(bootstrap 阶段 master 会显式触发 /baseline/refresh,
	// 这里的启动首跑作为 fallback,保证 node-agent 重启后 60s 内 baseline 一致)
	if err := p.pullIfChanged(ctx); err != nil {
		log.Warn("baseline first pull failed", "err", err.Error())
	}

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info("baseline poller stopped")
			return
		case <-ticker.C:
			if err := p.pullIfChanged(ctx); err != nil {
				log.Warn("baseline pull failed", "err", err.Error())
			}
		}
	}
}

// ForceRefresh 外部触发(HTTP /baseline/refresh 或 bootstrap);独占锁防并发。
func (p *Poller) ForceRefresh(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, refreshTimeoutBase)
	defer cancel()
	return p.pullIfChanged(ctx)
}

// pullIfChanged:读 master version,和本地 .version 比较,不等则拉 tarball。
func (p *Poller) pullIfChanged(ctx context.Context) error {
	// 独占刷新:同一时刻只允许一个 pullIfChanged
	p.mu.Lock()
	if p.refreshing {
		p.mu.Unlock()
		return errors.New("refresh already in progress")
	}
	p.refreshing = true
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.refreshing = false
		p.mu.Unlock()
	}()

	masterVer, err := p.fetchVersion(ctx)
	if err != nil {
		return fmt.Errorf("fetch version: %w", err)
	}
	localVer := p.readLocalVersion()
	if localVer == masterVer && masterVer != "" {
		logging.L().Debug("baseline up to date", "version", masterVer)
		p.mu.Lock()
		p.lastVersion = masterVer
		p.mu.Unlock()
		return nil
	}
	logging.L().Info("baseline version mismatch, pulling",
		"local", localVer, "master", masterVer)
	if err := p.pullAndApply(ctx, masterVer); err != nil {
		return fmt.Errorf("pull: %w", err)
	}
	p.mu.Lock()
	p.lastVersion = masterVer
	p.mu.Unlock()
	return nil
}

func (p *Poller) fetchVersion(ctx context.Context) (string, error) {
	url := strings.TrimRight(p.cfg.MasterBaselineBaseURL, "/") + versionEndpoint
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	if err := p.addAuth(req); err != nil {
		return "", err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("version endpoint status=%d", resp.StatusCode)
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body); err != nil {
		return "", err
	}
	if body.Version == "" {
		return "", errors.New("empty version")
	}
	return body.Version, nil
}

// countingReader 是 io.Reader wrapper,记录消费字节数,供超限判定。
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func (p *Poller) pullAndApply(ctx context.Context, expectVersion string) (err error) {
	url := strings.TrimRight(p.cfg.MasterBaselineBaseURL, "/") + tarballEndpoint
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if err := p.addAuth(req); err != nil {
		return err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("tarball endpoint status=%d", resp.StatusCode)
	}

	// 解包到 staging dir;限定总字节数 + 路径前缀校验
	stagingDir := BaselineDir + ".new"
	_ = os.RemoveAll(stagingDir)
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		return fmt.Errorf("mkdir staging: %w", err)
	}

	// 显式计数 reader:超 maxTarballBytes 立即终止,避免误判。
	counter := &countingReader{r: resp.Body}
	limited := io.LimitReader(counter, maxTarballBytes+1)
	// 边流式解 tar 边算 sha256
	hasher := sha256.New()
	tee := io.TeeReader(limited, hasher)

	gz, err := gzip.NewReader(tee)
	if err != nil {
		return fmt.Errorf("gzip reader: %w", err)
	}
	// gzip trailer (CRC/ISIZE) 在 Close() 时校验;吞掉 Close 错误等于接受损坏包
	defer func() {
		if cerr := gz.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("gzip close: %w", cerr)
		}
	}()
	tr := tar.NewReader(gz)

	var totalBytes int64
	for {
		hdr, nextErr := tr.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return fmt.Errorf("tar next: %w", nextErr)
		}
		// 只接受普通文件和目录
		switch hdr.Typeflag {
		case tar.TypeDir, tar.TypeReg, tar.TypeRegA:
			// ok
		default:
			return fmt.Errorf("tar entry %q has disallowed type %d", hdr.Name, hdr.Typeflag)
		}
		// 防路径穿越:Clean + 禁 .. 开头或绝对
		clean := filepath.Clean(hdr.Name)
		if strings.HasPrefix(clean, "..") || strings.HasPrefix(clean, "/") ||
			strings.Contains(clean, ".."+string(filepath.Separator)) {
			return fmt.Errorf("tar entry path unsafe: %q", hdr.Name)
		}
		target := filepath.Join(stagingDir, clean)
		// 再兜底一次:target 必须仍在 stagingDir 下
		rel, relErr := filepath.Rel(stagingDir, target)
		if relErr != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("tar entry escapes staging: %q", hdr.Name)
		}

		if hdr.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("mkdir %s: %w", target, err)
			}
			continue
		}
		// per-entry + 累计 uncompressed 上界,防压缩炸弹
		if hdr.Size < 0 || hdr.Size > maxTarballBytes {
			return fmt.Errorf("tar entry %q size %d exceeds per-entry cap", hdr.Name, hdr.Size)
		}
		if totalBytes+hdr.Size > maxTarballBytes {
			return fmt.Errorf("cumulative uncompressed size exceeds %d", maxTarballBytes)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("mkdir parent %s: %w", target, err)
		}
		f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			return fmt.Errorf("open %s: %w", target, err)
		}
		n, copyErr := io.Copy(f, tr)
		if copyErr != nil {
			_ = f.Close()
			return fmt.Errorf("write %s: %w", target, copyErr)
		}
		if err := f.Close(); err != nil {
			return fmt.Errorf("close %s: %w", target, err)
		}
		totalBytes += n
	}

	// 解包结束后,继续 drain limited(tar 可能不消费到 gz 流尾)以把整包 bytes 喂给 hasher
	if _, err := io.Copy(io.Discard, tee); err != nil {
		return fmt.Errorf("drain tail: %w", err)
	}
	// 显式超限判定:计数器突破 maxTarballBytes 即视为恶意大包
	if counter.n > maxTarballBytes {
		return fmt.Errorf("compressed tarball exceeds %d bytes (got %d)", maxTarballBytes, counter.n)
	}
	digest := "sha256:" + hex.EncodeToString(hasher.Sum(nil))
	if digest != expectVersion {
		return fmt.Errorf("version mismatch: master=%s computed=%s", expectVersion, digest)
	}

	// 写 .version 到 staging
	if err := os.WriteFile(filepath.Join(stagingDir, versionFileName), []byte(digest), 0o644); err != nil {
		return fmt.Errorf("write .version: %w", err)
	}

	// 原子切换: baseline → .old, .new → baseline, rm -rf .old
	oldDir := BaselineDir + ".old"
	_ = os.RemoveAll(oldDir) // 若上次中断留下,先清
	if _, err := os.Stat(BaselineDir); err == nil {
		if err := os.Rename(BaselineDir, oldDir); err != nil {
			return fmt.Errorf("rename old: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat baseline: %w", err)
	}
	if err := os.Rename(stagingDir, BaselineDir); err != nil {
		// swap 中途失败尝试回滚
		_ = os.Rename(oldDir, BaselineDir)
		return fmt.Errorf("rename new: %w", err)
	}
	_ = os.RemoveAll(oldDir)
	logging.L().Info("baseline applied", "version", digest, "bytes", totalBytes)
	return nil
}

func (p *Poller) readLocalVersion() string {
	b, err := os.ReadFile(filepath.Join(BaselineDir, versionFileName))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// CurrentVersion 返回当前已同步到本地 baseline 的 version。
// 优先读内存 lastVersion(上一次 pull 成功后刷新);回退读磁盘 .version。
// 供 master /baseline/version 探测使用。
func (p *Poller) CurrentVersion() string {
	p.mu.Lock()
	v := p.lastVersion
	p.mu.Unlock()
	if v != "" {
		return v
	}
	return p.readLocalVersion()
}

// addAuth 给请求加 Bearer PSK(同 server side authmw 使用的 PSK)。
// master 侧 baselineServer 会用 authmw 做 mTLS + PSK 双因子。
func (p *Poller) addAuth(req *http.Request) error {
	psk, err := p.cfg.ReadPsk()
	if err != nil {
		return err
	}
	// psk 是文本 token,直接拼 header。用完置零防内存残留。
	token := string(psk)
	req.Header.Set("Authorization", "Bearer "+token)
	for i := range psk {
		psk[i] = 0
	}
	return nil
}
