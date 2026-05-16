// files_test.go — 覆盖 v1.0.72 新加的 owner_uid/owner_gid 解析 + chown 行为。
//
// 不测原有 PUT/DELETE/STAT 主流程(那部分已在生产稳定多版本)。仅锁定:
//   - parseOwner 严格策略(缺一 / 负数 / overflow / 非数字 → error)
//   - handlePut 在带 owner 参数时调 osChown(用 var 替换 mock)
//   - chown 失败 → 500 CHOWN_FAIL + tmp 清理
//   - 不带 owner 参数 → 不调 chown(向后兼容,老 master 不受影响)
package files

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseOwner(t *testing.T) {
	cases := []struct {
		name      string
		uidRaw    string
		gidRaw    string
		wantHas   bool
		wantUID   int
		wantGID   int
		wantErr   bool
		errSubstr string
	}{
		{name: "both empty → no owner", wantHas: false},
		{name: "valid uid+gid", uidRaw: "1000", gidRaw: "1000", wantHas: true, wantUID: 1000, wantGID: 1000},
		{name: "uid only → 400", uidRaw: "1000", wantErr: true, errSubstr: "both"},
		{name: "gid only → 400", gidRaw: "1000", wantErr: true, errSubstr: "both"},
		{name: "negative uid → 400", uidRaw: "-1", gidRaw: "0", wantErr: true, errSubstr: "non-negative"},
		{name: "negative gid → 400", uidRaw: "0", gidRaw: "-5", wantErr: true, errSubstr: "non-negative"},
		{name: "non-numeric uid → 400", uidRaw: "abc", gidRaw: "0", wantErr: true, errSubstr: "invalid"},
		{name: "non-numeric gid → 400", uidRaw: "0", gidRaw: "x", wantErr: true, errSubstr: "invalid"},
		{name: "overflow uid → 400", uidRaw: "999999999999", gidRaw: "0", wantErr: true, errSubstr: "invalid"},
		{name: "zero uid+gid (root) OK", uidRaw: "0", gidRaw: "0", wantHas: true, wantUID: 0, wantGID: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			uid, gid, has, err := parseOwner(tc.uidRaw, tc.gidRaw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				if tc.errSubstr != "" && !strings.Contains(err.Error(), tc.errSubstr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tc.errSubstr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if has != tc.wantHas {
				t.Fatalf("hasOwner: want %v got %v", tc.wantHas, has)
			}
			if has {
				if uid != tc.wantUID || gid != tc.wantGID {
					t.Fatalf("uid/gid: want %d/%d got %d/%d", tc.wantUID, tc.wantGID, uid, gid)
				}
			}
		})
	}
}

// withTempAllowedRoot 临时把 dir 加入 AllowedRoots,return cleanup。
// 不并发安全,t.Parallel 不可与该 helper 共用。
func withTempAllowedRoot(t *testing.T, dir string) func() {
	t.Helper()
	orig := AllowedRoots
	AllowedRoots = append(append([]string{}, orig...), dir)
	return func() { AllowedRoots = orig }
}

func TestHandlePut_OwnerChown_Success(t *testing.T) {
	// 测试 mock:override osChown 记录调用参数。返回 nil(成功)。
	// 真实 chown 在非 root 跑测试时会 EPERM,所以必须 mock。
	var gotPath string
	var gotUID, gotGID int
	var chownCalled bool
	osChownOrig := osChown
	osChown = func(name string, uid, gid int) error {
		chownCalled = true
		gotPath = name
		gotUID = uid
		gotGID = gid
		return nil
	}
	defer func() { osChown = osChownOrig }()

	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "auth.json")
	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0400")
	q.Set("owner_uid", "1000")
	q.Set("owner_gid", "1001")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader([]byte("payload")))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: want 204 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !chownCalled {
		t.Fatalf("osChown not called")
	}
	// chown 在 chmod 前调用,作用对象是 tmp(p+".tmp");rename 后才是 p
	if gotPath != target+".tmp" {
		t.Fatalf("chown path: want %q got %q", target+".tmp", gotPath)
	}
	if gotUID != 1000 || gotGID != 1001 {
		t.Fatalf("chown uid/gid: want 1000/1001 got %d/%d", gotUID, gotGID)
	}

	// 文件已 rename 到 target
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read final: %v", err)
	}
	if string(body) != "payload" {
		t.Fatalf("body: want %q got %q", "payload", string(body))
	}
	// tmp 已清理(rename 走的是 atomic move,tmp 不存在)
	if _, err := os.Stat(target + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("tmp should be gone, stat err=%v", err)
	}
}

