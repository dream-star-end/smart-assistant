// Package files 提供受控的文件投递 RPC:PUT/DELETE/STAT。
//
// 严格约束:
//   - path 必须绝对路径且清洗后仍在 AllowedRoots 白名单之内
//   - 单文件 body 上限 16MiB
//   - 写入走 tmp + fsync + chmod + rename 原子
//   - 同 path 互斥,全局并发 16
//   - 只接受调用方已经通过 mTLS + authmw 认证的请求
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// MaxFileSize 是单次 PUT body 的上限。超过会返 413。
//
// 2026-05-16:从 16 MiB 提到 200 MiB 与 master gateway MAX_UPLOAD_SINGLE 对齐。
// 远端 host 用户上传 ≤200MB 文件直接走 master → node-agent /files PUT 推到 user
// volume(/var/lib/docker/volumes/oc-v3-data-u<uid>/_data/uploads),否则 master
// 端要先在自己 paths.uploadsDir 暂存再推送时 16MiB 上限会成为新瓶颈。
const MaxFileSize = 200 << 20 // 200 MiB

// AllowedRoots 定义 PUT/DELETE/STAT 允许操作的固定根目录前缀。
//
// 设计:路径经 filepath.Clean 后必须等于某 root 或以 root + '/' 开头。
// 不允许相对路径 / 不允许 `..` 穿越(Clean 会解掉)。
//
// 动态根目录(per-user docker volume)由 AllowedDirRegexes 单独管理 —— 该机制
// 不走前缀匹配,而是匹配文件的 parent dir 是否符合 v3 用户卷的规范形态。
var AllowedRoots = []string{
	"/var/lib/openclaude/baseline",
	"/var/lib/openclaude/user-data",
	"/var/lib/openclaude-v3/codex-container-auth",
	"/run/ccb-ssh",
}

// AllowedDirRegexes 定义"父目录"必须匹配的严格正则集合 —— 用于允许操作那些
// 名字带 per-user 序号(uid)的动态目录,典型即 v3/v5 commercial 用户 docker volume
// 下的 uploads/generated 子目录:
//
//	/var/lib/docker/volumes/oc-(v3|v5)-data-u<uid>/_data/(uploads|generated)
//
// 匹配方式:对清洗后的文件路径取 filepath.Dir(),与每个正则尝试。任一命中即视
// 为合法。
//
// 严格性:
//   - uid 必须是 1-19 位正整数,不允许前导 0、负号、非数字
//   - 仅允许 uploads / generated 两个子目录(与 commercial userMedia.ts 中
//     MediaKind 严格同步;新增 kind 需同时更新这里)
//   - 不允许目录之下再嵌套子目录(文件直接落在 uploads/generated 之下)
//
// 安全:resolveParentNoSymlink 会先 EvalSymlinks parent 真身,再用本组正则匹配,
// 防御 user-data symlink 逃逸到此动态根。
var AllowedDirRegexes = []*regexp.Regexp{
	regexp.MustCompile(`^/var/lib/docker/volumes/oc-(v3|v5)-data-u[1-9][0-9]{0,18}/_data/(uploads|generated)$`),
}

// dirMatchesAllowedRegex 检查 dir(已 Clean)是否命中 AllowedDirRegexes 任一项。
// 抽出供 validatePath + resolveParentNoSymlink 共用。
func dirMatchesAllowedRegex(dir string) bool {
	for _, re := range AllowedDirRegexes {
		if re.MatchString(dir) {
			return true
		}
	}
	return false
}

