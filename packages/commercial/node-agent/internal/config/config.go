// Package config 读取 /etc/openclaude/node-agent.yml,校验必填字段。
//
// 配置的每个字段含义见 docs/v3/02-DEVELOPMENT-PLAN.md §M1。
// 敏感文件(psk / tls key / ca)只通过路径引用,运行时按需读取,避免长期驻留内存。
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	// Host 身份
	HostUUID string `yaml:"host_uuid"`

	// 监听
	Bind string `yaml:"bind"` // "0.0.0.0:9443"

	// 认证
	PskPath string `yaml:"psk_path"`

	// TLS
	TLSKey string `yaml:"tls_key"`
	TLSCrt string `yaml:"tls_cert"`
	CACrt  string `yaml:"ca_cert"`

	// 网络
	DockerBridge string `yaml:"docker_bridge"` // "openclaude-br0"
	BridgeCIDR   string `yaml:"bridge_cidr"`   // "172.30.X.0/24"
	ProxyBind    string `yaml:"proxy_bind"`    // "172.30.X.1:3128"

	// Master 入口(egress proxy CONNECT 注入 X-V3-Container-IP 的目标 host 白名单)
	MasterHosts []string `yaml:"master_hosts"` // e.g. ["api.claudeai.chat","claudeai.chat"]

	// Egress allowlist — CONNECT 只允许到这些 host 的 443
	EgressAllowHosts []string `yaml:"egress_allow_hosts"`

	// Container runtime
	DockerBin string `yaml:"docker_bin"` // default "docker"

	// V3 D.1c:L7 内部 anthropic 反代。容器 default route 指向 bridge gateway
	// (172.30.X.1),plain HTTP 到 InternalProxyBind,然后由本进程走 mTLS 转到 MasterMtlsURL。
	// 空字符串 → 禁用(测试 / self host 不需要,self host 容器直连 master 的 18791)。
	InternalProxyBind string `yaml:"internal_proxy_bind"` // e.g. "172.30.1.1:18791"
	MasterMtlsURL     string `yaml:"master_mtls_url"`     // e.g. "https://master.internal:18443"

	// Baseline 同步 — master 侧 baseline serve endpoint 的 base URL。
	// 例 "https://master.internal:18792";poller 会附加 /internal/v3/baseline-{version,tarball}。
	// 空字符串 → 禁用 baseline poller(如 self host 或不需要基线的测试场景)。
	MasterBaselineBaseURL string `yaml:"master_baseline_base_url"`

	// 0038:master forward proxy。每台 host 上 master 端 dispatcher 拨此处 CONNECT
	// api.anthropic.com:443,以本机 NIC 出口为 OAuth 账号专属稳定 IP。
	// 空字符串 → 禁用(self host 不需要 — 自机出口跟"不走 proxy"等价)。
	// 典型值 "0.0.0.0:9444"。监听需要从 master VM IP 可达;防火墙由 nodeBootstrap 同步。
	MasterEgressBind string `yaml:"master_egress_bind"`

	// 0042:self-probe 用。agent 周期性 docker image inspect 这个 tag,
	// 把 ID + tag 在 /health 回包里报给 master,作为 loaded_image_id 唯一可信来源。
	// 空字符串 → self-probe 跳过 loaded image 探测(loadedImageId/loadedImageTag = nil)。
	RuntimeImageTag string `yaml:"runtime_image_tag"`
}

func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	var c Config
	if err := yaml.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse yaml %s: %w", path, err)
	}
	if c.DockerBin == "" {
		c.DockerBin = "docker"
	}
	return &c, c.Validate()
}

