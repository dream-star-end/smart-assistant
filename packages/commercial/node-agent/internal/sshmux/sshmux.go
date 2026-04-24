// Package sshmux 管理 ssh ControlMaster 进程(一 user × host 一 master)。
//
// 运行形态:
//
//	/run/ccb-ssh/u<uid>/h<hid>/
//	  known_hosts      master 侧通过 /files PUT 预写入 → 本 handler 只改属主权限
//	  ctl.sock         `ssh -M -N` 本地建 → ready 后本 handler chown 0660 root:AGENT_GID
//
// 密钥纪律:
//   - password 仅由 /sshmux/start 的 JSON body 走 mTLS+PSK 入站;decode 成 []byte 后
//     通过 fd 3 pipe 传给 sshpass,写完立刻 fill(0),**永不写盘**。
//   - 跨线 JSON 字符串是不可变的,无法清零 —— 依赖 TLS 传输加密。
//
// 并发模型:
//   - registry (reg) 由 m.mu 保护,持有时间仅做 map 读写(μs 级)。
//   - 同 key 启停互斥由 per-key 锁串行(m.lockFor(key))。
//   - 跨 key 并行,避免单 host 启动 10s 拖慢其他 host。
package sshmux

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/openclaude/node-agent/internal/logging"
)

const (
	// agentGID 与 TypeScript 侧 `packages/commercial/src/agent-sandbox/constants.ts`
	// 的 V3_AGENT_GID=1000 保持同步。容器内 agent 进程 gid=1000,
	// 宿主侧 /run/ccb-ssh 各级路径 chown 到该 gid 以让容器通过 gid 匹配获得访问权。
	agentGID = 1000

	sshRunRoot = "/run/ccb-ssh"

	// ControlMaster spawn 后等待 socket 就绪的总预算。
	readyTimeout      = 10 * time.Second
	readyPollInterval = 250 * time.Millisecond
	// 单次 `ssh -O check` 自身的超时,避免 check 卡住把整个 ready-loop 拖住
	// (Codex C.2 plan-review NIT)。
	singleCheckTimeout = 2 * time.Second

	// stopGrace —— SIGTERM 到 SIGKILL 的宽限期。
	stopGrace = 3 * time.Second

	// ShutdownBudget —— Manager.Shutdown 全局总预算。
	shutdownBudget = 5 * time.Second
)

// hid 只允许字母数字 + . _ -;禁 `/` 防 path traversal。长度 1..64 够用
// (UUID v4 = 36;加 8 字节随机串 = 44;都在范围内)。
var hidRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

// entry 记录一条活跃 master 的最小状态。
//
// exited 在单一 reaper goroutine 里 close —— stop/shutdown/readyloop 统一 <-exited,
// 禁止对 cmd 再调第二次 Wait()(os/exec 文档明确禁止重复 Wait)。
type entry struct {
	cmd         *exec.Cmd
	pgid        int
	controlPath string
	exited      chan struct{}
}

// Manager 管理所有 ssh ControlMaster 进程。
type Manager struct {
	mu  sync.Mutex
	reg map[string]*entry

	kmu      sync.Mutex
	keyLocks map[string]*sync.Mutex
}

// New 构造空 Manager。无需 ctx —— 生命周期随 Server 进程(调用 Shutdown 终止)。
func New() *Manager {
	return &Manager{
		reg:      map[string]*entry{},
		keyLocks: map[string]*sync.Mutex{},
	}
}

// lockFor 返回该 key 的专属 mutex。首次访问时创建;不清理(key 基数 = uid×host,
// 实际规模可忽略)。
func (m *Manager) lockFor(key string) *sync.Mutex {
	m.kmu.Lock()
	defer m.kmu.Unlock()
	lk, ok := m.keyLocks[key]
	if !ok {
		lk = &sync.Mutex{}
		m.keyLocks[key] = lk
	}
	return lk
}

func keyOf(uid int, hid string) string { return fmt.Sprintf("%d/%s", uid, hid) }

func runDirFor(uid int, hid string) string {
	return filepath.Join(sshRunRoot, fmt.Sprintf("u%d", uid), "h"+hid)
}

// ─── HTTP handlers ─────────────────────────────────────────────────────

