// Package usercontext 实现 GET /v1/users/<uid>/openclaude-context endpoint。
//
// 给 master 端 platform envelope rewrite 用 — 读 host 上对应用户的 docker volume
// `oc-v3-data-u<uid>` 里 OpenClaude 用户级 USER.md / MEMORY.md / SKILLS,返 JSON
// 供 master 在外接 API outbound 时注入到 system[N+1]。
//
// 权威路径(与 packages/storage/src/paths.ts 对齐):
//   <volume_mountpoint>/user.md                  (用户级共享 USER.md — 该用户所有 agent 共用)
//   <volume_mountpoint>/agents/main/MEMORY.md    (per-agent — 主 agent 工作记忆,保持隔离)
//   <volume_mountpoint>/skills/<slug>/SKILL.md   (用户级共享 skill 库)
//
// 安全约束:
//   - 路径完全由 server 端拼接,client 仅传 uid;不接受任何路径参数
//   - uid 严格 [1-9][0-9]{0,15},不允许前导 0 / 负 / 非数字(与 volumes.go reVolumeName 对齐)
//   - 文件读取大小硬上限 256 KiB(单文件),超过即截断返(防恶意撑爆 master 内存)
//   - skills 扫描数量上限 200(防目录爆炸);frontmatter 只取 name + description
//   - 不读 user.md / MEMORY.md / SKILL.md 之外任何文件
package usercontext

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/openclaude/node-agent/internal/containers"
)

// uidRe 严格匹配 master 侧 user_id 字符串形态。
// 与 containers/volumes.go reVolumeName 中 uid 段对齐(1-16 位),长度必须一致 ——
// 之前用 19 位上限会让 17-19 位 uid 过本层校验,然后再被下游 InspectVolume
// 拼出来的 "oc-v3-data-u<uid>" 在 docker volume 命名规则下 500,体验是 500 而非 400。
// master 实际 user_id 远低于 2^53,16 位余量充足(Codex Phase 5 round-1 MINOR)。
var uidRe = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)

const (
	// 单文件读取上限。USER.md / MEMORY.md 实际通常 < 32 KiB,256 KiB 留余量;
	// 防被恶意写超大文件撑爆 master 接收 buffer。超过即只读前 256 KiB 截断。
	maxFileBytes = 256 * 1024
	// skills/ 目录扫描上限。OpenClaude 现状 ~20 skill,200 留充足余量。
	maxSkillCount = 200
	// SKILL.md frontmatter 解析读取上限(只读头部)。
	skillHeadBytes = 4 * 1024
)

// Response 是 GET /v1/users/<uid>/openclaude-context 的成功响应 shape。
// 与 master 端 PlatformContext interface 严格对齐(plan §3.6 唯一权威定义)。
type Response struct {
	UserMd      string         `json:"userMd"`
	MemoryMd    string         `json:"memoryMd"`
	Skills      []SkillSummary `json:"skills"`
	VolumeMtime *string        `json:"volumeMtime"` // RFC3339Nano,volume 不存在时为 null
}

// SkillSummary 给 master 端 attribution block 注入用,只含元信息。
type SkillSummary struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Handler 持有 docker volume inspect 用的 Runner 引用。
type Handler struct {
	runner *containers.Runner
}

// New 构造 handler。runner 必须 != nil。
func New(runner *containers.Runner) *Handler {
	if runner == nil {
		panic("usercontext: runner is nil")
	}
	return &Handler{runner: runner}
}

// ServeHTTP 路由 GET /v1/users/<uid>/openclaude-context。
//
// 错误码:
//   - 405:非 GET
//   - 400:uid 格式不合法
//   - 404:volume 不存在(用户从未启过容器,正常路径)
//   - 500:docker inspect 失败 / 读盘失败
//
// 200 时即使所有文件都缺失也返 200(三段空字符串 + 空 skills + null mtime)。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "use GET", http.StatusMethodNotAllowed)
		return
	}
	// 解 path /v1/users/<uid>/openclaude-context
	const prefix = "/v1/users/"
	const suffix = "/openclaude-context"
	p := r.URL.Path
	if !strings.HasPrefix(p, prefix) || !strings.HasSuffix(p, suffix) {
		http.NotFound(w, r)
		return
	}
	uid := p[len(prefix) : len(p)-len(suffix)]
	if !uidRe.MatchString(uid) {
		http.Error(w, `{"code":"BAD_UID","error":"uid must be positive integer"}`, http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	volumeName := "oc-v3-data-u" + uid
	vi, err := h.runner.InspectVolume(ctx, volumeName)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"code":"VOL_INSPECT_FAIL","error":%q}`, err.Error()),
			http.StatusInternalServerError)
		return
	}
	if !vi.Exists {
		// 用户从未启过容器:这是正常路径,master 应 fallback 到空 context。
		http.Error(w, `{"code":"VOLUME_NOT_FOUND","error":"user data volume not present on this host"}`,
			http.StatusNotFound)
		return
	}

	resp, err := readPlatformContext(vi.Mountpoint)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"code":"READ_FAIL","error":%q}`, err.Error()),
			http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// readPlatformContext 从 volume mountpoint 读 USER.md / MEMORY.md / skills/*/SKILL.md。
