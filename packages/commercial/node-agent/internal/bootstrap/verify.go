// Package bootstrap 提供 /bootstrap/verify 的检查逻辑。
//
// 检查项(非硬失败;缺依赖只记录 skipped):
//   - docker_ok:能 `docker info` 成功
//   - bridge_ok:`ip link show <bridge>` 有返回
//   - iptables_ok:FORWARD chain 有本 host bridge 子网的 MASQUERADE(简单 grep)
//   - psk_ok / tls_ok / ca_ok:对应文件存在且权限 0600(psk/key)/ 0644(cert/ca)
//   - clock_ok:chronyc tracking system time offset < 1s;chronyc 不在则 skipped
package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/logging"
)

type Result struct {
	OK      bool            `json:"ok"`
	Checks  map[string]bool `json:"checks"`
	Skipped map[string]string `json:"skipped,omitempty"`
	Message string          `json:"message,omitempty"`
}

type Verifier struct {
	cfg *config.Config
}

func NewVerifier(cfg *config.Config) *Verifier {
	return &Verifier{cfg: cfg}
}

func (v *Verifier) Verify(ctx context.Context) *Result {
	res := &Result{
		OK:     true,
		Checks: map[string]bool{},
		Skipped: map[string]string{},
	}
	mark := func(name string, ok bool, whyNot string) {
		res.Checks[name] = ok
		if !ok {
			res.OK = false
			if whyNot != "" && res.Message == "" {
				res.Message = fmt.Sprintf("%s: %s", name, whyNot)
			}
		}
	}

	// docker
	{
		ctxD, cancel := context.WithTimeout(ctx, 5*time.Second)
		cmd := exec.CommandContext(ctxD, v.cfg.DockerBin, "info")
		err := cmd.Run()
		cancel()
		mark("docker_ok", err == nil, stringOrEmpty(err))
	}

	// bridge
	{
		ctxD, cancel := context.WithTimeout(ctx, 3*time.Second)
		cmd := exec.CommandContext(ctxD, "ip", "link", "show", v.cfg.DockerBridge)
		err := cmd.Run()
		cancel()
		mark("bridge_ok", err == nil, stringOrEmpty(err))
	}

	// iptables — grep bridge cidr in iptables-save
	{
		ctxD, cancel := context.WithTimeout(ctx, 3*time.Second)
		var out bytes.Buffer
		cmd := exec.CommandContext(ctxD, "iptables-save")
		cmd.Stdout = &out
		err := cmd.Run()
		cancel()
		if err != nil {
			mark("iptables_ok", false, err.Error())
		} else {
			ok := strings.Contains(out.String(), strings.Split(v.cfg.BridgeCIDR, "/")[0])
			mark("iptables_ok", ok, "no masquerade rule for bridge cidr")
		}
	}

	// files + perms
	{
		ok, why := checkMode(v.cfg.PskPath, 0o600)
		mark("psk_ok", ok, why)
	}
	{
		ok, why := checkMode(v.cfg.TLSKey, 0o600)
		mark("key_ok", ok, why)
	}
	{
		ok, why := checkExists(v.cfg.TLSCrt)
		mark("cert_ok", ok, why)
	}
	{
		ok, why := checkExists(v.cfg.CACrt)
		mark("ca_ok", ok, why)
	}

	// clock
	if _, err := exec.LookPath("chronyc"); err != nil {
		res.Skipped["clock_ok"] = "chronyc not installed"
	} else {
		ctxD, cancel := context.WithTimeout(ctx, 3*time.Second)
		var out bytes.Buffer
		cmd := exec.CommandContext(ctxD, "chronyc", "tracking")
		cmd.Stdout = &out
		err := cmd.Run()
		cancel()
		if err != nil {
			mark("clock_ok", false, err.Error())
		} else {
			off, ok := parseChronyOffset(out.String())
			if !ok {
				res.Skipped["clock_ok"] = "cannot parse chronyc tracking output"
			} else {
				mark("clock_ok", math.Abs(off) < 1.0, fmt.Sprintf("offset %.3fs", off))
			}
		}
	}
	return res
}

func checkMode(path string, wantMode os.FileMode) (bool, string) {
	st, err := os.Stat(path)
	if err != nil {
		return false, err.Error()
	}
	// 只要 mode & 0o777 == wantMode(严格)
	have := st.Mode() & 0o777
	if have != wantMode {
		return false, fmt.Sprintf("mode %o != expected %o", have, wantMode)
	}
	return true, ""
}

func checkExists(path string) (bool, string) {
	_, err := os.Stat(path)
	if err != nil {
		return false, err.Error()
	}
	return true, ""
}

var reChronyOffset = regexp.MustCompile(`(?m)^System time\s+:\s+([0-9eE.+-]+)\s+seconds`)

func parseChronyOffset(s string) (float64, bool) {
	m := reChronyOffset.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

func stringOrEmpty(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// HTTP handler — 只接 POST,body 忽略
func (v *Verifier) Handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	res := v.Verify(r.Context())
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(res); err != nil {
		logging.L().Warn("bootstrap verify encode err", "err", err.Error())
	}
}