type startReq struct {
	UID         int    `json:"uid"`
	HID         string `json:"hid"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	PasswordB64 string `json:"passwordB64"`
}

type stopReq struct {
	UID int    `json:"uid"`
	HID string `json:"hid"`
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "error": msg})
}

// HandleStart 处理 POST /sshmux/start。
func (m *Manager) HandleStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONErr(w, http.StatusMethodNotAllowed, "METHOD", "use POST")
		return
	}
	var req startReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONErr(w, http.StatusBadRequest, "BAD_BODY", err.Error())
		return
	}
	if err := validateStart(&req); err != nil {
		writeJSONErr(w, http.StatusBadRequest, "BAD_ARG", err.Error())
		return
	}
	pw, err := base64.StdEncoding.DecodeString(req.PasswordB64)
	if err != nil || len(pw) == 0 {
		// pw 可能部分 decode 出敏感字节,尽可能抹掉
		for i := range pw {
			pw[i] = 0
		}
		writeJSONErr(w, http.StatusBadRequest, "BAD_PASSWORD", "passwordB64 empty or invalid base64")
		return
	}
	// 无论成功失败最终都清零
	defer func() {
		for i := range pw {
			pw[i] = 0
		}
	}()

	key := keyOf(req.UID, req.HID)
	lk := m.lockFor(key)
	lk.Lock()
	defer lk.Unlock()

	// 幂等:若已存在且 reaper 尚未 close exited,认为仍活 → 204。
	// 用 channel 状态而不是 Kill 探活,可规避 pid 重用边界。
	if existing := m.regGet(key); existing != nil {
		select {
		case <-existing.exited:
			// reaper 已 close —— 进程退了,从 reg 摘掉(reaper 自己也会摘,幂等 OK)
			m.regDel(key)
		default:
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}

	runDir := runDirFor(req.UID, req.HID)

	// 修正 runDir 权属:master 通过 /files PUT 写 known_hosts 时,
	// /files handler 会 MkdirAll parent 0o755 root:root。这里强制刷成
	// 0o750 root:AGENT_GID 以满足容器 gid=1000 访问。
	if err := os.MkdirAll(runDir, 0o750); err != nil {
		writeJSONErr(w, http.StatusInternalServerError, "MKDIR_FAIL", err.Error())
		return
	}
	if err := os.Chmod(runDir, 0o750); err != nil {
		writeJSONErr(w, http.StatusInternalServerError, "CHMOD_DIR_FAIL", err.Error())
		return
	}
	if err := os.Chown(runDir, 0, agentGID); err != nil {
		writeJSONErr(w, http.StatusInternalServerError, "CHOWN_DIR_FAIL", err.Error())
		return
	}

	knownHostsPath := filepath.Join(runDir, "known_hosts")
	// known_hosts 必须已由 master /files PUT 就位 —— 本 handler 不兜底生成。
	// 必须是普通文件:目录/symlink 会让 ssh -o UserKnownHostsFile 行为不确定。
	khStat, err := os.Lstat(knownHostsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONErr(w, http.StatusBadRequest, "KNOWN_HOSTS_MISSING",
				"known_hosts not present; master must PUT it first")
			return
		}
		writeJSONErr(w, http.StatusInternalServerError, "STAT_FAIL", err.Error())
		return
	}
	if !khStat.Mode().IsRegular() {
		writeJSONErr(w, http.StatusBadRequest, "KNOWN_HOSTS_NOT_REGULAR",
			"known_hosts must be a regular file")
		return
	}
	if err := os.Chmod(knownHostsPath, 0o640); err != nil {
		writeJSONErr(w, http.StatusInternalServerError, "CHMOD_KH_FAIL", err.Error())
		return
	}
	if err := os.Chown(knownHostsPath, 0, agentGID); err != nil {
		writeJSONErr(w, http.StatusInternalServerError, "CHOWN_KH_FAIL", err.Error())
		return
	}

	controlPath := filepath.Join(runDir, "ctl.sock")
	// 残留 socket(上次崩溃未清)显式 rm;忽略 not-exist
	if err := os.Remove(controlPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeJSONErr(w, http.StatusInternalServerError, "REMOVE_STALE_SOCK_FAIL", err.Error())
		return
	}

	// 起 sshpass + ssh ControlMaster
	pipeR, pipeW, err := os.Pipe()
	if err != nil {
		writeJSONErr(w, http.StatusInternalServerError, "PIPE_FAIL", err.Error())
		return
	}

	args := []string{
		"-d", "3", // 从 fd 3 读密码
		"ssh",
		"-M", "-N", "-T",
		"-S", controlPath,
		"-o", "UserKnownHostsFile=" + knownHostsPath,
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "NumberOfPasswordPrompts=1",
		"-o", "BatchMode=no",
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=2",
		"-o", "ControlPersist=no",
		"-p", strconv.Itoa(req.Port),
		req.User + "@" + req.Host,
	}
	cmd := exec.Command("sshpass", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.ExtraFiles = []*os.File{pipeR} // → sshpass 的 fd 3
	// nil stdout/stderr 会继承父进程 fd,不合适;显式 Discard 同时避免管道 goroutine 开销。
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard

	if err := cmd.Start(); err != nil {
		_ = pipeR.Close()
		_ = pipeW.Close()
		writeJSONErr(w, http.StatusInternalServerError, "SPAWN_FAIL", err.Error())
		return
	}
	// 父进程 fork 后的 pipeR 副本,sshpass 已经拿到自己的副本,我们立刻关
	_ = pipeR.Close()
	pgid := cmd.Process.Pid // Setpgid=true 使 pgid = pid

	// 单例 reaper:只此一处调用 cmd.Wait(),完成后 close(exited)。
	// 所有其他路径(ready 等待 / stop / shutdown)仅 <-exited,禁止二次 Wait。
	ent := &entry{
		cmd:         cmd,
		pgid:        pgid,
		controlPath: controlPath,
		exited:      make(chan struct{}),
	}
	go func() {
		werr := cmd.Wait()
		// 先记 err 到日志,再 close exited —— 任何 <-exited 之后的观察者不再需要 err。
		logging.L().Info("sshmux controlmaster exited",
			"uid", req.UID, "hid", req.HID, "err", fmt.Sprint(werr))
		close(ent.exited)
		// 从 reg 摘除(若已 register)。未 register 路径(ready 前挂掉)不需要摘。
		m.mu.Lock()
		if cur, ok := m.reg[key]; ok && cur == ent {
			delete(m.reg, key)
		}
		m.mu.Unlock()
	}()

	// 写 password + '\n' 到 pipeW,然后关闭。任何失败路径都经 kill + <-exited 收敛。
	if _, err := pipeW.Write(pw); err != nil {
		_ = pipeW.Close()
		killPG(pgid)
		<-ent.exited
		writeJSONErr(w, http.StatusInternalServerError, "WRITE_PW_FAIL", err.Error())
		return
	}
	if _, err := pipeW.Write([]byte{'\n'}); err != nil {
		_ = pipeW.Close()
		killPG(pgid)
		<-ent.exited
		writeJSONErr(w, http.StatusInternalServerError, "WRITE_PW_FAIL", err.Error())
		return
	}
	_ = pipeW.Close()

	if err := waitForReady(controlPath, req.User, req.Host, req.Port, ent.exited); err != nil {
		killPG(pgid)
		drainExit(ent.exited, pgid)
		_ = os.Remove(controlPath)
		writeJSONErr(w, http.StatusInternalServerError, "CONTROL_NOT_READY", err.Error())
		return
	}

	// ready → 调整 ctl.sock 属主权限
	if err := os.Chmod(controlPath, 0o660); err != nil {
		killPG(pgid)
		drainExit(ent.exited, pgid)
		writeJSONErr(w, http.StatusInternalServerError, "CHMOD_SOCK_FAIL", err.Error())
		return
	}
	if err := os.Chown(controlPath, 0, agentGID); err != nil {
		killPG(pgid)
		drainExit(ent.exited, pgid)
		writeJSONErr(w, http.StatusInternalServerError, "CHOWN_SOCK_FAIL", err.Error())
		return
	}

	m.regSet(key, ent)
	logging.L().Info("sshmux controlmaster ready",
		"uid", req.UID, "hid", req.HID, "host", req.Host)
	w.WriteHeader(http.StatusNoContent)
}

// HandleStop 处理 POST /sshmux/stop。
func (m *Manager) HandleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONErr(w, http.StatusMethodNotAllowed, "METHOD", "use POST")
		return
	}
	var req stopReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONErr(w, http.StatusBadRequest, "BAD_BODY", err.Error())
		return
	}
	if req.UID <= 0 {
		writeJSONErr(w, http.StatusBadRequest, "BAD_ARG", "uid must be positive")
		return
	}
	if !hidRe.MatchString(req.HID) {
		writeJSONErr(w, http.StatusBadRequest, "BAD_ARG", "hid invalid")
		return
	}

	key := keyOf(req.UID, req.HID)
	lk := m.lockFor(key)
	lk.Lock()
	defer lk.Unlock()

	ent := m.regGet(key)
	if ent == nil {
		// 幂等:不存在直接 204
		w.WriteHeader(http.StatusNoContent)
		return
	}
	m.regDel(key)

	killPG(ent.pgid)
	// HandleStart 的 reaper 是唯一 Wait() 调用方;这里仅 <-exited。
	select {
	case <-ent.exited:
	case <-time.After(stopGrace):
		_ = syscall.Kill(-ent.pgid, syscall.SIGKILL)
		<-ent.exited
	}
	_ = os.Remove(ent.controlPath)
	// known_hosts / runDir 不删 —— master releaseMux 之后通过 /files DELETE 清理。
	w.WriteHeader(http.StatusNoContent)
}

// Shutdown 由 Server.ListenAndServe 在 ctx.Done() 时先调(HTTP shutdown 之前)。
// 并发 kill 所有活跃 master,总预算 shutdownBudget;known_hosts/runDir 不动。
func (m *Manager) Shutdown() {
	m.mu.Lock()
	snapshot := make([]*entry, 0, len(m.reg))
	for k, e := range m.reg {
		snapshot = append(snapshot, e)
		delete(m.reg, k)
	}
	m.mu.Unlock()

	if len(snapshot) == 0 {
		return
	}
	var wg sync.WaitGroup
	for _, e := range snapshot {
		wg.Add(1)
		go func(e *entry) {
			defer wg.Done()
			killPG(e.pgid)
			select {
			case <-e.exited:
			case <-time.After(stopGrace):
				_ = syscall.Kill(-e.pgid, syscall.SIGKILL)
				<-e.exited
			}
			_ = os.Remove(e.controlPath)
		}(e)
	}
	doneAll := make(chan struct{})
	go func() { wg.Wait(); close(doneAll) }()
	select {
	case <-doneAll:
	case <-time.After(shutdownBudget):
		logging.L().Warn("sshmux shutdown budget exceeded")
	}
}

// ─── helpers ───────────────────────────────────────────────────────────

func (m *Manager) regGet(k string) *entry {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reg[k]
}

func (m *Manager) regSet(k string, e *entry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reg[k] = e
}

func (m *Manager) regDel(k string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.reg, k)
}

func validateStart(req *startReq) error {
	if req.UID <= 0 {
		return errors.New("uid must be positive")
	}
	if !hidRe.MatchString(req.HID) {
		return errors.New("hid must match [A-Za-z0-9._-]{1,64}")
	}
	if req.Host == "" {
		return errors.New("host required")
	}
	if req.Port <= 0 || req.Port > 65535 {
		return errors.New("port out of range")
	}
	if req.User == "" {
		return errors.New("user required")
	}
	if req.PasswordB64 == "" {
		return errors.New("passwordB64 required")
	}
	return nil
}

// killPG 先 SIGTERM 到进程组(pgid 负号)。非致命错误忽略。
func killPG(pgid int) {
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
}

// drainExit 用于"已启动但后续出错"路径:kill 已发,这里 <-exited 等 reaper
// 收掉进程;超时则 SIGKILL 兜底。禁止在这里自己调 cmd.Wait()。
func drainExit(exited <-chan struct{}, pgid int) {
	select {
	case <-exited:
	case <-time.After(stopGrace):
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		<-exited
	}
}

// waitForReady 轮询 `ssh -O check`。同时监听 exited(master 提前退出);
// 总预算 readyTimeout;单次 check 独立 singleCheckTimeout(避免 check 自己卡死)。
func waitForReady(controlPath, user, host string, port int, exited <-chan struct{}) error {
	deadline := time.Now().Add(readyTimeout)
	ticker := time.NewTicker(readyPollInterval)
	defer ticker.Stop()
	for {
		if checkControlReady(controlPath, user, host, port) {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("ready timeout")
		}
		select {
		case <-exited:
			return errors.New("ssh master exited before ready")
		case <-ticker.C:
		}
	}
}

func checkControlReady(controlPath, user, host string, port int) bool {
	cmd := exec.Command("ssh",
		"-S", controlPath,
		"-O", "check",
		"-p", strconv.Itoa(port),
		user+"@"+host,
	)
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return false
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err == nil
	case <-time.After(singleCheckTimeout):
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		<-done
		return false
	}
}
