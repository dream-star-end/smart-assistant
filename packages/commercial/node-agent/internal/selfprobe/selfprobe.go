// Package selfprobe 在 node-agent 进程内周期性自检以下三项能力,缓存最近一次结果给
// /health 返回:
//
//  1. uplink — 本机能否用自己的 mTLS leaf cert 拨 master:18443/v3/agent-uplink-probe
//     并拿到 2xx 响应(plan v4 round-2 收紧:401/403/404/5xx 都视为失败,不再当
//     "拿到任意响应即可")。这个能力是远程容器把 anthropic 流量经 internalProxy 反代
//     回 master 的前置;master 端在 0042 加了 /v3/agent-uplink-probe 专门给本探针,
//     跳过 status='ready' 这样 quarantined host 也能 self-heal 出 uplink-probe-failed。
//
//  2. egress — 本机 :9444 (masteregress) listener 是否在监听。我们只做 TCP dial,
//     不做完整 HTTP CONNECT,因为 :9444 mTLS 认对方持有 master leaf,agent 自身的
//     leaf 不带 master SPIFFE URI,做不到端到端 CONNECT 自测。但 listener 没起就
//     说明 :9444 进程级出问题,master egressDispatcher 必然失败,这层信号已足够。
//
//  3. loaded image — `docker image inspect --format '{{.Id}}' <runtime_image_tag>`
//     的输出。失败/空 → loaded_image_id 为 nil(未知),master 端不会强行写。
//
// 三项各自独立,任何一项失败不影响其他;探测器自身崩溃不影响 /health 主路径
// (Snapshot() 拷贝时永远不持锁回调外部代码)。
package selfprobe

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/logging"
)

// 默认 30s 间隔。和 master /health poll 一致,master 每次拿到的就是上一轮(最坏 30s 旧)结果。
const defaultInterval = 30 * time.Second

// Probe 单次探针结果。At 是探完的时刻;OK=false 时 Err 是简短原因。
type Probe struct {
	OK  bool
	At  time.Time
	Err string
}

// ImageInfo 单次 docker inspect 的结果。Tag 与 cfg.RuntimeImageTag 一致;ID 是
// `{{.Id}}` 输出(典型 sha256:xxx)。inspect 失败时 New() 不更新缓存,保留上一份。
type ImageInfo struct {
	ID  string
	Tag string
	At  time.Time
}

// Snapshot 给 /health handler 用 — 它直接返回缓存的指针副本,不做任何 IO。
type Snapshot struct {
	Uplink *Probe
	Egress *Probe
	Image  *ImageInfo
}

// Poller 持有探针周期性执行需要的状态。线程安全。
type Poller struct {
	cfg      *config.Config
	interval time.Duration

	mu     sync.RWMutex
	uplink *Probe
	egress *Probe
	image  *ImageInfo
}

// New 构造 Poller。不做 IO,出错只可能是 cfg 为 nil。
func New(cfg *config.Config) *Poller {
	return &Poller{cfg: cfg, interval: defaultInterval}
}

// Snapshot 返回当前缓存。三个字段任一为 nil 表示该维度未知(未配置 / 未跑过 / 探针失败)。
// 调用方不应修改返回的指针指向的内容。
func (p *Poller) Snapshot() Snapshot {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return Snapshot{Uplink: p.uplink, Egress: p.egress, Image: p.image}
}

// Start 启动探针循环,阻塞直到 ctx done。立即跑一次再进周期 ticker,避免 master 第一次
// /health 拿到全 nil。
func (p *Poller) Start(ctx context.Context) {
	logging.L().Info("selfprobe started",
		"interval", p.interval.String(),
		"uplink_enabled", p.cfg.MasterMtlsURL != "",
		"egress_enabled", p.cfg.MasterEgressBind != "",
		"image_tag", p.cfg.RuntimeImageTag,
	)
	p.tick(ctx)
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.tick(ctx)
		}
	}
}

func (p *Poller) tick(ctx context.Context) {
	p.tickUplink(ctx)
	p.tickEgress(ctx)
	p.tickImage(ctx)
}

func (p *Poller) tickUplink(ctx context.Context) {
	if p.cfg.MasterMtlsURL == "" {
		return
	}
	res := probeUplink(ctx, p.cfg)
	p.mu.Lock()
	p.uplink = &res
	p.mu.Unlock()
}

func (p *Poller) tickEgress(ctx context.Context) {
	if p.cfg.MasterEgressBind == "" {
		return
	}
	res := probeEgressListener(ctx, p.cfg)
	p.mu.Lock()
	p.egress = &res
	p.mu.Unlock()
}