// chownFile / chmodFile / renameFile 是可注入 seam,测试里 override 模拟失败
// 或验证 post-rename PATH_DIVERGED 分支(rename 把 tmp 移到白名单外的场景在
// 真实文件系统下没法稳定复现 race,只能 mock)。生产路径直接走标准库。
//
// 关键设计:chown/chmod 走 fd 而非路径。原因:rename 之前 tmp 文件已落地,
// 此时 attacker 若把 parent 换成 symlink → /etc,os.Chown("/parent/file.tmp",
// container_uid, ...) 会按当前 parent 路径解析,把 /etc/某文件的 owner 改成
// 容器 uid —— 这是真的提权路径(root 主动改 /etc 文件 owner)。f.Chown(uid,
// gid) 直接对 fd 引用的 inode 操作,完全绕开路径再解析。
var chownFile = func(f *os.File, uid, gid int) error { return f.Chown(uid, gid) }
var chmodFile = func(f *os.File, mode os.FileMode) error { return f.Chmod(mode) }
var renameFile = os.Rename

// per-path 互斥
var perPathMu sync.Map

func pathLock(p string) *sync.Mutex {
	m, _ := perPathMu.LoadOrStore(p, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// 全局并发 16
var globalSem = make(chan struct{}, 16)

func acquire() func() {
	globalSem <- struct{}{}
	return func() { <-globalSem }
}

// validatePath 返清洗后的绝对路径;校验在白名单之内。
//
// 通过条件(任一):
//  1. clean 等于 AllowedRoots 任一项或在其下
//  2. clean 的 parent dir 命中 AllowedDirRegexes(即 per-user docker volume
//     的 uploads/generated 子目录);此分支只接受"文件"(parent ≠ clean),
//     不接受目录本身 —— 操作 dynamic root 目录本身没有合法用途。
func validatePath(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("path required")
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("path must be absolute: %q", raw)
	}
	clean := filepath.Clean(raw)
	for _, root := range AllowedRoots {
		r := filepath.Clean(root)
		if clean == r || strings.HasPrefix(clean, r+string(filepath.Separator)) {
			return clean, nil
		}
	}
	parent := filepath.Dir(clean)
	if parent != clean && dirMatchesAllowedRegex(parent) {
		return clean, nil
	}
	return "", fmt.Errorf("path %q not under any allowed root", clean)
}

// resolveParentNoSymlink EvalSymlinks parent 目录,校验真身仍在某个 AllowedRoot
// 或 AllowedDirRegexes 命中的动态根之下。
//
// 防御:容器通过 user-data bind mount 在 AllowedRoots 内植入 symlink 逃到 /etc
// 等路径。AllowedDirRegexes 同样要求 EvalSymlinks 后真身仍匹配正则 —— 否则恶意
// container 可在 /var/lib/docker/volumes/oc-v3-data-uX/_data/uploads/ 下放
// symlink 指向 /etc/shadow,validatePath(只看 textual 路径)会放过,但 parent
// 已被替换。
//
// 仅对已存在的 parent 有意义;parent 不存在直接返 error,要求调用方先 MkdirAll。
func resolveParentNoSymlink(p string) error {
	parent := filepath.Dir(p)
	real, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return fmt.Errorf("resolve parent: %w", err)
	}
	if !pathInAllowedTree(real) {
		return fmt.Errorf("parent %q resolved to %q outside allowed roots", parent, real)
	}
	return nil
}

// pathInAllowedTree 纯文本判断 clean 路径是否落在 AllowedRoots 之下或其 parent
// 命中 AllowedDirRegexes。要求输入已是 absolute + cleaned —— 不做 symlink 解析。
//
// 抽出供 resolveParentNoSymlink + verifyFdTarget 共用,保证 PUT 写校验和 GET fd
// 后置校验用的是同一套"什么算合法位置"判定。
func pathInAllowedTree(clean string) bool {
	if !filepath.IsAbs(clean) {
		return false
	}
	for _, root := range AllowedRoots {
		r := filepath.Clean(root)
		if clean == r || strings.HasPrefix(clean, r+string(filepath.Separator)) {
			return true
		}
	}
	parent := filepath.Dir(clean)
	if parent != clean && dirMatchesAllowedRegex(parent) {
		return true
	}
	return false
}