//
// 设计:任一文件缺失都不算错(用户没写过 USER.md 是正常状态),返空串;
// 只有 fs 系统级错误(权限 / IO 故障)才向上抛。
func readPlatformContext(mountpoint string) (*Response, error) {
	agentRoot := filepath.Join(mountpoint, "agents", "main")

	// USER.md → user-level shared (volume root user.md). MEMORY.md stays main's per-agent
	// working notes. skills → user-level shared library (volume root skills/) post sharing.
	userMd, userMtime, err := readFileCapped(filepath.Join(mountpoint, "user.md"))
	if err != nil {
		return nil, fmt.Errorf("read user.md: %w", err)
	}
	memoryMd, memMtime, err := readFileCapped(filepath.Join(agentRoot, "MEMORY.md"))
	if err != nil {
		return nil, fmt.Errorf("read MEMORY.md: %w", err)
	}
	skills, skillMtime, err := readSkills(filepath.Join(mountpoint, "skills"))
	if err != nil {
		return nil, fmt.Errorf("read skills: %w", err)
	}

	maxMtime := maxNonZero(userMtime, memMtime, skillMtime)
	var mtimeStr *string
	if !maxMtime.IsZero() {
		s := maxMtime.UTC().Format(time.RFC3339Nano)
		mtimeStr = &s
	}

	return &Response{
		UserMd:      userMd,
		MemoryMd:    memoryMd,
		Skills:      skills,
		VolumeMtime: mtimeStr,
	}, nil
}

// readFileCapped 读文件并截断到 maxFileBytes。
// 文件不存在:返 ("", zero time, nil),不视为错。
func readFileCapped(path string) (string, time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", time.Time{}, nil
		}
		return "", time.Time{}, err
	}
	if info.IsDir() {
		return "", time.Time{}, fmt.Errorf("%s is a directory", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return "", time.Time{}, err
	}
	defer f.Close()
	// io.ReadFull 把"读到 cap 大小 OR EOF"两种正常情况合并:
	//   - 文件 > cap → n=cap, err=nil
	//   - 文件 ≤ cap → n=size, err=io.EOF or io.ErrUnexpectedEOF
	// 两种 EOF 都视为成功(只表示文件比 cap 小);其它 err 透出。
	buf := make([]byte, maxFileBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", info.ModTime(), err
	}
	return string(buf[:n]), info.ModTime(), nil
}

// readSkills 扫 skills/<slug>/SKILL.md,parse YAML-ish frontmatter 抽 name + description。
//
// 解析规则(对 OpenClaude 现有 skill 格式,保守解析):
//   - 文件必须以 `---\n` 开头才进 frontmatter 模式;否则跳过该 skill
//   - frontmatter 由两行 `name: <v>` / `description: <v>` 构成,其它字段忽略
//   - value 部分若被单/双引号包裹,去引号;否则原文 trim 空白
//
// skills 数组按 name asc 排序,保证多机一致(volume 内顺序不稳定)。
func readSkills(skillsDir string) ([]SkillSummary, time.Time, error) {
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []SkillSummary{}, time.Time{}, nil
		}
		return nil, time.Time{}, err
	}

	out := make([]SkillSummary, 0, len(entries))
	var maxMtime time.Time
	for i, e := range entries {
		if i >= maxSkillCount {
			break // 防目录爆炸
		}
		if !e.IsDir() {
			continue
		}
		mdPath := filepath.Join(skillsDir, e.Name(), "SKILL.md")
		info, err := os.Stat(mdPath)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue // skill 目录存在但 SKILL.md 缺失,跳过
			}
			return nil, time.Time{}, err
		}
		if info.ModTime().After(maxMtime) {
			maxMtime = info.ModTime()
		}
		f, err := os.Open(mdPath)
		if err != nil {
			return nil, time.Time{}, err
		}
		head := make([]byte, skillHeadBytes)
		n, _ := f.Read(head)
		f.Close()
		name, desc := parseFrontmatter(string(head[:n]))
		if name == "" {
			// 没解析出 name 时 fallback 到目录名(skill slug 通常等于 name)
			name = e.Name()
		}
		out = append(out, SkillSummary{Name: name, Description: desc})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, maxMtime, nil
}

// parseFrontmatter 从 SKILL.md 头部抽 name + description。
// 不引入 YAML 库:OpenClaude skill frontmatter 格式简单,手写解析够。
func parseFrontmatter(head string) (name, desc string) {
	if !strings.HasPrefix(head, "---\n") && !strings.HasPrefix(head, "---\r\n") {
		return "", ""
	}
	// 找闭合 ---
	rest := head[strings.Index(head, "\n")+1:]
	endIdx := strings.Index(rest, "\n---")
	if endIdx < 0 {
		// frontmatter 没闭合就当全段都是 frontmatter(头部 4KB cap 内通常够)
		endIdx = len(rest)
	}
	fm := rest[:endIdx]
	for _, line := range strings.Split(fm, "\n") {
		line = strings.TrimRight(line, "\r")
		if k, v, ok := splitKV(line); ok {
			switch k {
			case "name":
				name = unquote(v)
			case "description":
				desc = unquote(v)
			}
		}
	}
	return name, desc
}

// splitKV 解 "key: value" 形态。冒号后第一个空格起算 value。
func splitKV(line string) (key, value string, ok bool) {
	idx := strings.Index(line, ":")
	if idx <= 0 {
		return "", "", false
	}
	return strings.TrimSpace(line[:idx]), strings.TrimSpace(line[idx+1:]), true
}

// unquote 剥外层单/双引号。
func unquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// maxNonZero 返回所有非零 time.Time 中的最大值。全零则返零 time。
func maxNonZero(ts ...time.Time) time.Time {
	var maxT time.Time
	for _, t := range ts {
		if t.IsZero() {
			continue
		}
		if t.After(maxT) {
			maxT = t
		}
	}
	return maxT
}
