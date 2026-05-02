// Package containers 实现白名单的 docker CLI 封装。
//
// 严格约束:
//   - 所有参数通过 exec.Command(docker, args...) 传,绝无 shell 拼接
//   - 创建容器统一打 label com.openclaude.v3.managed=1(跟 master LocalDockerBackend
//     的 V3_MANAGED_LABEL_KEY 对齐);list/inspect/stop/remove 都按此 label 过滤
//   - 禁用 --privileged / host network / docker socket 挂载
//   - 挂载路径和 env 键名白名单过滤
//   - 每 cid per-container 单 in-flight,全局并发上限
//   - Run/Inspect/List/RunRequest 的 JSON 字段名必须跟 TS 侧 AgentRun*Request /
//     AgentContainerInspect 严格对齐(packages/commercial/src/compute-pool/types.ts)
package containers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openclaude/node-agent/internal/config"
)

// 跟 master LocalDockerBackend 的 V3_MANAGED_LABEL_KEY 对齐
const LabelKey = "com.openclaude.v3.managed"
const LabelValue = "1"

// 单 cid 最大 in-flight = 1
var perCidMu sync.Map // map[string]*sync.Mutex

func cidLock(cid string) *sync.Mutex {
	m, _ := perCidMu.LoadOrStore(cid, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// 全局并发
var globalSem = make(chan struct{}, 32)

func acquire() func() {
	globalSem <- struct{}{}
	return func() { <-globalSem }
}

// ─── 输入校验 ──────────────────────────────────────────────────────

var (
	// 容器 name (master 传来 /containers/run 的 Name 字段):oc-v3-u<uid>
	reName = regexp.MustCompile(`^oc-v3-[a-zA-Z0-9_-]{1,48}$`)
	// docker 内部 id(stop/remove/inspect URL 里 master 传回来):64-hex 或 12-hex short
	reDockerId  = regexp.MustCompile(`^[a-f0-9]{12,64}$`)
	reImage     = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$`)
	reLabelKey  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)
	reEnvKey    = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
	reVolumeSrc = regexp.MustCompile(`^oc-v3-(data|proj)-u[1-9][0-9]{0,15}$`)
)

// ValidateCid 接受 master 传来的 name (oc-v3-*) 或 docker 内部 id (hex)。
// Run 时传 name,stop/remove/inspect 用 master 记录的 containerInternalId(docker hex id)。
func ValidateCid(cid string) error {
	if reName.MatchString(cid) || reDockerId.MatchString(cid) {
		return nil
	}
	return fmt.Errorf("invalid container id: %q", cid)
}

// ValidateContainerName 只接受 oc-v3-* 的容器 name(Run 用)。
func ValidateContainerName(name string) error {
	if !reName.MatchString(name) {
		return fmt.Errorf("invalid container name: %q", name)
	}
	return nil
}

func validateImage(image string) error {
	if !reImage.MatchString(image) {
		return fmt.Errorf("invalid image: %q", image)
	}
	return nil
}

func validateEnvKey(k string) error {
	if !reEnvKey.MatchString(k) {
		return fmt.Errorf("invalid env key: %q", k)
	}
	return nil
}

func validateLabelKey(k string) error {
	if !reLabelKey.MatchString(k) {
		return fmt.Errorf("invalid label key: %q", k)
	}
	return nil
}

// isNamedVolumeSource 判定 bind source 是 docker named volume(无 "/" 且匹配
// oc-v3-(data|proj)-u<uid>)还是 host 绝对路径。docker -v 对 named volume 和
// bind path 语法相同(<src>:<tgt>[:<mode>]),但校验路径不同:volume 走 regex,
// path 走 MountRoots 白名单。
func isNamedVolumeSource(s string) bool {
	return !strings.HasPrefix(s, "/") && reVolumeSrc.MatchString(s)
}

func validateBoundIp(ip string, cidr string) error {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return fmt.Errorf("invalid ip: %q", ip)
	}
	_, subnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return fmt.Errorf("invalid bridge cidr: %w", err)
	}
	if !subnet.Contains(parsed) {
		return fmt.Errorf("ip %s not in bridge cidr %s", ip, cidr)
	}
	return nil
}

// validateMount 只允许来源路径在白名单根目录下。
func validateMount(src string, allowedRoots []string) error {
	abs, err := filepath.Abs(src)
	if err != nil {
		return err
	}
	clean := filepath.Clean(abs)
	for _, root := range allowedRoots {
		r := filepath.Clean(root)
		if clean == r || strings.HasPrefix(clean, r+string(filepath.Separator)) {
			return nil
		}
	}
	return fmt.Errorf("mount source %s not in allowed roots", clean)
}

// 挂载源白名单根(bootstrap 初始化,不从请求来)。host 路径型 bind 必须落在这里。
// named volume 源(oc-v3-data-u<uid> 等)走独立 regex,不受此白名单约束。
var MountRoots = []string{
	"/var/lib/openclaude/containers", // 容器 workdir 上层
	"/var/lib/openclaude/skills",
	"/var/lib/openclaude/user-data",
	"/var/lib/openclaude/baseline",                  // CCB baseline(由 baseline poller 拉到本地,容器 ro 挂载)
	"/var/lib/openclaude-v3/codex-container-auth",   // 远端 codex auth(per-container 子目录,master 通过 PUT /files 写入)
}

// ─── 请求结构 ──────────────────────────────────────────────────────
//
// **所有 JSON 字段名必须跟 TS 侧 packages/commercial/src/compute-pool/types.ts
// 的 AgentRunContainerRequest / AgentRunContainerResponse / AgentContainerInspect
// 严格对齐。改动这里要同步审视 TS 侧。**

type Bind struct {
	Source   string `json:"source"`   // docker named volume 名 或 host abs path
	Target   string `json:"target"`   // 容器内 abs path
	ReadOnly bool   `json:"readonly"`
}

type RunRequest struct {
	ContainerDbId int64             `json:"containerDbId"` // master agent_containers.id,供打 label
	Name          string            `json:"name"`          // docker container name (oc-v3-u<uid>)
	Image         string            `json:"image"`
	BoundIP       string            `json:"boundIp"`
	InternalPort  int               `json:"internalPort"` // master 记录,node-agent 不落地
	Env           map[string]string `json:"env"`
	Labels        map[string]string `json:"labels"`       // master 已 merge managed=1
	Binds         []Bind            `json:"binds"`
	MemoryBytes   int64             `json:"memoryBytes"`
	NanoCpus      int64             `json:"nanoCpus"`
	PidsLimit     int               `json:"pidsLimit"`
	Cmd           []string          `json:"cmd"` // 可空;空则用 image 默认
}

// RunResponse 跟 TS AgentRunContainerResponse 严格对齐:只回 containerInternalId。
type RunResponse struct {
	ContainerInternalId string `json:"containerInternalId"` // docker 64-hex id
}

// InspectResponse 跟 TS AgentContainerInspect 对齐。时间用可空字符串保留 null 语义。
type InspectResponse struct {
	Id         string  `json:"id"`
	State      string  `json:"state"` // running|exited|created|dead|paused|restarting|removing
	ExitCode   *int    `json:"exitCode"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	OomKilled  bool    `json:"oomKilled"`
	BoundIP    string  `json:"boundIp"`
}

// ─── Docker CLI wrapper ───────────────────────────────────────────

type Runner struct {
	cfg *config.Config
}

func NewRunner(cfg *config.Config) *Runner {
	return &Runner{cfg: cfg}
}

// exec 是受控 docker 调用;所有参数走 args 数组,绝不走 shell。
func (r *Runner) exec(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, r.cfg.DockerBin, args...)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// 仅返回前 500 字节,避免日志爆
		es := stderr.String()
		if len(es) > 500 {
			es = es[:500] + "..."
		}
		return "", fmt.Errorf("docker %s: %w: %s", args[0], err, es)
	}
	return out.String(), nil
}