// readFdRealPath 读 /proc/self/fd/<n> 返回 kernel 视角下 fd 的真实路径。
// 用于 verifyFdTarget,以及未来其他需要"fd 真身"判定的场景。
func readFdRealPath(fd uintptr) (string, error) {
	return os.Readlink(fmt.Sprintf("/proc/self/fd/%d", fd))
}

// verifyFdTarget 在 Open 之后再用 /proc/self/fd/<fd> 反查 fd 的 kernel 视角真实
// 路径,确认它仍落在 AllowedRoots / AllowedDirRegexes 内。
//
// 用途:关掉 resolveParentNoSymlink → OpenFile 之间最后的 TOCTOU race window。
// 即便 PUT 时 parent 被检查过、O_NOFOLLOW 防住了最终项 symlink,attacker 仍可
// 在 EvalSymlinks 通过 → OpenFile 之间瞬间把 parent 换成 symlink 指向白名单外
// 路径,让 fd 拿到一个外部 inode。读 /proc/self/fd 拿 kernel 解析后的真实路径
// 是最直接的事后裁决。
//
// 同时拒 " (deleted)" 后缀:那意味着 dentry 已被 unlink,继续读会返回一个 doomed
// inode 的旧内容 — 攻击场景:create file → open → unlink → readlink shows
// "<path> (deleted)" → 即使 path 在白名单,该 inode 也已和文件系统脱钩,不可信。
//
// Linux-only(依赖 procfs)。node-agent 部署平台明确为 Linux 容器宿主。
func verifyFdTarget(fd uintptr) error {
	realTarget, err := readFdRealPath(fd)
	if err != nil {
		return fmt.Errorf("readlink fd: %w", err)
	}
	if strings.HasSuffix(realTarget, " (deleted)") {
		return fmt.Errorf("fd target marked deleted: %q", realTarget)
	}
	if !pathInAllowedTree(realTarget) {
		return fmt.Errorf("fd target %q outside allowed roots", realTarget)
	}
	return nil
}

// parseMode 解析 octal mode 字符串(如 "0600" / "600"),默认 0600。
func parseMode(raw string) (os.FileMode, error) {
	if raw == "" {
		return 0o600, nil
	}
	n, err := strconv.ParseUint(raw, 8, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid mode %q: %w", raw, err)
	}
	// 屏蔽高位,只保留权限位
	return os.FileMode(n) & 0o7777, nil
}

// parseOwner 解析 owner_uid / owner_gid query。两者必须同时出现或同时缺。
// 出现时:base=10,非负,<= MaxInt32(防 overflow / chown -1 "保持不变" 语义)。
// 返回 (uid, gid, hasOwner, err)。hasOwner=false 表示 caller 跳过 chown。
//
// 设计:Unix chown(-1, ...) 有"保持当前 owner"的特殊语义。本 endpoint
// 暴露给 master 跨机调,不允许这种隐式行为 — 严格拒绝负数 / overflow / 缺一参数,
// caller 必须显式两个都传或都不传。
func parseOwner(uidRaw, gidRaw string) (uid int, gid int, hasOwner bool, err error) {
	if uidRaw == "" && gidRaw == "" {
		return 0, 0, false, nil
	}
	if uidRaw == "" || gidRaw == "" {
		return 0, 0, false, errors.New("owner_uid and owner_gid must both be set or both omitted")
	}
	parse := func(name, raw string) (int, error) {
		// bitSize=32 防 32-bit 系统 overflow;Unix uid_t 是 uint32 但 chown 用 int
		n, e := strconv.ParseInt(raw, 10, 32)
		if e != nil {
			return 0, fmt.Errorf("invalid %s %q: %w", name, raw, e)
		}
		if n < 0 {
			return 0, fmt.Errorf("invalid %s %q: must be non-negative (chown -1 not allowed)", name, raw)
		}
		return int(n), nil
	}
	uid, err = parse("owner_uid", uidRaw)
	if err != nil {
		return 0, 0, false, err
	}
	gid, err = parse("owner_gid", gidRaw)
	if err != nil {
		return 0, 0, false, err
	}
	return uid, gid, true, nil
}