func TestHandlePut_NoOwner_SkipsChown(t *testing.T) {
	// 老 master 不发 owner 参数 — 必须不调 chown(向后兼容)
	var chownCalled bool
	osChownOrig := osChown
	osChown = func(name string, uid, gid int) error {
		chownCalled = true
		return nil
	}
	defer func() { osChown = osChownOrig }()

	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "data.bin")
	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0644")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader([]byte("x")))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: want 204 got %d body=%q", rec.Code, rec.Body.String())
	}
	if chownCalled {
		t.Fatalf("osChown should not be called when owner not specified")
	}
}

func TestHandlePut_ChownFails_500AndTmpCleaned(t *testing.T) {
	osChownOrig := osChown
	osChown = func(name string, uid, gid int) error {
		return os.ErrPermission
	}
	defer func() { osChown = osChownOrig }()

	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "fail.json")
	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0400")
	q.Set("owner_uid", "1000")
	q.Set("owner_gid", "1000")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader([]byte("x")))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: want 500 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "CHOWN_FAIL") {
		t.Fatalf("body should contain CHOWN_FAIL, got %q", rec.Body.String())
	}
	// tmp 已清理
	if _, err := os.Stat(target + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("tmp should be cleaned, stat err=%v", err)
	}
	// 最终文件不应该存在(chown 失败 → 不 rename)
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("final file should not exist, stat err=%v", err)
	}
}