func (c *Config) Validate() error {
	if c.HostUUID == "" {
		return fmt.Errorf("host_uuid is required")
	}
	if c.Bind == "" {
		return fmt.Errorf("bind is required")
	}
	if _, _, err := net.SplitHostPort(c.Bind); err != nil {
		return fmt.Errorf("bind invalid: %w", err)
	}
	for _, p := range []struct {
		name, v string
	}{
		{"psk_path", c.PskPath},
		{"tls_key", c.TLSKey},
		{"tls_cert", c.TLSCrt},
		{"ca_cert", c.CACrt},
	} {
		if p.v == "" {
			return fmt.Errorf("%s is required", p.name)
		}
	}
	if c.DockerBridge == "" {
		return fmt.Errorf("docker_bridge is required")
	}
	if c.BridgeCIDR == "" {
		return fmt.Errorf("bridge_cidr is required")
	}
	if _, _, err := net.ParseCIDR(c.BridgeCIDR); err != nil {
		return fmt.Errorf("bridge_cidr invalid: %w", err)
	}
	if c.ProxyBind == "" {
		return fmt.Errorf("proxy_bind is required")
	}
	if _, _, err := net.SplitHostPort(c.ProxyBind); err != nil {
		return fmt.Errorf("proxy_bind invalid: %w", err)
	}
	// lower-case master/egress allowlist 便于比较
	for i, h := range c.MasterHosts {
		c.MasterHosts[i] = strings.ToLower(strings.TrimSpace(h))
	}
	for i, h := range c.EgressAllowHosts {
		c.EgressAllowHosts[i] = strings.ToLower(strings.TrimSpace(h))
	}
	// 0038:master_egress_bind 校验。空 = 禁用,非空必须 host:port 形态。
	if c.MasterEgressBind != "" {
		if _, _, err := net.SplitHostPort(c.MasterEgressBind); err != nil {
			return fmt.Errorf("master_egress_bind invalid: %w", err)
		}
	}
	// D.1c:一对配对 —— bind + masterURL 要么都有,要么都空(禁用)。
	// 一个有一个没有肯定是配置错误。
	if (c.InternalProxyBind == "") != (c.MasterMtlsURL == "") {
		return fmt.Errorf("internal_proxy_bind 和 master_mtls_url 必须同时设置或同时为空")
	}
	if c.InternalProxyBind != "" {
		if _, _, err := net.SplitHostPort(c.InternalProxyBind); err != nil {
			return fmt.Errorf("internal_proxy_bind invalid: %w", err)
		}
		u, err := url.Parse(c.MasterMtlsURL)
		if err != nil {
			return fmt.Errorf("master_mtls_url parse: %w", err)
		}
		if u.Scheme != "https" {
			return fmt.Errorf("master_mtls_url must use https scheme, got %q", u.Scheme)
		}
		if u.Host == "" {
			return fmt.Errorf("master_mtls_url missing host")
		}
	}
	return nil
}

// ReadPsk 读 psk 文件内容,trim 空白,返回原始字节。调用方用完置零。
func (c *Config) ReadPsk() ([]byte, error) {
	b, err := os.ReadFile(c.PskPath)
	if err != nil {
		return nil, fmt.Errorf("read psk: %w", err)
	}
	return []byte(strings.TrimSpace(string(b))), nil
}

// IsMasterHost 判断 CONNECT 的目标 authority 是否指向 master(大小写不敏感,去掉端口)。
func (c *Config) IsMasterHost(authority string) bool {
	host := authority
	if h, _, err := net.SplitHostPort(authority); err == nil {
		host = h
	}
	host = strings.ToLower(host)
	for _, m := range c.MasterHosts {
		if host == m {
			return true
		}
	}
	return false
}

// IsEgressAllowed 判断是否允许 CONNECT 到该目标。master 域名默认全部允许;
// 其他域名必须在 egress_allow_hosts 列表中。
func (c *Config) IsEgressAllowed(authority string) bool {
	if c.IsMasterHost(authority) {
		return true
	}
	host := authority
	if h, _, err := net.SplitHostPort(authority); err == nil {
		host = h
	}
	host = strings.ToLower(host)
	for _, h2 := range c.EgressAllowHosts {
		if host == h2 {
			return true
		}
	}
	return false
}