// StatResponse 是 GET /files/stat 的 JSON 响应。
type StatResponse struct {
	Exists bool   `json:"exists"`
	Size   int64  `json:"size,omitempty"`
	Mtime  string `json:"mtime,omitempty"`  // RFC3339
	Sha256 string `json:"sha256,omitempty"` // 仅 Exists=true 时计算
}

// Handler 是 HTTP handler 集合。authmw 已在 server 层包住。
type Handler struct{}

func New() *Handler {
	return &Handler{}
}

// ServeHTTP 做路由:
//
//	PUT    /files?path=...&mode=... body
//	DELETE /files?path=...
//	GET    /files?path=...               (流式 body,Content-Type=application/octet-stream)
//	GET    /files/stat?path=...
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPut && r.URL.Path == "/files":
		h.handlePut(w, r)
	case r.Method == http.MethodDelete && r.URL.Path == "/files":
		h.handleDelete(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/files":
		h.handleGet(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/files/stat":
		h.handleStat(w, r)
	default:
		http.NotFound(w, r)
	}
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "error": msg})
}

func (h *Handler) handlePut(w http.ResponseWriter, r *http.Request) {
	p, err := validatePath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_PATH", err.Error())
		return
	}
	mode, err := parseMode(r.URL.Query().Get("mode"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_MODE", err.Error())
		return
	}
	ownerUID, ownerGID, hasOwner, err := parseOwner(
		r.URL.Query().Get("owner_uid"),
		r.URL.Query().Get("owner_gid"),
	)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_OWNER", err.Error())
		return
	}

	lk := pathLock(p)
	lk.Lock()
	defer lk.Unlock()
	release := acquire()
	defer release()

	// 限读:超 MaxFileSize+1 字节就拒
	r.Body = http.MaxBytesReader(w, r.Body, MaxFileSize)
	defer r.Body.Close()

	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "MKDIR_FAIL", err.Error())
		return
	}
	// symlink 逃逸防御: parent 真身必须仍在 AllowedRoots
	if err := resolveParentNoSymlink(p); err != nil {
		writeErr(w, http.StatusBadRequest, "PARENT_UNSAFE", err.Error())
		return
	}

	tmp := p + ".tmp"
	// O_NOFOLLOW 防止 tmp/p 本身被预先植入 symlink 指向其他位置
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "OPEN_TMP_FAIL", err.Error())
		return
	}

	// Codex review(短期 hardening,与 GET 对齐):open 后立刻 /proc/self/fd
	// 反查 fd 真实路径,挡 resolveParentNoSymlink → OpenFile 之间 parent 被
	// 换成 symlink 的 race 窗口。失败时只关 fd、不做 path-based remove ——
	// 此时 tmp 文本路径已不可信,os.Remove(tmp) 可能误删 attacker 控制下的
	// 同名文件。
	if err := verifyFdTarget(f.Fd()); err != nil {
		_ = f.Close()
		writeErr(w, http.StatusBadRequest, "PATH_DIVERGED", err.Error())
		return
	}

	// post-open failure 一律不做 path-based cleanup(Codex review)。原因:
	//   - readlink + Remove 两步之间仍有 race window,attacker 可以在判定
	//     "fd == tmpPath"通过后再换 parent,让 Remove 走偏。
	//   - 唯一闭环的清理需要 fd-based unlinkat,Linux 用户态没现成 API。
	//   - 接受 .tmp 残留:fd 在 open 时 verifyFdTarget 已确认落在 safe parent
	//     下,root-owned 0600,无攻击面;下次同名 PUT 走 O_TRUNC 会覆盖,
	//     不构成磁盘累积问题。
	// 因此 close 时只关 fd,不再 Remove。中期由 openat2 + unlinkat(dirfd) 根治。
	failClose := func() {
		_ = f.Close()
	}

	if _, err := io.Copy(f, r.Body); err != nil {
		failClose()
		// MaxBytesError → 413
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
				fmt.Sprintf("body exceeds %d bytes", MaxFileSize))
			return
		}
		writeErr(w, http.StatusInternalServerError, "WRITE_FAIL", err.Error())
		return
	}
	if err := f.Sync(); err != nil {
		failClose()
		writeErr(w, http.StatusInternalServerError, "FSYNC_FAIL", err.Error())
		return
	}
	// chown/chmod 必须在 Close 之前,且通过 fd 而非 tmp 文本路径。原因:
	// 路径式 os.Chown(tmp, container_uid, ...) 在 attacker race 后会按当前
	// parent 解析,可能把 /etc/某文件 的 owner 改成容器 uid —— root 主动给
	// 出宿主关键文件的 ownership,是真的提权路径。f.Chown / f.Chmod 直接
	// 对 fd 引用的 inode 操作,不经路径解析,attacker 无法欺骗。
	//
	// chown 仍必须在 chmod 之前。原因:caller 用 mode=0o400 owner=container_uid:gid
	// 让容器内 agent 可读;若反过来先 chmod 0o400 再 chown,owner 切换瞬间文件归
	// 容器 uid 但 mode 已是只读 — 从 root 切到容器 uid 这段时间窗内,host 上以
	// 容器 uid 跑的进程理论可短暂读到 tmp。先 chown 后 chmod 整个时间窗内 mode
	// 仍是 0o600 owner=root,host 上其他 uid 进程无法读;rename 后才完整生效。
	if hasOwner {
		if err := chownFile(f, ownerUID, ownerGID); err != nil {
			failClose()
			writeErr(w, http.StatusInternalServerError, "CHOWN_FAIL", err.Error())
			return
		}
	}
	if err := chmodFile(f, mode); err != nil {
		failClose()
		writeErr(w, http.StatusInternalServerError, "CHMOD_FAIL", err.Error())
		return
	}
	// Close / Rename 失败后 fd 已无效,无法 safeCleanTmp。接受 .tmp 残留在
	// open 时验证过的 safe parent 下(root-owned 0600,无攻击面);下次同
	// 名 PUT 走 O_TRUNC 会覆盖。
	if err := f.Close(); err != nil {
		writeErr(w, http.StatusInternalServerError, "CLOSE_FAIL", err.Error())
		return
	}
	if err := renameFile(tmp, p); err != nil {
		writeErr(w, http.StatusInternalServerError, "RENAME_FAIL", err.Error())
		return
	}
	// Codex review(post-rename guard):Rename 本身仍是按文本路径解析,如果
	// attacker 恰在 Rename 那一刻把 parent 换成 symlink → 白名单外,文件会落
	// 到外部目录。再做一次 resolveParentNoSymlink(p) 兜底:p 的 parent 真身
	// 必须仍在白名单内。pathInAllowedTree(纯文本)不够 —— parent 是 symlink
	// 时文本判定仍会通过。
	//
	// 失败时不 os.Remove(p):此时 parent 不 safe,Remove 操作的路径不可信(可
	// 能误删非自己写入的文件)。让 master 收到 500 + log 后人工处置。
	if err := resolveParentNoSymlink(p); err != nil {
		writeErr(w, http.StatusInternalServerError, "PATH_DIVERGED",
			fmt.Sprintf("post-rename parent unsafe: %v", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) handleDelete(w http.ResponseWriter, r *http.Request) {
	p, err := validatePath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_PATH", err.Error())
		return
	}
	lk := pathLock(p)
	lk.Lock()
	defer lk.Unlock()
	release := acquire()
	defer release()

	// parent 真身校验,与 PUT/GET/STAT 对齐:挡 user-data symlink 逃逸让
	// Remove 落到 /etc 之类。
	// parent 不存在(ENOENT)语义等价"文件不存在",返 204 幂等 —— 与下方 Lstat
	// ErrNotExist 分支一致,保持 sshMux / remoteCodexAuth 等调用方"删除不存在
	// 视为成功"的预期。
	// unlink syscall 没有 fd,无法做 verifyFdTarget post-check;接受 race window
	// 残留极小(中期由 openat2 一次性根治,见 audit-file-toctou.md)。
	if err := resolveParentNoSymlink(p); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeErr(w, http.StatusBadRequest, "PARENT_UNSAFE", err.Error())
		return
	}

	// Lstat 防御:若 p 是 symlink,拒删(避免 master 误以为删的是真文件)。
	// 不存在 → 幂等成功。
	st, err := os.Lstat(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeErr(w, http.StatusInternalServerError, "LSTAT_FAIL", err.Error())
		return
	}
	if st.Mode()&os.ModeSymlink != 0 {
		writeErr(w, http.StatusBadRequest, "IS_SYMLINK", "refuse to delete symlink")
		return
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeErr(w, http.StatusInternalServerError, "REMOVE_FAIL", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) handleStat(w http.ResponseWriter, r *http.Request) {
	p, err := validatePath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_PATH", err.Error())
		return
	}
	lk := pathLock(p)
	lk.Lock()
	defer lk.Unlock()
	release := acquire()
	defer release()

	// 与 handleGet 对齐:先 parent 真身校验,挡 user-data symlink 逃逸。
	// parent 不存在(ENOENT)语义等价"文件不存在",返 {exists:false} —— 不能升级
	// 为 500,master 侧 statFile 调用方(nodeBootstrap 查 baseline VERSION)按
	// "文件缺失"处理这条分支。
	if err := resolveParentNoSymlink(p); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(StatResponse{Exists: false})
			return
		}
		writeErr(w, http.StatusBadRequest, "PARENT_UNSAFE", err.Error())
		return
	}

	// Lstat 代替 Stat:symlink 指向白名单外的目标不应当被当作普通文件 stat。
	st, err := os.Lstat(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(StatResponse{Exists: false})
			return
		}
		writeErr(w, http.StatusInternalServerError, "STAT_FAIL", err.Error())
		return
	}
	// 只允许普通文件;拒 dir/symlink/device/pipe
	if !st.Mode().IsRegular() {
		writeErr(w, http.StatusBadRequest, "NOT_REGULAR_FILE",
			fmt.Sprintf("mode=%s not a regular file", st.Mode()))
		return
	}
	// size 上界保护:ReadFile 会把整个文件加载内存,对异常大的文件直接拒
	if st.Size() > MaxFileSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
			fmt.Sprintf("size %d exceeds %d", st.Size(), MaxFileSize))
		return
	}

	// 流式算 sha256,O_NOFOLLOW 防御在 stat 与 open 之间被替换成 symlink。
	// verifyFdTarget 与 handleGet 对齐:open 后 /proc/self/fd 反查 fd 真实路径,
	// 关掉 resolveParentNoSymlink → OpenFile 之间的最后一道 race window。
	// 拒绝时返 400 PATH_DIVERGED 而非 {exists:false} —— 这意味着真有 attacker
	// race,应让 master 看见错误而不是被误导成"文件缺失"。
	//
	// OpenFile 失败保留原 best-effort 语义:digest 留空,仍返 {exists:true}(对
	// 应权限/ACL/EBUSY 等不该升级为 500 的瞬时错);verifyFdTarget 才是 hard
	// fail 边界。
	digest := ""
	f, openErr := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if openErr == nil {
		if err := verifyFdTarget(f.Fd()); err != nil {
			_ = f.Close()
			writeErr(w, http.StatusBadRequest, "PATH_DIVERGED", err.Error())
			return
		}
		hasher := sha256.New()
		if _, copyErr := io.Copy(hasher, io.LimitReader(f, MaxFileSize+1)); copyErr == nil {
			digest = hex.EncodeToString(hasher.Sum(nil))
		}
		_ = f.Close()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(StatResponse{
		Exists: true,
		Size:   st.Size(),
		Mtime:  st.ModTime().UTC().Format(time.RFC3339),
		Sha256: digest,
	})
}

