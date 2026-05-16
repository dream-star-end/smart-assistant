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
// 名字带 per-user 序号(uid)的动态目录,典型即 v3 commercial 用户 docker volume
// 下的 uploads/generated 子目录:
//
//	/var/lib/docker/volumes/oc-v3-data-u<uid>/_data/(uploads|generated)
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
	regexp.MustCompile(`^/var/lib/docker/volumes/oc-v3-data-u[1-9][0-9]{0,18}/_data/(uploads|generated)$`),
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

// osChown 是 os.Chown 的可注入 seam,测试里 override 模拟 chown 失败。
// 生产路径直接走标准库。
var osChown = os.Chown

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
	for _, root := range AllowedRoots {
		r := filepath.Clean(root)
		if real == r || strings.HasPrefix(real, r+string(filepath.Separator)) {
			return nil
		}
	}
	if dirMatchesAllowedRegex(real) {
		return nil
	}
	return fmt.Errorf("parent %q resolved to %q outside allowed roots", parent, real)
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
//	GET    /files/stat?path=...
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPut && r.URL.Path == "/files":
		h.handlePut(w, r)
	case r.Method == http.MethodDelete && r.URL.Path == "/files":
		h.handleDelete(w, r)
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
	// 失败时清理 tmp
	cleanTmp := func() { _ = os.Remove(tmp) }

	if _, err := io.Copy(f, r.Body); err != nil {
		_ = f.Close()
		cleanTmp()
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
		_ = f.Close()
		cleanTmp()
		writeErr(w, http.StatusInternalServerError, "FSYNC_FAIL", err.Error())
		return
	}
	if err := f.Close(); err != nil {
		cleanTmp()
		writeErr(w, http.StatusInternalServerError, "CLOSE_FAIL", err.Error())
		return
	}
	// chown 必须在 chmod 之前。原因:caller 用 mode=0o400 owner=container_uid:gid
	// 让容器内 agent 可读;若反过来先 chmod 0o400 再 chown,owner 切换瞬间文件归
	// 容器 uid 但 mode 已是只读 — 从 root 切到容器 uid 这段时间窗内,host 上以
	// 容器 uid 跑的进程理论可短暂读到 tmp(虽 NOFOLLOW + tmp 名字不可猜,但纪律
	// 上避免)。先 chown 后 chmod 整个时间窗内 mode 仍是 0o600 owner=root,host
	// 上其他 uid 进程无法读;rename 后才完整生效。
	if hasOwner {
		if err := osChown(tmp, ownerUID, ownerGID); err != nil {
			cleanTmp()
			writeErr(w, http.StatusInternalServerError, "CHOWN_FAIL", err.Error())
			return
		}
	}
	if err := os.Chmod(tmp, mode); err != nil {
		cleanTmp()
		writeErr(w, http.StatusInternalServerError, "CHMOD_FAIL", err.Error())
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		cleanTmp()
		writeErr(w, http.StatusInternalServerError, "RENAME_FAIL", err.Error())
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

	// 流式算 sha256,O_NOFOLLOW 防御在 stat 与 open 之间被替换成 symlink
	digest := ""
	if f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0); err == nil {
		h := sha256.New()
		if _, copyErr := io.Copy(h, io.LimitReader(f, MaxFileSize+1)); copyErr == nil {
			digest = hex.EncodeToString(h.Sum(nil))
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