// Run 创建并启动容器。docker run args 跟 master LocalDockerBackend 的 HostConfig
// 严格一致(硬化选项:User 1000:1000、CapDrop NET_RAW/NET_ADMIN、no-new-privileges、
// MemorySwap=Memory、Swappiness=0、Tmpfs /run/oc/claude-config、ShmSize 64m)。
func (r *Runner) Run(ctx context.Context, req *RunRequest) (*RunResponse, error) {
	if err := ValidateContainerName(req.Name); err != nil {
		return nil, err
	}
	if err := validateImage(req.Image); err != nil {
		return nil, err
	}
	if err := validateBoundIp(req.BoundIP, r.cfg.BridgeCIDR); err != nil {
		return nil, err
	}
	if req.InternalPort < 1 || req.InternalPort > 65535 {
		return nil, fmt.Errorf("internalPort invalid")
	}
	if req.MemoryBytes <= 0 {
		return nil, fmt.Errorf("memoryBytes must be > 0")
	}
	if req.NanoCpus <= 0 {
		return nil, fmt.Errorf("nanoCpus must be > 0")
	}
	if req.PidsLimit <= 0 {
		return nil, fmt.Errorf("pidsLimit must be > 0")
	}
	for k := range req.Env {
		if err := validateEnvKey(k); err != nil {
			return nil, err
		}
	}
	for k := range req.Labels {
		if err := validateLabelKey(k); err != nil {
			return nil, err
		}
	}
	for _, b := range req.Binds {
		if !strings.HasPrefix(b.Target, "/") {
			return nil, fmt.Errorf("bind target must be absolute: %q", b.Target)
		}
		if isNamedVolumeSource(b.Source) {
			continue
		}
		if !strings.HasPrefix(b.Source, "/") {
			return nil, fmt.Errorf("bind source %q is neither oc-v3 volume nor abs path", b.Source)
		}
		if err := validateMount(b.Source, MountRoots); err != nil {
			return nil, err
		}
	}

	l := cidLock(req.Name)
	l.Lock()
	defer l.Unlock()
	release := acquire()
	defer release()

	// NanoCpus → --cpus float(保留 3 位小数,TS 传的都是 1e6 倍数)
	cpus := float64(req.NanoCpus) / 1e9

	args := []string{
		"run", "-d",
		"--name", req.Name,
		"--user", "1000:1000",
		"--network", r.cfg.DockerBridge,
		"--ip", req.BoundIP,
		"--restart", "no",
		"--cap-drop", "NET_RAW",
		"--cap-drop", "NET_ADMIN",
		"--security-opt", "no-new-privileges",
		"--memory", fmt.Sprintf("%db", req.MemoryBytes),
		"--memory-swap", fmt.Sprintf("%db", req.MemoryBytes), // 禁 swap
		"--memory-swappiness", "0",
		"--cpus", strconv.FormatFloat(cpus, 'f', 3, 64),
		"--pids-limit", fmt.Sprintf("%d", req.PidsLimit),
		"--shm-size", "64m",
		"--tmpfs", "/run/oc/claude-config:rw,nosuid,nodev,size=4m,mode=0700,uid=1000,gid=1000",
	}

	// 保底 managed label(master 通常已经 merge,这里 idempotent 再写一次)。
	args = append(args, "--label", fmt.Sprintf("%s=%s", LabelKey, LabelValue))
	// 额外打 containerDbId label,用于 host 上 reconcile/GC
	args = append(args, "--label", fmt.Sprintf("com.openclaude.v3.containerDbId=%d", req.ContainerDbId))
	for k, v := range req.Labels {
		if k == LabelKey && v == LabelValue {
			continue // 避免重复 append 同 K/V
		}
		args = append(args, "--label", fmt.Sprintf("%s=%s", k, v))
	}

	for k, v := range req.Env {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}

	for _, b := range req.Binds {
		mode := "rw"
		if b.ReadOnly {
			mode = "ro"
		}
		// -v 对 named volume 和 bind path 语法一致;validation 已分流。
		args = append(args, "-v", fmt.Sprintf("%s:%s:%s", b.Source, b.Target, mode))
	}

	args = append(args, req.Image)
	args = append(args, req.Cmd...)

	out, err := r.exec(ctx, args...)
	if err != nil {
		// 尝试清理:docker rm -f(按 name 即可,docker 还未分配 id 或已分配无所谓)
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = r.exec(cleanupCtx, "rm", "-f", req.Name)
		return nil, err
	}
	// docker run -d stdout 是 64-hex container id(尾部可能带 \n)
	internalId := strings.TrimSpace(out)
	if !reDockerId.MatchString(internalId) {
		// 不常见;兜底 rm,报错
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = r.exec(cleanupCtx, "rm", "-f", req.Name)
		return nil, fmt.Errorf("unexpected docker run output: %q", out)
	}
	return &RunResponse{
		ContainerInternalId: internalId,
	}, nil
}