// ── AllowedDirRegexes(v3 user-volume media)的 validatePath 行为 ──────
//
// 该 regex 允许 PUT/DELETE/STAT 命中
// /var/lib/docker/volumes/oc-v3-data-u<uid>/_data/(uploads|generated)/<file>
// 这一动态路径(per-user docker volume)。覆盖 accept / reject 两侧边界。
func TestValidatePath_V3UserVolumeMedia(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		// accept
		{"uploads 下文件", "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/abc.txt", false},
		{"generated 下文件", "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated/img.png", false},
		{"uid=1 小数字", "/var/lib/docker/volumes/oc-v3-data-u1/_data/uploads/a.bin", false},
		{"uid=19 位 (MAX_SAFE_INT 范围)", "/var/lib/docker/volumes/oc-v3-data-u9007199254740991/_data/uploads/a", false},
		{"含 dedup-style 文件名 (digest.ext)", "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/deadbeef.jpg", false},

		// reject — 目录本身不接受(规避对 dynamic root 目录的直接操作)
		{"目录本身(uploads)", "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads", true},
		{"目录本身(generated)", "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated", true},

		// reject — 嵌套子目录(uploads/sub/file)
		{"uploads 嵌套子目录", "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/sub/x.txt", true},

		// reject — 非 uploads/generated 子目录
		{"其他子目录(projects)", "/var/lib/docker/volumes/oc-v3-data-u42/_data/projects/x.txt", true},
		{"其他子目录(skills)", "/var/lib/docker/volumes/oc-v3-data-u42/_data/skills/x.txt", true},

		// reject — uid 形态不合法
		{"uid=0", "/var/lib/docker/volumes/oc-v3-data-u0/_data/uploads/x", true},
		{"uid 前导 0", "/var/lib/docker/volumes/oc-v3-data-u042/_data/uploads/x", true},
		{"uid 含非数字", "/var/lib/docker/volumes/oc-v3-data-uabc/_data/uploads/x", true},
		{"uid 含负号", "/var/lib/docker/volumes/oc-v3-data-u-1/_data/uploads/x", true},
		{"uid 超长 20 位", "/var/lib/docker/volumes/oc-v3-data-u12345678901234567890/_data/uploads/x", true},
		{"卷名前缀不对(proj 而非 data)", "/var/lib/docker/volumes/oc-v3-proj-u42/_data/uploads/x", true},
		{"docker volumes 根下其它卷", "/var/lib/docker/volumes/random-vol/_data/uploads/x", true},

		// reject — 路径穿越
		{"含 ..", "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/../../etc/passwd", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validatePath(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// handleGet 覆盖(2026-05-16 Phase 2):master 通过这个 endpoint 拉远端 user
// volume 文件。锁定四件事:
//   - 正常存在的普通文件 → 200 + 完整 body + 正确 Content-Length
//   - 不存在 → 404 NOT_FOUND(让 master 区分 fallback 与 502)
//   - 目录而非普通文件 → 400 NOT_REGULAR_FILE(挡 dir/FIFO/device)
//   - 白名单外路径 → 400 BAD_PATH(validatePath gate)
func TestHandleGet_RegularFile_200(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	payload := []byte("hello-from-remote-host-1234567890")
	target := filepath.Join(tmpDir, "img.png")
	if err := os.WriteFile(target, payload, 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	q := url.Values{}
	q.Set("path", target)
	req := httptest.NewRequest(http.MethodGet, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleGet(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: want 200 got %d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("Content-Type: want application/octet-stream got %q", got)
	}
	if got := rec.Header().Get("Content-Length"); got != "33" {
		t.Fatalf("Content-Length: want 33 got %q", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), payload) {
		t.Fatalf("body mismatch: want %q got %q", payload, rec.Body.Bytes())
	}
}

func TestHandleGet_NotFound_404(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	q := url.Values{}
	q.Set("path", filepath.Join(tmpDir, "missing.png"))
	req := httptest.NewRequest(http.MethodGet, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleGet(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status: want 404 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "NOT_FOUND") {
		t.Fatalf("body should contain NOT_FOUND, got %q", rec.Body.String())
	}
}

func TestHandleGet_Directory_400(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	subdir := filepath.Join(tmpDir, "sub")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	q := url.Values{}
	q.Set("path", subdir)
	req := httptest.NewRequest(http.MethodGet, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleGet(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "NOT_REGULAR_FILE") {
		t.Fatalf("body should contain NOT_REGULAR_FILE, got %q", rec.Body.String())
	}
}

func TestHandleGet_OutsideAllowlist_400(t *testing.T) {
	// 不调 withTempAllowedRoot → /tmp 不在白名单
	tmpFile, err := os.CreateTemp("", "outside-*.dat")
	if err != nil {
		t.Fatalf("tmp: %v", err)
	}
	tmpFile.Close()
	defer os.Remove(tmpFile.Name())

	q := url.Values{}
	q.Set("path", tmpFile.Name())
	req := httptest.NewRequest(http.MethodGet, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleGet(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "BAD_PATH") {
		t.Fatalf("body should contain BAD_PATH, got %q", rec.Body.String())
	}
}

// verifyFdTarget(Phase 2 Codex review #3 补丁):/proc/self/fd 反查 fd 真实路径,
// 关掉"parent 在 check 和 open 之间被换成 symlink"的最后一道 race window。
//
// 测三件事:
//  1. 正常 open 一个白名单内文件 → verifyFdTarget 通过
//  2. open 之后 unlink 文件 → readlink 看到 " (deleted)" → 拒
//  3. open 一个白名单外文件(如 /etc/hostname 这种宿主静态文件)→ 拒
//
// 真正的 race(EvalSymlinks 通过 → 攻击者换 parent → Open)无法稳定复现 — 该
// 测试覆盖的是 verifyFdTarget 的判定逻辑,即"拿到一个外部目标的 fd 后能不能识
// 别"。在真实 race 发生时同一段代码会拒掉 attacker 得到的 fd。
func TestVerifyFdTarget_InsideAllowed_OK(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "ok.bin")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	f, err := os.Open(target)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	if err := verifyFdTarget(f.Fd()); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
}

func TestVerifyFdTarget_Deleted_Rejected(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "doomed.bin")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	f, err := os.Open(target)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	// unlink while fd still open — kernel marks /proc/self/fd/<n> 路径以
	// " (deleted)" 结尾
	if err := os.Remove(target); err != nil {
		t.Fatalf("remove: %v", err)
	}

	err = verifyFdTarget(f.Fd())
	if err == nil {
		t.Fatalf("expected error on deleted fd, got nil")
	}
	if !strings.Contains(err.Error(), "deleted") {
		t.Fatalf("error should mention deleted, got %q", err.Error())
	}
}

func TestVerifyFdTarget_OutsideAllowed_Rejected(t *testing.T) {
	// 不挂临时 AllowedRoots → /etc 系统文件天然在白名单外
	f, err := os.Open("/etc/hostname")
	if err != nil {
		t.Skipf("skip: /etc/hostname not readable: %v", err)
	}
	defer f.Close()

	err = verifyFdTarget(f.Fd())
	if err == nil {
		t.Fatalf("expected error for /etc/hostname, got nil")
	}
	if !strings.Contains(err.Error(), "outside allowed roots") {
		t.Fatalf("error should mention outside allowed roots, got %q", err.Error())
	}
}

// pathInAllowedTree 是 verifyFdTarget 调用的纯文本白名单判定,锁定它的边界:
//   - AllowedRoots 下 / 等于 root → 通过
//   - AllowedDirRegexes 命中的 parent + 文件 → 通过
//   - 相对路径 / 白名单外路径 → 拒
//   - "前缀污染"(/var/lib/openclaude/baseline-evil/...)→ 拒
func TestPathInAllowedTree(t *testing.T) {
	cases := []struct {
		name string
		p    string
		want bool
	}{
		{"AllowedRoot 下文件", "/var/lib/openclaude/baseline/foo.txt", true},
		{"AllowedRoot 自身", "/var/lib/openclaude/baseline", true},
		{"AllowedDirRegex uploads 下", "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/a.png", true},
		{"AllowedDirRegex generated 下", "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated/a.png", true},
		// 反例
		{"相对路径", "etc/passwd", false},
		{"/etc/passwd", "/etc/passwd", false},
		{"baseline-evil 前缀污染", "/var/lib/openclaude/baseline-evil/x", false},
		{"uploads 嵌套子目录", "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/sub/x", false},
		{"uploads-evil 后缀污染", "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads-evil/x.png", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pathInAllowedTree(tc.p); got != tc.want {
				t.Fatalf("want %v got %v for %q", tc.want, got, tc.p)
			}
		})
	}
}

func TestHandlePut_BadOwner_400(t *testing.T) {
	osChownOrig := osChown
	osChown = func(name string, uid, gid int) error {
		t.Fatalf("osChown must not be called when owner is invalid")
		return nil
	}
	defer func() { osChown = osChownOrig }()

	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "bad.json")

	cases := []struct {
		name string
		q    url.Values
	}{
		{"uid only", url.Values{"path": []string{target}, "owner_uid": []string{"1000"}}},
		{"gid only", url.Values{"path": []string{target}, "owner_gid": []string{"1000"}}},
		{"negative uid", url.Values{"path": []string{target}, "owner_uid": []string{"-1"}, "owner_gid": []string{"0"}}},
		{"non-numeric", url.Values{"path": []string{target}, "owner_uid": []string{"foo"}, "owner_gid": []string{"0"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/files?"+tc.q.Encode(), bytes.NewReader([]byte("x")))
			rec := httptest.NewRecorder()
			(&Handler{}).handlePut(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "BAD_OWNER") {
				t.Fatalf("body should contain BAD_OWNER, got %q", rec.Body.String())
			}
		})
	}
}
