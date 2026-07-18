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
	"fmt"
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
	// 测试 mock:override chownFile 记录调用参数。返回 nil(成功)。
	// 真实 chown 在非 root 跑测试时会 EPERM,所以必须 mock。
	//
	// 关键 assertion(防退回 path-based chown):验证 fd 指向的真实路径是
	// tmp(即 target+".tmp"),不是任何 attacker-swapped 路径。/proc/self/fd
	// readlink 是 kernel 视角的 fd→inode→path 反查。
	var gotFdPath string
	var gotUID, gotGID int
	var chownCalled bool
	chownOrig := chownFile
	chownFile = func(f *os.File, uid, gid int) error {
		chownCalled = true
		// readlink 拿 fd 真实路径,验 fd-based 语义生效(参数是 fd 不是路径)
		if p, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", f.Fd())); err == nil {
			gotFdPath = p
		}
		gotUID = uid
		gotGID = gid
		return nil
	}
	defer func() { chownFile = chownOrig }()

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
		t.Fatalf("chownFile not called")
	}
	// chown 在 chmod 前调用,作用对象是 tmp 的 fd(p+".tmp");rename 后才是 p
	if gotFdPath != target+".tmp" {
		t.Fatalf("chown fd path: want %q got %q", target+".tmp", gotFdPath)
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
	chownOrig := chownFile
	chownFile = func(f *os.File, uid, gid int) error {
		chownCalled = true
		return nil
	}
	defer func() { chownFile = chownOrig }()

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

func TestHandlePut_ChownFails_500_FinalNotCreated(t *testing.T) {
	// chown 失败 → 500 CHOWN_FAIL + 最终文件不应创建。
	// 注:.tmp 残留是预期行为(Codex review 阻塞点修法:post-open failure 不
	// 做 path-based cleanup,避免 race-swap 后误删白名单外文件)。.tmp 在
	// verified-safe parent 下 root-owned 0600,无攻击面;下次同名 PUT 走
	// O_TRUNC 覆盖。
	chownOrig := chownFile
	chownFile = func(f *os.File, uid, gid int) error {
		return os.ErrPermission
	}
	defer func() { chownFile = chownOrig }()

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
	// 最终文件不应该存在(chown 失败 → 不 rename)
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("final file should not exist, stat err=%v", err)
	}
	// tmp 残留是预期(见函数 docstring,非安全契约,仅运维卫式)。本测试用
	// body=[]byte("x"),tmp 体积应当 ≤ 几字节;断个宽松上界防未来意外大泄漏。
	// 若改测试 body 体积需相应放宽此上界,这条不视为安全契约一部分。
	if st, err := os.Stat(target + ".tmp"); err == nil {
		if st.Size() > 1024 {
			t.Fatalf("tmp residue unexpectedly large: %d bytes (sanity guard, not security)", st.Size())
		}
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
		{"v5 uploads 下文件", "/var/lib/docker/volumes/oc-v5-data-u42/_data/uploads/abc.txt", false},
		{"v5 generated 下文件", "/var/lib/docker/volumes/oc-v5-data-u42/_data/generated/img.png", false},
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
		{"非 commercial channel", "/var/lib/docker/volumes/oc-v4-data-u42/_data/uploads/x", true},
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
// volume 文件。锁定五件事:
//   - 正常存在的普通文件 → 200 + 完整 body + 正确 Content-Length
//   - 不存在 → 404 NOT_FOUND(让 master 区分 fallback 与 502)
//   - 目录而非普通文件 → 400 NOT_REGULAR_FILE(挡 dir/FIFO/device)
//   - 白名单外路径 → 400 BAD_PATH(validatePath gate)
//   - 最终项 symlink → 400 OPEN_FAIL(O_NOFOLLOW gate)
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

func TestHandleGet_FinalSymlink_400(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "target.bin")
	link := filepath.Join(tmpDir, "link.bin")
	if err := os.WriteFile(target, []byte("must-not-follow"), 0o600); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("seed symlink: %v", err)
	}

	q := url.Values{}
	q.Set("path", link)
	req := httptest.NewRequest(http.MethodGet, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleGet(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "OPEN_FAIL") {
		t.Fatalf("body should contain OPEN_FAIL, got %q", rec.Body.String())
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
	chownOrig := chownFile
	chownFile = func(f *os.File, uid, gid int) error {
		t.Fatalf("chownFile must not be called when owner is invalid")
		return nil
	}
	defer func() { chownFile = chownOrig }()

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

// ── handleStat handler-level 覆盖(2026-05-16 hardening Part B)──────
//
// 短期 hardening 前 handleStat 没有 handler-level 测试,只能靠 validatePath
// 间接验路径。boss 要求"覆盖正常使用"补齐 happy path / 各类失败语义。

func TestHandleStat_HappyPath_ExistsTrue(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	payload := []byte("stat-me-please")
	target := filepath.Join(tmpDir, "file.bin")
	if err := os.WriteFile(target, payload, 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	q := url.Values{}
	q.Set("path", target)
	req := httptest.NewRequest(http.MethodGet, "/files/stat?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleStat(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: want 200 got %d body=%q", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	// exists=true 与 size + sha256 + mtime 字段必出现
	if !strings.Contains(body, `"exists":true`) {
		t.Fatalf("body missing exists=true: %s", body)
	}
	if !strings.Contains(body, fmt.Sprintf(`"size":%d`, len(payload))) {
		t.Fatalf("body missing correct size: %s", body)
	}
	if !strings.Contains(body, `"sha256":"`) {
		t.Fatalf("body missing sha256: %s", body)
	}
	if !strings.Contains(body, `"mtime":"`) {
		t.Fatalf("body missing mtime: %s", body)
	}
}

func TestHandleStat_FileNotFound_ExistsFalse(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	q := url.Values{}
	q.Set("path", filepath.Join(tmpDir, "no-such-file.bin"))
	req := httptest.NewRequest(http.MethodGet, "/files/stat?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleStat(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: want 200 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"exists":false`) {
		t.Fatalf("body should have exists=false, got %s", rec.Body.String())
	}
}

func TestHandleStat_ParentNotExist_ExistsFalse(t *testing.T) {
	// 锁定新加 resolveParentNoSymlink 在 parent ENOENT 时返 {exists:false}
	// 的语义 —— 等价文件不存在,不升级为 500。master nodeBootstrap 依赖此契约。
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	q := url.Values{}
	q.Set("path", filepath.Join(tmpDir, "no-such-subdir", "file.bin"))
	req := httptest.NewRequest(http.MethodGet, "/files/stat?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleStat(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: want 200 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"exists":false`) {
		t.Fatalf("body should have exists=false, got %s", rec.Body.String())
	}
}

func TestHandleStat_Directory_400(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	subdir := filepath.Join(tmpDir, "i-am-a-dir")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	q := url.Values{}
	q.Set("path", subdir)
	req := httptest.NewRequest(http.MethodGet, "/files/stat?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleStat(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "NOT_REGULAR_FILE") {
		t.Fatalf("body should contain NOT_REGULAR_FILE, got %q", rec.Body.String())
	}
}

func TestHandleStat_OutsideAllowlist_400(t *testing.T) {
	// 不挂临时 AllowedRoots → /etc 系统文件在白名单外
	q := url.Values{}
	q.Set("path", "/etc/hostname")
	req := httptest.NewRequest(http.MethodGet, "/files/stat?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleStat(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "BAD_PATH") {
		t.Fatalf("body should contain BAD_PATH, got %q", rec.Body.String())
	}
}

func TestHandleStat_ParentSymlinkEscape_400(t *testing.T) {
	// 锁定 resolveParentNoSymlink 防御:parent 是 symlink 指向白名单外,拒。
	//
	// 拓扑(参考 Codex review):
	//   allowedRoot = tmpDir
	//   tmpDir/link -> evilOutside
	//   path = tmpDir/link/file
	// validatePath 文本判定通过(在 tmpDir 下);resolveParentNoSymlink EvalSymlinks
	// parent(= tmpDir/link)真身解到 evilOutside,evilOutside 不在白名单,拒。
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	evilOutside := t.TempDir() // 系统 /tmp/xxx,不在白名单
	if err := os.WriteFile(filepath.Join(evilOutside, "secret"), []byte("secret"), 0o600); err != nil {
		t.Fatalf("seed evil: %v", err)
	}
	if err := os.Symlink(evilOutside, filepath.Join(tmpDir, "link")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	q := url.Values{}
	q.Set("path", filepath.Join(tmpDir, "link", "secret"))
	req := httptest.NewRequest(http.MethodGet, "/files/stat?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleStat(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "PARENT_UNSAFE") {
		t.Fatalf("body should contain PARENT_UNSAFE, got %q", rec.Body.String())
	}
}

// ── handleDelete handler-level 覆盖 ──────

func TestHandleDelete_HappyPath_Removed(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "doomed.bin")
	if err := os.WriteFile(target, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	q := url.Values{}
	q.Set("path", target)
	req := httptest.NewRequest(http.MethodDelete, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleDelete(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: want 204 got %d body=%q", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("file should be removed, stat err=%v", err)
	}
}

func TestHandleDelete_FileNotFound_204Idempotent(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	q := url.Values{}
	q.Set("path", filepath.Join(tmpDir, "never-existed.bin"))
	req := httptest.NewRequest(http.MethodDelete, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleDelete(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: want 204 got %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestHandleDelete_ParentNotExist_204Idempotent(t *testing.T) {
	// 锁定新加 resolveParentNoSymlink 在 parent ENOENT 时返 204 幂等,
	// 与 "file 不存在" 分支一致 —— 不破坏 sshMux/remoteCodexAuth 的预期。
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	q := url.Values{}
	q.Set("path", filepath.Join(tmpDir, "no-such-subdir", "file.bin"))
	req := httptest.NewRequest(http.MethodDelete, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleDelete(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: want 204 got %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestHandleDelete_Symlink_400(t *testing.T) {
	// p 本身是 symlink → 拒(避免误以为删的是真文件)
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	realTarget := filepath.Join(tmpDir, "real.bin")
	if err := os.WriteFile(realTarget, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	link := filepath.Join(tmpDir, "link.bin")
	if err := os.Symlink(realTarget, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	q := url.Values{}
	q.Set("path", link)
	req := httptest.NewRequest(http.MethodDelete, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleDelete(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "IS_SYMLINK") {
		t.Fatalf("body should contain IS_SYMLINK, got %q", rec.Body.String())
	}
	// 文件仍应存在(没被误删)
	if _, err := os.Stat(realTarget); err != nil {
		t.Fatalf("real target should still exist, stat err=%v", err)
	}
}

func TestHandleDelete_OutsideAllowlist_400(t *testing.T) {
	q := url.Values{}
	q.Set("path", "/etc/hostname")
	req := httptest.NewRequest(http.MethodDelete, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleDelete(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "BAD_PATH") {
		t.Fatalf("body should contain BAD_PATH, got %q", rec.Body.String())
	}
}

func TestHandleDelete_ParentSymlinkEscape_400(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	evilOutside := t.TempDir()
	if err := os.WriteFile(filepath.Join(evilOutside, "secret"), []byte("x"), 0o600); err != nil {
		t.Fatalf("seed evil: %v", err)
	}
	if err := os.Symlink(evilOutside, filepath.Join(tmpDir, "link")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	q := url.Values{}
	q.Set("path", filepath.Join(tmpDir, "link", "secret"))
	req := httptest.NewRequest(http.MethodDelete, "/files?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	(&Handler{}).handleDelete(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "PARENT_UNSAFE") {
		t.Fatalf("body should contain PARENT_UNSAFE, got %q", rec.Body.String())
	}
	// evilOutside/secret 仍存在 —— 没被误删
	if _, err := os.Stat(filepath.Join(evilOutside, "secret")); err != nil {
		t.Fatalf("evil file should still exist (defense worked), stat err=%v", err)
	}
}

// ── handlePut 补强测试 ──────

func TestHandlePut_HappyPath_NoOwner_BodyAndModeApplied(t *testing.T) {
	// 完整 happy path:无 owner 参数,正常写入,验证 body + mode 都落地。
	// (原 TestHandlePut_NoOwner_SkipsChown 只验 chown 没被调,没读回 body。)
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "happy.bin")
	payload := []byte("happy-path-content-12345")
	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0644")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader(payload))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: want 204 got %d body=%q", rec.Code, rec.Body.String())
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read final: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("body mismatch: want %q got %q", payload, got)
	}
	st, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st.Mode().Perm() != 0o644 {
		t.Fatalf("mode: want 0644 got %o", st.Mode().Perm())
	}
}

func TestHandlePut_BodyExceedsMax_413(t *testing.T) {
	// MaxBytesReader 在 MaxFileSize+1 字节时切断 → 413 FILE_TOO_LARGE。
	// 不真生成 200 MiB,用一个 contentLength 故意比 cap 大的 body —— MaxBytesReader
	// 看 Content-Length 与 cap 比较时也会拒,但更可靠的是真发超过 cap 的字节流。
	// 用 io.LimitReader 模拟:body 实际写入 MaxFileSize+128 字节,读到 cap+1 时
	// MaxBytesReader 会返 MaxBytesError。
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "too-large.bin")

	// 用一个无限 reader,MaxBytesReader 会在 MaxFileSize+1 字节时切断
	body := &infiniteByteReader{ch: 'A'}
	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0644")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), body)
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status: want 413 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "FILE_TOO_LARGE") {
		t.Fatalf("body should contain FILE_TOO_LARGE, got %q", rec.Body.String())
	}
	// 最终文件不应存在(写入未到 rename 阶段)
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("final file should not exist, stat err=%v", err)
	}
	// .tmp 残留是预期(Codex review:post-open failure 不做 path-based unlink);
	// io.Copy 中断后,tmp 内容应在 MaxFileSize 上下(MaxBytesReader 切断点)。
}

// infiniteByteReader 永远返回同一个字节,用于 MaxBytesReader 切断测试。
// 不用 bytes.Repeat 一次性分配 200MB,内存友好。
type infiniteByteReader struct{ ch byte }

func (r *infiniteByteReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = r.ch
	}
	return len(p), nil
}

func TestHandlePut_ParentSymlinkEscape_400(t *testing.T) {
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	evilOutside := t.TempDir()
	if err := os.Symlink(evilOutside, filepath.Join(tmpDir, "link")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	q := url.Values{}
	q.Set("path", filepath.Join(tmpDir, "link", "newfile"))
	q.Set("mode", "0644")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader([]byte("x")))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "PARENT_UNSAFE") {
		t.Fatalf("body should contain PARENT_UNSAFE, got %q", rec.Body.String())
	}
	// evilOutside 下不应被写入新文件
	if _, err := os.Stat(filepath.Join(evilOutside, "newfile")); !os.IsNotExist(err) {
		t.Fatalf("evil outside should not have new file (defense worked), stat err=%v", err)
	}
}

func TestHandlePut_PostRenameParentUnsafe_500_PathDiverged(t *testing.T) {
	// 锁定 A.3 post-rename guard:用 renameFile seam 模拟 rename 把 tmp 移到
	// 白名单外的路径(真实文件系统下无法稳定复现 race,只能 mock)。
	//
	// 场景:tmp 写完后,renameFile 走 fake,把 tmp rename 到 evilOutside/file。
	// 之后 handlePut 调 resolveParentNoSymlink(p) — p 是 tmpDir/file(在白名单
	// 内,parent 是 tmpDir 本身正常),但此时 attacker 已把 tmpDir 换成 symlink
	// 指向 evilOutside —— 这部分我们用 symlink 物理模拟:
	//   - 先把 tmpDir 加白名单
	//   - rename 把 tmp 实际放进 evilOutside
	//   - 再把 tmpDir 换成 symlink → evilOutside,这样 resolveParentNoSymlink(p)
	//     的 parent EvalSymlinks 会拿到 evilOutside,不在白名单,触发 PATH_DIVERGED
	//
	// 注意 t.TempDir() 在 /tmp/xxx,evilOutside 也在 /tmp/xxx,两个互不嵌套。
	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	evilOutside := t.TempDir()

	// p 文本在 tmpDir 下;rename 完成后我们把 tmpDir 换成 symlink → evilOutside
	target := filepath.Join(tmpDir, "victim.bin")

	renameOrig := renameFile
	renameFile = func(src, dst string) error {
		// 真正把 tmp rename 到 evilOutside,模拟 attacker 在 rename 那瞬间
		// 让 parent 解析到外部
		evilDst := filepath.Join(evilOutside, filepath.Base(dst))
		if err := os.Rename(src, evilDst); err != nil {
			return err
		}
		// 接着把 tmpDir 替换成 symlink → evilOutside,这样后续的
		// resolveParentNoSymlink(p=tmpDir/victim.bin) 解 parent 拿到 evilOutside
		if err := os.RemoveAll(tmpDir); err != nil {
			return err
		}
		if err := os.Symlink(evilOutside, tmpDir); err != nil {
			return err
		}
		return nil
	}
	defer func() {
		renameFile = renameOrig
		// 清理:把 tmpDir symlink 干掉,让 t.TempDir 的 cleanup 别报错
		_ = os.Remove(tmpDir)
	}()

	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0644")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader([]byte("payload")))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: want 500 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "PATH_DIVERGED") {
		t.Fatalf("body should contain PATH_DIVERGED, got %q", rec.Body.String())
	}
}