// handleGet 流式回送 AllowedRoots 下的普通文件。
//
// 2026-05-16:用于 master gateway "/api/media + /api/file" 在 remote-host
// 用户场景下从远端 docker volume 拉文件回服(读路径,与 PUT 镜像)。
//
// 防御链(对齐 PUT,避免本地读路径强度低于本地写路径):
//   - validatePath: 文本层白名单(AllowedRoots 或 AllowedDirRegexes)
//   - resolveParentNoSymlink: parent 真身仍在白名单(挡 user-data symlink 逃逸)
//   - O_NOFOLLOW open: 最终项不允许是 symlink
//   - fd.Stat (而非先 Lstat 再 Open): 关掉 TOCTOU 窗口 + 屏蔽 FIFO/设备/dir
//   - size 上限 MaxFileSize: 与 master upload limit 对齐
//
// Content-Length / Content-Type 是协议必要;master 自己再按真实 MIME 设头给
// HTTP 终端用户,本端给的 octet-stream 只是 RPC 信道默认。
func (h *Handler) handleGet(w http.ResponseWriter, r *http.Request) {
	p, err := validatePath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_PATH", err.Error())
		return
	}
	lk := pathLock(p)
	lk.Lock()
	defer lk.Unlock()
	release := acquire()
	defer release()

	// Codex review #2 (Phase 2):pre-check parent 真身 → 再 Open。
	// 顺序原因:post-open check 不能证明 fd 来源安全 — attacker 可能在
	// "parent 暂时换成外部目录 → Open → parent 换回安全位" 的窗口中让 fd 指向
	// 外部 inode。pre-check + Open 把窗口收窄到 EvalSymlinks → Open 之间,远小于
	// 之前。注意 parent 不存在时 EvalSymlinks 返 err,这里要把"父目录不存在"
	// 同样 map 成 404(语义上等价于"文件不存在")。
	if err := resolveParentNoSymlink(p); err != nil {
		// EvalSymlinks 在 parent 不存在时返 *os.PathError(syscall=ENOENT)
		if errors.Is(err, os.ErrNotExist) {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "parent does not exist")
			return
		}
		writeErr(w, http.StatusBadRequest, "PARENT_UNSAFE", err.Error())
		return
	}
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "file does not exist")
			return
		}
		// O_NOFOLLOW 命中 symlink 时,Linux 返 ELOOP;包成 BAD_PATH
		writeErr(w, http.StatusBadRequest, "OPEN_FAIL", err.Error())
		return
	}
	defer f.Close()

	// Codex review #3 (Phase 2):resolveParentNoSymlink + O_NOFOLLOW 仍留有
	// "parent 在 EvalSymlinks 与 Open 之间被换成 symlink → 外部目录" 的窗口
	// (NOFOLLOW 只防最终项,parent 路径分量已是 symlink 不算)。读 /proc/self/fd
	// 拿 fd 真实路径再过一次白名单,把这道缝缝严。
	if err := verifyFdTarget(f.Fd()); err != nil {
		writeErr(w, http.StatusBadRequest, "PATH_DIVERGED", err.Error())
		return
	}

	st, err := f.Stat()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "STAT_FAIL", err.Error())
		return
	}
	if !st.Mode().IsRegular() {
		writeErr(w, http.StatusBadRequest, "NOT_REGULAR_FILE",
			fmt.Sprintf("mode=%s not a regular file", st.Mode()))
		return
	}
	if st.Size() > MaxFileSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
			fmt.Sprintf("size %d exceeds %d", st.Size(), MaxFileSize))
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	w.WriteHeader(http.StatusOK)
	// io.Copy 走 sendfile fast path(Linux);流式不占额外内存。
	// 即便 client 中途断,err 不致命 — master 那侧会自己处理 truncated body。
	_, _ = io.Copy(w, f)
}