func (r *Runner) Stop(ctx context.Context, cid string) error {
	if err := ValidateCid(cid); err != nil {
		return err
	}
	if err := r.assertOwned(ctx, cid); err != nil {
		return err
	}
	l := cidLock(cid)
	l.Lock()
	defer l.Unlock()
	release := acquire()
	defer release()
	_, err := r.exec(ctx, "stop", "-t", "10", cid)
	return err
}

func (r *Runner) Remove(ctx context.Context, cid string, force bool) error {
	if err := ValidateCid(cid); err != nil {
		return err
	}
	if err := r.assertOwned(ctx, cid); err != nil {
		return err
	}
	l := cidLock(cid)
	l.Lock()
	defer l.Unlock()
	release := acquire()
	defer release()
	args := []string{"rm"}
	if force {
		args = append(args, "-f")
	}
	args = append(args, cid)
	_, err := r.exec(ctx, args...)
	return err
}

// Inspect 查单容器状态。cid 可以是 master 记的 docker internal id 或容器 name。
func (r *Runner) Inspect(ctx context.Context, cid string) (*InspectResponse, error) {
	if err := ValidateCid(cid); err != nil {
		return nil, err
	}
	if err := r.assertOwned(ctx, cid); err != nil {
		return nil, err
	}
	out, err := r.exec(ctx, "inspect", cid)
	if err != nil {
		return nil, err
	}
	var arr []struct {
		ID    string `json:"Id"`
		State struct {
			Status     string `json:"Status"`
			ExitCode   int    `json:"ExitCode"`
			StartedAt  string `json:"StartedAt"`
			FinishedAt string `json:"FinishedAt"`
			OOMKilled  bool   `json:"OOMKilled"`
		} `json:"State"`
		NetworkSettings struct {
			Networks map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
	}
	if err := json.Unmarshal([]byte(out), &arr); err != nil {
		return nil, fmt.Errorf("parse inspect: %w", err)
	}
	if len(arr) == 0 {
		return nil, errors.New("no inspect result")
	}
	i := arr[0]
	state := normalizeState(i.State.Status)
	ec := i.State.ExitCode
	resp := &InspectResponse{
		Id:        i.ID,
		State:     state,
		ExitCode:  &ec,
		OomKilled: i.State.OOMKilled,
	}
	// 跟 TS containerService.ts inspect() 严格对齐:
	//   startedAt: state.StartedAt ?? null
	//   finishedAt: state.FinishedAt ?? null
	// TS 侧没有归一化 docker 的零值时间字面量 "0001-01-01T00:00:00Z",
	// Go 也不做归一化,仅把空字符串视为 null。
	if i.State.StartedAt != "" {
		s := i.State.StartedAt
		resp.StartedAt = &s
	}
	if i.State.FinishedAt != "" {
		s := i.State.FinishedAt
		resp.FinishedAt = &s
	}
	// 优先 v3 bridge 的 IP;缺失则 fallback 任意网络的第一个(容错)
	if bridge := r.cfg.DockerBridge; bridge != "" {
		if n, ok := i.NetworkSettings.Networks[bridge]; ok && n.IPAddress != "" {
			resp.BoundIP = n.IPAddress
		}
	}
	if resp.BoundIP == "" {
		for _, n := range i.NetworkSettings.Networks {
			if n.IPAddress != "" {
				resp.BoundIP = n.IPAddress
				break
			}
		}
	}
	return resp, nil
}

// normalizeState 把 docker Status 归到 TS AgentContainerInspect.state 的 union。
// docker Status 原生值本身就是 union 的成员;这里做一次显式白名单,异常值归 exited。
func normalizeState(s string) string {
	switch s {
	case "running", "exited", "created", "dead", "paused", "restarting", "removing":
		return s
	default:
		return "exited"
	}
}

// normalizeDockerTime 把 docker 返回的 "0001-01-01T00:00:00Z"(零值)折成空字符串,
// 其它值原样返回(TS 侧直接拿 RFC3339Nano 字符串)。
// List 只列本 host 上 label=com.openclaude.v3.managed=1 的容器。
func (r *Runner) List(ctx context.Context) ([]*InspectResponse, error) {
	out, err := r.exec(ctx, "ps", "-a", "--no-trunc",
		"--filter", fmt.Sprintf("label=%s=%s", LabelKey, LabelValue),
		"--format", "{{.ID}}")
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			ids = append(ids, line)
		}
	}
	res := make([]*InspectResponse, 0, len(ids))
	for _, id := range ids {
		if !reDockerId.MatchString(id) {
			continue // 不合法 id 跳过(双保险)
		}
		ii, err := r.Inspect(ctx, id)
		if err != nil {
			continue
		}
		res = append(res, ii)
	}
	return res, nil
}

// assertOwned 验证该容器带 managed label。防止 master 拿到其它容器的 cid 发指令。
func (r *Runner) assertOwned(ctx context.Context, cid string) error {
	out, err := r.exec(ctx, "inspect", "-f", "{{index .Config.Labels \""+LabelKey+"\"}}", cid)
	if err != nil {
		return err
	}
	if strings.TrimSpace(out) != LabelValue {
		return fmt.Errorf("container %s not owned by openclaude.v3 (label %q)", cid, LabelKey)
	}
	return nil
}

// InspectRaw 供 tunnel 拿 bound IP(不做 auth 级校验,仅用于本 host 内部调用)。
func (r *Runner) InspectRaw(ctx context.Context, cid string) (boundIp string, err error) {
	if err := ValidateCid(cid); err != nil {
		return "", err
	}
	if err := r.assertOwned(ctx, cid); err != nil {
		return "", err
	}
	ii, err := r.Inspect(ctx, cid)
	if err != nil {
		return "", err
	}
	return ii.BoundIP, nil
}