func (p *Poller) tickImage(ctx context.Context) {
	if p.cfg.RuntimeImageTag == "" {
		return
	}
	info := probeImage(ctx, p.cfg)
	if info == nil {
		// inspect 失败保留上一份;首次失败 image 维持 nil。
		return
	}
	p.mu.Lock()
	p.image = info
	p.mu.Unlock()
}

// probeUplink:用 agent 自己的 mTLS leaf cert 拨 master:18443/v3/agent-uplink-probe。
//
// plan v4 round-2:仅 2xx 视为 OK。401/403 表示 cert 没在 master CA pool(可能续期
// 延迟或 SPIFFE URI 漂)、404 表示 master 没部署本端点(版本错配)、5xx 表示 master
// 内部异常 — 任一都说明反向通道实际不可用,不该把它当 healthy。
// 失败原因典型:DNS / 路由 / 防火墙 / cert 续期延迟没同步到 master / 端点缺失。
func probeUplink(ctx context.Context, cfg *config.Config) Probe {
	p := Probe{At: time.Now()}
	cert, err := tls.LoadX509KeyPair(cfg.TLSCrt, cfg.TLSKey)
	if err != nil {
		p.Err = "load cert: " + err.Error()
		return p
	}
	caBytes, err := os.ReadFile(cfg.CACrt)
	if err != nil {
		p.Err = "read ca: " + err.Error()
		return p
	}
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caBytes) {
		p.Err = "ca not valid PEM"
		return p
	}
	u, err := url.Parse(cfg.MasterMtlsURL)
	if err != nil {
		p.Err = "parse master_mtls_url: " + err.Error()
		return p
	}
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
				RootCAs:      caPool,
				MinVersion:   tls.VersionTLS12,
			},
			DisableKeepAlives:   true,
			TLSHandshakeTimeout: 5 * time.Second,
		},
	}
	probeURL := strings.TrimRight(u.String(), "/") + "/v3/agent-uplink-probe"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURL, nil)
	if err != nil {
		p.Err = "build req: " + err.Error()
		return p
	}
	resp, err := client.Do(req)
	if err != nil {
		p.Err = trim("uplink: "+err.Error(), 256)
		return p
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	// plan v4 round-2:仅 2xx 视为 OK。401/403/404/5xx 都说明反向通道实际不可用,
	// 不该把它当 healthy。
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		p.Err = trim(fmt.Sprintf("uplink: unexpected status %d", resp.StatusCode), 256)
		return p
	}
	p.OK = true
	return p
}

// probeEgressListener:TCP dial 自身 :9444。listener 没起 → connect refused。
// 不做完整 CONNECT(需要 master leaf cert,agent 自身证书做不到)。
func probeEgressListener(ctx context.Context, cfg *config.Config) Probe {
	p := Probe{At: time.Now()}
	bind := cfg.MasterEgressBind
	host, port, err := net.SplitHostPort(bind)
	if err != nil {
		p.Err = "parse master_egress_bind: " + err.Error()
		return p
	}
	// listener 配 0.0.0.0 时拨 127.0.0.1 即可
	if host == "0.0.0.0" || host == "::" || host == "" {
		host = "127.0.0.1"
	}
	d := net.Dialer{Timeout: 3 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		p.Err = trim("egress dial: "+err.Error(), 256)
		return p
	}
	_ = conn.Close()
	p.OK = true
	return p
}

// probeImage:docker image inspect --format {{.Id}} <tag>。
// 找不到 / docker daemon 不可达 → 返 nil(不覆盖之前缓存)。
func probeImage(ctx context.Context, cfg *config.Config) *ImageInfo {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	bin := cfg.DockerBin
	if bin == "" {
		bin = "docker"
	}
	cmd := exec.CommandContext(cctx, bin, "image", "inspect", "--format", "{{.Id}}", cfg.RuntimeImageTag)
	out, err := cmd.Output()
	if err != nil {
		// 区分:docker daemon 不可达(典型 dial unix /var/run/docker.sock connect)
		// vs image not found(exit 1, no such image)。两者都让缓存保留上一份。
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			// not found:debug 即可,5min 再 retry
			logging.L().Debug("docker image inspect failed",
				"tag", cfg.RuntimeImageTag, "stderr", trim(string(ee.Stderr), 256))
		} else {
			logging.L().Debug("docker image inspect spawn error",
				"tag", cfg.RuntimeImageTag, "err", err.Error())
		}
		return nil
	}
	id := strings.TrimSpace(string(out))
	if id == "" {
		return nil
	}
	return &ImageInfo{ID: id, Tag: cfg.RuntimeImageTag, At: time.Now()}
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
